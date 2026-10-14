import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { parseHTML } from "linkedom";
import { OutlinePageDetails } from "../../src/features/deck-workspace/components/OutlinePageDetails";
import type { OutlineDetail } from "../../src/data/mockDeck";
import { messages } from "../../src/i18n";
import type { OutlineImageAsset } from "../../src/features/outline/images";
import type { PageImageUploadService } from "../../src/features/page-image-upload/service";

for (const locale of ["zh", "en", "ja", "de"] as const) test(`${locale}: 多图上传部分失败可重试，处理中禁止关闭，默认勾选且仅显式保存详情`, async () => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(window.HTMLElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: class { observe() {} disconnect() {} },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const t = messages[locale];
  const asset = (id: string): OutlineImageAsset => ({ asset_id: id, file_path: `/tmp/${id}`, sha256: id, description: "",
    mime_type: "image/png", bytes_size: 5, aspect_ratio: 1, reason: "manual", source_url: `manual-upload://${id}`, matched_queries: [], source: "uploaded", source_filename: id });
  const saved: OutlineDetail[] = [];
  const uploads: string[] = [];
  let failSecond = true;
  let finishFirst!: () => void;
  let first = true;
  let closed = 0;
  const library = [asset("old")];
  const service: PageImageUploadService = {
    upload: async (file) => {
      uploads.push(file.name);
      if (first) { first = false; await new Promise<void>((resolve) => { finishFirst = resolve; }); }
      if (file.name === "second.png" && failSecond) { failSecond = false; throw new Error("offline"); }
      const ready = asset(file.name); library.push(ready); return ready;
    },
  };
  async function click(label: string, within = host) {
    const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
    assert.ok(button, label); await act(async () => button.click());
  }
  async function choose(names: string[]) {
    const input = host.querySelector<HTMLInputElement>('.page-image-upload input[type="file"]')!;
    assert.ok(input);
    await act(async () => Simulate.change(input, { target: { files: names.map((name) => new File(["image"], name, { type: "image/png" })), value: "" } } as never));
  }
  try {
    await act(async () => root.render(createElement(OutlinePageDetails, { t, index: 0,
      outline: [{ title: "当前页", content: "正文", page_type: "standard", selected_image_ids: ["old"] }],
      pageImageSearch: null, imageUpload: service, deckTitle: "演示", globalRequirements: "", loadImages: async () => library,
      images: [asset("old")], imageLoading: false, imageError: false, loadPreview: async () => "", retryImages() {}, onClose() { closed++; },
      onSave: async (item) => { saved.push(item); return true; },
    })));
    assert.equal(host.querySelector(".page-image-search-trigger"), null, "only the shared image manager opens from page details");
    await act(async () => {
      Simulate.change(host.querySelector(".outline-details-title")!, { target: { value: "未保存的新标题" } } as never);
      Simulate.change(host.querySelector(".outline-details-fields > label textarea")!, { target: { value: "未保存的新大纲" } } as never);
    });
    await click(t.outline.addImage);
    assert.ok(host.querySelector(".page-image-context")!.textContent!.includes("未保存的新标题"));
    assert.ok(host.querySelector(".page-image-context")!.textContent!.includes("未保存的新大纲"));
    await choose(["first.png", "second.png"]);
    const picker = host.querySelector(".outline-image-picker")!;
    assert.equal(picker.querySelector<HTMLButtonElement>("header button")!.disabled, true);
    await act(async () => Simulate.cancel(picker));
    await click(t.outline.imageDone, picker);
    assert.ok(host.querySelector(".outline-image-picker"));
    assert.equal(saved.length, 0); assert.equal(closed, 0);
    await act(async () => finishFirst());
    assert.equal(host.querySelectorAll(".outline-selected-image").length, 1, "picker selections stay local until Done");
    assert.equal(host.querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 2);
    assert.ok(host.textContent?.includes(t.pageImageUpload.uploadFailed));
    await click(t.outline.imageRetry, host.querySelector(".page-image-upload")!);
    assert.deepEqual(uploads, ["first.png", "second.png", "second.png"], "retry uploads the failed file only");
    assert.equal(host.querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 3);
    await choose(["first.png"]);
    assert.equal(host.querySelectorAll('.outline-image-select[aria-pressed="true"]').length, 3, "duplicate upload must not duplicate the selection");
    await click(t.outline.imageDone, host.querySelector(".outline-image-picker")!);
    assert.equal(host.querySelectorAll(".outline-selected-image").length, 3);
    assert.equal(saved.length, 0);
    await act(async () => Simulate.submit(host.querySelector(".outline-details-form")!));
    assert.deepEqual(saved[0]?.selected_image_ids, ["old", "first.png", "second.png"]);
    assert.equal(saved[0]?.title, "未保存的新标题");
    assert.equal(saved[0]?.content, "未保存的新大纲");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
