import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpreadsheetAttachmentBriefBatchPrompt,
  buildSpreadsheetAttachmentBriefChunkPrompt,
  buildSpreadsheetAttachmentBriefFinalPrompt,
  buildSpreadsheetAttachmentBriefPrompt,
} from "../../src/ai/attachmentBriefPrompt";
import {
  buildSpreadsheetAttachmentBriefBatches,
  normalizeSpreadsheetBatchEvidencePacket,
  normalizeStructuredBrief,
} from "../../src/features/deck-generation/attachmentBriefWorkflow";

const promptSource = {
  sourceId: "source-1",
  filename: "metrics.xlsx",
  userBrief: "总结全部工作表",
  originalReadingMethod: "spreadsheet_read" as const,
  warnings: [],
};

test("spreadsheet prompts require explicit coverage for every Sheet", () => {
  const chunkPrompt = buildSpreadsheetAttachmentBriefChunkPrompt({
    ...promptSource,
    sheetName: "Sales",
    chunk: {
      chunkId: "chunk-001",
      totalChunks: 2,
      headingPath: ["Sheet: Sales"],
      sourceRange: "characters:0-100",
      content: "# Sheet: Sales\n[Row 2 | A2:B2] A: North | B: 42",
    },
  });
  const finalPrompt = buildSpreadsheetAttachmentBriefFinalPrompt({
    ...promptSource,
    sheetNames: ["Sales", "Costs"],
    packets: [],
  });
  const batchPrompt = buildSpreadsheetAttachmentBriefBatchPrompt({
    ...promptSource,
    sheetNames: ["Sales", "Costs"],
    batch: {
      chunkId: "batch-001",
      totalChunks: 2,
      headingPath: ["Sheet: Sales"],
      sourceRange: "characters:0-200",
      content: "# Sheet: Sales\n[Row 2 | A2:B2] A: North | B: 42\n\n# Sheet: Costs\n[Row 2 | A2:B2] A: Travel | B: 7",
    },
  });
  const singlePrompt = buildSpreadsheetAttachmentBriefPrompt({
    ...promptSource,
    sheetNames: ["Sales", "Costs"],
    content: "# Sheet: Sales\n[Row 2 | A2:B2] A: North | B: 42\n\n# Sheet: Costs\n[Row 2 | A2:B2] A: Travel | B: 7",
  });

  assert.match(chunkPrompt, /当前工作表：Sales/);
  assert.match(chunkPrompt, /不要静默遗漏工作表/);
  assert.match(finalPrompt, /expected_sheets: \["Sales","Costs"\]/);
  assert.match(finalPrompt, /sheet_coverage/);
  assert.match(finalPrompt, /Reference integrity/);
  assert.match(batchPrompt, /Included Sheets: \["Sales","Costs"\]/);
  assert.match(batchPrompt, /progress_summary/);
  assert.match(batchPrompt, /sheet_coverage/);
  assert.match(singlePrompt, /expected_sheets: \["Sales","Costs"\]/);
  assert.match(singlePrompt, /sheet_coverage/);
});

test("spreadsheet Brief validation rejects a missing Sheet coverage entry", () => {
  const base = {
    content_strategy: "summarized_context",
    original_reading_method: "spreadsheet_read",
    key_facts: [{
      evidence_id: "evidence-1",
      fact: "North sales are 42.",
      source_label: "Sales!A2:B2",
      excerpt: "North | B: 42",
    }],
    must_include: [],
    must_avoid: [],
    recommended_storyline: [],
    gaps: [],
    unread_content: [],
  };

  assert.throws(
    () => normalizeStructuredBrief(
      {
        ...base,
        sheet_coverage: [{ sheet_name: "Sales", status: "covered", evidence_ids: ["evidence-1"] }],
      },
      (excerpt) => excerpt === "North | B: 42",
      "spreadsheet_read",
      ["Sales", "Costs"],
    ),
    /cover every expected Sheet exactly once/,
  );
});

test("spreadsheet Brief validation accepts a covered Sheet and an explicit non-relevant Sheet", () => {
  const brief = normalizeStructuredBrief(
    {
      content_strategy: "summarized_context",
      original_reading_method: "spreadsheet_read",
      key_facts: [{
        evidence_id: "evidence-1",
        fact: "North sales are 42.",
        source_label: "Sales!A2:B2",
        excerpt: "North | B: 42",
      }],
      must_include: [],
      must_avoid: [],
      recommended_storyline: [],
      gaps: [],
      unread_content: [],
      sheet_coverage: [
        { sheet_name: "Sales", status: "covered", evidence_ids: ["evidence-1"] },
        { sheet_name: "Costs", status: "not_relevant", reason: "Only operating notes; unrelated to the requested sales overview.", evidence_ids: [] },
      ],
    },
    (excerpt) => excerpt === "North | B: 42",
    "spreadsheet_read",
    ["Sales", "Costs"],
  );

  assert.deepEqual(brief.sheet_coverage, [
    { sheet_name: "Sales", status: "covered", evidence_ids: ["evidence-1"] },
    { sheet_name: "Costs", status: "not_relevant", reason: "Only operating notes; unrelated to the requested sales overview.", evidence_ids: [] },
  ]);
});

test("spreadsheet Brief validation identifies the missing evidence ID in must_include", () => {
  assert.throws(
    () => normalizeStructuredBrief(
      {
        content_strategy: "summarized_context",
        original_reading_method: "spreadsheet_read",
        key_facts: [{
          evidence_id: "evidence-1",
          fact: "North sales are 42.",
          source_label: "Sales!A2:B2",
          excerpt: "North | B: 42",
        }],
        must_include: [{ requirement: "Compare regions.", evidence_ids: ["evidence-404"] }],
        must_avoid: [],
        recommended_storyline: [],
        gaps: [],
        unread_content: [],
        sheet_coverage: [{ sheet_name: "Sales", status: "covered", evidence_ids: ["evidence-1"] }],
      },
      () => true,
      "spreadsheet_read",
      ["Sales"],
    ),
    /evidence-404/,
  );
});

test("spreadsheet batch validation accepts a reformatted row excerpt while preserving Sheet evidence checks", () => {
  const packet = normalizeSpreadsheetBatchEvidencePacket(
    {
      sheet_coverage: [{ sheet_name: "Sales", status: "covered", evidence_ids: ["evidence-1"] }],
      key_facts: [{
        evidence_id: "evidence-1",
        fact: "North sales are 42.",
        source_label: "Sales!A2:B2",
        // This is a faithful table reformat, but intentionally not a
        // contiguous substring of the row-oriented persisted extraction.
        excerpt: "North: 42",
      }],
    },
    {
      chunkId: "batch-001",
      totalChunks: 1,
      headingPath: ["Sheet: Sales"],
      sourceRange: "characters:0-60",
      content: "# Sheet: Sales\n[Row 2 | A2:B2] A: North | B: 42",
    },
    ["Sales"],
  );

  assert.equal(Array.isArray(packet.key_facts), true);
});

test("spreadsheet batches respect the persisted-text transport character limit", () => {
  const batches = buildSpreadsheetAttachmentBriefBatches([
    {
      chunkId: "chunk-001",
      totalChunks: 2,
      headingPath: ["Sheet: First"],
      sourceRange: "characters:0-160000",
      startOffset: 0,
      endOffset: 160_000,
      tokenEstimate: 70_000,
      sheetName: "First",
    },
    {
      chunkId: "chunk-002",
      totalChunks: 2,
      headingPath: ["Sheet: Second"],
      sourceRange: "characters:160002-320000",
      startOffset: 160_002,
      endOffset: 320_000,
      tokenEstimate: 70_000,
      sheetName: "Second",
    },
  ]);

  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.sheetNames), [["First"], ["Second"]]);
  assert.ok(batches.every((batch) => batch.endOffset - batch.startOffset <= 300_000));
});
