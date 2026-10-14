import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentContext, PresentationRequirements, SharedResearchContextResult, WorkspaceOutline } from "../../src/api/types.ts";
import { buildPageHtmlPrompt, buildPageHtmlRefinementPrompt, buildVisualMasterHtmlPrompt } from "../../src/features/deck-generation/htmlPrompts.ts";

import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts.ts";

const requirements = {
  source: { brief: "制作一份市场演示" },
  selections: {
    output_language: "中文",
  },
} as PresentationRequirements;

const outline: WorkspaceOutline = {
  version: 4,
  status: "confirmed",
  title: "市场演示",
  items: [{ page_id: "page-1", page_type: "standard", title: "复购驱动的增长路径", content: "增长数据" }],
  updated_at: null,
  confirmed_at: null,
};
const page = authoringDeckFromConfirmedOutline(outline).pages[0]!;

const research: SharedResearchContextResult = {
  workspace_dir: "/tmp/workspace",
  web_summary_path: "/tmp/workspace/research/evidence/web-summary.md",
  image_catalog_path: "/tmp/workspace/research/evidence/image-catalog.json",
  images_dir: "/tmp/workspace/research/evidence/images",
  progress_path: "/tmp/workspace/research/progress.json",
  web_summary: "## 市场事实\n- 2025 年市场增长 18%。",
  image_catalog: {
    schema_version: 2,
    assets: [{
      asset_id: "asset-1",
      file_path: "/tmp/workspace/research/evidence/images/asset-1.jpg",
      sha256: "a".repeat(64),
      mime_type: "image/jpeg",
      bytes_size: 1024,
      width: 1600,
      height: 900,
      aspect_ratio: 16 / 9,
      description: "真实产品使用场景。",
      reason: "适合市场页。",
      matched_queries: ["product usage"],
      source_url: "https://example.com/source",
    }],
  },
  progress: {},
};

const attachmentContext: AttachmentContext = {
  version: 1,
  user_brief: requirements.source?.brief ?? "",
  attachment_context: [{
    version: 1,
    source_id: "source-1",
    filename: "source.md",
    content_strategy: "full_context",
    original_reading_method: "document_read",
    content: "附件正文",
    key_facts: [],
    must_include: [],
    must_avoid: [],
    recommended_storyline: [],
    gaps: [],
    unread_content: [],
    updated_at: "2026-09-04T00:00:00.000Z",
  }],
  updated_at: "2026-09-04T00:00:00.000Z",
};

test("page prompt carries only the page content and the visual references", () => {
  const visualMasterHtml = "<!doctype html><html><body>STANDARD_MASTER</body></html>";
  const referenceHtml = "<!doctype html><html><body>PAGE_REFERENCE</body></html>";
  const pagePrompt = buildPageHtmlPrompt({
    outline,
    page,
    visualMasterHtml,
    referenceHtml,
  });
  const masterPrompt = buildVisualMasterHtmlPrompt({ requirements, outline, referenceHtml: "Reference" });

  assert.ok(pagePrompt.includes(page.title));
  assert.doesNotMatch(pagePrompt, /core_message|核心信息/);
  assert.ok(pagePrompt.includes(page.outline));
  assert.ok(pagePrompt.includes(visualMasterHtml));
  assert.ok(pagePrompt.includes(referenceHtml));

  // 只检查输入数据的传递边界，不锁定提示词标题、措辞或排版格式。
  assert.doesNotMatch(pagePrompt, /2025 年市场增长 18%|asset-1\.jpg|附件正文/);
  assert.doesNotMatch(pagePrompt, new RegExp(requirements.source!.brief));
  assert.doesNotMatch(masterPrompt, /2025 年市场增长 18%|asset-1\.jpg/);
});

test("page refinement prompt keeps the same context plus the request and original HTML", () => {
  const input = {
    outline,
    page,
    visualMasterHtml: "<html><body>{{PAGE_CONTENT}}</body></html>",
    referenceHtml: "<html><body>Reference</body></html>",
    refinementRequest: "把右侧图表改成更易读的横向布局。",
    originalHtml: "<!doctype html><html><body><div class=\"slide\">原有结论</div></body></html>",
  };
  const prompt = buildPageHtmlRefinementPrompt(input);

  assert.ok(prompt.includes(input.visualMasterHtml));
  assert.ok(prompt.includes(input.referenceHtml));
  assert.ok(prompt.includes(page.outline));
  assert.ok(prompt.includes(input.refinementRequest));
  assert.ok(prompt.includes(input.originalHtml));
  assert.doesNotMatch(prompt, /2025 年市场增长 18%|asset-1\.jpg|附件正文/);
});

test("封面生成和精修按页面类型识别封面，保留参考 HTML 并排除母版", () => {
  const coverOutline: WorkspaceOutline = {
    ...outline,
    items: [outline.items[0]!, {
      page_id: "cover-page", page_type: "cover", title: "市场演示",
      content: "复购驱动的增长路径",
    }],
  };
  // 封面放在第二页，确保依据类型而非页序；原有用例覆盖第一页是普通页。
  const cover = authoringDeckFromConfirmedOutline(coverOutline).pages[1]!;
  const input = {
    outline: coverOutline,
    page: cover,
    visualMasterHtml: "<html><body>MASTER_MUST_NOT_LEAK</body></html>",
    referenceHtml: "<html><body>COVER_REFERENCE</body></html>",
  };
  for (const prompt of [
    buildPageHtmlPrompt(input),
    buildPageHtmlRefinementPrompt({ ...input, refinementRequest: "放大主标题", originalHtml: "<html><body>原有封面</body></html>" }),
  ]) {
    assert.ok(prompt.includes(cover.title));
    assert.ok(prompt.includes(cover.outline));
    assert.ok(prompt.includes(input.referenceHtml));
    assert.doesNotMatch(prompt, /MASTER_MUST_NOT_LEAK/);
  }
});
