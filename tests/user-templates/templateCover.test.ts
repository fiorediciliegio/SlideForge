import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { TemplateCover } from "../../src/features/user-templates/TemplateCover";
import { messages } from "../../src/i18n";

function setupDom() {
  const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    document,
    host: document.getElementById("root")!,
    restore() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test("TemplateCover: successful preview renders the cover image", async () => {
  const { document, host, restore } = setupDom();
  const root = createRoot(host);
  const calls: string[] = [];
  const t = messages["zh"];
  try {
    await act(async () => {
      root.render(createElement(TemplateCover, {
        t,
        templateId: "tpl-1",
        pageNumber: 3,
        alt: "封面",
        preview: async (id, page) => { calls.push(`${id}:${page}`); return "blob:cover-url"; },
      }));
    });
    const img = document.querySelector("img");
    assert.ok(img, "should render an img once the preview resolves");
    assert.equal(img.getAttribute("src"), "blob:cover-url");
    assert.equal(img.getAttribute("alt"), "封面");
    assert.equal(calls.join(","), "tpl-1:3");
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});

test("TemplateCover: preview failure degrades to a retry affordance and re-fetches on click", async () => {
  const { document, host, restore } = setupDom();
  const root = createRoot(host);
  const t = messages["zh"];
  let attempts = 0;
  try {
    await act(async () => {
      root.render(createElement(TemplateCover, {
        t,
        templateId: "tpl-2",
        alt: "封面",
        preview: async () => { attempts += 1; if (attempts < 2) throw new Error("network down"); return "blob:recovered"; },
      }));
    });
    const retry = document.querySelector(".user-template-thumb-retry");
    assert.ok(retry, "failed preview should render the retry placeholder");
    assert.equal(document.querySelector("img"), null);
    await act(async () => { retry.dispatchEvent(new window.Event("click", { bubbles: true })); });
    const img = document.querySelector("img");
    assert.ok(img, "clicking retry should re-fetch and render the cover");
    assert.equal(img.getAttribute("src"), "blob:recovered");
    assert.equal(attempts, 2);
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});

test("TemplateCover: a broken image (onError) degrades to the retry state", async () => {
  const { document, host, restore } = setupDom();
  const root = createRoot(host);
  const t = messages["zh"];
  try {
    await act(async () => {
      root.render(createElement(TemplateCover, {
        t,
        templateId: "tpl-3",
        alt: "封面",
        preview: async () => "blob:will-break",
      }));
    });
    const img = document.querySelector("img")!;
    assert.ok(img);
    await act(async () => { img.dispatchEvent(new window.Event("error")); });
    assert.equal(document.querySelector("img"), null);
    assert.ok(document.querySelector(".user-template-thumb-retry"), "onError should degrade to the retry placeholder");
  } finally {
    await act(async () => { root.unmount(); });
    restore();
  }
});
