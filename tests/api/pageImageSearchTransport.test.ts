import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime";
import assert from "node:assert/strict";
import test from "node:test";
import { createAnnaPptBackend } from "../../src/api/annaPptBackend";
import type { PageImageSearchRequest, PageImageSearchTask } from "../../src/api/pageImageSearchTypes";
import type { AnnaRuntime, AnnaToolInvokeInput } from "../../src/runtime/annaRuntime";
import { readCheckpoint } from "../../src/features/deck-generation/linearResearchWorkflow";
import { confirmedRequirements } from "../fixtures/imageRequirements";

test("按页任务超过旧阈值仍提交原始对象，由普通 invoke 统一传输", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    __ANNA_TOOL_IDS__: { "ppt-engine": "tool-ppt-engine" },
  } });
  const calls: AnnaToolInvokeInput[] = [];
  const uploads: string[] = [];
  let negotiatedSize = 0;
  globalThis.fetch = async (_url, options) => {
    uploads.push(await new Response(options?.body).text());
    return new Response("", { status: 200 });
  };
  const runtime: AnnaRuntime = {
    tools: { invoke: withOrdinaryInvokeTransport(async (input) => { calls.push(input); return { success: true, data: {} }; }) },
    llm: { complete: async () => ({}) },
    agent: { session: async () => { throw new Error("not used"); } },
    upload: {
      negotiate: async (input) => {
        negotiatedSize = input.size_bytes;
        return { put_url: "https://upload.example/put", headers: {}, r2_key: "tasks/page-image-search.json" };
      },
      confirm: async ({ r2_key }) => ({ download_url: "https://upload.example/get", r2_key, size_bytes: negotiatedSize }),
    },
  };
  const task: PageImageSearchTask = {
    id: crypto.randomUUID(), status: "running", max_searches: 10,
    context: { target_key: "draft", title: "演示", global_creation_requirements: "", opinion: "",
      page: { title: "当前页", content: "正文" }, requirements: confirmedRequirements() },
    checkpoint: readCheckpoint({}), result_ids: [], updated_at: new Date().toISOString(),
  };
  const request: PageImageSearchRequest = { workspace_dir: "/tmp/ppt-test", action: "save", owner: crypto.randomUUID(), task };
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const padding = 48 * 1024 - bytes(request);
  task.context.opinion = "中".repeat(Math.floor(padding / 3)) + "a".repeat(padding % 3);
  try {
    const backend = createAnnaPptBackend(runtime, { diagnosticLoggingEnabled: false });
    assert.equal(bytes(request), 48 * 1024);
    assert.equal(await backend.pageImageSearch(request), null);
    assert.deepEqual((calls.at(-1)?.args as Record<string, unknown>).task, task);
    assert.equal(uploads.length, 0);

    task.context.opinion += "a";
    await backend.pageImageSearch(request);
    const args = calls.at(-1)?.args as Record<string, unknown>;
    assert.deepEqual(args.task, task);
    assert.equal(args.task_upload, undefined);
    assert.deepEqual(uploads, []);
    assert.equal(negotiatedSize, 0);
    assert.equal(calls.at(-1)?.method, "app_page_image_search");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
