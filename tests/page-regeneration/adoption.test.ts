import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { PptBackend } from "../../src/api/pptBackend";
import type { PageRegenerationBatch } from "../../src/api/pageRegenerationTypes";
import { usePageRegeneration, type PageRegenerationModel } from "../../src/features/page-regeneration/usePageRegeneration";
import { messages } from "../../src/i18n/messages";
import { pageAdoptionFixture } from "../helpers/pageAdoption";

test("美化与重新生成采用候选后，都将目标页面标识交给结果刷新回调", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const fixture = pageAdoptionFixture();
  const batch: PageRegenerationBatch = { id: "batch", page_id: fixture.pageId, page_index: 8, status: "ready",
    outline: fixture.outline.items[8], reference_path: "", base_fingerprint: "base", created_at: "now",
    candidates: [{ id: "candidate", status: "ready" }] };
  const adopted: string[][] = [];
  const backend = { pageRegeneration: async (input: { action: string }) => input.action === "adopt"
    ? { ...batch, status: "adopted", selected_id: "candidate" } : batch } as PptBackend;
  let model!: PageRegenerationModel;
  function Harness() {
    model = usePageRegeneration({ backend, workspace: fixture.workspace, ai: null, agent: null, logger: null,
      pageImageSearch: null, t: messages.zh, locale: "zh", onAdopted: async (...args) => { adopted.push(args); } });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    for (const mode of ["beautify", "regenerate"] as const) {
      batch.mode = mode;
      await act(async () => model.open(8, mode));
      await act(async () => model.refresh());
      await act(async () => model.adopt("candidate"));
      assert.equal(model.view, "closed");
      assert.equal(model.applying, false);
    }
    assert.deepEqual(adopted, [0, 1].map(() => [fixture.workspace.workspace_dir, fixture.pageId]));
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
