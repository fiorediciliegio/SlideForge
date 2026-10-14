import assert from "node:assert/strict";
import test from "node:test";
import { createAgentClient } from "../../src/agent/agentClient.ts";
import { createSessionRunTrace, type SessionTraceContext } from "../../src/agent/sessionTrace.ts";
import type { AnnaRuntime } from "../../src/runtime/annaRuntime.ts";

function fixture(enabled = true) {
  const entries: Array<{ channel: string; entry: Record<string, any> }> = [];
  const trace: SessionTraceContext = { context: { template_id: "user-test", creation_run_id: "creation-1", operation_id: "analyze-1" }, sink: {
    enabled, async write(channel, entry) { entries.push({ channel, entry }); },
  } };
  return { trace, entries };
}

test("template tracing preserves all raw frames, requests and session lifecycle", async () => {
  const { trace, entries } = fixture();
  const requests: any[] = [];
  const runtime = {
    agent: { session: async (request: unknown) => {
      requests.push(request);
      return { id: "host-session", run: (request: unknown) => {
        requests.push(request);
        return (async function* () {
          yield { event: "run_meta", run_id: "host-run", custom: { diagnostic: "keep" } };
          for (let i = 0; i < 120; i++) yield { event: "unknown-future-event", custom_index: i, tool_data: { input: { secret: "secret-value" }, result: { arbitrary: i } } };
          yield { event: "message", text: '{"page_numbers":[1]}' };
          yield { event: "complete", task_complete: { token_usage: { total_tokens: 42 } } };
        })();
      }, delete: async () => {} };
    } },
  } as unknown as AnnaRuntime;
  const client = await createAgentClient(runtime);
  assert.deepEqual(await client.runStructuredPrompt("Read https://example.test/a?X-Amz-Signature=SECRET", (x) => x, {
    sessionTrace: trace, sessionTools: ["doc_read"], attachments: [{ type: "image/png", url: "https://secret.test/image", filename: "page-001.png" }],
  }), { page_numbers: [1] });
  assert.deepEqual(requests[0].quotaCaps.allowed_tools, ["doc_read"]);
  assert.equal(requests[1].attachments[0].url, "https://secret.test/image");
  const frames = entries.filter((x) => x.channel === "ai-user-template-stream").flatMap((x) => x.entry.frames);
  assert.equal(frames.length, 123);
  assert.deepEqual(frames.map((x) => x.receive_index), Array.from({ length: 123 }, (_, i) => i + 1));
  assert.equal(frames[1].frame.tool_data.result.arbitrary, 0);
  assert.equal(frames[120].frame.custom_index, 119);
  const started = entries.find((x) => x.entry.event === "session.run.started")!.entry;
  assert.match(started.request.content, /REDACTED_URL/);
  assert.equal(started.request.attachments[0].url, "[REDACTED]");
  const finished = entries.find((x) => x.entry.event === "session.run.finished")!.entry;
  assert.equal(finished.interaction_id, started.interaction_id);
  assert.equal(finished.frame_integrity.complete, true);
  assert.equal(finished.frame_integrity.persisted, 123);
  assert.equal(finished.usage.total_tokens, 42);
  assert.ok(entries.some((x) => x.entry.event === "session.create.started"));
  assert.ok(entries.some((x) => x.entry.event === "session.delete.succeeded"));
  assert.ok(entries.every((x) => x.entry.creation_run_id === "creation-1"));
  assert.doesNotMatch(JSON.stringify(entries), /secret-value|secret\.test|Signature=SECRET/);
});

test("creation failure and same-session validation repairs retain separate evidence", async () => {
  const { trace, entries } = fixture();
  let creates = 0, runs = 0;
  const runtime = { agent: { session: async () => {
    if (++creates === 1) throw new Error("session mint failed");
    return { id: "session-2", run: () => (async function* () {
      yield { event: "message", text: ++runs === 1 ? "not json" : '{"ok":true}' };
    })(), delete: async () => {} };
  } } } as unknown as AnnaRuntime;
  const client = await createAgentClient(runtime);
  await client.runStructuredPrompt("initial", (x) => x, { sessionTrace: trace });
  assert.equal(creates, 2); assert.equal(runs, 2);
  assert.ok(entries.some((x) => x.entry.event === "session.create.failed" && x.entry.error.message === "session mint failed"));
  const starts = entries.filter((x) => x.entry.event === "session.run.started");
  assert.equal(new Set(starts.map((x) => x.entry.interaction_id)).size, 2);
  assert.equal(new Set(starts.map((x) => x.entry.local_session_id)).size, 1);
  assert.ok(entries.some((x) => x.entry.event === "session.attempt.result" && x.entry.response_validation === "failed" && x.entry.will_retry));
});

test("raw frames flush during a running session and failure keeps partial output", async () => {
  const { trace, entries } = fixture();
  const run = createSessionRunTrace(trace, {})!;
  await run.start({ content: "run" });
  run.frame({ event: "message", text: "partial" }); run.content("partial");
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(entries.filter((x) => x.channel === "ai-user-template-stream").length, 1);
  run.frame({ event: "error", error: { message: "failed" } });
  await run.finish("failed", { error: new Error("failed") });
  const terminal = entries.at(-1)!.entry;
  assert.equal(terminal.partial_output.text, "partial");
  assert.equal(terminal.frame_integrity.received, 2);
});

test("stream logging failure is reported without changing a successful model result", async () => {
  const { trace, entries } = fixture();
  const write = trace.sink.write;
  trace.sink.write = async (channel, entry) => { if (channel === "ai-user-template-stream") throw new Error("disk failure"); return write(channel, entry); };
  const run = createSessionRunTrace(trace, {})!;
  await run.start({ content: "run" });
  run.frame({ event: "message", text: "done" }); run.content("done");
  await run.finish("succeeded", {});
  assert.equal(entries.at(-1)!.entry.output, "done");
  assert.equal(entries.at(-1)!.entry.frame_integrity.complete, false);
  assert.equal(entries.at(-1)!.entry.frame_integrity.dropped, 1);
  assert.equal(entries.at(-1)!.entry.frame_integrity.missing_ranges[0].reason, "write_failed");
});

test("disabled tracing collects no requests or raw frames", async () => {
  const { trace, entries } = fixture(false);
  const runtime = { agent: { session: async () => ({ run: () => (async function* () { yield { event: "message", text: "{}" }; })(), delete: async () => {} }) } } as unknown as AnnaRuntime;
  await (await createAgentClient(runtime)).runStructuredPrompt("run", (x) => x, { sessionTrace: trace });
  assert.deepEqual(entries, []);
  assert.equal(createSessionRunTrace(trace, {}), undefined);
});
