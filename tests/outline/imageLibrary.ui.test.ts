import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { parseHTML } from "linkedom";
import { OutlineImagePicker } from "../../src/features/deck-workspace/components/OutlineImages";
import type { OutlineImageAsset } from "../../src/features/outline/images";
import type { OutlineImageLibraryService } from "../../src/features/outline/imageLibrary";
import type { PageImageUploadService } from "../../src/features/page-image-upload/service";
import { messages, type Locale } from "../../src/i18n";

function candidate(id: string, hash: string, recommendation: "recommended" | "not_recommended" | "not_analysed" = "not_recommended"): OutlineImageAsset {
  return { asset_id: id, file_path: "", sha256: hash.repeat(64), mime_type: "image/png", bytes_size: 100,
    aspect_ratio: null, description: "", reason: "", matched_queries: [], source_url: "", source: "search",
    remote_candidate: { candidate_id: id, aps_path: `aps/${id}`, sha256: hash.repeat(64), mime_type: "image/png",
      bytes_size: 100, image_url: "", source_url: "", source_urls: [], matched_queries: [], description: "",
      use_in_ppt: recommendation === "recommended", recommendation } };
}
function formal(image: OutlineImageAsset, id: string): OutlineImageAsset {
  return { ...image, asset_id: id, file_path: `/workspace/${id}.png`, remote_candidate: undefined };
}

async function mountPicker(input: { assets: OutlineImageAsset[]; library: Pick<OutlineImageLibraryService, "adoptMany">;
  ids?: string[]; locale?: Locale; upload?: PageImageUploadService }) {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(window.HTMLElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true, IntersectionObserver: class { observe() {} disconnect() {} } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const chosen: string[][] = [];
  const saved: OutlineImageAsset[] = [];
  let closed = 0;
  const t = messages[input.locale ?? "zh"];
  function Host() {
    const [ids, setIds] = useState(input.ids ?? []);
    const [open, setOpen] = useState(true);
    return open ? createElement(OutlineImagePicker, { t, pageIndex: 0, outline: [{ title: "Page", content: "Content", selected_image_ids: ids }],
      assets: input.assets, imageLibrary: input.library as OutlineImageLibraryService, imageUpload: input.upload,
      loadPreview: async () => "", onUploaded: (image) => saved.push(image),
      onChange: (next) => { chosen.push(next); setIds(next); }, onClose: () => { closed++; setOpen(false); } }) : null;
  }
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  await act(async () => root.render(createElement(Host)));
  const options = () => [...host.querySelectorAll<HTMLButtonElement>(".outline-image-select")];
  const done = () => host.querySelector<HTMLButtonElement>(".outline-image-picker footer .primary-btn")!;
  let unmounted = false;
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()); } };
  return { host, t, chosen, saved, options, done, unmount, get closed() { return closed; },
    async cleanup() {
      await unmount();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

for (const locale of ["zh", "en", "ja", "de"] as const) test(`${locale}: 勾选立即响应且不下载，完成时统一保存，部分失败仅重试失败图，卡片不展示推荐或来源标签`, async () => {
  const a = candidate("a", "a"); const b = candidate("b", "b", "not_analysed"); const c = candidate("c", "c", "recommended");
  const calls: string[][] = [];
  let finish!: (images: OutlineImageAsset[]) => void;
  const h = await mountPicker({ locale, assets: [a, b, c], upload: { upload: async () => formal(a, "uploaded") }, library: {
    adoptMany: async (images) => { calls.push(images.map((image) => image.candidate_id)); return new Promise((resolve) => { finish = resolve; }); },
  } });
  try {
    const captions = [...h.host.querySelectorAll(".outline-image-caption")];
    assert.equal(captions.length, 3);
    for (const caption of captions) {
      assert.equal(caption.querySelector("strong")!.textContent, h.t.outline.imageUnnamed);
      assert.equal(caption.querySelector("small"), null);
    }
    await act(async () => { h.options()[0].click(); h.options()[1].click(); h.options()[2].click(); h.options()[2].click(); });
    assert.deepEqual(h.options().map((button) => button.getAttribute("aria-pressed")), ["true", "true", "false"]);
    assert.ok(h.options().every((button) => !button.disabled));
    assert.ok(h.host.textContent!.includes(h.t.outline.imageCount.replace("{count}", "2")));
    assert.deepEqual(calls, []); assert.deepEqual(h.chosen, []);
    await act(async () => h.done().click());
    assert.deepEqual(calls, [["a", "b"]]);
    assert.equal(h.done().getAttribute("aria-busy"), "true");
    assert.ok(h.done().querySelector(".spinner"));
    assert.ok(h.done().textContent!.includes(h.t.outline.imagePreparing));
    assert.equal(h.host.querySelector('.outline-image-picker > [role="status"]'), null, "saving feedback stays in the confirmation button");
    assert.ok(h.options().every((button) => button.disabled));
    assert.ok(h.host.querySelector<HTMLButtonElement>("header button")!.disabled);
    assert.ok(h.host.querySelector<HTMLInputElement>('.page-image-upload input[type="file"]')!.disabled);
    await act(async () => { Simulate.cancel(h.host.querySelector(".outline-image-picker")!); Simulate.click(h.done()); });
    assert.equal(h.closed, 0); assert.equal(calls.length, 1);
    await act(async () => finish([formal(a, "formal-a")]));
    assert.deepEqual(h.saved.map((image) => image.asset_id), ["formal-a"]);
    assert.deepEqual(h.chosen, []); assert.equal(h.closed, 0);
    assert.ok(h.host.textContent!.includes(h.t.outline.imageAddFailed));
    assert.equal(h.options()[1].querySelector('[role="alert"]')!.textContent, h.t.outline.imageFileFailed);
    assert.deepEqual(h.options().slice(0, 2).map((button) => button.getAttribute("aria-pressed")), ["true", "true"]);
    await act(async () => h.done().click());
    assert.deepEqual(calls, [["a", "b"], ["b"]], "successful images must not be downloaded again");
    await act(async () => finish([formal(b, "formal-b")]));
    assert.deepEqual(h.chosen, [["formal-a", "formal-b"]], "only formal IDs may leave the picker, in selection order");
    assert.equal(h.closed, 1);
  } finally { await h.cleanup(); }
});

for (const method of ["close", "escape"] as const) test(`${method}: 关闭未完成的选择不下载、不应用选择`, async () => {
  let calls = 0;
  const h = await mountPicker({ assets: [candidate("a", "a")], library: { adoptMany: async () => { calls++; return []; } } });
  try {
    await act(async () => h.options()[0].click());
    await act(async () => method === "close" ? h.host.querySelector<HTMLButtonElement>("header button")!.click()
      : Simulate.cancel(h.host.querySelector(".outline-image-picker")!));
    assert.equal(calls, 0); assert.deepEqual(h.chosen, []); assert.equal(h.closed, 1);
  } finally { await h.cleanup(); }
});

test("取消勾选失败图片后可完成，成功素材保留", async () => {
  const a = candidate("a", "a"); const b = candidate("b", "b");
  let calls = 0;
  const h = await mountPicker({ assets: [a, b], library: { adoptMany: async () => { calls++; return [formal(a, "formal-a")]; } } });
  try {
    await act(async () => { h.options()[0].click(); h.options()[1].click(); });
    await act(async () => h.done().click());
    await act(async () => h.options()[1].click());
    assert.equal(h.host.querySelectorAll('[role="alert"]').length, 0);
    await act(async () => h.done().click());
    assert.equal(calls, 1); assert.deepEqual(h.chosen, [["formal-a"]]); assert.equal(h.closed, 1);
  } finally { await h.cleanup(); }
});

test("上传同内容图片直接替换未保存候选，完成无需再下载", async () => {
  const a = candidate("a", "a");
  let calls = 0;
  const h = await mountPicker({ assets: [a], upload: { upload: async () => formal(a, "uploaded") }, library: { adoptMany: async () => { calls++; return []; } } });
  try {
    await act(async () => h.options()[0].click());
    await act(async () => Simulate.change(h.host.querySelector('.page-image-upload input[type="file"]')!, {
      target: { files: [new File(["image"], "same.png", { type: "image/png" })], value: "" },
    } as never));
    assert.equal(h.options().length, 1); assert.equal(h.options()[0].getAttribute("aria-pressed"), "true");
    await act(async () => h.done().click());
    assert.equal(calls, 0); assert.deepEqual(h.chosen, [["uploaded"]]);
  } finally { await h.cleanup(); }
});

test("已有素材重复上传保留历史已选 ID，完成不下载", async () => {
  const a = formal(candidate("a", "a"), "formal-a");
  let calls = 0;
  const h = await mountPicker({ assets: [{ ...a, asset_aliases: ["legacy"] }], ids: ["legacy"],
    upload: { upload: async () => formal(a, "uploaded") }, library: { adoptMany: async () => { calls++; return []; } } });
  try {
    await act(async () => Simulate.change(h.host.querySelector('.page-image-upload input[type="file"]')!, {
      target: { files: [new File(["image"], "same.png", { type: "image/png" })], value: "" },
    } as never));
    assert.equal(h.options().length, 1); assert.equal(h.options()[0].getAttribute("aria-pressed"), "true");
    await act(async () => h.done().click());
    assert.equal(calls, 0); assert.deepEqual(h.chosen, [["legacy"]]);
  } finally { await h.cleanup(); }
});

test("保存期间离开页面，迟到结果不更新编辑或关闭新页面", async () => {
  const a = candidate("a", "a");
  let finish!: (images: OutlineImageAsset[]) => void;
  const h = await mountPicker({ assets: [a], library: { adoptMany: async () => new Promise((resolve) => { finish = resolve; }) } });
  try {
    await act(async () => h.options()[0].click());
    await act(async () => h.done().click());
    await h.unmount();
    await act(async () => finish([formal(a, "formal-a")]));
    assert.deepEqual(h.saved, []); assert.deepEqual(h.chosen, []); assert.equal(h.closed, 0);
  } finally { await h.cleanup(); }
});
