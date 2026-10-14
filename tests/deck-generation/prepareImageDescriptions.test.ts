import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunCancelledError, createAgentClient } from "../../src/agent/agentClient";
import type { PptBackend } from "../../src/api/pptBackend";
import type { SharedResearchContextResult, SharedResearchImageAsset } from "../../src/api/types";
import type { AnnaAgentSessionRunInput, HostRuntime } from "../../src/runtime/hostRuntime";
import { prepareSelectedImageDescriptions } from "../../src/features/deck-generation/prepareImageDescriptions";

const asset = (index: number, description = ""): SharedResearchImageAsset => ({
  asset_id: `image-${index}`, sha256: index.toString(16).padStart(64, "0"), description,
  file_path: `/workspace/${index}.png`, mime_type: "image/png", bytes_size: 100,
  aspect_ratio: 1, reason: "", matched_queries: [], source_url: `manual-upload://${index}`,
});
const context = (images: SharedResearchImageAsset[]) => ({
  workspace_dir: "/workspace", image_catalog: { schema_version: 2, assets: images },
  uploaded_asset_catalog: { schema_version: 2, assets: [] }, progress: {},
}) as SharedResearchContextResult;

async function harness(images: SharedResearchImageAsset[], respond: (input: AnnaAgentSessionRunInput, run: number) => unknown) {
  const requests: AnnaAgentSessionRunInput[] = [];
  const prepared: string[] = [];
  const saved: string[] = [];
  const logs: unknown[] = [];
  const attemptedByRun = new Map<string, Set<string>>();
  let sessions = 0;
  let closed = 0;
  const runtime: HostRuntime = {
    tools: { invoke: async () => ({}) }, llm: { complete: async () => ({}) },
    agent: { session: async () => {
      sessions++;
      return {
        run: (input) => (async function* () {
          requests.push(input);
          const response = respond(input, requests.length);
          yield { event: "message", text: JSON.stringify(response) };
          yield { event: "complete" };
        })(),
        delete: async () => { closed++; },
      };
    } },
  };
  const research = context(images);
  const backend = {
    uploadOutlineImageForAgent: async ({ asset_id }: { asset_id: string }) => {
      prepared.push(asset_id);
      // Resolve in reverse order to expose accidental attachment/asset remapping.
      await new Promise((resolve) => setTimeout(resolve, 16 - Number(asset_id.split("-").at(-1))));
      return { host_upload: { url: `https://images.test/${asset_id}.png`, mime_type: "image/png", filename: `${asset_id}.png` } };
    },
    outlineImageDescriptions: async (input: { action: string; run_key?: string; sha256s?: string[]; asset_id?: string; description?: string }) => {
      const attempted = attemptedByRun.get(input.run_key!) ?? new Set<string>();
      if (input.action === "mark_attempted") { input.sha256s?.forEach((hash) => attempted.add(hash)); attemptedByRun.set(input.run_key!, attempted); }
      if (input.action !== "describe") return { attempted_sha256: [...attempted] };
      saved.push(input.asset_id!);
      const image = images.find((image) => image.asset_id === input.asset_id)!;
      image.description = input.description!;
      return { image };
    },
    appendWorkspaceLog: async ({ entry }: { entry: unknown }) => { logs.push(entry); },
  } as unknown as PptBackend;
  const agent = await createAgentClient(runtime);
  const runKey = crypto.randomUUID();
  const prepare = (options: Partial<Parameters<typeof prepareSelectedImageDescriptions>[0]> = {}) => prepareSelectedImageDescriptions({
    backend, agent, workspaceDir: "/workspace", locale: "zh", context: research,
    selectedImageIds: images.map((image) => image.asset_id), runKey, ...options,
  });
  return { backend, agent, requests, prepared, saved, logs, prepare, attemptedByRun,
    get sessions() { return sessions; }, get closed() { return closed; } };
}
const success = (input: AnnaAgentSessionRunInput) => ({ descriptions: input.attachments!.map((image, index) => ({
  attachment_index: index + 1, description: `实际画面 ${image.filename}`,
})) });

test("14 张缺描述选图分为 6、6、2 批，跨页重复不重复描述，附件异步完成不串位", async () => {
  const images = Array.from({ length: 14 }, (_, index) => asset(index + 1));
  const h = await harness([...images, asset(15, "已有描述"), asset(16)], success);
  const result = await h.prepare({ selectedImageIds: [...images.map((image) => image.asset_id), images[0].asset_id, "image-15"] });
  assert.deepEqual(h.requests.map((request) => request.attachments!.length), [6, 6, 2]);
  assert.equal(h.sessions, 3); assert.equal(h.closed, 3);
  assert.equal(h.prepared.length, 14); assert.equal(h.saved.length, 14);
  for (const image of result.image_catalog.assets.slice(0, 14)) assert.equal(image.description, `实际画面 ${image.asset_id}.png`);
  assert.equal(result.image_catalog.assets[14].description, "已有描述");
  assert.equal(result.image_catalog.assets[15].description, "");
});

test("未选择和已有描述素材不创建会话，不准备原图", async () => {
  const h = await harness([asset(1, "客观描述"), asset(2)], () => assert.fail("must not describe"));
  await h.prepare({ selectedImageIds: ["image-1"] });
  await h.prepare({ selectedImageIds: [] });
  assert.equal(h.sessions, 0); assert.deepEqual(h.prepared, []);
});

test("单项不可见触发同会话有界重试，保留早先成功描述，耗尽后返回全量选图", async () => {
  const h = await harness([asset(1), asset(2)], (_input, run) => ({ descriptions: [
    run === 1 ? { attachment_index: 1, description: "已看见的第一张" } : { attachment_index: 1, error: "IMAGE_NOT_AVAILABLE" },
    { attachment_index: 2, error: "IMAGE_NOT_AVAILABLE" },
  ] }));
  const result = await h.prepare();
  assert.equal(h.sessions, 1); assert.equal(h.requests.length, 3); assert.equal(h.closed, 1);
  assert.equal(result.image_catalog.assets.length, 2);
  assert.deepEqual(result.image_catalog.assets.map((image) => image.description), ["已看见的第一张", ""]);
  assert.deepEqual(h.saved, ["image-1"]);
  assert.ok(h.logs.length);
  // The persisted run marker survives resume and page retries without restarting the failed item's budget.
  const restoredProgress: unknown[] = [];
  await h.prepare({ onProgress: (value) => restoredProgress.push(value) });
  assert.deepEqual(restoredProgress.at(-1), { completed: 1, total: 1, failed: 1 });
  assert.equal(h.requests.length, 3);
  await h.prepare({ runKey: "run-2" });
  assert.equal(h.requests.length, 6);
});

test("整批基础设施失败用统一新会话预算，后续批次继续，保存失败保留内存成功结果", async () => {
  const images = Array.from({ length: 8 }, (_, index) => asset(index + 1));
  const h = await harness(images, (input) => {
    if (input.attachments?.[0].filename === "image-1.png") throw new Error("session failed https://test/private?signature=secret");
    return success(input);
  });
  const save = h.backend.outlineImageDescriptions;
  h.backend.outlineImageDescriptions = async (input) => { if (input.action === "describe") throw new Error("save failed"); return save(input); };
  const result = await h.prepare();
  assert.equal(h.sessions, 4); assert.equal(h.requests.length, 4);
  assert.deepEqual(result.image_catalog.assets.map((image) => image.description), ["", "", "", "", "", "", "实际画面 image-7.png", "实际画面 image-8.png"]);
  assert.ok(images.every((image) => image.description === ""), "failed auxiliary save must not mutate the input catalog");
  assert.doesNotMatch(JSON.stringify(h.logs), /signature=secret|https:\/\//);
  await h.prepare();
  assert.equal(h.requests.length, 4);
});

test("某张附件准备失败不交换其余附件编号，描述仅写回对应素材", async () => {
  const h = await harness([asset(1), asset(2), asset(3)], success);
  const upload = h.backend.uploadOutlineImageForAgent;
  h.backend.uploadOutlineImageForAgent = async (input) => { if (input.asset_id === "image-2") throw new Error("file unavailable"); return upload(input); };
  const result = await h.prepare();
  assert.deepEqual(h.requests[0].attachments?.map((image) => image.filename), ["image-1.png", "image-3.png"]);
  assert.deepEqual(result.image_catalog.assets.map((image) => image.description), ["实际画面 image-1.png", "", "实际画面 image-3.png"]);
});

test("用户取消传入真实会话并立即停止，不启动修复或后续批次，不保存迟到响应", async () => {
  const controller = new AbortController();
  const h = await harness(Array.from({ length: 8 }, (_, index) => asset(index + 1)), () => {
    controller.abort(); return { descriptions: [] };
  });
  await assert.rejects(h.prepare({ signal: controller.signal }), (error: unknown) => error instanceof AgentRunCancelledError);
  assert.equal(h.sessions, 1); assert.equal(h.requests.length, 1); assert.equal(h.closed, 1); assert.equal(h.saved.length, 0);
  assert.equal(h.prepared.length, 6);
});


test("辅助运行记录保存失败时，同次应用运行仍保留成功描述并避免重复消耗失败预算", async () => {
  const h = await harness([asset(1), asset(2)], () => ({ descriptions: [
    { attachment_index: 1, description: "第一张客观画面" }, { attachment_index: 2, error: "IMAGE_NOT_AVAILABLE" },
  ] }));
  h.backend.outlineImageDescriptions = async () => { throw new Error("persistence offline"); };
  const first = await h.prepare();
  const retried = await h.prepare();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(retried.image_catalog.assets.map((image) => image.description), first.image_catalog.assets.map((image) => image.description));
  assert.equal(retried.image_catalog.assets[0].description, "第一张客观画面");
});
