import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expandBatchTestInput,
  parseBatchTestJson,
  parseBatchTestText,
} from "../../src/features/batch-testing/input.ts";
import { batchTestTargetIncludes } from "../../src/features/batch-testing/types.ts";

test("orders batch targets from requirements through PPTX export", () => {
  assert.equal(batchTestTargetIncludes("requirements-confirmed", "web-research-completed"), false);
  assert.equal(batchTestTargetIncludes("image-research-completed", "outline-confirmed"), true);
  assert.equal(batchTestTargetIncludes("pptx-exported", "image-research-completed"), true);
});

test("parses blank-line Briefs and expands the configured repetitions", () => {
  const input = parseBatchTestText("第一份 Brief\n\n第二份 Brief", 2, "zh");
  assert.equal(input.target_stage, "pptx-exported");
  assert.deepEqual(expandBatchTestInput(input, "zh"), [
    {
      case_id: "brief-001-001",
      brief_id: "brief-001",
      brief: "第一份 Brief",
      repetition: 1,
      total_repetitions: 2,
    },
    {
      case_id: "brief-001-002",
      brief_id: "brief-001",
      brief: "第一份 Brief",
      repetition: 2,
      total_repetitions: 2,
    },
    {
      case_id: "brief-002-001",
      brief_id: "brief-002",
      brief: "第二份 Brief",
      repetition: 1,
      total_repetitions: 2,
    },
    {
      case_id: "brief-002-002",
      brief_id: "brief-002",
      brief: "第二份 Brief",
      repetition: 2,
      total_repetitions: 2,
    },
  ]);
});

test("accepts JSON arrays and per-Brief repetition overrides", () => {
  const input = parseBatchTestJson(JSON.stringify({
    test_id: "weekly-regression",
    repeat: 2,
    target_stage: "image-research-completed",
    briefs: [
      { id: "market-review", brief: "市场复盘", repeat: 1 },
      { brief: "产品路线图" },
    ],
  }), "zh");

  assert.equal(input.test_id, "weekly-regression");
  assert.equal(input.target_stage, "image-research-completed");
  assert.deepEqual(expandBatchTestInput(input, "zh").map((item) => item.case_id), [
    "market-review-001",
    "brief-002-001",
    "brief-002-002",
  ]);
});

test("accepts Requirements reuse only for Requirements-confirmed batch tests", () => {
  const input = parseBatchTestJson(JSON.stringify({
    repeat: 3,
    target_stage: "requirements-confirmed",
    reuse_requirements: true,
    briefs: [{ brief: "测试模板推荐" }],
  }), "zh");

  assert.equal(input.reuse_requirements, true);
  assert.throws(
    () => parseBatchTestJson(JSON.stringify({
      target_stage: "pptx-exported",
      reuse_requirements: true,
      briefs: [{ brief: "测试模板推荐" }],
    }), "zh"),
    /reuse_requirements 只能用于 requirements-confirmed/,
  );
});

test("accepts research routing prompt version v11", () => {
  const input = parseBatchTestJson(JSON.stringify({
    target_stage: "research-routing-completed",
    briefs: [{ id: "case-001", brief: "Check v11 routing" }],
    research_routing: {
      git_commit: "a".repeat(40),
      prompts: [{
        prompt_version: "v11",
        prompt: "Prompt body",
        prompt_hash: "b".repeat(64),
      }],
      expected_by_brief_id: {
        "case-001": { web: false, images: false },
      },
    },
  }), "en");
  assert.equal(input.research_routing?.prompts[0]?.prompt_version, "v11");
});

test("imports generated default and v11 batches without changing the 50 cases", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "ppt-routing-input-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../../evals/research-routing/scripts/build-stage1-batch-input.mjs", import.meta.url));
  const saved = JSON.parse(readFileSync(new URL("../../evals/research-routing/config/stage1-smoke-v11-batch-input.json", import.meta.url), "utf8"));
  for (const versions of [[], ["--prompt", "v11"]]) {
    const output = join(temp, "input.json");
    execFileSync(process.execPath, [script, ...versions, "--output", output]);
    const raw = JSON.parse(readFileSync(output, "utf8"));
    const input = parseBatchTestJson(JSON.stringify(raw), "en");
    assert.equal(input.research_routing?.prompts.length, versions.length ? 1 : 11);
    assert.equal(expandBatchTestInput(input, "en").length, versions.length ? 50 : 550);
    assert.deepEqual(raw.briefs, saved.briefs);
    assert.deepEqual(raw.research_routing.expected_by_brief_id, saved.research_routing.expected_by_brief_id);
    assert.deepEqual(raw.research_routing.prompts.find((item: { prompt_version: string }) => item.prompt_version === "v11"), saved.research_routing.prompts[0]);
  }
});

test("keeps page refinement classification limited to v1 through v10", () => {
  const input = (version: string) => JSON.stringify({
    target_stage: "page-refinement-classification-completed",
    briefs: [{ brief: "Classify this request" }],
    page_refinement_classification: {
      git_commit: "a".repeat(40),
      prompts: [{ prompt_version: version, prompt: "Prompt body", prompt_hash: "b".repeat(64) }],
    },
  });
  assert.equal(parseBatchTestJson(input("v10"), "en").page_refinement_classification?.prompts[0]?.prompt_version, "v10");
  assert.throws(() => parseBatchTestJson(input("v11"), "en"), /Invalid or duplicated page refinement classification prompt v11/);
});

test("builds requirements prompts without attachment context", async () => {
  const { buildPresentationRequirementsRequest } = await import("../../src/ai/requirementsPrompt.ts");
  const request = buildPresentationRequirementsRequest("Brief", "English", null, true, null);
  assert.equal(request.messages[0]?.role, "system");
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[1]?.role, "user");
});

test("accepts confirmed supplied Requirements only for outline-only batch tests", () => {
  const providedRequirements = {
    version: 1,
    status: "confirmed",
    source: { brief: "Canonical brief from the Requirements fixture" },
    research: {
      web: { enabled: false },
      images: { enabled: false },
    },
  };
  const input = parseBatchTestJson(JSON.stringify({
    target_stage: "outline-confirmed",
    briefs: [{
      id: "outline-fixture",
      brief: "The separate workbook Brief is retained only as case metadata",
      provided_requirements: providedRequirements,
    }],
  }), "en");
  const [batchCase] = expandBatchTestInput(input, "en");
  assert.equal(batchCase?.provided_requirements?.source?.brief, providedRequirements.source.brief);
  assert.throws(
    () => parseBatchTestJson(JSON.stringify({
      target_stage: "requirements-confirmed",
      briefs: [{ brief: "Brief", provided_requirements: providedRequirements }],
    }), "en"),
    /provided_requirements can only be used with outline-confirmed/,
  );
});

test("accepts per-Brief Host Upload attachments and carries them into cases", () => {
  const input = parseBatchTestJson(JSON.stringify({
    target_stage: "requirements-confirmed",
    briefs: [{
      brief: "Use the attached notes",
      attachments: [{
        filename: "notes.pdf",
        mime_type: "application/pdf",
        size_bytes: 123,
        host_upload: { transport: "host_upload", r2_key: "key", url: "https://example.test/notes.pdf", mime_type: "application/pdf", size_bytes: 123 },
      }],
    }],
  }), "en");
  const [item] = expandBatchTestInput(input, "en");
  assert.equal(item?.attachments?.[0]?.filename, "notes.pdf");
  assert.equal(item?.attachments?.[0]?.host_upload.transport, "host_upload");
});

test("keeps empty attachment arrays compatible with normal batch inputs", () => {
  const input = parseBatchTestJson(JSON.stringify({
    target_stage: "pptx-exported",
    briefs: [{ brief: "Create a deck without attachments", attachments: [] }],
  }), "en");
  assert.deepEqual(expandBatchTestInput(input, "en")[0]?.attachments, []);
});

test("parses attachment-only fixtures and keeps their uploaded-source metadata", () => {
  const input = parseBatchTestJson(JSON.stringify({
    target_stage: "attachment-context-created",
    briefs: [{
      id: "pdf-fixture",
      brief: "根据附件里面的内容做一份介绍的PPT。",
      attachments: [{ filename: "annual-report.pdf", expected_strategy: "summarized_context" }],
    }],
  }), "zh");
  const attachment = input.briefs[0]?.attachments?.[0];
  assert.ok(attachment);
  Object.assign(attachment, {
    size_bytes: 42,
    host_upload: {
      transport: "host_upload",
      r2_key: "fixtures/annual-report.pdf",
      url: "https://example.test/annual-report.pdf",
      mime_type: "application/pdf",
      size_bytes: 42,
    },
  });
  const [batchCase] = expandBatchTestInput(input, "zh");
  assert.equal(batchCase?.attachments?.[0]?.filename, "annual-report.pdf");
  assert.equal(batchCase?.attachments?.[0]?.expected_strategy, "summarized_context");
  assert.doesNotThrow(
    () => parseBatchTestJson(JSON.stringify({
      target_stage: "requirements-confirmed",
      briefs: [{ brief: "Brief", attachments: [{ filename: "source.pdf" }] }],
    }), "en"),
  );
});

test("rejects invalid or duplicate Brief input with localized errors", () => {
  assert.throws(
    () => expandBatchTestInput(
      parseBatchTestJson(JSON.stringify({ briefs: [{ id: "same", brief: "a" }, { id: "same", brief: "b" }] }), "zh"),
      "zh",
    ),
    /Brief id 重复|Duplicate Brief id/,
  );
  assert.throws(
    () => parseBatchTestText("", 1, "en"),
    /Enter between 1 and 200 Briefs/,
  );
  assert.throws(
    () => parseBatchTestJson(JSON.stringify({ target_stage: "unknown", briefs: ["Brief"] }), "zh"),
    /target_stage/,
  );
});
