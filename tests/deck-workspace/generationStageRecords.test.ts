import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { messages } from "../../src/i18n/messages.ts";
import type { DeckGenerationProgress } from "../../src/features/deck-generation/index.ts";
import { buildPageGenerationStageRecords } from "../../src/features/deck-workspace/generationStageRecords.ts";
import type { GenerationStreamSnapshot } from "../../src/features/deck-workspace/types.ts";

function makeProgress(overrides: Partial<DeckGenerationProgress> = {}): DeckGenerationProgress {
  return {
    step: "page-authoring",
    message: "Generating 2 pages",
    currentPageIndex: 0,
    totalPages: 2,
    pages: [
      {
        page_id: "page-02",
        index: 1,
        title: "Second",
        status: "rendering",
        render_attempts: 0,
        render_attempt_limit: 10,
        visual_review_attempts: 0,
        visual_review_attempt_limit: 5,
        agent_failures: 0,
        agent_failure_limit: 5,
        agent_infrastructure_failures: 0,
      },
      {
        page_id: "page-01",
        index: 0,
        title: "First",
        status: "authoring",
        render_attempts: 0,
        render_attempt_limit: 10,
        visual_review_attempts: 0,
        visual_review_attempt_limit: 5,
        agent_failures: 0,
        agent_failure_limit: 5,
        agent_infrastructure_failures: 0,
      },
    ],
    ...overrides,
  };
}

describe("Page Generation Stage Records", () => {
  it("页面会话最终超时显示服务繁忙，保留可恢复状态和诊断错误", () => {
    const progress = makeProgress({ step: "failed", activeStreams: [] });
    const raw = "Agent stream idle timeout after 180000ms";
    progress.pages[0].status = "agent_infrastructure_failed";
    progress.pages[0].last_error = raw;
    for (const locale of ["zh", "en", "ja", "de"] as const) {
      const t = messages[locale];
      const records = buildPageGenerationStageRecords({ t, progress, history: [] });
      const page = records.find((record) => record.pageId === "page-02")!;
      assert.equal(page.pageStatusLabel, t.errors.summaryModelBusy);
      assert.equal(page.state, "pending");
      assert.equal(page.stages[0].label, t.errors.summaryModelBusy);
    }
    assert.equal(progress.pages[0].last_error, raw);
  });

  it("页面会话额度耗尽显示额度提示，保留诊断错误", () => {
    const progress = makeProgress({ step: "failed", activeStreams: [] });
    const raw = "Agent stream error: Quota exhausted, unable to continue using Anna service.";
    progress.pages[0].status = "agent_infrastructure_failed";
    progress.pages[0].last_error = raw;
    for (const locale of ["zh", "en", "ja", "de"] as const) {
      const t = messages[locale];
      const records = buildPageGenerationStageRecords({ t, progress, history: [] });
      const page = records.find((record) => record.pageId === "page-02")!;
      assert.equal(page.pageStatusLabel, t.errors.summaryQuotaExceeded);
      assert.equal(page.stages[0].label, t.errors.summaryQuotaExceeded);
    }
    assert.equal(progress.pages[0].last_error, raw);
  });

  it("groups active streams and completed snapshots by page", () => {
    const progress = makeProgress({
      activeStreams: [
        {
          run_id: "run-1",
          kind: "authoring",
          page_id: "page-01",
          page_index: 0,
          status: "正在思考第 1 页的表达",
          lines: ["writing"],
          activities: ["read outline"],
        },
      ],
    });
    const history: GenerationStreamSnapshot[] = [
      {
        id: "page-visual-review:page-01:review-1",
        phase: "page-authoring",
        kind: "authoring",
        label: "第 1 页 · page-visual-review",
        page_id: "page-01",
        page_index: 0,
        status: "completed",
        message: "done",
        lines: ["reviewed"],
        activities: [],
        updated_at: "2026-06-02T00:00:00.000Z",
      },
    ];

    const records = buildPageGenerationStageRecords({
      t: messages.zh,
      progress,
      history,
    });

    assert.deepEqual(records.map((record) => record.pageId), ["page-01", "page-02"]);
    assert.equal(records[0].stages.some((stage) => stage.label === "正在思考第 1 页的表达"), true);
    assert.equal(records[0].stages.some((stage) => stage.lines.includes("writing")), true);
    assert.equal(records[0].stages.some((stage) => stage.lines.includes("reviewed")), true);
  });

  it("does not duplicate the active stream when history has the same snapshot id", () => {
    const progress = makeProgress({
      activeStreams: [
        {
          run_id: "run-1",
          kind: "authoring",
          page_id: "page-01",
          page_index: 0,
          status: "Thinking through page 1",
          lines: ["active"],
          activities: [],
        },
      ],
    });
    const history: GenerationStreamSnapshot[] = [
      {
        id: "page-authoring:page-01:run-1",
        phase: "page-authoring",
        kind: "authoring",
        label: "Page 1 · authoring",
        page_id: "page-01",
        page_index: 0,
        status: "Thinking through page 1",
        message: "Generating",
        lines: ["older"],
        activities: [],
        updated_at: "2026-06-02T00:00:00.000Z",
      },
    ];

    const records = buildPageGenerationStageRecords({
      t: messages.en,
      progress,
      history,
    });
    const authoringStages = records[0].stages.filter((stage) => stage.stageKey === "authoring");

    assert.equal(authoringStages.length, 1);
    assert.deepEqual(authoringStages[0].lines, ["active"]);
  });

  it("creates a truthful tool stage for rendering without stream output", () => {
    const records = buildPageGenerationStageRecords({
      t: messages.en,
      progress: makeProgress(),
      history: [],
    });
    const secondPage = records.find((record) => record.pageId === "page-02");
    const renderingStage = secondPage?.stages.find((stage) => stage.stageKey === "rendering");

    assert.equal(renderingStage?.label, "Rendering page");
    assert.equal(renderingStage?.hasStream, false);
    assert.equal(renderingStage?.state, "active");
  });

  it("uses locale labels instead of raw internal statuses", () => {
    const zhRecords = buildPageGenerationStageRecords({
      t: messages.zh,
      progress: makeProgress(),
      history: [],
    });
    const enRecords = buildPageGenerationStageRecords({
      t: messages.en,
      progress: makeProgress(),
      history: [],
    });

    assert.equal(zhRecords[0].pageStatusLabel, "正在思考这一页");
    assert.equal(enRecords[0].pageStatusLabel, "Thinking through this page");
    assert.notEqual(zhRecords[0].pageStatusLabel, "authoring");
    assert.notEqual(enRecords[0].pageStatusLabel, "authoring");
  });

  it("orders completed attempts and active work by their actual timeline", () => {
    const progress = makeProgress({
      step: "page-authoring",
      message: "正在生成 1 页，0/1 页已通过",
      totalPages: 1,
      pages: [
        {
          page_id: "page-01",
          index: 0,
          title: "First",
          status: "authoring",
          render_attempts: 0,
          render_attempt_limit: 10,
          visual_review_attempts: 1,
          visual_review_attempt_limit: 5,
          agent_failures: 0,
          agent_failure_limit: 5,
          agent_infrastructure_failures: 0,
        },
      ],
      activeStreams: [
        {
          run_id: "page-01-page-visual-review-run-2",
          kind: "authoring",
          page_id: "page-01",
          page_index: 0,
          status: "正在检查页面视觉",
          lines: ["current attempt"],
          activities: [],
          started_at: "2026-06-02T00:00:03.000Z",
          updated_at: "2026-06-02T00:00:04.000Z",
        },
      ],
    });
    const history: GenerationStreamSnapshot[] = [
      {
        id: "page-visual-review:page-01:run-1",
        phase: "page-authoring",
        kind: "authoring",
        label: "第 1 页 · page-visual-review",
        page_id: "page-01",
        page_index: 0,
        status: "completed",
        message: "done",
        lines: ["first attempt"],
        activities: [],
        updated_at: "2026-06-02T00:00:01.000Z",
      },
      {
        id: "page-authoring:page-01:fix-1",
        phase: "page-authoring",
        kind: "authoring",
        label: "第 1 页 · visual-review-fix",
        page_id: "page-01",
        page_index: 0,
        status: "completed",
        message: "done",
        lines: ["second attempt"],
        activities: [],
        updated_at: "2026-06-02T00:00:02.000Z",
      },
    ];

    const records = buildPageGenerationStageRecords({
      t: messages.zh,
      progress,
      history,
    });

    assert.deepEqual(
      records[0].stages.filter((stage) => stage.hasStream).flatMap((stage) => stage.lines),
      ["first attempt", "second attempt", "current attempt"],
    );
    assert.equal(records[0].stages.at(-1)?.state, "active");
  });

});

it("localizes layout phases independently for concurrent pages and language switches", () => {
  const progress = makeProgress();
  progress.pages[0].status = "layout_checking";
  progress.pages[1].status = "layout_rewriting";
  progress.activeStreams = [
    { kind: "page-layout-check", page_id: "page-02", page_index: 1, status: "layout_checking", lines: [], activities: [] },
    { kind: "page-layout-rewrite", page_id: "page-01", page_index: 0, status: "layout_rewriting", lines: [], activities: [] },
  ];
  for (const locale of ["zh", "en"] as const) {
    const records = buildPageGenerationStageRecords({ t: messages[locale], progress, history: [] });
    assert.doesNotMatch(records[0].pageStatusLabel, /layout_rewriting/);
    assert.equal(records[0].stages[0].label, messages[locale].generating.stageRecords.stages.layoutRewriting);
    assert.equal(records[1].stages[0].label, messages[locale].generating.stageRecords.stages.layoutChecking);
    assert.equal(records[0].state, "active");
  }
  progress.activeStreams = [];
  progress.pages[0].status = "layout_check_failed";
  const failed = buildPageGenerationStageRecords({ t: messages.zh, progress, history: [] });
  assert.equal(failed[1].state, "failed");
  assert.equal(failed[1].pageStatusLabel, "布局检查失败");
});

it("并发邻页切换阶段不会改变本页阶段标识，真实重试仍有独立标识", () => {
  const stream = { kind: "page-layout-check", run_id: "page-01:1:0", page_id: "page-01", page_index: 0,
    status: "layout_checking", lines: [], activities: [] };
  const record = (step: DeckGenerationProgress["step"], runId = stream.run_id) =>
    buildPageGenerationStageRecords({ t: messages.zh, history: [], progress: makeProgress({ step,
      activeStreams: [{ ...stream, run_id: runId }] }) })[0].stages[0];
  const first = record("page-layout-check");
  assert.equal(record("page-authoring").id, first.id);
  assert.equal(record("page-layout-rewrite").id, first.id);
  assert.notEqual(record("page-layout-check", "page-01:2:0").id, first.id);
});
