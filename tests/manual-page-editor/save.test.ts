import assert from "node:assert/strict";
import test from "node:test";
import type { SaveManualPageRevisionInput, SaveManualPageRevisionResult } from "../../src/api/types";
import { persistManualPageDraft, saveManualPageDrafts, type ManualPageDraft } from "../../src/features/manual-page-editor/manualPageSave";

const input: SaveManualPageRevisionInput = {
  workspace_dir: "/workspace", page_id: "page-a", base_revision: 1,
  html: '<html><img src="file:///workspace/page-assets/a.png">修改后的文字</html>', save_source: "shortcut",
};
const saved = { manifest: { revision: 3 } } as SaveManualPageRevisionResult;
const draft = (): ManualPageDraft => ({ html: input.html, baseline: "原文", baseRevision: 1 });

test("当前页与跨页草稿均向适配器传递本地 HTML 和原始保存来源", async () => {
  const calls: SaveManualPageRevisionInput[] = [];
  const result = await persistManualPageDraft({ saveManualPageRevision: async (args) => {
    calls.push(args); return saved;
  } }, input, "原文", async () => { throw new Error("不应刷新"); });
  assert.equal(result, saved);
  assert.deepEqual(calls, [input]);
  assert.equal("host_upload" in calls[0], false);
});

test("只有修订号变化、服务端正文不变时才重试一次", async () => {
  const calls: SaveManualPageRevisionInput[] = [];
  await persistManualPageDraft({ saveManualPageRevision: async (args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error("revision conflict");
    return saved;
  } }, input, "原文", async () => ({ html: "原文", revision: 2 }));
  assert.deepEqual(calls, [input, { ...input, base_revision: 2 }]);
});

test("真实内容冲突和再次点击保存均不能覆盖服务器新内容", async () => {
  const calls: SaveManualPageRevisionInput[] = [];
  const backend = { saveManualPageRevision: async (args: SaveManualPageRevisionInput) => {
    calls.push(args); throw new Error("revision conflict");
  } };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(persistManualPageDraft(backend, input, "原文", async () => ({ html: "其他操作保存的新内容", revision: 2 })), /revision conflict/);
  }
  assert.deepEqual(calls.map((call) => call.base_revision), [1, 1]);
});

test("传输失败不刷新修订号；二次冲突不无限重试", async () => {
  await assert.rejects(persistManualPageDraft({ saveManualPageRevision: async () => { throw new Error("network failed"); } }, input, "原文", async () => { throw new Error("不应刷新"); }), /network failed/);
  let calls = 0;
  await assert.rejects(persistManualPageDraft({ saveManualPageRevision: async () => {
    calls++; throw new Error("revision conflict");
  } }, input, "原文", async () => ({ html: "原文", revision: 2 })), /revision conflict/);
  assert.equal(calls, 2);
});

test("逐页保存中途失败保留失败及未处理草稿，重试不重复保存成功页", async () => {
  const drafts = new Map([['a', draft()], ['b', draft()], ['c', draft()]]);
  const calls: string[] = [];
  const remaining: number[] = [];
  await assert.rejects(saveManualPageDrafts(drafts, async (id) => {
    calls.push(id); if (id === 'b') throw new Error("network failed");
  }, () => remaining.push(drafts.size)), /network failed/);
  assert.deepEqual([...drafts.keys()], ['b', 'c']);
  await saveManualPageDrafts(drafts, async (id) => { calls.push(id); }, () => remaining.push(drafts.size));
  assert.deepEqual(calls, ['a', 'b', 'b', 'c']);
  assert.deepEqual(remaining, [2, 1, 0]);
});

test("保存中的新草稿不会被旧请求清除，尚未开始的旧草稿不会提交", async () => {
  const drafts = new Map([['a', draft()], ['b', draft()]]);
  const newerA = { ...draft(), html: "保存过程中新增的文字" };
  const newerB = { ...draft(), html: "新页面内容" };
  const calls: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const saving = saveManualPageDrafts(drafts, async (id) => { calls.push(id); await barrier; }, () => {});
  assert.deepEqual(calls, ['a']);
  drafts.set('a', newerA); drafts.set('b', newerB);
  release(); await saving;
  assert.deepEqual(calls, ['a']);
  assert.equal(drafts.get('a'), newerA);
  assert.equal(drafts.get('b'), newerB);
});
