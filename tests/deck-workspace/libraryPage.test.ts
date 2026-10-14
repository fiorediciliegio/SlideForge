import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GetWorkspaceSnapshotInfoResult, WorkspaceResult, WorkspaceSnapshotSyncState } from "../../src/api/types.ts";
import { LibraryPage } from "../../src/features/deck-workspace/components/LibraryPage.tsx";
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

function makeSyncState(patch: Partial<WorkspaceSnapshotSyncState> = {}): WorkspaceSnapshotSyncState {
  return {
    schema_version: 1,
    workspace_id: "demo",
    status: "completed",
    revision: "rev-3",
    source_updated_at: "2026-07-23T10:00:00Z",
    source_sha256: "a".repeat(64),
    snapshot_sha256: "b".repeat(64),
    snapshot_path: "/tmp/workspaces/demo/.snapshot-sync/snapshot.zip",
    snapshot_size_bytes: 4096,
    file_count: 6,
    attachments: [],
    generated_at: "2026-07-23T10:05:00Z",
    created_at: "2026-07-23T10:05:00Z",
    updated_at: "2026-07-23T10:05:00Z",
    error: null,
    publish: null,
    restore: null,
    ...patch,
  };
}

const snapshotInfo: GetWorkspaceSnapshotInfoResult = {
  workspace_id: "demo",
  revision: "rev-3",
  snapshot_path: "/tmp/workspaces/demo/.snapshot-sync/snapshot.zip",
  zip_sha256: "b".repeat(64),
  zip_sha256_matches_state: true,
  manifest: {
    workspace_id: "demo",
    revision: "rev-3",
    source_sha256: "a".repeat(64),
    source_updated_at: "2026-07-23T10:00:00Z",
    files: [],
    attachments: [],
    created_at: "2026-07-23T10:05:00Z",
  },
  entries: [],
  file_count: 6,
  missing_files: [],
  mismatched_files: [],
  all_files_verified: true,
};

type RenderOverrides = {
  t?: typeof messages.zh;
  settings?: Record<string, unknown>;
  currentWorkspace?: WorkspaceResult | null;
  snapshotInfo?: GetWorkspaceSnapshotInfoResult | null;
  snapshotSyncState?: WorkspaceSnapshotSyncState | null;
  workspaceDiagnosticBundleEnabled?: boolean;
  diagnosticTemplate?: { templates: { id: string; name: string }[]; selectedId: string; select: (id: string) => void };
};

function renderLibraryPage(overrides: RenderOverrides = {}) {
  const t = overrides.t ?? messages.zh;
  return renderToStaticMarkup(createElement(LibraryPage, {
    t,
    locale: t === messages.en ? "en" : "zh",
    settings: overrides.settings ?? {},
    currentWorkspace: overrides.currentWorkspace === undefined ? workspace : overrides.currentWorkspace,
    loading: false,
    savingSettings: false,
    runtimeInfo: null,
    runtimeInfoError: "",
    agentResourceInfo: { enabled: false, loading: false, error: "", info: null },
    snapshotInfo: overrides.snapshotInfo ?? null,
    snapshotSyncState: overrides.snapshotSyncState ?? null,
    onRefreshSnapshotInfo: async () => undefined,
    onBack: () => undefined,
    onSaveSettings: async () => undefined,
    onSaveTitle: async () => undefined,
    workspaceDiagnosticBundleEnabled: overrides.workspaceDiagnosticBundleEnabled ?? false,
    diagnosticTemplate: overrides.diagnosticTemplate,
    workspaceDiagnosticBundle: { status: "idle", message: "" },
    onDownloadWorkspaceDiagnosticBundle: async () => undefined,
    onResetWorkspaceDiagnosticBundle: () => undefined,
    performanceTesting: { enabled: false, supported: false, loading: false, busy: false, error: "", activeRun: null, runs: [], reportHtml: "", reportRunId: null },
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

describe("LibraryPage", () => {
  it("shows global preferences without a current workspace", () => {
    const html = renderLibraryPage({ currentWorkspace: null });

    assert.match(html, /设置/);
    assert.match(html, /页面生成并发数/);
    assert.doesNotMatch(html, /当前任务/);
  });

  it("renders the read-only cloud snapshot panel with revision and status", () => {
    const html = renderLibraryPage({
      snapshotInfo,
      snapshotSyncState: makeSyncState({
        publish: {
          status: "completed",
          job_id: "job-1",
          workspace_dir: "/tmp/workspaces/demo",
          revision: "rev-3",
          aps_path: "workspaces/demo/snapshot.zip",
          aps_meta_path: null,
          meta_json: null,
          snapshot_path: "/tmp/workspaces/demo/.snapshot-sync/snapshot.zip",
          source_updated_at: "2026-07-23T10:00:00Z",
          source_sha256: "a".repeat(64),
          snapshot_sha256: "b".repeat(64),
          snapshot_size_bytes: 4096,
          file_count: 6,
          attachments: [],
          last_synced_updated_at: "2026-07-23T10:05:00Z",
          last_synced_sha256: "a".repeat(64),
          mirror: null,
          started_at: null,
          updated_at: null,
          completed_at: null,
          error: null,
        },
      }),
    });

    assert.match(html, /snapshot-state-box/);
    assert.match(html, /云备份/);
    assert.match(html, /rev-3/);
    assert.match(html, /已完成/);
    assert.match(html, />6</);
    assert.doesNotMatch(html, /尚未备份到云端/);
  });

  it("reports when the workspace has no cloud snapshot", () => {
    const html = renderLibraryPage({ snapshotInfo: null, snapshotSyncState: null });

    assert.match(html, /snapshot-state-box/);
    assert.match(html, /当前任务尚未备份到云端/);
  });

  it("keeps the snapshot panel read-only with no actions", () => {
    const html = renderLibraryPage({
      snapshotInfo,
      snapshotSyncState: makeSyncState(),
    });

    assert.match(html, /snapshot-state-box/);
    assert.doesNotMatch(html, /snapshot-state-[\s\S]*?<button/);
    assert.equal(html.match(/data-performance-control="true"/g)?.length, 1);
  });
});

for (const locale of ["zh", "en", "ja", "de"] as const) it(`template diagnostics work without a deck in ${locale}`, () => {
  const t = messages[locale];
  const input = { t, currentWorkspace: null, workspaceDiagnosticBundleEnabled: true,
    diagnosticTemplate: { templates: [{ id: "user-test", name: "Template A" }], selectedId: "user-test", select: () => {} } };
  const html = renderLibraryPage(input);
  assert.ok(html.includes(t.userTemplates.diagnosticTarget));
  assert.ok(html.includes(t.userTemplates.diagnosticDescription));
  assert.match(html, /value="user-test" selected=""/);
  const unselected = renderLibraryPage({ ...input, diagnosticTemplate: { ...input.diagnosticTemplate, selectedId: "" } });
  assert.match(unselected, /diagnostic-bundle-generate-btn[^>]*disabled=""/);
});
