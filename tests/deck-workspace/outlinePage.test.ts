import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  OutlinePage,
} from "../../src/features/deck-workspace/components/OutlinePage.tsx";
import { normalizeOutlineContentText } from "../../src/features/outline/model.ts";
import type { ComponentProps } from "react";
import type { LoadingKind } from "../../src/features/deck-workspace/types.ts";
import { messages } from "../../src/i18n/messages.ts";

function renderOutlinePage(dirty: boolean, saving = false, loading: LoadingKind = "none", overrides: Partial<ComponentProps<typeof OutlinePage>> = {}) {
  return renderToStaticMarkup(createElement(OutlinePage, {
    t: messages.zh,
    pageImageSearch: null, workspaceKey: "test",
    loadImages: async () => [],
    loadImagePreview: async () => "",
    title: "演示文稿标题",
    globalRequirements: "",
    setGlobalRequirements: () => undefined,
    outline: [{
      page_type: "standard",
      title: "第一页",
      content: "必要内容",
      creation_requirements: "文案一字不改",
    }],
    dirty,
    saving,
    error: "",
    loading,
    setTitle: () => undefined,
    replaceItems: () => undefined,
    feedback: "",
    setFeedback: () => undefined,
    applyFeedback: async () => undefined,
    save: async () => true,
    retry: async () => undefined,
    backToRequirements: () => undefined,
    forward: () => undefined,
    confirm: async () => undefined,
    ...overrides,
  }));
}

describe("OutlinePage", () => {
  it("shows the return-to-requirements action in the footer for an existing outline", () => {
    const html = renderOutlinePage(false);
    const footer = html.slice(html.indexOf('<div class="outline-card-footer">'));

    assert.match(footer, />返回</);
    assert.ok(footer.indexOf("返回") < footer.indexOf("草稿已保存"));
    assert.match(footer, /data-performance-id="outline.forward"/);
    assert.ok(footer.indexOf("前进") < footer.indexOf("保存</button>"));
  });

  it("renders the save state in the footer before the save and confirm actions", () => {
    const html = renderOutlinePage(false);
    const footer = html.slice(html.indexOf('<div class="outline-card-footer">'));

    assert.match(footer, /草稿已保存/);
    assert.ok(footer.indexOf("草稿已保存") < footer.indexOf("保存</button>"));
    assert.ok(footer.indexOf("保存</button>") < footer.indexOf("确认并生成"));
  });

  it("shows compact title cards with direct image entry, a drag handle and a single more-actions entry", () => {
    const html = renderOutlinePage(false);
    assert.match(html, /页面结构/);
    assert.match(html, /outline-compact-card/);
    assert.match(html, /outline-drag-handle/);
    assert.match(html, /draggable="true"/);
    assert.match(html, /第一页/);
    assert.match(html, /class="outline-card-image-add"/);
    assert.match(html, /aria-label="为第 1 页选择或搜索配图"/);
    for (const text of ["全部展开", "全部折叠", "必要内容", "核心信息", "复制页面", "删除页面"]) assert.ok(!html.includes(text));
  });

  it("opens AI editing from the toolbar instead of showing a persistent input", () => {
    const html = renderOutlinePage(false);
    assert.match(html, /data-performance-id="outline.rewrite.open"/);
    assert.match(html, /AI 修改/);
    assert.ok(html.indexOf("outline.rewrite.open") < html.indexOf("outline-compact-list"));
    assert.doesNotMatch(html, /feedback-box|outline-review-controls/);
  });

  it("shows the draft-saving state while saving", () => {
    const html = renderOutlinePage(true, true);

    assert.match(html, /正在保存草稿\.\.\./);
    assert.doesNotMatch(html, /有未保存的修改/);
  });

  it("shows immediate feedback while confirming the Outline", () => {
    const html = renderOutlinePage(false, false, "deck");

    assert.match(html, /spinner small/);
    assert.match(html, /确认并生成/);
  });

  it("preserves user text and intentional whitespace", () => {
    assert.equal(
      normalizeOutlineContentText("第一段叙述。   \n\n\n\n第二段叙述。  "),
      "第一段叙述。   \n\n\n\n第二段叙述。  ",
    );
    assert.throws(() => normalizeOutlineContentText("   \n  "), /页面内容不能为空/);
  });
});

for (const locale of ["zh", "en"] as const) {
  const t = messages[locale];
  it(`${locale}: saving keeps the list visible and disables edits`, () => {
    const html = renderOutlinePage(true, true, "outline", { t });
    assert.ok(html.includes("outline-compact-list"));
    assert.ok(!html.includes("requirements-loading"));
    assert.match(html, /class="outline-drag-handle"[^>]*disabled/);
    assert.match(html, /class="outline-card-image-add"[^>]*disabled/);
    assert.ok(html.includes(t.outline.saving));
  });

  it(`${locale}: rewrite failures retain the original title-only list and allow retry`, () => {
    const html = renderOutlinePage(true, false, "none", { t, error: t.outline.rewriteError });
    assert.ok(html.includes("第一页"));
    assert.ok(html.includes(t.outline.rewriteError));
    assert.doesNotMatch(html, /data-performance-id="outline.rewrite.open"[^>]*disabled/);
  });
}
