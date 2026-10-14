import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { parseHTML } from "linkedom";
import type { PageRegenerationModel } from "../../src/features/page-regeneration/usePageRegeneration";
import type { WorkspaceOutlineItem } from "../../src/api/types";
import { messages } from "../../src/i18n";

const hooks = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith(".css")) return { format: "module", source: "export {};", shortCircuit: true };
  return nextLoad(url, context);
} });
const { PageRegenerationSetupPage } = await import("../../src/features/page-regeneration/PageRegeneration");
hooks.deregister();

test("单页候选使用新上传配图，但上传和开始生成均不修改正式大纲", async () => {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(window.HTMLElement.prototype, { showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true, IntersectionObserver: class { observe() {} disconnect() {} } })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  const host = document.getElementById("root")!;
  const official: WorkspaceOutlineItem = { page_id: "page-1", page_type: "standard", title: "原页", content: "原正文", selected_image_ids: [] };
  let generated: WorkspaceOutlineItem | undefined;
  let uploads = 0;
  let adopted = 0;
  const image = { asset_id: "manual", file_path: "/tmp/image.png", sha256: "hash", mime_type: "image/png", bytes_size: 5,
    aspect_ratio: 1, description: "", reason: "manual", matched_queries: [], source_url: "manual-upload://hash", source: "uploaded" as const };
  const model = { text: messages.zh.pageRegeneration, mode: "regenerate", outline: official, outlineItems: [official],
    deckTitle: "演示", globalRequirements: "", busy: false, error: "", detail: "", pageImageSearch: null,
    loadImages: async () => [], loadImagePreview: async () => "", close() {}, adopt() { adopted++; },
    start: async (_count: number, edited: WorkspaceOutlineItem) => { generated = edited; },
    pageImageUpload: { upload: async () => { uploads++; return image; } },
  } as unknown as PageRegenerationModel;
  async function click(label: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label);
    assert.ok(button, label); await act(async () => button.click());
  }
  try {
    await act(async () => root.render(createElement(PageRegenerationSetupPage, { model, t: messages.zh })));
    assert.equal(host.querySelector(".page-image-search-trigger"), null);
    await act(async () => {
      Simulate.change(host.querySelector('.alternatives-fields input')!, { target: { value: "未保存的新标题" } } as never);
      Simulate.change(host.querySelector('.alternatives-outline-input')!, { target: { value: "未保存的新大纲" } } as never);
    });
    await click(messages.zh.outline.addImage);
    assert.ok(host.querySelector(".page-image-context")!.textContent!.includes("未保存的新标题"));
    assert.ok(host.querySelector(".page-image-context")!.textContent!.includes("未保存的新大纲"));
    await act(async () => Simulate.change(host.querySelector('.page-image-upload input[type="file"]')!, {
      target: { files: [new File(["image"], "image.png", { type: "image/png" })], value: "" },
    } as never));
    assert.equal(uploads, 1); assert.equal(adopted, 0); assert.equal(generated, undefined);
    await click(messages.zh.outline.imageDone);
    await act(async () => Simulate.submit(host.querySelector(".alternatives-content")!));
    assert.deepEqual(generated?.selected_image_ids, ["manual"]);
    assert.equal(generated?.title, "未保存的新标题");
    assert.equal(generated?.content, "未保存的新大纲");
    assert.deepEqual(official.selected_image_ids, []); assert.equal(adopted, 0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
