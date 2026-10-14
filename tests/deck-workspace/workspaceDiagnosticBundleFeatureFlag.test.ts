import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceResult } from "../../src/api/types.ts";
import { LibraryPage } from "../../src/features/deck-workspace/components/LibraryPage.tsx";
import type {
  AgentResourceInfoState,
  PerformanceTestingState,
} from "../../src/features/deck-workspace/types.ts";
import { messages } from "../../src/i18n/messages.ts";

const workspace: WorkspaceResult = {
  workspace_root: "/tmp/workspaces",
  workspace_dir: "/tmp/workspaces/demo",
  workspace_id: "demo",
  initialized: true,
  created_files: [],
  missing_files: [],
  files: {
    task: "/tmp/workspaces/demo/task.json",
    setting: "/tmp/workspaces/demo/setting.json",
    outline: "/tmp/workspaces/demo/outline.json",
    pages: "/tmp/workspaces/demo/pages.json",
    template: "/tmp/workspaces/demo/template.json",
  },
  task: { title: "Demo" },
  setting: {},
  outline: {},
  pages: [],
  template: {},
};

const agentResourceInfo: AgentResourceInfoState = {
  enabled: false,
  loading: false,
  error: "",
  info: null,
};

const performanceTesting: PerformanceTestingState = {
  enabled: false,
  supported: false,
  loading: false,
  busy: false,
  error: "",
  activeRun: null,
  runs: [],
  reportHtml: "",
  reportRunId: null,
};

function renderSettings(workspaceDiagnosticBundleEnabled: boolean): string {
  return renderToStaticMarkup(createElement(LibraryPage, {
    t: messages.zh,
    locale: "zh",
    settings: {},
    currentWorkspace: workspace,
    loading: false,
    savingSettings: false,
    runtimeInfo: null,
    runtimeInfoError: "",
    agentResourceInfo,
    onBack: () => undefined,
    onSaveSettings: async () => undefined,
    onSaveTitle: async () => undefined,
    workspaceDiagnosticBundleEnabled,
    workspaceDiagnosticBundle: { status: "idle", message: "" },
    onDownloadWorkspaceDiagnosticBundle: async () => undefined,
    onResetWorkspaceDiagnosticBundle: () => undefined,
    performanceTesting,
    onRefreshPerformanceRuns: async () => undefined,
    onRefreshAgentResourceInfo: async () => undefined,
    onStartPerformanceRun: async () => undefined,
    onFinalizePerformanceRun: async () => undefined,
    onAbandonPerformanceRun: async () => undefined,
    onViewPerformanceReport: async () => undefined,
    onRegeneratePerformanceReport: async () => undefined,
    onDeletePerformanceRun: async () => undefined,
  }));
}

describe("Workspace Diagnostic Bundle feature flag", () => {
  it("reads the Vite flag as an explicit true-only switch", async () => {
    const source = await readFile(path.resolve(
      "src/features/deck-workspace/hooks/useDeckWorkspace.ts",
    ), "utf8");

    assert.match(
      source,
      /VITE_WORKSPACE_DIAGNOSTIC_BUNDLE_ENABLED === "true"/,
    );
  });

  it("hides only the diagnostic bundle controls when disabled", () => {
    const html = renderSettings(false);

    assert.match(html, /当前任务/);
    assert.doesNotMatch(html, /问题排查包/);
  });

  it("shows the diagnostic bundle controls when enabled", () => {
    const html = renderSettings(true);

    assert.match(html, /问题排查包/);
    assert.match(html, /下载问题排查包/);
  });
});
