import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PptxExportJob } from "../../src/api/types.ts";
import {
  createArtifactExportProgress,
  createExportDownloadPreparingProgress,
  createExportStartProgress,
  createIdleExportProgress,
  createPptxJobExportProgress,
  isPptxExportJobRunning,
} from "../../src/features/deck-workspace/exportProgressDisplay.ts";
import type { ExportArtifact } from "../../src/features/deck-workspace/types.ts";
import { messages } from "../../src/i18n/messages.ts";

function makePptxJob(overrides: Partial<PptxExportJob>): PptxExportJob {
  return {
    version: 2,
    job_id: "job-1",
    status: "queued",
    message: "Queued for PPTX export.",
    percent: 5,
    workspace_dir: "/tmp/workspaces/demo",
    status_path: "/tmp/workspaces/demo/output/pptx-export.json",
    output_dir: "/tmp/workspaces/demo/output",
    deck_html_path: "",
    pptx_path: "/tmp/workspaces/demo/output/deck.pptx",
    started_at: null,
    updated_at: null,
    completed_at: null,
    error: null,
    warnings: [],
    warning_count: 0,
    ...overrides,
  };
}

describe("Export Progress Display", () => {
  it("shows an idle empty progress state when no artifact exists", () => {
    assert.deepEqual(createIdleExportProgress(messages.zh), {
      type: null,
      mode: "idle",
      message: "暂无可下载文件",
      percent: 0,
      active: false,
    });
  });

  it("maps an existing artifact to a completed progress state", () => {
    const artifact: ExportArtifact = {
      type: "PPTX",
      path: "/tmp/workspaces/demo/output/deck.pptx",
      fileName: "deck.pptx",
      updatedAt: "2026-07-18T10:00:00Z",
      mirrorStatus: "ready",
    };

    assert.deepEqual(createArtifactExportProgress(messages.en, artifact), {
      type: "PPTX",
      mode: "complete",
      message: "PPTX ready",
      percent: 100,
      active: false,
    });
  });

  it("uses an indeterminate bar while either export format is active", () => {
    assert.equal(createExportStartProgress(messages.zh, "PPTX").mode, "indeterminate");
    assert.equal(createExportStartProgress(messages.zh, "PDF").mode, "indeterminate");
    assert.deepEqual(createExportDownloadPreparingProgress(messages.zh, "PPTX"), {
      type: "PPTX",
      mode: "indeterminate",
      message: "准备下载...",
      percent: 0,
      active: true,
    });
  });

  it("uses localized PPTX job status text and real percent", () => {
    assert.deepEqual(
      createPptxJobExportProgress(messages.zh, makePptxJob({
        status: "converting",
        percent: 75,
      })),
      {
        type: "PPTX",
        mode: "indeterminate",
        message: "正在生成 PPTX 文件",
        percent: 75,
        active: true,
      },
    );
  });

  it("keeps page-level progress when reconnecting to an isolated page export", () => {
    assert.deepEqual(
      createPptxJobExportProgress(messages.en, makePptxJob({
        status: "converting",
        percent: 64,
        current_page: 3,
        total_pages: 7,
        export_phase: "rendering",
      })),
      {
        type: "PPTX",
        mode: "determinate",
        message: "Rendering page 3 of 7",
        percent: 64,
        active: true,
      },
    );
    assert.deepEqual(
      createPptxJobExportProgress(messages.en, makePptxJob({
        status: "converting",
        percent: 92,
        current_page: 7,
        total_pages: 7,
        export_phase: "merging",
      })),
      {
        type: "PPTX",
        mode: "determinate",
        message: "Combining 7 rendered pages",
        percent: 92,
        active: true,
      },
    );
  });

  it("maps failed jobs to a non-breathing error state", () => {
    assert.deepEqual(
      createPptxJobExportProgress(messages.en, makePptxJob({
        status: "failed",
        message: "Generator failed",
        percent: 100,
      })),
      {
        type: "PPTX",
        mode: "error",
        message: "Generator failed",
        percent: 100,
        active: false,
      },
    );
  });

  it("does not expose managed font warnings after export completes", () => {
    assert.deepEqual(
      createPptxJobExportProgress(messages.zh, makePptxJob({
        status: "completed",
        percent: 100,
        warnings: ["Portable Demo: bold, italic"],
        font_embed_warnings: ["Portable Demo: font embedding failed"],
        warning_count: 2,
      })),
      {
        type: "PPTX",
        mode: "complete",
        message: "PPTX 已就绪",
        percent: 100,
        active: false,
      },
    );
  });

  it("treats queued and in-flight jobs as resumable so a rerender never starts a second export", () => {
    for (const status of ["queued", "validating", "converting"] as const) {
      assert.equal(isPptxExportJobRunning(makePptxJob({ status })), true, status);
    }
  });

  it("allows a new export once the previous job settled or never existed", () => {
    for (const status of ["idle", "completed", "failed"] as const) {
      assert.equal(isPptxExportJobRunning(makePptxJob({ status })), false, status);
    }
    assert.equal(isPptxExportJobRunning(null), false);
    assert.equal(isPptxExportJobRunning(undefined), false);
  });
});
