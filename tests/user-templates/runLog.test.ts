import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunLog, describeError, finishRunLog, formatRunLog, loadRunLogs, persistRunLog, runLogged } from "../../src/features/user-templates/runLog.ts";

test("runLogged records ok entries with duration and meta", async () => {
  const log = createRunLog();
  const value = await runLogged(log, { stage: "profile", label: "extraction", meta: { prompt_chars: 1200 } }, async () => "done");
  assert.equal(value, "done");
  assert.equal(log.entries.length, 1);
  const entry = log.entries[0];
  assert.equal(entry.stage, "profile");
  assert.equal(entry.result, "ok");
  assert.equal(entry.meta?.prompt_chars, 1200);
  assert.ok(entry.duration_ms >= 0);
  assert.ok(!entry.detail);
});

test("runLogged records errors and rethrows", async () => {
  const log = createRunLog();
  const boom = new Error("Agent run completed without producing any output");
  await assert.rejects(() => runLogged(log, { stage: "profile", label: "extraction" }, async () => { throw boom; }), boom);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].result, "error");
  assert.match(log.entries[0].detail ?? "", /without producing any output/);
});

test("runLogged classifies AbortError as aborted", async () => {
  const log = createRunLog();
  await assert.rejects(
    () => runLogged(log, { stage: "master", label: "generation" }, async () => { throw new DOMException("Aborted", "AbortError"); }),
    (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError",
  );
  assert.equal(log.entries[0].result, "aborted");
});

test("finishRunLog sets outcome, finished_at and error once", () => {
  const log = createRunLog();
  finishRunLog(log, "error", "boom");
  const finishedAt = log.finished_at;
  finishRunLog(log, "success");
  assert.equal(log.outcome, "success");
  assert.equal(log.finished_at, finishedAt);
});

test("formatRunLog renders a plain-text diagnostic report", async () => {
  const log = createRunLog();
  await runLogged(log, { stage: "analyze", label: "page selection", meta: { tool: "doc_read" } }, async () => 1);
  finishRunLog(log, "error", "empty completion");
  const text = formatRunLog(log);
  assert.match(text, /outcome: error/);
  assert.match(text, /error: empty completion/);
  assert.match(text, /analyze\/page selection: ok in \d+ms tool=doc_read/);
});

test("persistRunLog/loadRunLogs roundtrip keeps the latest 5 logs", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  for (let index = 0; index < 7; index += 1) {
    const log = createRunLog();
    log.template_id = `user-${index}`;
    finishRunLog(log, "error", `failure ${index}`);
    persistRunLog(storage, log);
  }
  const logs = loadRunLogs(storage);
  assert.equal(logs.length, 5);
  assert.equal(logs[0].log.template_id, "user-6");
  assert.equal(logs[0].log.error, "failure 6");
  assert.equal(logs[4].log.template_id, "user-2");
});

test("persistRunLog never throws on broken storage", () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const log = finishRunLog(createRunLog(), "success");
  assert.doesNotThrow(() => persistRunLog(broken, log));
  assert.equal(loadRunLogs({ getItem: () => { throw new Error("denied"); } }).length, 0);
});

test("describeError handles non-Error causes", () => {
  assert.equal(describeError("plain"), "plain");
  assert.equal(describeError(new Error("msg")), "msg");
});

test("classifyRunError buckets known bridge and executor messages", async () => {
  const { classifyRunError } = await import("../../src/features/user-templates/runLog.ts");
  assert.equal(classifyRunError("Agent run completed without producing any output (no assistant message, no tool calls)"), "empty_completion");
  assert.equal(classifyRunError("upstream model returned an empty completion"), "empty_completion");
  assert.equal(classifyRunError("Agent run timed out after 90000ms"), "timeout");
  assert.equal(classifyRunError("解析失败：该文件实际为 XLSX 工作簿格式"), "parse");
  assert.equal(classifyRunError("Agent Session returned an invalid response after 3 attempts"), "parse");
  assert.equal(classifyRunError("Aborted"), "cancelled");
  assert.equal(classifyRunError("Failed to fetch"), "network");
  assert.equal(classifyRunError("Host upload failed: Failed to fetch. Engine relay skipped: runtime.tools.invoke unavailable."), "network");
  assert.equal(classifyRunError("something else entirely"), "unknown");
  assert.equal(classifyRunError(undefined), "unknown");
});

test("runLogged stamps the run's model preference into every entry", async () => {
  const log = createRunLog();
  log.model_preference = "google/gemini-3.8-flash";
  await runLogged(log, { stage: "analyze", label: "ok-case" }, async () => 1);
  await assert.rejects(() => runLogged(log, { stage: "analyze", label: "err-case" }, async () => { throw new Error("Agent run completed without producing any output"); }));
  assert.equal(log.entries[0].meta?.model, "google/gemini-3.8-flash");
  assert.equal(log.entries[1].meta?.model, "google/gemini-3.8-flash");
  assert.equal(log.entries[1].meta?.kind, "empty_completion");
  finishRunLog(log, "error", "Agent run completed without producing any output");
  assert.equal(log.error_kind, "empty_completion");
  const text = formatRunLog(log);
  assert.match(text, /model_preference: google\/gemini-3\.8-flash/);
  assert.match(text, /error_kind: empty_completion/);
  assert.match(text, /kind=empty_completion/);
});

test("frame collector summarizes and caps stream events", async () => {
  const { createFrameCollector, summarizeStreamEvent } = await import("../../src/features/user-templates/runLog.ts");
  assert.match(summarizeStreamEvent({ type: "activity", tool: "doc_read", path: "slides/slide1.xml", size: 2048, message: "reading" }), /activity: doc_read slides\/slide1\.xml 2048B/);
  assert.match(summarizeStreamEvent({ type: "activity", tool: "doc_read", diagnosticOnly: true, message: "warn" }), /activity\(diagnostic\)/);
  assert.match(summarizeStreamEvent({ type: "error", code: "E_X", expired: false, message: "boom" }), /error: code=E_X expired=false boom/);
  assert.match(summarizeStreamEvent({ type: "content", text: "x".repeat(999) }), new RegExp(`^content: x{${500}}$`));
  assert.match(summarizeStreamEvent({ type: "complete", usage: { input: 1 } }), /complete: usage=/);
  const frames: import("../../src/features/user-templates/runLog.ts").RunFrame[] = [];
  const collect = createFrameCollector(1000, frames, 3);
  for (let index = 0; index < 5; index += 1) collect({ type: "content", text: `frame ${index}` });
  assert.equal(frames.length, 3);
  assert.ok(frames[0].offset_ms >= 0);
});

test("runLogged attaches live-collected frames to the entry", async () => {
  const { createFrameCollector } = await import("../../src/features/user-templates/runLog.ts");
  const log = createRunLog();
  const frames: import("../../src/features/user-templates/runLog.ts").RunFrame[] = [];
  const collect = createFrameCollector(Date.now(), frames);
  await assert.rejects(() => runLogged(log, { stage: "analyze", label: "doc_read", frames }, async () => {
    collect({ type: "activity", tool: "doc_read", path: "slides/slide3.xml" });
    collect({ type: "error", message: "Agent run completed without producing any output" });
    throw new Error("Agent run completed without producing any output");
  }));
  const entry = log.entries[0];
  assert.equal(entry.frames?.length, 2);
  assert.match(entry.frames?.[0].summary ?? "", /doc_read slides\/slide3\.xml/);
  const text = formatRunLog(log);
  assert.match(text, /\+\d+ms activity: doc_read slides\/slide3\.xml/);
  assert.match(text, /\+\d+ms error: .*without producing any output/);
});

test("frame collector stamps the platform run id from a live holder", async () => {
  const { createFrameCollector } = await import("../../src/features/user-templates/runLog.ts");
  const frames: import("../../src/features/user-templates/runLog.ts").RunFrame[] = [];
  const holder: { run_id?: string } = {};
  const collect = createFrameCollector(0, frames, 200, holder);
  collect({ type: "activity", message: "first session" });
  holder.run_id = "run-abc-123";
  collect({ type: "error", message: "boom" });
  assert.equal(frames[0].run_id, undefined);
  assert.equal(frames[1].run_id, "run-abc-123");
  assert.match(formatRunLog(createRunLog()), /# Template run log/);
  const log = createRunLog();
  await assert.rejects(() => runLogged(log, { stage: "analyze", label: "x", frames }, async () => { throw new Error("boom"); }), /boom/);
  assert.match(formatRunLog(log), /\[run-abc-123\] error: code=- expired=false boom/);
});

test("captureRunEnvironment is browser-safe and merges extras", async () => {
  const { captureRunEnvironment } = await import("../../src/features/user-templates/runLog.ts");
  const env = captureRunEnvironment({ engine_version: "5.1.10" });
  assert.equal(env.engine_version, "5.1.10");
  // Node test runtime: no navigator/location, but it must not throw.
  if (typeof navigator !== "undefined") assert.ok(env.ua);
});

test("summarizeRawFrame renders wire frames with truncated strings, never throws", async () => {
  const { summarizeRawFrame } = await import("../../src/features/user-templates/runLog.ts");
  const rendered = summarizeRawFrame({ event: "sse", data: { choices: [{ delta: { text: "y".repeat(500) } }] }, run_id: "r1" });
  assert.match(rendered, /"event":"sse"/);
  assert.match(rendered, /run_id/);
  assert.match(rendered, /…\(500c\)/);
  assert.ok(rendered.length <= 1000);
  assert.doesNotThrow(() => summarizeRawFrame(BigInt(1)));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => summarizeRawFrame(circular));
});
