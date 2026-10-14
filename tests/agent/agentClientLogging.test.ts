import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAiInteractionLogger, type AiOperationLogContext } from "../../src/ai/interactionLog.ts";
import { createAgentClient, isAgentRunCancelledError } from "../../src/agent/agentClient.ts";
import type { AnnaAgentRunFrame, HostRuntime } from "../../src/runtime/hostRuntime.ts";

describe("AgentClient AI Interaction Log", () => {
  for (const enabled of [true, false]) it(`preserves Agent output with logging ${enabled ? "on" : "off"}`, async () => {
    let historyReads = 0;
    const logs: unknown[] = [];
    const logger = createAiInteractionLogger({
      diagnosticLoggingEnabled: enabled,
      appendWorkspaceLog: async (input) => {
        logs.push(input);
      },
    });
    const runtime: HostRuntime = {
      tools: { invoke: async () => ({}) },
      llm: { complete: async () => ({}) },
      agent: {
        session: async () => ({
          run: () =>
            (async function* () {
              yield {
                event: "message",
                text: JSON.stringify({
                  status: "ready_for_render",
                  changed_files: [],
                  summary: "ok",
                  needs_render: true,
                  notes: [],
                }),
              };
              yield { event: "complete", task_complete: { token_usage: { total: 1 } } };
            })(),
          history: async () => { historyReads += 1; return { frames: 2 }; },
          delete: async () => undefined,
        }),
      },
    };
    const context: AiOperationLogContext = {
      logger,
      workspace_dir: "/tmp/workspace",
      domain: "page_agent",
      operation: "authoring",
      operation_id: "op-1",
      page_id: "page-01",
      page_index: 0,
      kind: "authoring",
    };

    const client = await createAgentClient(runtime);
    const result = await client.runAuthoringPrompt("write the slide", { logContext: context });
    assert.match(JSON.stringify(result), /ready_for_render/);
    assert.equal(historyReads, enabled ? 1 : 0);
    if (!enabled) {
      assert.deepEqual(logs, []);
      return;
    }

    assert.equal(logs.length, 2);
    const started = logs[0] as { channel?: string; entry?: Record<string, unknown> };
    const finished = logs[1] as { channel?: string; entry?: Record<string, unknown> };
    assert.equal(started.channel, "ai-page-agent-interactions");
    assert.equal(started.entry?.prompt, "write the slide");
    assert.equal(finished.channel, "ai-page-agent-interactions");
    assert.equal(finished.entry?.status, "succeeded");
    assert.match(String(finished.entry?.output), /ready_for_render/);
    assert.deepEqual(finished.entry?.session_history, { frames: 2 });
    assert.equal(finished.entry?.operation_id, "op-1");
  });
});


function diagnosticFixture(runs: Array<{ frames: AnnaAgentRunFrame[]; hang?: boolean; runId?: string }>, options: { enabled?: boolean; history?: () => Promise<unknown> } = {}) {
  const logs: Array<{ entry: Record<string, any>; payload_keys?: string[] }> = [];
  let runCount = 0;
  let sessionCount = 0;
  let returns = 0;
  let historyReads = 0;
  const cancels: string[] = [];
  const pending: Array<(frame: IteratorResult<AnnaAgentRunFrame>) => void> = [];
  const logger = createAiInteractionLogger({
    diagnosticLoggingEnabled: options.enabled ?? true,
    appendWorkspaceLog: async (input) => { logs.push(input); },
  });
  const context: AiOperationLogContext = { logger, workspace_dir: "/tmp/workspace", domain: "research", operation: "research", operation_id: "research-test" };
  const runtime: HostRuntime = {
    tools: { invoke: async () => ({}) }, llm: { complete: async () => ({}) },
    agent: { session: async () => {
      sessionCount += 1;
      return {
        appSessionUuid: `session-${sessionCount}`,
        run: () => {
          const run = runs[runCount++] ?? runs.at(-1)!;
          let index = 0;
          return {
            run_id: run.runId,
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                if (index < run.frames.length) return { done: false, value: run.frames[index++] };
                if (run.hang) return new Promise<IteratorResult<AnnaAgentRunFrame>>((resolve) => pending.push(resolve));
                return { done: true, value: undefined };
              },
              return: async () => { returns += 1; return { done: true, value: undefined }; },
            }),
          };
        },
        history: async () => { historyReads += 1; return options.history?.(); },
        cancel: async (id) => { cancels.push(id); },
        delete: async () => undefined,
      };
    } },
  };
  return {
    runtime, context, logs, cancels, pending,
    get finished() { return logs.filter((log) => log.entry.status !== "started"); },
    get returns() { return returns; },
    get runCount() { return runCount; },
    get sessionCount() { return sessionCount; },
    get historyReads() { return historyReads; },
  };
}

const taskComplete = (taskId = "task-1"): AnnaAgentRunFrame => ({
  event: "sse", choices: [{ delta: { task_complete: { task_id: taskId, status: "completed", token_usage: { total_tokens: 42 } } } }],
});

describe("Agent stream diagnostic snapshots", () => {
  it("separates all visible identifier sources and stops observing after task completion", async () => {
    const fixture = diagnosticFixture([{
      runId: "local-1",
      frames: [
        { event: "run_meta", run_id: "remote-1", app_session_uuid: "session-1" },
        { event: "sse", choices: [{ delta: { content: "done" } }] }, taskComplete(),
      ], hang: true,
    }]);
    const client = await createAgentClient(fixture.runtime, { streamIdleTimeoutMs: 10 });
    const held = await client.createWebResearchSession("system");
    assert.equal(await held.run("run", { logContext: fixture.context }), "done");
    const log = fixture.finished[0];
    const diag = log.entry.stream_diagnostics;
    assert.equal(diag.identifiers.stream_run_id, "local-1");
    assert.equal(diag.identifiers.run_meta_run_id, "remote-1");
    assert.equal(diag.markers.task_complete.task_id, "task-1");
    assert.equal(diag.exit_reason, "task_complete");
    assert.equal(diag.counts.frames, 3);
    assert.equal(diag.counts.content_chars, 4);
    assert.equal(diag.markers.iterator_done, false);
    assert.equal(diag.markers.raw_done, false);
    assert.equal(diag.subsequent_frames, "not_observed");
    assert.equal(diag.rpc_outer_metadata, "unavailable");
    assert.equal(diag.cleanup.iterator_return, "resolved");
    assert.equal(diag.operation_id, log.entry.operation_id);
    assert.equal(diag.interaction_id, log.entry.interaction_id);
    assert.deepEqual(log.entry.usage, { total_tokens: 42 });
    assert.ok(log.payload_keys?.includes("stream_diagnostics"));
    assert.ok(log.payload_keys?.includes("partial_output"));
    assert.equal(fixture.returns, 1);
    assert.equal(fixture.sessionCount, 1);
    await held.close();
  });

  it("records event_type-only stream_end, raw DONE and actual iterator exhaustion separately", async () => {
    const fixture = diagnosticFixture([{ frames: [
      { event: "message", text: "done" },
      { event_type: "stream_end", reason: "done", task_id: "task-1" },
      { event: "raw", text: "[DONE]" },
    ] }]);
    const held = await (await createAgentClient(fixture.runtime)).createImageResearchSession("system");
    assert.equal(await held.run("run", { logContext: fixture.context }), "done");
    const diag = fixture.finished[0].entry.stream_diagnostics;
    assert.equal(diag.exit_reason, "stream_exhausted");
    assert.equal(diag.markers.stream_end.reason, "done");
    assert.equal(diag.markers.raw_done, true);
    assert.equal(diag.markers.iterator_done, true);
    assert.equal(diag.counts.content_chars, 4);
    assert.equal(diag.counts.event_type.stream_end, 1);
    assert.equal(diag.frames[1].event, "unavailable");
    assert.equal(fixture.returns, 0);
  });

  for (const frames of [[], [{ event: "run_meta", run_id: "remote-1" }], [{ event: "message", text: "partial" }]]) {
    it(`retains idle failure evidence after ${frames.length ? frames[0].event : "no frames"}`, async () => {
      const fixture = diagnosticFixture([{ frames, hang: true }]);
      const held = await (await createAgentClient(fixture.runtime, { streamIdleTimeoutMs: 10 })).createWebResearchSession("system", { manageFreshSessionRetries: false });
      await assert.rejects(held.run("run", { logContext: fixture.context }), /idle timeout/);
      const log = fixture.finished[0].entry;
      const diag = log.stream_diagnostics;
      assert.equal(diag.exit_reason, "idle_timeout");
      assert.equal(diag.counts.frames, frames.length);
      assert.equal(log.partial_output.kind, "partial");
      assert.equal(log.partial_output.text, frames[0]?.text ?? "");
      assert.equal(log.output, undefined);
      assert.equal(Boolean(diag.timing.first_content), Boolean(frames[0]?.text));
      assert.equal(Boolean(diag.timing.first_frame), frames.length > 0);
      assert.ok(diag.timing.since_last_frame_ms >= 5);
      assert.equal(diag.cleanup.host_cancel, "not_requested");
      assert.equal(fixture.cancels.length, 0);
      assert.equal(fixture.returns, 1);
    });
  }

  it("keeps failed attempts independent from fresh retries and reused sessions", async () => {
    const fixture = diagnosticFixture([
      { frames: [{ event: "run_meta", run_id: "old" }, { event: "message", text: "bad" }], hang: true },
      { frames: [{ event: "message", text: "good" }, taskComplete("second")] },
      { frames: [{ event: "message", text: "next" }, taskComplete("third")] },
    ]);
    const held = await (await createAgentClient(fixture.runtime, { streamIdleTimeoutMs: 10 })).createWebResearchSession("system");
    assert.equal(await held.run("first", { logContext: fixture.context }), "good");
    assert.equal(await held.run("next", { logContext: fixture.context }), "next");
    const logs = fixture.finished.map((log) => log.entry);
    assert.deepEqual(logs.map((log) => log.stream_diagnostics.counts.frames), [2, 2, 2]);
    assert.equal(logs[0].partial_output.text, "bad");
    assert.equal(logs[1].partial_output, undefined);
    assert.equal(logs[1].stream_diagnostics.identifiers.run_meta_run_id, undefined);
    assert.equal(logs[2].stream_diagnostics.markers.task_complete.task_id, "third");
    assert.equal(new Set(logs.map((log) => log.interaction_id)).size, 3);
    assert.equal(fixture.sessionCount, 2);
    assert.equal(fixture.returns, 3);
    assert.equal(logs[1].held_session_attempt.fresh_session_retry_count, 1);
  });

  it("records cancellation without retry, while drainOnCancel can still complete", async () => {
    for (const drainOnCancel of [false, true]) {
      const controller = new AbortController();
      const fixture = diagnosticFixture([{ frames: [{ event: "message", text: "partial" }, taskComplete()] }]);
      const held = await (await createAgentClient(fixture.runtime)).createOutlineSession("system");
      const promise = held.run("run", {
        logContext: fixture.context, signal: controller.signal, drainOnCancel,
        onStreamEvent: (event) => { if (event.type === "content") controller.abort(); },
      });
      if (drainOnCancel) assert.equal(await promise, "partial");
      else await assert.rejects(promise, isAgentRunCancelledError);
      assert.equal(fixture.finished[0].entry.stream_diagnostics.exit_reason, drainOnCancel ? "task_complete" : "cancelled");
      assert.equal(fixture.sessionCount, 1);
    }
  });

  it("freezes total-timeout evidence before slow history and ignores late frames", async () => {
    let resolveHistory: (() => void) | undefined;
    let enteredHistory: (() => void) | undefined;
    const historyEntered = new Promise<void>((resolve) => { enteredHistory = resolve; });
    const fixture = diagnosticFixture([{ runId: "local", frames: [{ event: "message", text: "partial" }], hang: true }], {
      history: () => { enteredHistory!(); return new Promise<void>((resolve) => { resolveHistory = resolve; }); },
    });
    const held = await (await createAgentClient(fixture.runtime, { runTimeoutMs: 10, streamIdleTimeoutMs: 1000 })).createWebResearchSession("system", { manageFreshSessionRetries: false });
    const promise = held.run("run", { logContext: fixture.context });
    const rejection = assert.rejects(promise, /timed out/);
    await historyEntered;
    fixture.pending[0]({ done: false, value: { event: "run_meta", run_id: "late", text: "late" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveHistory!();
    await rejection;
    const log = fixture.finished[0].entry;
    const diag = log.stream_diagnostics;
    const snapshot = JSON.stringify(diag);
    assert.equal(diag.exit_reason, "run_timeout");
    assert.equal(diag.counts.frames, 1);
    assert.equal(log.partial_output.text, "partial");
    assert.ok(diag.timing.terminated.elapsed_ms < log.duration_ms);
    assert.deepEqual(fixture.cancels, ["local"]);
    assert.equal(diag.cleanup.host_cancel, "resolved");
    assert.equal(fixture.returns, 1);
    await Promise.resolve();
    assert.equal(JSON.stringify(diag), snapshot);
  });

  it("does not reuse a previous run id when the next run times out without metadata", async () => {
    const fixture = diagnosticFixture([
      { runId: "old", frames: [{ event: "message", text: "first" }, taskComplete()] },
      { frames: [], hang: true },
    ]);
    const held = await (await createAgentClient(fixture.runtime, { runTimeoutMs: 10, streamIdleTimeoutMs: 1000 })).createWebResearchSession("system", { manageFreshSessionRetries: false });
    await held.run("first", { logContext: fixture.context });
    await assert.rejects(held.run("second", { logContext: fixture.context }), /timed out/);
    assert.deepEqual(fixture.cancels, []);
    assert.equal(fixture.finished[1].entry.stream_diagnostics.identifiers.stream_run_id, undefined);
    assert.equal(fixture.finished[1].entry.stream_diagnostics.cleanup.host_cancel, "unavailable");
  });

  it("bounds thousands of frame summaries and partial text, redacting split credentials and URLs", async () => {
    const fixture = diagnosticFixture([{ frames: [
      { event: "started", Authorization: "Bearer hidden-frame-secret" },
      { event: "message", text: 'Authorization: Bear' },
      { event: "message", text: 'er hidden-body-secret https://host/path?sig=hidden-url-secret ' },
      { event: "sse", choices: [{ delta: { tool_start: { name: "tool", input: { token: "hidden-tool-secret" } } } }] },
      ...Array.from({ length: 5000 }, () => ({ event: "message", text: "x".repeat(100) })),
      { event_type: "stream_end", reason: "done" },
    ], hang: true }]);
    const held = await (await createAgentClient(fixture.runtime, { streamIdleTimeoutMs: 10 })).createWebResearchSession("system", { manageFreshSessionRetries: false });
    await assert.rejects(held.run("run", { logContext: fixture.context }), /idle timeout/);
    const log = fixture.finished[0].entry;
    const diag = log.stream_diagnostics;
    assert.equal(diag.counts.frames, 5005);
    assert.ok(diag.frames.length <= 72);
    assert.equal(diag.frame_budget.truncated, true);
    assert.equal(diag.frame_budget.dropped, 5005 - diag.frames.length);
    assert.equal(diag.markers.stream_end.observed, true);
    assert.equal(diag.frames.at(-1).event_type, "stream_end");
    assert.equal(log.partial_output.retained_chars, 65536);
    assert.equal(log.partial_output.truncated, true);
    assert.ok(JSON.stringify(diag).length < 40_000);
    const diagnosticText = JSON.stringify([diag, log.partial_output]);
    for (const secret of ["hidden-frame-secret", "hidden-body-secret", "hidden-url-secret", "hidden-tool-secret", "https://"]) assert.ok(!diagnosticText.includes(secret));
  });

  it("keeps concurrent Web and image sessions independent", async () => {
    const fixture = diagnosticFixture([
      { runId: "web-local", frames: [{ event: "message", text: "web" }, taskComplete("web-task")] },
      { runId: "image-local", frames: [{ event: "message", text: "image" }, taskComplete("image-task")] },
    ]);
    const client = await createAgentClient(fixture.runtime);
    const web = await client.createWebResearchSession("web");
    const image = await client.createImageResearchSession("image");
    assert.deepEqual(await Promise.all([
      web.run("web", { logContext: { ...fixture.context, operation_id: "web-op" } }),
      image.run("image", { logContext: { ...fixture.context, operation_id: "image-op" } }),
    ]), ["web", "image"]);
    const logs = fixture.finished.map((log) => log.entry);
    assert.deepEqual(logs.map((log) => log.stream_diagnostics.identifiers.stream_run_id), ["web-local", "image-local"]);
    assert.deepEqual(logs.map((log) => log.stream_diagnostics.counts.content_chars), [3, 5]);
    assert.deepEqual(logs.map((log) => log.stream_diagnostics.operation_id), ["web-op", "image-op"]);
    assert.equal(fixture.returns, 2);
  });

  it("preserves original failure if diagnostic logging throws", async () => {
    const fixture = diagnosticFixture([{ frames: [{ event: "error", message: "original stream failure" }] }]);
    fixture.context.logger!.finishInteraction = async () => { throw new Error("log failure"); };
    const held = await (await createAgentClient(fixture.runtime)).createWebResearchSession("system", { manageFreshSessionRetries: false });
    await assert.rejects(held.run("run", { logContext: fixture.context }), /original stream failure/);
    assert.equal(fixture.runCount, 1);
  });

  it("does not inspect diagnostic-only fields or read history when logging is disabled", async () => {
    const frame = taskComplete();
    Object.defineProperty(frame, "event_type", { get() { throw new Error("diagnostics must be disabled"); } });
    const fixture = diagnosticFixture([{ frames: [{ event: "message", text: "done" }, frame], hang: true }], { enabled: false });
    const held = await (await createAgentClient(fixture.runtime)).createWebResearchSession("system");
    assert.equal(await held.run("run", { logContext: fixture.context }), "done");
    assert.deepEqual(fixture.logs, []);
    assert.equal(fixture.historyReads, 0);
    assert.equal(fixture.returns, 1);
  });

  it("does not let diagnostic extraction or logger failure change success or trigger retry", async () => {
    const frame = taskComplete();
    Object.defineProperty(frame, "event_type", { get() { throw new Error("diagnostic getter"); } });
    const fixture = diagnosticFixture([{ frames: [{ event: "message", text: "done" }, frame] }]);
    fixture.context.logger!.finishInteraction = async () => { throw new Error("serialization or upload failure"); };
    const held = await (await createAgentClient(fixture.runtime)).createWebResearchSession("system");
    assert.equal(await held.run("run", { logContext: fixture.context }), "done");
    assert.equal(fixture.sessionCount, 1);
    assert.equal(fixture.runCount, 1);
  });
});
