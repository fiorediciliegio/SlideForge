import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureAttachmentBriefs,
  isSourceSupportedExcerpt,
  normalizeStructuredBrief,
  pdfSourceLabelForExcerpt,
} from "../../src/features/deck-generation/attachmentBriefWorkflow";
import type { AttachmentBriefCompletionClient } from "../../src/ai/attachmentBriefCompletion";
import type { PptBackend } from "../../src/api/pptBackend";
import type {
  AttachmentBrief,
  UploadedSourceMaterial,
  UploadedSourcePreflightResult,
  WorkspaceResult,
} from "../../src/api/types";
import {
  buildAttachmentBriefChunkPrompt,
  buildAttachmentBriefFinalPrompt,
} from "../../src/ai/attachmentBriefPrompt";

const rustChunk = `- [Enable MIR inlining for optimized compilations](https://github.com/rust-lang/rust/pull/91743)
  This provides a 3-10% improvement in compiletimes for real world crates.

- [Stabilize \`#[derive(Default)]\` on enums with a \`#[default]\` variant][94457]
- Added the \`cargo add\` command for adding dependencies to \`Cargo.toml\` from
  the command-line.`;

test("accepts retained Markdown list evidence without link destinations", () => {
  assert.equal(
    isSourceSupportedExcerpt(
      "- [Enable MIR inlining for optimized compilations]\n  This provides a 3-10% improvement in compiletimes for real world crates.",
      rustChunk,
    ),
    true,
  );
});

test("accepts separate retained Markdown bullets in source order", () => {
  assert.equal(
    isSourceSupportedExcerpt(
      "- [Stabilize \`#[derive(Default)]\` on enums with a \`#[default]\` variant]\n- Added the \`cargo add\` command for adding dependencies to \`Cargo.toml\` from\n  the command-line.",
      rustChunk,
    ),
    true,
  );
});

test("continues to reject rewritten evidence", () => {
  assert.equal(
    isSourceSupportedExcerpt("- [Enable MIR inlining for every build]", rustChunk),
    false,
  );
});

const pagedPdfText = `# Page 12

The fund received exactly USD 2,524.28 million in contributions and investment income.

# Page 13

The implementation target remains planned for 2026.`;

test("derives deterministic PDF page labels from verified excerpts", () => {
  assert.equal(
    pdfSourceLabelForExcerpt("exactly USD 2,524.28 million", pagedPdfText),
    "page:12",
  );
  assert.equal(
    pdfSourceLabelForExcerpt(
      "The fund received exactly USD 2,524.28 million ... The implementation target remains planned for 2026.",
      pagedPdfText,
    ),
    "pages:12-13",
  );
  assert.equal(pdfSourceLabelForExcerpt("not present", pagedPdfText), null);
});

test("PDF Brief normalization replaces a model-supplied character range with the verified page label", () => {
  const brief = normalizeStructuredBrief(
    {
      content_strategy: "summarized_context",
      original_reading_method: "document_retrieval",
      key_facts: [{
        evidence_id: "evidence-1",
        fact: "The fund received USD 2,524.28 million.",
        source_label: "characters:0-9999",
        excerpt: "exactly USD 2,524.28 million",
      }],
      must_include: [{ requirement: "Preserve the exact figure.", evidence_ids: ["evidence-1"] }],
      must_avoid: [],
      recommended_storyline: [],
      gaps: [],
      unread_content: [],
    },
    (excerpt) => isSourceSupportedExcerpt(excerpt, pagedPdfText),
    "document_retrieval",
    [],
    (excerpt) => pdfSourceLabelForExcerpt(excerpt, pagedPdfText),
  );

  assert.equal(brief.key_facts[0]?.source_label, "page:12");
});

test("chunked PDF defers page-label canonicalization until split page headings and bodies are recombined", async () => {
  const pageHeadingChunk = "# Page 105\n\n## Native text";
  const pageBody = "In 2025, cumulative financing leveraged through URTF support reached $3.1 billion.";
  const extractedText = `${pageHeadingChunk}\n\n${pageBody}`;
  const pageBodyOffset = extractedText.indexOf(pageBody);
  const source = {
    uploaded_source_id: "source-pdf",
    original_filename: "annual-report.pdf",
    extension: ".pdf",
  } as unknown as UploadedSourceMaterial;
  const preflight = {
    source_id: source.uploaded_source_id,
    filename: source.original_filename,
    file_type: "pdf",
    content_strategy: "summarized_context",
    original_reading_method: "document_read",
    character_count: extractedText.length,
    token_estimate: 400_001,
    warnings: [],
  } as unknown as UploadedSourcePreflightResult;
  const workspace = { workspace_dir: "C:\\workspace" } as WorkspaceResult;
  let finalPrompt = "";
  const evidenceFact = {
    evidence_id: "evidence-1",
    fact: "URTF support reached $3.1 billion.",
    source_label: "page:112",
    excerpt: pageBody,
  };

  const completionClient: AttachmentBriefCompletionClient = {
    async complete(input) {
      const mode = input.metadata?.mode;
      const chunkId = input.metadata?.chunk_id;
      const keyFacts = mode === "chunk" && chunkId === "chunk-002"
        ? [evidenceFact]
        : [];
      if (mode === "final") finalPrompt = input.prompt;
      const rawText = JSON.stringify({
        ...(mode === "final" ? {
          content_strategy: "summarized_context",
          original_reading_method: "document_retrieval",
          relationship_to_task: "Relevant annual-report evidence.",
          main_message: "URTF financing evidence.",
        } : {
          chunk_id: chunkId,
          progress_summary: "Chunk evidence.",
        }),
        key_facts: mode === "final"
          ? [evidenceFact]
          : keyFacts,
        must_include: mode === "final"
          ? [{ requirement: "Preserve the financing figure.", evidence_ids: ["evidence-1"] }]
          : [],
        must_avoid: [],
        recommended_storyline: [],
        gaps: [],
        unread_content: [],
      });
      return {
        value: await input.accept(rawText, {}),
        attempts: [],
        requested_model: "test-model",
        actual_model: "test-model",
        token_usage: null,
      };
    },
  };
  const backend = {
    async listUploadedSources() {
      return { active: [source] };
    },
    async getUploadedSourcePreflightChunks() {
      return {
        chunks: [
          {
            chunk_id: "chunk-001",
            heading_path: ["Page 105", "Native text"],
            source_range: `characters:0-${pageHeadingChunk.length}`,
            start_offset: 0,
            end_offset: pageHeadingChunk.length,
            token_estimate: 20,
          },
          {
            chunk_id: "chunk-002",
            heading_path: ["Page 112", "OCR text"],
            source_range: `characters:${pageBodyOffset}-${extractedText.length}`,
            start_offset: pageBodyOffset,
            end_offset: extractedText.length,
            token_estimate: 30,
          },
        ],
      };
    },
    async getUploadedSourcePreflightText(request: { offset?: number; limit?: number }) {
      const offset = request.offset ?? 0;
      const end = offset + (request.limit ?? extractedText.length);
      return {
        content: extractedText.slice(offset, end),
        offset,
        next_offset: end < extractedText.length ? end : null,
        total_characters: extractedText.length,
        complete: end >= extractedText.length,
        truncated: end < extractedText.length,
      };
    },
    async recordAttachmentBrief(request: { brief: AttachmentBrief }) {
      return request.brief;
    },
    async writeAttachmentContext() {
      return {};
    },
  } as unknown as PptBackend;

  const briefs = await ensureAttachmentBriefs({
    backend,
    completionClient,
    workspace,
    userBrief: "Preserve exact figures and cite PDF pages.",
    preflightRun: { results: [preflight] },
  });

  assert.match(finalPrompt, /"source_label":"page:105"/);
  assert.equal(briefs[0]?.key_facts[0]?.source_label, "page:105");
});

test("PDF prompts conditionally preserve explicit precision, status, prohibition, coverage, and page requirements", () => {
  const source = {
    sourceId: "source-pdf",
    filename: "annual-report.pdf",
    userBrief: "Preserve exact figures, distinguish completed results from plans, cite PDF pages, and do not infer causality.",
    originalReadingMethod: "document_retrieval" as const,
    warnings: [],
  };
  const chunkPrompt = buildAttachmentBriefChunkPrompt({
    ...source,
    chunk: {
      chunkId: "chunk-001",
      totalChunks: 1,
      headingPath: ["Page 12"],
      sourceRange: "characters:0-500",
      content: pagedPdfText,
    },
  });
  const finalPrompt = buildAttachmentBriefFinalPrompt({ ...source, packets: [] });

  for (const prompt of [chunkPrompt, finalPrompt]) {
    assert.match(prompt, /如果用户明确要求保留精确数字/);
    assert.match(prompt, /如果用户明确要求区分事实状态/);
    assert.match(prompt, /must_avoid/);
    assert.match(prompt, /gaps/);
    assert.match(prompt, /page:N/);
  }
  assert.match(chunkPrompt, /"source_label":"page:12"/);
});
