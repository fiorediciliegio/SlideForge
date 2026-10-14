import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createAppBatchTestRun,
  deleteAppBatchTestRun,
  listAppBatchTestRuns,
  prepareAppBatchTestBundle,
  updateAppBatchTestCase,
  updateAppBatchTestRun,
} from "../../src/app-workspace/index.ts";
import {
  appendPerformanceEvents,
  deletePerformanceRun,
  finalizePerformanceRun,
  materializePerformanceRun,
  startPerformanceRun,
} from "../../src/performance-runs/index.ts";

test("persists attachment parsing batch fixtures without starting deck generation", async () => {
  const testId = `attachment-batch-${randomUUID().slice(0, 8)}`;
  let created: Awaited<ReturnType<typeof createAppBatchTestRun>> | null = null;
  try {
    created = await createAppBatchTestRun({
      test_id: testId,
      target_stage: "attachment-context-created",
      cases: [{
        case_id: "pdf-001-001",
        brief_id: "pdf-001",
        brief: "根据附件里面的内容做一份介绍的PPT。",
        repetition: 1,
        total_repetitions: 1,
        attachments: [{
          filename: "annual-report.pdf",
          mime_type: "application/pdf",
          size_bytes: 42,
          host_upload: { transport: "host_upload", r2_key: "fixtures/annual-report.pdf", url: "https://example.test/annual-report.pdf", mime_type: "application/pdf", size_bytes: 42 },
          expected_strategy: "summarized_context",
        }],
      }],
    });
    const [batchCase] = created.run.cases;
    assert.equal(batchCase?.attachments, undefined);
    assert.equal(batchCase?.pptx_path, null);
    const persistedCase = JSON.parse(await readFile(path.join(batchCase!.case_dir, "case.json"), "utf8"));
    assert.equal(persistedCase.attachments?.[0]?.filename, "annual-report.pdf");
    assert.equal(persistedCase.attachments?.[0]?.expected_strategy, "summarized_context");
    const history = await listAppBatchTestRuns();
    assert.equal(history.runs.find((item) => item.test_id === testId)?.cases[0]?.attachments, undefined);
  } finally {
    if (created) await rm(created.run.root_dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

for (const target of ["requirements-confirmed", "web-research-completed", "outline-confirmed", "image-research-completed", "pptx-exported"] as const) {
  test(`${target} persists attachments for the complete batch workflow`, async () => {
    const upload = { transport: "host_upload" as const, r2_key: "notes.pdf", url: "https://example.test/notes.pdf", mime_type: "application/pdf", size_bytes: 42 };
    const created = await createAppBatchTestRun({
      test_id: `attachment-${target}-${randomUUID().slice(0, 8)}`,
      target_stage: target,
      cases: [{
        case_id: "notes-001", brief_id: "notes", brief: "Use the attached notes", repetition: 1, total_repetitions: 1,
        attachments: [{ filename: "notes.pdf", mime_type: "application/pdf", size_bytes: 42, host_upload: upload, expected_strategy: "full_context" }],
      }],
    });
    try {
      const persisted = JSON.parse(await readFile(path.join(created.run.cases[0]!.case_dir, "case.json"), "utf8"));
      assert.deepEqual(persisted.attachments, created.run.cases[0]!.attachments);
      assert.equal(persisted.attachments[0].host_upload.r2_key, upload.r2_key);
      assert.equal(persisted.attachments[0].expected_strategy, "full_context");
    } finally {
      await rm(created.run.root_dir, { recursive: true, force: true });
    }
  });
}

test("empty attachments remain valid for full batches but not attachment-only batches", async () => {
  const batchCase = {
    case_id: "empty-001", brief_id: "empty", brief: "Create a deck", repetition: 1, total_repetitions: 1, attachments: [],
  };
  const created = await createAppBatchTestRun({
    test_id: `empty-attachments-${randomUUID().slice(0, 8)}`,
    target_stage: "pptx-exported", cases: [batchCase],
  });
  try {
    assert.deepEqual(created.run.cases[0]?.attachments, []);
    await assert.rejects(createAppBatchTestRun({
      test_id: `empty-specialized-${randomUUID().slice(0, 8)}`,
      target_stage: "attachment-context-created", cases: [batchCase],
    }), /at least one attachment/);
  } finally {
    await rm(created.run.root_dir, { recursive: true, force: true });
  }
});

test("persists a template recommendation result in the batch case artifact", async () => {
  const created = await createAppBatchTestRun({
    test_id: `template-recommendation-${randomUUID().slice(0, 8)}`,
    target_stage: "template-recommendation-completed",
    cases: [{
      case_id: "template-001", brief_id: "template", brief: "季度经营复盘", repetition: 1, total_repetitions: 1,
    }],
  });
  const result = {
    preset: { id: "14-Quarterly Business Review", version: 1, name: "Quarterly Business Review", description: "Executive quarterly review" },
    trace: { input_tags: { use_case: ["business-review"], industry: [], audience: [], format: [], style: [] }, low_signal: false, candidates: [] },
  };
  try {
    const updated = await updateAppBatchTestCase({
      root_dir: created.run.root_dir,
      case_id: "template-001",
      status: "completed",
      template_recommendation_result: result,
    });
    assert.deepEqual(updated.cases[0]?.template_recommendation_result, result);
    const saved = JSON.parse(await readFile(path.join(created.run.cases[0]!.case_dir, "case.json"), "utf8"));
    assert.deepEqual(saved.template_recommendation_result, result);
  } finally {
    await rm(created.run.root_dir, { recursive: true, force: true });
  }
});

test("creates an isolated batch tree and materializes a complete performance report", async () => {
  const testId = `batch-light-${randomUUID().slice(0, 8)}`;
  let created: Awaited<ReturnType<typeof createAppBatchTestRun>> | null = null;
  let performanceRunId: string | null = null;
  let archivePath: string | null = null;
  try {
    created = await createAppBatchTestRun({
      test_id: testId,
      target_stage: "image-research-completed",
      cases: [
        {
          case_id: "brief-001-001",
          brief_id: "brief-001",
          brief: "测试一个销售复盘演示文稿",
          repetition: 1,
          total_repetitions: 1,
        },
        {
          case_id: "brief-002-001",
          brief_id: "brief-002",
          brief: "测试一个产品路线图演示文稿",
          repetition: 1,
          total_repetitions: 1,
        },
      ],
    });
    assert.equal(created.run.status, "queued");
    assert.equal(created.run.target_stage, "image-research-completed");
    assert.equal(created.run.started_at, null);
    assert.equal(created.run.ended_at, null);
    assert.equal(created.run.cases.length, 2);
    assert.notEqual(created.run.cases[0]?.workspace_id, created.run.cases[1]?.workspace_id);
    for (const item of created.run.cases) {
      assert.match(item.workspace_dir, /\/workspace\/ppt-\d{8}-\d{6}$/);
      assert.equal(JSON.parse(await readFile(path.join(item.case_dir, "case.json"), "utf8")).case_id, item.case_id);
      assert.equal((await stat(path.join(item.workspace_dir, "task.json"))).isFile(), true);
    }

    await assert.rejects(
      updateAppBatchTestCase({
        root_dir: created.run.root_dir,
        case_id: "brief-001-001",
        status: "invalid" as never,
      }),
      /Invalid batch test case status/,
    );

    const running = await updateAppBatchTestCase({
      root_dir: created.run.root_dir,
      case_id: "brief-001-001",
      status: "running",
    });
    assert.equal(running.cases[0]?.status, "running");
    assert.ok(running.started_at);
    assert.equal(running.ended_at, null);

    const performanceRun = await startPerformanceRun({ app_version: "test", environment: { mode: "batch-test" } });
    performanceRunId = performanceRun.run_id;
    await appendPerformanceEvents({
      run_id: performanceRun.run_id,
      events: [{
        schema_version: 1,
        event_id: "batch-test-event",
        event_type: "span.finished",
        recorded_at: new Date().toISOString(),
        producer_id: "batch-test",
        sequence_number: 1,
        operation_name: "batch.case",
        duration_ms: 1,
        status: "ok",
      }, {
        schema_version: 1,
        event_id: "batch-test-token-event",
        event_type: "token.usage",
        recorded_at: new Date().toISOString(),
        producer_id: "batch-test",
        sequence_number: 2,
        operation_name: "agent.session",
        attributes: {
          token_source: "session",
          token_calls: 1,
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      }],
    });
    const finalized = await finalizePerformanceRun({ run_id: performanceRun.run_id, locale: "zh", force: true });
    assert.equal(finalized.run.status, "completed");

    const performanceDir = created.run.cases[0]!.performance_dir;
    const materialized = await materializePerformanceRun({ run_id: performanceRun.run_id, destination_dir: performanceDir });
    assert.deepEqual(new Set(materialized.files.map((file) => path.basename(file))), new Set(["run.json", "events.jsonl", "report.html"]));
    assert.equal((await stat(path.join(performanceDir, "report.html"))).isFile(), true);

    const completedCase = await updateAppBatchTestCase({
      root_dir: created.run.root_dir,
      case_id: "brief-001-001",
      status: "completed",
      pptx_path: path.join(created.run.cases[0]!.workspace_dir, "output", "deck.pptx"),
      token_usage: finalized.run.token_usage,
    });
    assert.equal(completedCase.cases[0]?.pptx_path, path.join(created.run.cases[0]!.workspace_dir, "output", "deck.pptx"));
    assert.equal(completedCase.cases[0]?.token_usage?.session.total_tokens, 120);
    const afterLostResponse = await updateAppBatchTestCase({
      root_dir: created.run.root_dir,
      case_id: "brief-001-001",
      status: "failed",
      error: "executa process exited",
    });
    assert.deepEqual(afterLostResponse.cases[0], JSON.parse(JSON.stringify(completedCase.cases[0])));
    const savedCase = JSON.parse(await readFile(path.join(created.run.cases[0]!.case_dir, "case.json"), "utf8"));
    assert.equal(savedCase.status, "completed");
    const completedRun = await updateAppBatchTestRun({ root_dir: created.run.root_dir, status: "completed" });
    assert.equal(completedRun.status, "completed");
    assert.ok(completedRun.started_at);
    assert.ok(completedRun.ended_at);

    const history = await listAppBatchTestRuns();
    assert.ok(history.runs.some((item) => item.test_id === testId));

    const bundle = await prepareAppBatchTestBundle({ root_dir: created.run.root_dir });
    archivePath = bundle.archive_path;
    assert.equal(bundle.content_type, "application/zip");
    assert.match(bundle.filename, new RegExp(`^${testId}-batch-test\\.zip$`));
    assert.ok((await stat(bundle.archive_path)).size > 0);

    const deleted = await deleteAppBatchTestRun(created.run.root_dir);
    assert.deepEqual(deleted, { deleted: true, test_id: testId, root_dir: created.run.root_dir });
    created = null;
  } finally {
    if (archivePath) await unlink(archivePath).catch(() => undefined);
    if (performanceRunId) await deletePerformanceRun({ run_id: performanceRunId }).catch(() => undefined);
    if (created) await rm(created.run.root_dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("persists a page refinement classification-only batch result", async () => {
  const testId = `batch-classifier-${randomUUID().slice(0, 8)}`;
  let created: Awaited<ReturnType<typeof createAppBatchTestRun>> | null = null;
  try {
    created = await createAppBatchTestRun({
      test_id: testId,
      target_stage: "page-refinement-classification-completed",
      cases: [{
        case_id: "text-v1-001",
        brief_id: "text",
        brief: "把标题中的 2024 改成 2025",
        repetition: 1,
        total_repetitions: 1,
        page_refinement_classification: {
          prompt_version: "v1",
          prompt: "Return the required classification JSON.",
          prompt_hash: "a".repeat(64),
          git_commit: "a".repeat(40),
          requested_model: null,
          expected: {
            task_type: "exact_text_edit",
            execution_scope: "local",
            web_research: false,
            image_research: false,
          },
        },
      }],
    });
    const updated = await updateAppBatchTestCase({
      root_dir: created.run.root_dir,
      case_id: "text-v1-001",
      status: "completed",
      page_refinement_classification_result: {
        actual: {
          task_type: "exact_text_edit",
          execution_scope: "local",
          web_research: false,
          image_research: false,
          reason: "只需替换已知文字。",
        },
        requested_model: null,
        actual_model: "test-model",
        latency_ms: 12,
        token_usage: { input_tokens: 8, output_tokens: 4 },
        json_repair_count: 0,
        retry_count: 0,
        retry_reasons: [],
      },
    });
    assert.equal(updated.cases[0]?.page_refinement_classification_result?.actual.task_type, "exact_text_edit");
    assert.equal(updated.cases[0]?.page_refinement_classification_result?.actual_model, "test-model");
  } finally {
    if (created) await rm(created.run.root_dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
