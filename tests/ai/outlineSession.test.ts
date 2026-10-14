import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiOutlineGenerationError, createAnnaAiClient } from "../../src/ai/annaAiClient.ts";
import type { AgentRunOptions } from "../../src/agent/agentClient.ts";
import type { PresentationRequirements } from "../../src/api/types.ts";
import type { AnnaRuntime } from "../../src/runtime/annaRuntime.ts";

function requirements(count = 60): PresentationRequirements {
  return {
    version: 1,
    status: "confirmed",
    source: { brief: "制作行业分析演示文稿" },
    candidates: { slide_count: [count], output_language: ["中文"] },
    selections: { slide_count: count, output_language: "中文", aspect_ratio: "16:9", visual_style_preset: null },
    research: {
      web: { recommended: false, reason: "无需研究", enabled: false },
      images: { recommended: false, reason: "无需图片", enabled: false },
    },
    updated_at: "2026-09-22T00:00:00Z",
    confirmed_at: "2026-09-22T00:00:00Z",
  };
}

const header = (count: number, title = "标题", global_creation_requirements = "") => JSON.stringify({ title, total_pages: count, global_creation_requirements });

function chunk(start: number, end: number, prefix = "页面") {
  return JSON.stringify({
    items: Array.from({ length: end - start + 1 }, (_, i) => ({
      page_number: start + i,
      page_type: start + i === 1 ? "cover" : "standard",
      title: `${prefix}${start + i}`,
      generation_notes: "来源：用户需求",
      content: "详细正文",
      ...(start + i === 2 ? { creation_requirements: "保留指定文案" } : {}),
    })),
  });
}

function harness(respond: (session: number, turn: number, prompt: string) => string | Error) {
  const prompts: string[][] = [];
  const options: AgentRunOptions[] = [];
  let closed = 0;
  const client = createAnnaAiClient({} as AnnaRuntime, {
    createOutlineSession: async (system, creation) => {
      assert.ok(system.length > 0);
      assert.equal(creation?.manageFreshSessionRetries, false);
      const session = prompts.length;
      prompts.push([]);
      return {
        run: async (prompt, runOptions) => {
          prompts[session]!.push(prompt);
          options.push(runOptions);
          const response = respond(session, prompts[session]!.length, prompt);
          if (response instanceof Error) throw response;
          runOptions.onStreamEvent?.({ type: "content", text: response });
          return response;
        },
        close: async () => { closed += 1; },
      };
    },
  });
  return { client, prompts, options, closed: () => closed };
}

describe("outline Agent Session", () => {
  it("generates fixed-size chunks in one session and preserves creation requirements", async () => {
    const h = harness((_session, turn) => {
      if (turn === 1) return header(21, "标题", "全局要求");
      return turn === 2 ? chunk(1, 20) : chunk(21, 21);
    });
    const result = await h.client.generateOutline({ requirements: requirements(21) });
    assert.equal(h.prompts.length, 1);
    assert.equal(h.closed(), 1);
    assert.equal(h.prompts[0]!.length, 3);
    assert.equal(result.outline.items.length, 21);
    assert.equal(result.outline.global_creation_requirements, "全局要求");
    assert.equal(result.outline.items[1]?.creation_requirements, "保留指定文案");
    assert.equal(Object.hasOwn(result.outline.items[0]!, "generation_notes"), false);
    assert.equal(Object.hasOwn(result.outline.items[0]!, "page_number"), false);
    assert.ok(h.options.every((option) => option.modelPreference === "google/gemini-3.8-flash" && option.toolAccessPolicy === "off"));
    assert.deepEqual(result.attempts.map((attempt) => attempt.stage), ["header", "items", "items"]);
  });

  it("repairs malformed header and chunk responses in the same session", async () => {
    const responses = ["{\"title\":", header(2), header(1), "{\"items\":", chunk(1, 2), chunk(1, 1)];
    const h = harness((_session, turn) => responses[turn - 1]!);
    const result = await h.client.generateOutline({ requirements: requirements(1) });
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0]!.length, responses.length);
    assert.ok(h.prompts[0]!.some((prompt) => prompt.includes("必须为已确认的 1 页")));
    assert.ok(h.prompts[0]!.some((prompt) => prompt.includes("本段返回 2 页")));
    assert.equal(result.outline.items.length, 1);
  });

  it("restarts from the original prompt after a session failure", async () => {
    const h = harness((session, turn) => {
      if (session === 0) return turn === 1 ? header(21) : new Error("Session expired");
      if (turn === 1) return header(21, "新标题");
      return turn === 2 ? chunk(1, 20, "新") : chunk(21, 21, "新");
    });
    const result = await h.client.generateOutline({ requirements: requirements(21) });
    assert.equal(h.prompts.length, 2);
    assert.equal(h.closed(), 2);
    assert.equal(h.prompts[0]![0], h.prompts[1]![0]);
    assert.equal(result.outline.title, "新标题");
    assert.equal(result.outline.items.length, 21);
    assert.equal(result.attempts.at(-1)?.sessionAttempt, 2);
  });

  it("revises with numbered input while preserving global and page creation requirements", async () => {
    const h = harness((_session, turn) => turn === 1 ? header(1) : chunk(1, 1));
    const result = await h.client.reviseOutline({
      title: "原始标题",
      global_creation_requirements: "每页图片至少占 80%",
      outline: [{ page_type: "cover", title: "原始页", content: "原始正文", creation_requirements: "图片不要裁切" }],
      feedback: "保留原文并调整标题",
      requirements: requirements(1),
    });
    assert.match(h.prompts[0]![0]!, /global_creation_requirements/);
    assert.match(h.prompts[0]![0]!, /page_number/);
    assert.match(h.prompts[0]![0]!, /保留原文并调整标题/);
    assert.equal(result.outline.items.length, 1);
  });

  it("does not accept incomplete chunks after retry budgets are exhausted", async () => {
    const h = harness((_session, turn) => turn === 1 ? header(2) : chunk(1, 1));
    await assert.rejects(
      () => h.client.generateOutline({ requirements: requirements(2) }),
      (error) => error instanceof AiOutlineGenerationError,
    );
    assert.equal(h.prompts.length, 6);
    assert.equal(h.closed(), 6);
  });
});

it("reports every header, chunk, correction and fresh session as a separate live attempt", async () => {
  const h = harness((session, turn) => {
    if (session === 0) return turn === 1 ? header(21) : turn === 2 ? chunk(1, 20) : new Error("Session expired");
    if (turn === 1) return "invalid-header";
    if (turn === 2) return header(21);
    return turn === 3 ? chunk(1, 20) : chunk(21, 21);
  });
  const events: string[] = [];
  const result = await h.client.generateOutline({
    requirements: requirements(21),
    onAttemptStart: ({ session, stage, correction, pageRange }) => events.push(`start:${session}:${stage}:${correction}:${pageRange?.start ?? 0}`),
    onStreamEvent: (event) => { if (event.type === "content") events.push("stream"); },
    onAttemptEnd: ({ status }) => events.push(`end:${status}`),
  });
  assert.equal(result.outline.items.length, 21);
  assert.deepEqual(events, [
    "start:1:header:0:0", "stream", "end:success",
    "start:1:items:0:1", "stream", "end:success",
    "start:1:items:0:21", "end:error",
    "start:2:header:0:0", "stream", "end:retry",
    "start:2:header:1:0", "stream", "end:success",
    "start:2:items:0:1", "stream", "end:success",
    "start:2:items:0:21", "stream", "end:success",
  ]);
});
