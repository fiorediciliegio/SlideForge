import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { parseHTML } from "linkedom";
import { OutlinePage } from "../../src/features/deck-workspace/components/OutlinePage.tsx";
import { cloneOutlineItems, type EditableOutline } from "../../src/features/outline/model.ts";
import type { OutlineImageAsset } from "../../src/features/outline/images.ts";
import { messages, type Locale } from "../../src/i18n/messages.ts";

const initial: EditableOutline = {
  title: "原演示标题",
  global_creation_requirements: "每页图片至少占 80%",
  items: [
    { title: "第一页", content: "正文一", page_type: "cover", selected_image_ids: ["image-1"] },
    { title: "第二页", content: "正文二", page_type: "standard", selected_image_ids: ["image-2"] },
    { title: "第三页", content: "正文三", page_type: "standard", selected_image_ids: [] },
  ],
};
const proposed: EditableOutline = { title: "AI 新标题", global_creation_requirements: "文案一字不改", items: [{ ...initial.items[1]!, title: "AI 新页面" }] };

async function withReview(locale: Locale, run: (context: {
  host: HTMLElement;
  click: (selector: string) => Promise<void>;
  event: (selector: string, type: string, fields?: Record<string, unknown>) => Promise<void>;
  change: (selector: string, value: string) => Promise<void>;
  saves: EditableOutline[];
  snapshot: () => EditableOutline;
  setSaveSuccess: (value: boolean) => void;
  setGenerate: (generate: () => Promise<EditableOutline | undefined>) => void;
  switchWorkspace: () => Promise<void>;
}) => Promise<void>, options: {
  outline?: EditableOutline;
  assets?: OutlineImageAsset[];
  preview?: ComponentProps<typeof OutlinePage>["loadImagePreview"];
  imageLibrary?: ComponentProps<typeof OutlinePage>["imageLibrary"];
} = {}) {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(window.HTMLElement.prototype, {
    showModal() { this.setAttribute("open", ""); },
    close() { this.removeAttribute("open"); },
    scrollIntoView() {},
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    IntersectionObserver: class { observe() {} disconnect() {} },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const saves: EditableOutline[] = [];
  const reviewInitial = options.outline ?? initial;
  let current = reviewInitial;
  let saveSuccess = true;
  let generate = async (): Promise<EditableOutline | undefined> => structuredClone(proposed);
  const t = messages[locale];
  const loadImages = async () => options.assets ?? [];
  const loadImagePreview = options.preview ?? (async () => "");
  function Harness({ workspaceKey }: { workspaceKey: string }) {
    const [outline, setOutline] = useState(() => cloneOutlineItems(reviewInitial.items));
    const [title, setTitle] = useState(reviewInitial.title);
    const [globalRequirements, setGlobalRequirements] = useState(reviewInitial.global_creation_requirements ?? "");
    const [feedback, setFeedback] = useState("");
    const [saving, setSaving] = useState(false);
    current = { title, global_creation_requirements: globalRequirements, items: outline };
    const props: ComponentProps<typeof OutlinePage> = {
      pageImageSearch: null, imageLibrary: options.imageLibrary, workspaceKey, t, outline, title, setTitle, globalRequirements, setGlobalRequirements, replaceItems: setOutline, feedback, setFeedback,
      dirty: true, saving, loading: saving ? "outline" : "none", error: "", loadImages, loadImagePreview,
      save: async (value = current) => {
        saves.push(structuredClone(value));
        setSaving(true);
        await Promise.resolve();
        if (saveSuccess) { setOutline(cloneOutlineItems(value.items)); setTitle(value.title); setGlobalRequirements(value.global_creation_requirements ?? ""); }
        setSaving(false);
        return saveSuccess;
      },
      applyFeedback: () => generate(), retry: async () => {},
      confirm: async () => {}, backToRequirements: () => {},
    };
    return createElement(OutlinePage, props);
  }
  async function click(selector: string) {
    const button = host.querySelector<HTMLButtonElement>(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  }
  try {
    await act(async () => root.render(createElement(Harness, { workspaceKey: "workspace-1" })));
    await run({ host, click, saves, snapshot: () => current, setSaveSuccess: (value) => { saveSuccess = value; },
      setGenerate: (value) => { generate = value; },
      switchWorkspace: async () => { await act(async () => root.render(createElement(Harness, { workspaceKey: "workspace-2" }))); },
      event: async (selector, type, fields = {}) => {
        const element = host.querySelector(selector);
        assert.ok(element, selector);
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, fields);
        await act(async () => {
          if (type === "keydown" && element.tagName === "TEXTAREA") Simulate.keyDown(element, { ...fields, nativeEvent: event } as never);
          else element.dispatchEvent(event);
        });
      },
      change: async (selector, value) => {
        const input = host.querySelector<HTMLInputElement>(selector);
        assert.ok(input, selector);
        await act(async () => {
          if (input.tagName === "SELECT") Simulate.change(input, { target: { value } } as never);
          else { input.value = value; Simulate.change(input); }
        });
      },
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const cardImages: OutlineImageAsset[] = Array.from({ length: 5 }, (_, index) => ({
  asset_id: `image-${index + 1}`, file_path: `/workspace/image-${index + 1}.png`,
  sha256: String(index + 1).repeat(64), mime_type: "image/png", bytes_size: 100,
  aspect_ratio: 1.5, title: `配图 ${index + 1}`, description: "", reason: "",
  matched_queries: [], source_url: "", source: "uploaded",
}));

for (const locale of ["zh", "en", "ja", "de"] as const) {
  test(`${locale}: card image selection opens directly and updates only the draft until explicitly saved`, async () => {
    const t = messages[locale];
    await withReview(locale, async ({ host, click, change, event, snapshot, saves }) => {
      await change(".outline-global-requirements textarea", "保留未保存的创作要求");
      await event("[data-outline-page='2'] .outline-drag-handle", "keydown", { key: "ArrowUp" });
      const add = host.querySelector("[data-outline-page='1'] .outline-card-image-add")!;
      assert.equal(add.getAttribute("aria-label"), t.outlineReview.managePageImages.replace("{page}", "2"));
      await click("[data-outline-page='1'] .outline-card-image-add");
      assert.equal(host.querySelector(".outline-details"), null, "the card opens the picker without the drawer");
      assert.ok(host.querySelector(".page-image-context")!.textContent.includes("第三页"));
      assert.ok(host.querySelector(".page-image-context")!.textContent.includes("正文三"));
      await click(".outline-image-option:nth-child(3) .outline-image-select");
      assert.deepEqual(snapshot().items[1]!.selected_image_ids, [], "picker choices stay local until confirmation");
      await click(".outline-image-picker footer .primary-btn");
      assert.equal(host.querySelector(".outline-image-picker"), null);
      assert.deepEqual(snapshot().items[1]!.selected_image_ids, ["image-3"]);
      assert.equal(snapshot().global_creation_requirements, "保留未保存的创作要求");
      assert.deepEqual(snapshot().items.map((item) => item.title), ["第一页", "第三页", "第二页"]);
      assert.deepEqual(snapshot().items[0]!.selected_image_ids, ["image-1"]);
      assert.deepEqual(snapshot().items[2]!.selected_image_ids, ["image-2"]);
      assert.equal(host.querySelectorAll("[data-outline-page='1'] .outline-card-image").length, 1);
      assert.equal(saves.length, 0, "confirming images must not implicitly save the outline");
      await click("[data-performance-id='outline.save']");
      assert.deepEqual(saves[0]!.items[1]!.selected_image_ids, ["image-3"]);
      assert.equal(saves[0]!.global_creation_requirements, "保留未保存的创作要求");
    }, { assets: cardImages });
  });
}

for (const dismissal of ["cancel", "escape"] as const) {
  test(`${dismissal}: cancelling card image selection retains every assignment including images beyond the three previews`, async () => {
    const fiveImages: EditableOutline = { ...initial, items: cloneOutlineItems(initial.items) };
    fiveImages.items[0]!.selected_image_ids = cardImages.map((image) => image.asset_id);
    await withReview("zh", async ({ host, click, event, snapshot, saves, switchWorkspace }) => {
      const card = host.querySelector("[data-outline-page='0']")!;
      assert.equal(card.querySelectorAll(".outline-card-image").length, 3);
      assert.equal(card.querySelector(".outline-card-image-overflow")!.textContent, "+2");
      assert.equal(card.querySelector(".outline-card-images")!.getAttribute("aria-label"), "本页图片 · 5 张图片");
      await click("[data-outline-page='0'] .outline-card-image-add");
      assert.equal(host.querySelectorAll(".page-image-selected-card").length, 5);
      await click(".page-image-selected-card .outline-image-remove");
      if (dismissal === "cancel") await click(".outline-image-picker footer .secondary-btn");
      else await event(".outline-image-picker", "cancel");
      assert.deepEqual(snapshot().items[0]!.selected_image_ids, fiveImages.items[0]!.selected_image_ids);
      await click("[data-outline-page='0'] .outline-card-image-add");
      assert.equal(host.querySelectorAll(".page-image-selected-card").length, 5);
      await click(".outline-image-picker footer .primary-btn");
      assert.deepEqual(snapshot().items[0]!.selected_image_ids, fiveImages.items[0]!.selected_image_ids, "confirmation must not truncate to three images");
      assert.equal(saves.length, 0);
      await click("[data-outline-page='0'] .outline-card-image-add");
      await switchWorkspace();
      assert.equal(host.querySelector(".outline-image-picker"), null);
    }, { outline: fiveImages, assets: cardImages });
  });
}

test("card thumbnails open the original image preview without opening page details or changing assignments", async () => {
  const previews: Array<[string, string | undefined]> = [];
  await withReview("zh", async ({ host, click, event, snapshot, saves }) => {
    await click("[data-outline-page='0'] .outline-card-image .outline-image-thumbnail");
    assert.equal(host.querySelector(".outline-details"), null);
    assert.equal(host.querySelector(".outline-image-picker"), null);
    assert.ok(host.querySelector(".outline-image-preview"));
    assert.deepEqual(previews, [["image-1", "large"]]);
    await event(".outline-image-preview", "cancel");
    assert.equal(host.querySelector(".outline-image-preview"), null);
    assert.deepEqual(snapshot().items[0]!.selected_image_ids, ["image-1"]);
    assert.equal(saves.length, 0);
  }, { assets: cardImages, preview: async (id, size) => { previews.push([id, size]); return "data:image/png;base64,cHJldmlldw=="; } });
});

test("adopting a candidate from a card immediately displays the saved image while its catalog refreshes", async () => {
  const ready = cardImages[2]!;
  const candidate: OutlineImageAsset = { ...ready, asset_id: "candidate-3", file_path: "", source: "search",
    remote_candidate: { candidate_id: "candidate-3", aps_path: "aps/image-3", sha256: ready.sha256,
      mime_type: ready.mime_type, bytes_size: ready.bytes_size, image_url: "", source_url: "", source_urls: [],
      matched_queries: [], description: "", use_in_ppt: false, recommendation: "not_analysed" } };
  const assets = [cardImages[0]!, cardImages[1]!, candidate];
  let adoptions = 0;
  await withReview("zh", async ({ host, click, snapshot, saves }) => {
    await click("[data-outline-page='2'] .outline-card-image-add");
    await click(".outline-image-option:nth-child(3) .outline-image-select");
    await click(".outline-image-picker footer .primary-btn");
    assert.equal(adoptions, 1);
    assert.deepEqual(snapshot().items[2]!.selected_image_ids, [ready.asset_id]);
    assert.ok(host.querySelector("[data-outline-page='2'] .outline-image-thumbnail"), "the newly adopted image remains visible even if the catalog still returns its remote candidate");
    assert.equal(host.querySelector("[data-outline-page='2'] .outline-card-image-placeholder"), null);
    await click("[data-outline-page='2'] .outline-card-image-add");
    await click(".outline-image-picker footer .primary-btn");
    assert.equal(adoptions, 1, "reopening the picker must reuse the saved image");
    assert.deepEqual(snapshot().items[2]!.selected_image_ids, [ready.asset_id]);
    assert.equal(saves.length, 0);
  }, { assets, imageLibrary: { load: async () => assets, preview: async () => "", adopt: async () => ready,
    adoptMany: async (images) => {
      adoptions++;
      assert.deepEqual(images.map((image) => image.candidate_id), [candidate.asset_id]);
      return [ready];
    } } });
});

for (const locale of ["zh", "en"] as const) {
  const t = messages[locale];
  test(`${locale}: one editable header title and adjacent page type save together without a core message`, async () => {
    await withReview(locale, async ({ host, click, change, event, saves, snapshot }) => {
      await click(".outline-compact-summary");
      const title = host.querySelector<HTMLTextAreaElement>(".outline-details-title")!;
      assert.equal(title.getAttribute("aria-label"), t.outline.pageTitle);
      assert.equal(title.getAttribute("title"), t.outline.editPageTitleHint);
      assert.equal(host.querySelectorAll(".outline-details-title").length, 1);
      assert.ok(title.parentElement!.querySelector("select"));
      assert.equal(host.querySelector(".outline-details-fields input"), null);
      assert.doesNotMatch(host.querySelector(".outline-details")!.textContent, /核心信息|Core message/);
      await change(".outline-details-title", "");
      assert.equal(host.querySelector<HTMLButtonElement>(".outline-details .outline-dialog-footer .primary-btn")!.disabled, true);
      await event(".outline-details-form", "submit");
      assert.equal(saves.length, 0);
      await change(".outline-details-title", "修改后的标题\n第二行");
      await change(".outline-details-heading select", "standard");
      assert.equal(title.value, "修改后的标题 第二行");
      assert.equal(snapshot().items[0]!.page_type, "cover");
      await event(".outline-details-title", "keydown", { key: "Enter", isComposing: true });
      await event(".outline-details-title", "keydown", { key: "Enter" });
      assert.equal(saves.length, 0);
      await event(".outline-details-form", "submit");
      assert.equal(snapshot().items[0]!.title, "修改后的标题 第二行");
      assert.equal(snapshot().items[0]!.page_type, "standard");
      assert.equal(snapshot().items[0]!.content, "正文一");
      assert.equal(Object.hasOwn(saves[0]!.items[0]!, "core_message"), false);
    });
  });
  test(`${locale}: details cancel discards title and image changes; failed saves retain them for retry`, async () => {
    await withReview(locale, async ({ host, click, change, event, saves, snapshot, setSaveSuccess }) => {
      await click(".outline-compact-summary");
      await change(".outline-details-title", "手动标题");
      await change(".outline-details-heading select", "standard");
      await click(".outline-image-remove");
      assert.equal(snapshot().items[0]!.title, "第一页");
      assert.equal(snapshot().items[0]!.page_type, "cover");
      assert.deepEqual(snapshot().items[0]!.selected_image_ids, ["image-1"]);
      await click(".outline-details .outline-dialog-footer .secondary-btn");
      assert.equal(saves.length, 0);
      assert.equal(host.querySelector(".outline-details"), null);
      await click(".outline-compact-summary");
      assert.equal(host.querySelector<HTMLTextAreaElement>(".outline-details-title")!.value, "第一页");
      await change(".outline-details-title", "保存标题");
      await click(".outline-image-remove");
      setSaveSuccess(false);
      await event(".outline-details-form", "submit");
      assert.equal(snapshot().items[0]!.title, "第一页");
      assert.equal(host.querySelector<HTMLTextAreaElement>(".outline-details-title")!.value, "保存标题");
      assert.ok(host.querySelector(".outline-details [role='alert']")!.textContent.includes(t.outlineReview.saveFailed));
      setSaveSuccess(true);
      await event(".outline-details-form", "submit");
      assert.equal(host.querySelector(".outline-details"), null);
      assert.equal(snapshot().items[0]!.title, "保存标题");
      assert.deepEqual(snapshot().items[0]!.selected_image_ids, []);
      assert.equal(snapshot().items[1]!.title, "第二页");
    });
  });

  test(`${locale}: AI preview cancellation preserves the draft; only Apply saves the proposed outline`, async () => {
    await withReview(locale, async ({ host, click, saves, snapshot, setSaveSuccess }) => {
      await click("[data-performance-id='outline.rewrite.open']");
      await click(".outline-rewrite-suggestions button");
      await click("[data-performance-id='outline.rewrite']");
      assert.ok(host.querySelector(".outline-preview-grid")!.textContent.includes("AI 新页面"));
      assert.equal(saves.length, 0);
      assert.equal(snapshot().title, initial.title);
      await click(".outline-rewrite-dialog .outline-dialog-footer .secondary-btn");
      assert.equal(snapshot().items.length, 3);
      await click("[data-performance-id='outline.rewrite.open']");
      assert.equal(host.querySelector<HTMLTextAreaElement>("#outline-rewrite-request")!.value, t.outlineReview.shorten);
      await click("[data-performance-id='outline.rewrite']");
      setSaveSuccess(false);
      await click("[data-performance-id='outline.rewrite.apply']");
      assert.equal(snapshot().title, initial.title);
      assert.ok(host.querySelector(".outline-preview-grid"));
      setSaveSuccess(true);
      await click("[data-performance-id='outline.rewrite.apply']");
      assert.equal(snapshot().title, proposed.title);
      assert.equal(snapshot().items.length, 1);
      assert.deepEqual(snapshot().items[0]!.selected_image_ids, ["image-2"]);
      assert.equal(host.querySelector(".outline-rewrite-dialog"), null);
      await click("[data-performance-id='outline.rewrite.open']");
      assert.equal(host.querySelector<HTMLTextAreaElement>("#outline-rewrite-request")!.value, "");
    });
  });
}

test("dragging and keyboard moves keep page content, cover type and images together", async () => {
  await withReview("zh", async ({ event, snapshot, saves }) => {
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData() {}, setDragImage() {} };
    await event("[data-outline-page='0'] .outline-drag-handle", "dragstart", { dataTransfer });
    await event("[data-outline-page='2']", "dragover", { dataTransfer });
    await event("[data-outline-page='2']", "drop", { dataTransfer });
    assert.deepEqual(snapshot().items.map((item) => item.title), ["第二页", "第三页", "第一页"]);
    assert.equal(snapshot().items[2]!.page_type, "cover");
    assert.equal(snapshot().items[2]!.content, "正文一");
    assert.deepEqual(snapshot().items[2]!.selected_image_ids, ["image-1"]);
    await event("[data-outline-page='2'] .outline-drag-handle", "keydown", { key: "ArrowUp" });
    assert.equal(snapshot().items[1]!.title, "第一页");
    assert.equal(saves.length, 0);
  });
});

test("closing a nested image picker preserves the drawer; switching workspaces discards local editing", async () => {
  await withReview("zh", async ({ host, click, event, switchWorkspace, saves }) => {
    await click("[data-outline-page='2'] .outline-compact-summary");
    await click(".outline-page-images .outline-field-heading button");
    await event(".outline-image-picker", "cancel");
    assert.equal(host.querySelector(".outline-image-picker"), null);
    assert.ok(host.querySelector(".outline-details"));
    await switchWorkspace();
    assert.equal(host.querySelector(".outline-details"), null);
    assert.equal(saves.length, 0);
  });
});

test("duplicating a page uses the more menu and does not copy its image assignments", async () => {
  await withReview("zh", async ({ host, click, snapshot }) => {
    await click(".outline-more-trigger");
    const duplicate = [...host.querySelectorAll<HTMLButtonElement>(".outline-more-actions button")].find((button) => button.textContent.includes(messages.zh.outline.duplicatePage))!;
    await act(async () => duplicate.click());
    assert.equal(snapshot().items.length, 4);
    assert.equal(snapshot().items[1]!.title, "第一页");
    assert.deepEqual(snapshot().items[1]!.selected_image_ids, []);
    assert.ok(host.querySelector(".outline-details"));
  });
});

test("a pending AI request blocks dismissal; failure keeps the request available for retry", async () => {
  await withReview("zh", async ({ host, click, event, setGenerate, snapshot, saves }) => {
    let reject!: (error: Error) => void;
    setGenerate(() => new Promise((_resolve, fail) => { reject = fail; }));
    await click("[data-performance-id='outline.rewrite.open']");
    await click(".outline-rewrite-suggestions button");
    await click("[data-performance-id='outline.rewrite']");
    assert.equal(host.querySelector<HTMLButtonElement>(".outline-rewrite-dialog .outline-dialog-close")!.disabled, true);
    await event(".outline-rewrite-dialog", "cancel");
    assert.ok(host.querySelector(".outline-rewrite-dialog"));
    await act(async () => reject(new Error("unavailable")));
    assert.equal(snapshot().title, initial.title);
    assert.equal(saves.length, 0);
    assert.equal(host.querySelector<HTMLTextAreaElement>("#outline-rewrite-request")!.value, messages.zh.outlineReview.shorten);
    assert.ok(host.querySelector(".outline-rewrite-dialog [role='alert']"));
    setGenerate(async () => structuredClone(proposed));
    await click("[data-performance-id='outline.rewrite']");
    assert.ok(host.querySelector(".outline-preview-grid"));
  });
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: global and page requirements are edited and saved with the outline`, async () => {
    await withReview(locale, async ({ change, click, event, saves, snapshot }) => {
      await change(".outline-global-requirements textarea", "图片至少占 90%。\n保留指定文案。");
      await click("[data-outline-page='2'] .outline-compact-summary");
      await change(".outline-details textarea:not([required])", "本页图片不要裁切。");
      await event(".outline-details-form", "submit");
      assert.equal(saves.at(-1)?.global_creation_requirements, "图片至少占 90%。\n保留指定文案。");
      assert.equal(saves.at(-1)?.items[2]?.creation_requirements, "本页图片不要裁切。");
      assert.equal(snapshot().items[0]?.creation_requirements, undefined);
    });
  });
  test(`${locale}: rewrite preview exposes changed requirements and applies only on confirmation`, async () => {
    await withReview(locale, async ({ host, click, snapshot, saves }) => {
      await click("[data-performance-id='outline.rewrite.open']");
      await click(".outline-rewrite-suggestions button");
      await click("[data-performance-id='outline.rewrite']");
      const preview = host.querySelector(".outline-preview-grid")!;
      assert.ok(preview.textContent.includes(initial.global_creation_requirements!));
      assert.ok(preview.textContent.includes(proposed.global_creation_requirements!));
      assert.equal(saves.length, 0);
      assert.equal(snapshot().global_creation_requirements, initial.global_creation_requirements);
      await click("[data-performance-id='outline.rewrite.apply']");
      assert.equal(snapshot().global_creation_requirements, proposed.global_creation_requirements);
    });
  });
}
