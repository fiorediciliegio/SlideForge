import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { BatchTestRunRecord } from "../../src/api/types.ts";
import { BatchTestingRunPage } from "../../src/features/batch-testing/BatchTestingRunPage.tsx";
import { createRequirementsDraft } from "../../src/features/requirements/presentationRequirements.ts";
import { createIdleBatchTestCaseDetail, createIdleBatchTestingState } from "../../src/features/batch-testing/types.ts";
import { messages } from "../../src/i18n/messages.ts";

const run: BatchTestRunRecord = {
  version: 1,
  test_id: "batch-test",
  target_stage: "requirements-confirmed",
  status: "running",
  root_dir: "/tmp/batch-test",
  manifest_path: "/tmp/batch-test/batch-test.json",
  created_at: "2026-08-22T00:00:00.000Z",
  started_at: "2026-08-22T00:00:01.000Z",
  ended_at: null,
  updated_at: "2026-08-22T00:02:00.000Z",
  cases: [{
    case_id: "brief-001-001",
    brief_id: "brief-001",
    brief: "制作团队沟通培训演示",
    repetition: 1,
    total_repetitions: 1,
    status: "completed",
    case_dir: "/tmp/batch-test/brief-001-001",
    workspace_dir: "/tmp/batch-test/brief-001-001/workspace/ppt-20260822-000000",
    workspace_id: "ppt-20260822-000000",
    performance_dir: "/tmp/batch-test/brief-001-001/performance",
    started_at: "2026-08-22T00:00:01.000Z",
    ended_at: "2026-08-22T00:02:00.000Z",
    error: null,
    pptx_path: null,
  }],
};

test("running batch details hide completion time and show research choices with reasons", () => {
  const requirements = createRequirementsDraft("制作团队沟通培训演示", {
    slide_count: [10],
    output_language: ["中文"],
  }, null, {
    web: { recommended: true, enabled: true, reason: "需要补充近期管理实践。" },
    images: { recommended: false, enabled: false, reason: "该主题不依赖外部图片。" },
  });
  const detail = {
    ...createIdleBatchTestCaseDetail(),
    requirements,
  };
  const state = {
    ...createIdleBatchTestingState(true),
    busy: true,
    run,
    selectedRun: run,
    cases: run.cases,
    caseDetails: { "brief-001-001": detail },
  };
  const html = renderToStaticMarkup(createElement(BatchTestingRunPage, {
    t: messages.zh,
    locale: "zh",
    state,
    run,
    onBack: () => undefined,
    onDownload: async () => undefined,
    onStop: async () => undefined,
    onDelete: async () => undefined,
    onLoadCase: async () => undefined,
    onLoadImages: async () => undefined,
  }));

  assert.match(html, /完成时间<\/span><strong>-<\/strong>/);
  assert.match(html, /Web 搜索/);
  assert.match(html, /图片搜索/);
  assert.match(html, /最终选择/);
  assert.match(html, /系统推荐/);
  assert.match(html, /需要补充近期管理实践/);
  assert.match(html, /该主题不依赖外部图片/);
});
