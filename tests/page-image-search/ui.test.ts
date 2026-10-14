import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { parseHTML } from "linkedom";
import { OutlineImagePicker } from "../../src/features/deck-workspace/components/OutlineImages";
import { messages, type Locale } from "../../src/i18n/messages";
import type { PageImageSearchInput, PageImageSearchService } from "../../src/features/page-image-search/service";
import type { PageImageSearchResult, PageImageSearchTask } from "../../src/api/pageImageSearchTypes";
import type { ImageCandidateReference } from "../../src/api/types";
import type { OutlineImageLibraryService } from "../../src/features/outline/imageLibrary";
import type { OutlineImageAsset } from "../../src/features/outline/images";

const page = { title: "未保存的新标题", content: "未保存的大纲正文\n第二段正文", creation_requirements: "图片要展示实物" };
function result(id: string, hash: string): PageImageSearchResult {
  return { result_id: id, title: id, query: "桥", image_url: `https://image.test/${id}.jpg`, source_url: `https://source.test/${id}`,
    final_url: `https://source.test/${id}`, aps_path: `aps/${id}`, get_url: `https://aps.test/${id}.jpg`, mime_type: "image/jpeg",
    bytes_size: 10, sha256: hash.repeat(64) };
}
function formal(candidate: ImageCandidateReference): OutlineImageAsset {
  return { ...candidate, asset_id: `formal-${candidate.candidate_id}`, file_path: `/workspace/${candidate.candidate_id}.jpg`,
    reason: "", aspect_ratio: 1, source: "search" };
}
function candidate(id: string, hash: string): ImageCandidateReference {
  return { ...result(id, hash), candidate_id: id, title: id, source_urls: [], matched_queries: [], description: "",
    use_in_ppt: false, recommendation: "not_analysed" };
}
function existing(id: string, hash: string): OutlineImageAsset {
  return { ...formal(candidate(id, hash)), asset_id: id, source: "uploaded" };
}
function task(input: PageImageSearchInput, results: PageImageSearchResult[], status: PageImageSearchTask["status"] = "completed"): PageImageSearchTask {
  return { id: crypto.randomUUID(), context: { ...input, target_key: "draft", requirements: {} as never }, status, max_searches: 1,
    checkpoint: { schema_version: 2, stages: {}, image: { searches: [] } }, result_ids: results.map((image) => image.result_id),
    results, updated_at: new Date().toISOString() };
}
function service(run: PageImageSearchService["run"]): PageImageSearchService {
  return { run, preview: async (image) => image.get_url, cancel() {}, isRunning: () => false,
    load: async () => { throw new Error("Opening must not load old tasks"); },
    add: async () => { throw new Error("Only the shared confirmation may adopt images"); } };
}
async function mount(input: { locale?: Locale; service: PageImageSearchService; assets?: OutlineImageAsset[]; ids?: string[];
  library?: Pick<OutlineImageLibraryService, "adoptMany"> }) {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(window.HTMLElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true, IntersectionObserver: class { observe() {} disconnect() {} } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = document.getElementById("root")!; const root = createRoot(host);
  const t = messages[input.locale ?? "zh"]; const chosen: string[][] = []; const saved: OutlineImageAsset[] = []; let closed = 0;
  let setAssets!: (images: OutlineImageAsset[]) => void;
  function Host() {
    const [open, setOpen] = useState(true);
    const [assets, updateAssets] = useState(input.assets ?? []); setAssets = updateAssets;
    return open ? createElement(OutlineImagePicker, { t, pageIndex: 1,
      outline: [{ title: "第一页", content: "正文" }, { ...page, selected_image_ids: input.ids ?? [] }],
      deckTitle: "演示标题", globalRequirements: "全局要求", pageImageSearch: input.service,
      assets, loadPreview: async () => "data:image/webp;base64,LOCAL",
      imageLibrary: (input.library ?? { adoptMany: async (images) => images.map(formal) }) as OutlineImageLibraryService,
      onUploaded: (image) => saved.push(image), onChange: (ids) => chosen.push(ids), onClose: () => { closed++; setOpen(false); } }) : null;
  }
  await act(async () => root.render(createElement(Host)));
  const panel = (name: "library" | "search") => host.querySelector<HTMLElement>(`[id$="-${name}-panel"]`)!;
  const done = () => host.querySelector<HTMLButtonElement>(".page-image-manager-actions .primary-btn")!;
  async function click(label: string, within: HTMLElement = host) {
    const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
    assert.ok(button, label); await act(async () => button.click());
  }
  async function search(query: string) {
    const field = panel("search").querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { field.value = query; Simulate.change(field); });
    await act(async () => panel("search").querySelector<HTMLButtonElement>(".page-image-search-actions .primary-btn")!.click());
  }
  async function toggle(label: string, name: "library" | "search" = "search") {
    const button = [...panel(name).querySelectorAll<HTMLButtonElement>(".outline-image-select")].find((node) => node.querySelector("strong")?.textContent === label);
    assert.ok(button, label); await act(async () => button.click());
  }
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  return { host, t, chosen, saved, panel, done, click, search, toggle, unmount, setAssets: async (images: OutlineImageAsset[]) => { await act(async () => setAssets(images)); }, get closed() { return closed; },
    async cleanup() {
      await unmount();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

for (const locale of ["zh", "en", "ja", "de"] as const) for (const outcome of ["all", "partial", "none"] as const) {
  test(`${locale}: 跨素材和两轮搜索保留选择、去重，统一确认 ${outcome}，仅重试失败图`, async () => {
    const received: PageImageSearchInput[] = []; const calls: string[][] = []; let finish!: (images: OutlineImageAsset[]) => void;
    const h = await mount({ locale, assets: [existing("old", "a"), existing("saved", "b")], ids: ["old"],
      service: service(async (input, previous, onChange) => {
        assert.equal(previous, null); received.push(input);
        const next = task(input, received.length === 1 ? [result("same-old", "a"), result("one", "c"), result("two", "d")]
          : [result("same-one", "c"), result("three", "e")]); onChange(next); return next;
      }), library: { adoptMany: async (images) => { calls.push(images.map((image) => image.candidate_id)); return new Promise((resolve) => { finish = resolve; }); } } });
    try {
      assert.ok(h.host.textContent!.includes(h.t.outline.imagePageNumber.replace("{page}", "2")));
      for (const text of Object.values(page)) assert.ok(h.host.querySelector(".page-image-context")!.textContent!.includes(text));
      assert.equal(h.panel("library").hidden, false); assert.equal(h.panel("search").hidden, true);
      await h.toggle("saved", "library"); await h.click(h.t.outline.imageSearchTab); await h.search("桥上灯光");
      assert.equal(received[0].page.title, page.title); assert.equal(received[0].page.content, page.content);
      assert.equal(received[0].page.creation_requirements, page.creation_requirements);
      assert.equal(h.panel("search").querySelector('.outline-image-select[aria-pressed="true"] strong')!.textContent, "old");
      await h.toggle("one"); await h.toggle("two"); await h.search("海边日落");
      assert.equal(h.host.querySelectorAll(".page-image-selected-card").length, 4);
      assert.equal(h.panel("search").querySelector('.outline-image-select[aria-pressed="true"] strong')!.textContent, "same-one");
      await h.toggle("three"); await h.click("桥上灯光", h.panel("search"));
      assert.equal(h.panel("search").querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 3);
      await h.click(h.t.outline.imageLibraryTab);
      assert.equal(h.panel("library").querySelectorAll(".outline-image-option").length, 5);
      assert.equal(h.host.querySelectorAll(".page-image-selected-card").length, 5);
      assert.deepEqual(calls, []); assert.deepEqual(h.chosen, []);
      await act(async () => h.done().click());
      assert.deepEqual(calls, [["same-one", "two", "three"]]);
      assert.equal(h.done().getAttribute("aria-busy"), "true"); assert.equal(h.done().textContent, h.t.outline.imagePreparing);
      assert.ok(h.done().querySelector(".spinner")); assert.equal(h.host.querySelectorAll(".process-timeline").length, 1);
      assert.ok(h.host.querySelector<HTMLButtonElement>("header button")!.disabled);
      assert.ok([...h.host.querySelectorAll<HTMLButtonElement>('.page-image-selected-card .outline-image-remove, [role="tab"]')].every((node) => node.disabled));
      await act(async () => { Simulate.cancel(h.host.querySelector(".outline-image-picker")!); h.done().click(); });
      assert.equal(h.closed, 0); assert.equal(calls.length, 1);
      const pending = [candidate("same-one", "c"), candidate("two", "d"), candidate("three", "e")];
      await act(async () => finish(outcome === "all" ? pending.map(formal) : outcome === "partial" ? pending.slice(0, 1).map(formal) : []));
      if (outcome !== "all") {
        assert.equal(h.closed, 0); assert.deepEqual(h.chosen, []); assert.ok(h.host.textContent!.includes(h.t.outline.imageAddFailed));
        assert.equal(h.host.querySelectorAll(".page-image-selected-card").length, 5); assert.equal(h.done().getAttribute("aria-busy"), null);
        await act(async () => h.done().click());
        assert.deepEqual(calls[1], outcome === "partial" ? ["two", "three"] : ["same-one", "two", "three"]);
        await act(async () => finish((outcome === "partial" ? pending.slice(1) : pending).map(formal)));
      }
      assert.deepEqual(h.chosen, [["old", "saved", "formal-same-one", "formal-two", "formal-three"]]);
      assert.equal(h.closed, 1); assert.equal(h.host.querySelector(".outline-image-picker"), null);
    } finally { await h.cleanup(); }
  });
}
for (const method of ["cancel", "escape", "close"] as const) test(`${method}: 搜索后关闭不下载也不应用选择`, async () => {
  let adopted = 0;
  const h = await mount({ service: service(async (input) => task(input, [result("one", "c")])),
    library: { adoptMany: async () => { adopted++; return []; } } });
  try {
    await h.click(h.t.outline.imageSearchTab); await h.search("桥"); await h.toggle("one");
    if (method === "escape") await act(async () => Simulate.cancel(h.host.querySelector(".outline-image-picker")!));
    else await h.click(method === "close" ? h.t.outline.imageClose : h.t.controls.cancel);
    assert.equal(adopted, 0); assert.deepEqual(h.chosen, []); assert.equal(h.closed, 1);
  } finally { await h.cleanup(); }
});
test("搜索和取消收尾期间禁止关闭，切换标签保留运行和关键词，取消保留成功候选", async () => {
  let finish!: (next: PageImageSearchTask) => void; let publish!: (next: PageImageSearchTask) => void; let active!: PageImageSearchTask;
  const cancelled: string[] = [];
  const api = service(async (input, _previous, onChange) => {
    active = task(input, [], "running"); publish = onChange; onChange(active); return new Promise((resolve) => { finish = resolve; });
  });
  api.cancel = (id) => { cancelled.push(id!); active = { ...active, status: "cancelled", results: [result("one", "c")], result_ids: ["one"] }; publish(active); };
  const h = await mount({ service: api, assets: [existing("old", "a")], ids: ["old"] });
  try {
    await h.click(h.t.outline.imageSearchTab); await h.search("桥");
    assert.ok(h.done().disabled); assert.ok(h.host.querySelector<HTMLButtonElement>("header button")!.disabled);
    await act(async () => Simulate.cancel(h.host.querySelector(".outline-image-picker")!)); assert.equal(h.closed, 0);
    await h.click(h.t.outline.imageLibraryTab); await h.toggle("old", "library");
    assert.equal(h.host.querySelectorAll(".page-image-selected-card").length, 1);
    await h.click(h.t.outline.imageSearchTab); assert.equal(h.panel("search").querySelector<HTMLTextAreaElement>("textarea")!.value, "桥");
    await h.click(h.t.pageImageSearch.cancel); assert.deepEqual(cancelled, [active.id]); assert.ok(h.done().disabled);
    await act(async () => finish(active)); assert.ok(!h.done().disabled);
    assert.equal(h.panel("search").querySelectorAll(".outline-image-select").length, 1);
    await h.toggle("one"); await act(async () => h.done().click()); assert.deepEqual(h.chosen, [["old", "formal-one"]]);
  } finally { await h.cleanup(); }
});
test("搜索图片复用大图预览，关闭大图回到配图窗口", async () => {
  const previews: string[] = []; const api = service(async (input) => task(input, [result("one", "c")]));
  api.preview = async (image) => { previews.push(image.result_id); return image.get_url; };
  const h = await mount({ service: api });
  try {
    await h.click(h.t.outline.imageSearchTab); await h.search("桥");
    await act(async () => h.panel("search").querySelector<HTMLButtonElement>(".outline-image-thumbnail")!.click());
    assert.deepEqual(previews, ["one"]); assert.equal(h.host.querySelector<HTMLImageElement>(".outline-image-preview img")!.src, "https://aps.test/one.jpg");
    await act(async () => Simulate.cancel(h.host.querySelector(".outline-image-preview")!));
    assert.equal(h.host.querySelector(".outline-image-preview"), null); assert.ok(h.host.querySelector(".outline-image-picker")); assert.equal(h.closed, 0);
  } finally { await h.cleanup(); }
});
test("离开页面取消本窗口搜索，迟到结果不应用到新页面", async () => {
  let finish!: (next: PageImageSearchTask) => void; let active!: PageImageSearchTask; const cancelled: string[] = [];
  const api = service(async (input, _previous, onChange) => {
    active = task(input, [], "running"); onChange(active); return new Promise((resolve) => { finish = resolve; });
  });
  api.cancel = (id) => { cancelled.push(id!); };
  const h = await mount({ service: api });
  try {
    await h.click(h.t.outline.imageSearchTab); await h.search("桥"); await h.unmount(); assert.deepEqual(cancelled, [active.id]);
    await act(async () => finish({ ...active, status: "completed", results: [result("one", "c")] }));
    assert.deepEqual(h.chosen, []); assert.deepEqual(h.saved, []); assert.equal(h.closed, 0);
  } finally { await h.cleanup(); }
});

test("素材库迟到的同内容正式图片替代本窗口新选候选，确认输出正式标识且无需下载", async () => {
  let adopted = 0;
  const h = await mount({ service: service(async (input) => task(input, [result("one", "c")])),
    library: { adoptMany: async () => { adopted++; return []; } } });
  try {
    await h.click(h.t.outline.imageSearchTab); await h.search("桥"); await h.toggle("one");
    await h.setAssets([existing("uploaded", "c")]);
    assert.equal(h.host.querySelectorAll(".page-image-selected-card").length, 1);
    await act(async () => h.done().click());
    assert.equal(adopted, 0); assert.deepEqual(h.chosen, [["uploaded"]]);
  } finally { await h.cleanup(); }
});

test("超过最近五轮后仍保留早期已选图片，移除已选图片同步取消素材与搜索结果勾选", async () => {
  let searches = 0;
  const h = await mount({ service: service(async (input) => task(input, [result(`image-${++searches}`, String(searches))])) });
  try {
    await h.click(h.t.outline.imageSearchTab); await h.search("搜索 1"); await h.toggle("image-1");
    for (let index = 2; index <= 6; index++) await h.search(`搜索 ${index}`);
    assert.equal(h.panel("search").querySelectorAll(".page-image-search-history button").length, 5);
    assert.equal(h.host.querySelectorAll(".page-image-selected-card").length, 1);
    await h.click(h.t.outline.imageLibraryTab);
    assert.equal(h.panel("library").querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 1);
    await act(async () => h.host.querySelector<HTMLButtonElement>(".page-image-selected-card .outline-image-remove")!.click());
    assert.equal(h.panel("library").querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 0);
    await h.toggle("image-6", "library"); await h.click(h.t.outline.imageSearchTab);
    assert.equal(h.panel("search").querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 1);
    await act(async () => h.host.querySelector<HTMLButtonElement>(".page-image-selected-card .outline-image-remove")!.click());
    assert.equal(h.panel("search").querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 0);
    await act(async () => h.done().click()); assert.deepEqual(h.chosen, [[]]);
  } finally { await h.cleanup(); }
});
