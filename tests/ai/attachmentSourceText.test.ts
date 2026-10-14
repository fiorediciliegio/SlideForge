import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NO_ATTACHMENT_SOURCES,
  formatAttachmentSourcesForPrompt,
} from "../../src/ai/attachmentSourceText.ts";
import { applyImageResearchFlag } from "../../src/features/requirements/presentationRequirements.ts";
import { IMAGE_RESEARCH_ENABLED } from "../../src/features/deck-generation/featureFlags.ts";
import type { AttachmentBrief, AttachmentContext } from "../../src/api/types.ts";

function context(briefs: Array<Partial<AttachmentBrief>>): AttachmentContext {
  return {
    version: 1,
    user_brief: "brief should not be repeated",
    attachment_context: briefs.map((brief, index) => ({
      version: 1,
      source_id: `source-${index + 1}`,
      filename: `source-${index + 1}.xlsx`,
      content_strategy: "summarized_context",
      original_reading_method: "document_retrieval",
      key_facts: [],
      must_include: [],
      must_avoid: [],
      recommended_storyline: [],
      gaps: [],
      unread_content: [],
      updated_at: "2026-09-04T00:00:00.000Z",
      ...brief,
    } as AttachmentBrief)),
    updated_at: "2026-09-04T00:00:00.000Z",
  };
}

describe("attachment sources for the outline prompt", () => {
  it("passes a simple attachment through as extracted source text", () => {
    const sheet = "# Sheet: 01_Monthly_KPI\n[Row 5] A: 2026-01 | H: $198,000";
    const text = formatAttachmentSourcesForPrompt(context([{
      content_strategy: "full_context",
      original_reading_method: "spreadsheet_read",
      content: sheet,
    }]));

    assert.ok(text.includes(sheet));
    assert.ok(text.includes("source-1.xlsx"));
    // 原始行号 / 数字必须保留，大纲要靠它现场计算派生指标。
    assert.ok(text.includes("$198,000"));
    // 不再以 JSON 注入，也不输出内部 source_id。
    assert.doesNotMatch(text, /"content_strategy"|source-1"/);
    // 换行必须是真实换行，不能是字面 \n。
    assert.doesNotMatch(text, /\\n/);
  });

  it("flattens a complex attachment's structured fields into readable text", () => {
    const text = formatAttachmentSourcesForPrompt(context([{
      relationship_to_task: "支撑 H1 复盘",
      main_message: "复购是增长主引擎",
      key_facts: [{
        evidence_id: "evidence-1",
        fact: "复购率达到 42%",
        source_label: "01_Monthly_KPI",
        excerpt: "复购率 42%",
      }],
      must_include: [{ requirement: "必须给出 H2 行动优先级", evidence_ids: ["evidence-1"] }],
      must_avoid: ["不要断定因果"],
      recommended_storyline: ["先规模、再质量"],
      gaps: ["缺少 Q3 数据"],
      unread_content: ["附录未读取"],
      sheet_coverage: [{ sheet_name: "01_Monthly_KPI", status: "covered", evidence_ids: ["evidence-1"] }],
    }]));

    for (const value of [
      "支撑 H1 复盘",
      "复购是增长主引擎",
      "复购率达到 42%",
      "01_Monthly_KPI",
      "必须给出 H2 行动优先级",
      "不要断定因果",
      "先规模、再质量",
      "缺少 Q3 数据",
      "附录未读取",
    ]) {
      assert.ok(text.includes(value), value);
    }
    assert.doesNotMatch(text, /"evidence_id"/);
  });

  it("reports the absence of attachments instead of emitting null", () => {
    assert.equal(formatAttachmentSourcesForPrompt(null), NO_ATTACHMENT_SOURCES);
    assert.equal(formatAttachmentSourcesForPrompt(context([])), NO_ATTACHMENT_SOURCES);
  });
});

describe("image research flag", () => {
  it("forces the image recommendation off while image search is disabled", () => {
    const research = applyImageResearchFlag({
      web: { recommended: true, reason: "需要最新资料", enabled: true },
      images: { recommended: true, reason: "需要真实产品图", enabled: true },
    });

    assert.equal(research.web.enabled, true, "Web research must stay untouched");
    assert.equal(research.images.enabled, IMAGE_RESEARCH_ENABLED ? true : false);
    assert.equal(research.images.recommended, IMAGE_RESEARCH_ENABLED ? true : false);
  });
});
