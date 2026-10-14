import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MyWorkPage } from "../../src/features/deck-workspace/components/MyWorkPage.tsx";
import { buildMyWorkMenuItems } from "../../src/features/deck-workspace/myWorkMenu.ts";
import type { WorkspaceCovers } from "../../src/features/deck-workspace/workspaceCovers.ts";
import type { ListMyWorkEntry, WorkspaceSnapshotSyncState } from "../../src/api/types.ts";
import { messages } from "../../src/i18n/messages.ts";

const scan = {
  workspace_root: "/tmp/workspaces",
  has_workspaces: true,
  latest_workspace: null,
  workspaces: [
    { workspace_id: "done", workspace_dir: "/tmp/workspaces/done", title: "季度复盘", status: "ready", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-23T10:00:00Z", has_deck_html: true },
    { workspace_id: "draft", workspace_dir: "/tmp/workspaces/draft", title: "产品规划", status: "initialized", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-23T09:00:00Z", has_deck_html: false },
  ],
};

type RenderOverrides = {
  locale?: "en" | "zh";
  workspaceScan?: typeof scan | null;
  workspaceCovers?: WorkspaceCovers;
  syncStates?: Record<string, WorkspaceSnapshotSyncState | null>;
  cloudWorkspaces?: ListMyWorkEntry[];
  openingWorkspaceDir?: string | null;
  loading?: boolean;
  error?: string;
  errorDetail?: string;
  onDuplicate?: (workspaceDir: string, sourceTitle: string) => Promise<void>;
  highlightedWorkspaceId?: string | null;
};

function makeSyncState(patch: Partial<WorkspaceSnapshotSyncState> = {}): WorkspaceSnapshotSyncState {
  return {
    schema_version: 1,
    workspace_id: "done",
    status: "completed",
    revision: "rev-1",
    source_updated_at: "2026-07-23T10:00:00Z",
    source_sha256: "a".repeat(64),
    snapshot_sha256: "b".repeat(64),
    snapshot_path: "/tmp/workspaces/done/.snapshot-sync/snapshot.zip",
    snapshot_size_bytes: 2048,
    file_count: 4,
    attachments: [],
    generated_at: "2026-07-23T10:05:00Z",
    created_at: "2026-07-23T10:05:00Z",
    updated_at: "2026-07-23T10:05:00Z",
    error: null,
    synced_baseline: null,
    change_seq: 0,
    pending_change_seq: null,
    generated_change_seq: 0,
    retry: null,
    semantic_validation_failed: null,
    publish: null,
    restore: null,
    ...patch,
  };
}

function renderMyWorkPage(overrides: RenderOverrides = {}) {
  const locale = overrides.locale ?? "zh";
  return renderToStaticMarkup(createElement(MyWorkPage, {
    t: messages[locale],
    locale,
    workspaceScan: overrides.workspaceScan === undefined ? scan : overrides.workspaceScan,
    workspaceCovers: overrides.workspaceCovers ?? {},
    syncStates: overrides.syncStates ?? {},
    cloudWorkspaces: overrides.cloudWorkspaces ?? [],
    openingWorkspaceDir: overrides.openingWorkspaceDir ?? null,
    loading: overrides.loading ?? false,
    error: overrides.error ?? "",
    errorDetail: overrides.errorDetail,
    onRetry: async () => undefined,
    onOpen: async () => undefined,
    onNew: async () => undefined,
    onRename: async () => undefined,
    onDelete: async () => undefined,
    onDuplicate: overrides.onDuplicate,
    highlightedWorkspaceId: overrides.highlightedWorkspaceId ?? null,
  }));
}

describe("MyWorkPage", () => {
  it("keeps a completed deck in presentations while its preview is missing", () => {
    const workspaceScan = { ...scan, workspaces: scan.workspaces.map((item) => item.workspace_id === "done"
      ? { ...item, has_deck_html: false, generation_completed: true } : item) };
    const html = renderMyWorkPage({ workspaceScan });
    assert.ok(html.indexOf("季度复盘") < html.indexOf("未完成项目"));
    assert.ok(html.indexOf("产品规划") > html.indexOf("未完成项目"));
  });

  it("separates generated presentations from unfinished projects", () => {
    const html = renderMyWorkPage({
      workspaceCovers: { done: { status: "ready", url: "https://example.test/cover.png" } },
    });

    assert.match(html, /演示文稿/);
    assert.match(html, /未完成项目/);
    assert.match(html, /季度复盘/);
    assert.match(html, /产品规划/);
    assert.match(html, /新建演示文稿/);
    assert.match(html, /slide-thumbnail/);
    assert.match(html, /default-project-cover\.svg/);
    assert.doesNotMatch(html, /src="\/default-project-cover\.svg"/);
  });

  it("renders skeletons while waiting for backend summaries", () => {
    const html = renderMyWorkPage({ locale: "en", workspaceScan: null, loading: true });

    assert.match(html, /my-work-skeleton-grid/);
    assert.doesNotMatch(html, /No generated presentations yet/);
  });

  it("uses the work title as the cover alt text and keeps the fallback decorative", () => {
    const html = renderMyWorkPage({
      workspaceCovers: { done: { status: "ready", url: "https://example.test/cover.png" } },
    });

    assert.match(html, /季度复盘/);
    assert.match(html, /slide-thumbnail/);
    assert.match(html, /default-project-cover\.svg" alt=""/);
  });

  it("shows a per-card cover skeleton instead of blocking the list", () => {
    const html = renderMyWorkPage({ workspaceCovers: { done: { status: "loading" } } });

    assert.match(html, /slide-thumbnail/);
    assert.match(html, /季度复盘/);
    assert.doesNotMatch(html, /my-work-skeleton-grid/);
  });

  it("falls back to the default cover when a single cover fails", () => {
    const html = renderMyWorkPage({ workspaceCovers: { done: { status: "error" } } });

    assert.doesNotMatch(html, /my-work-card-cover-skeleton/);
    assert.match(html, /default-project-cover\.svg/);
    assert.match(html, /季度复盘/);
  });

  it("drops the redundant Home breadcrumb above the title", () => {
    const html = renderMyWorkPage({ locale: "en" });

    assert.match(html, /<h1>My Works<\/h1>/);
    assert.doesNotMatch(html, /class="eyebrow"/);
  });

  it("keeps the list visible and offers a retry when opening a work fails", () => {
    const html = renderMyWorkPage({
      locale: "en",
      error: messages.en.myWork.openFailed,
      errorDetail: '{"jsonrpc":"2.0","error":{"code":-32000}}',
    });

    assert.match(html, /This project could not be opened\./);
    assert.match(html, /季度复盘/);
    assert.match(html, /Show technical details/);
    assert.doesNotMatch(html, /jsonrpc/);
  });

  it("marks only the card being opened as busy", () => {
    const html = renderMyWorkPage({ openingWorkspaceDir: "/tmp/workspaces/done" });

    assert.match(html, /my-work-card busy/);
    assert.match(html, /正在打开/);
    assert.equal(html.match(/my-work-card-busy/g)?.length, 1);
  });

  it("gives the card menu trigger a name and popup semantics", () => {
    const html = renderMyWorkPage({ locale: "en" });

    assert.match(
      html,
      /class="my-work-card-menu-trigger" aria-label="Project actions" aria-haspopup="menu" aria-expanded="false"/,
    );
    assert.match(html, /lucide-ellipsis[^>]*aria-hidden="true"/);
  });
});

describe("MyWorkPage duplicate", () => {
  it("marks the freshly created copy so the user can find it in the list", () => {
    const html = renderMyWorkPage({
      onDuplicate: async () => undefined,
      highlightedWorkspaceId: "draft",
    });

    assert.match(html, /my-work-card highlighted/);
    assert.equal(html.match(/my-work-card highlighted/g)?.length, 1);
  });

  it("leaves every card unmarked when nothing was just duplicated", () => {
    const html = renderMyWorkPage({ onDuplicate: async () => undefined });

    assert.doesNotMatch(html, /highlighted/);
  });
});

describe("MyWorkPage cloud sync badge", () => {
  it("shows the synced state when the local tree matches the last published snapshot", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({
          status: "completed",
          synced_baseline: {
            revision: "rev-1",
            source_updated_at: "2026-07-23T10:00:00Z",
            source_sha256: "a".repeat(64),
            updated_at: "2026-07-23T10:05:00Z",
          },
          publish: {
            status: "completed",
            job_id: "job-1",
            workspace_dir: "/tmp/workspaces/done",
            revision: "rev-1",
            aps_path: "workspaces/done/snapshot.zip",
            aps_meta_path: null,
            meta_json: null,
            snapshot_path: "/tmp/workspaces/done/.snapshot-sync/snapshot.zip",
            source_updated_at: "2026-07-23T10:00:00Z",
            source_sha256: "a".repeat(64),
            snapshot_sha256: "b".repeat(64),
            snapshot_size_bytes: 2048,
            file_count: 4,
            attachments: [],
            change_seq: 0,
            last_synced_updated_at: "2026-07-23T10:05:00Z",
            last_synced_sha256: "a".repeat(64),
            mirror: null,
            started_at: null,
            updated_at: null,
            completed_at: null,
            error: null,
          },
        }),
      },
    });

    assert.match(html, /my-work-card-sync-pill[^>]*status-pill-success/);
    assert.match(html, /Synced/);
  });

  it("shows saving while a newer local tree is waiting for its next snapshot", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({
          status: "completed",
          pending_change_seq: 1,
          publish: {
            status: "completed",
            job_id: "job-1",
            workspace_dir: "/tmp/workspaces/done",
            revision: "rev-0",
            aps_path: "workspaces/done/snapshot.zip",
            aps_meta_path: null,
            meta_json: null,
            snapshot_path: "/tmp/workspaces/done/.snapshot-sync/snapshot.zip",
            source_updated_at: "2026-07-20T10:00:00Z",
            source_sha256: "a".repeat(64),
            snapshot_sha256: "b".repeat(64),
            snapshot_size_bytes: 2048,
            file_count: 4,
            attachments: [],
            change_seq: 0,
            last_synced_updated_at: "2026-07-20T10:05:00Z",
            last_synced_sha256: "c".repeat(64),
            mirror: null,
            started_at: null,
            updated_at: null,
            completed_at: null,
            error: null,
          },
        }),
      },
    });

    assert.match(html, /status-pill-active/);
    assert.match(html, /Saving/);
  });

  it("shows an uploading label while a publish is running", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({
          status: "preparing",
          publish: {
            status: "uploading",
            job_id: "job-1",
            workspace_dir: "/tmp/workspaces/done",
            revision: null,
            aps_path: null,
            aps_meta_path: null,
            meta_json: null,
            snapshot_path: null,
            source_updated_at: "2026-07-23T10:00:00Z",
            source_sha256: "a".repeat(64),
            snapshot_sha256: null,
            snapshot_size_bytes: null,
            file_count: 0,
            attachments: [],
            change_seq: 1,
            last_synced_updated_at: null,
            last_synced_sha256: null,
            mirror: null,
            started_at: "2026-07-23T10:06:00Z",
            updated_at: "2026-07-23T10:06:00Z",
            completed_at: null,
            error: null,
          },
        }),
      },
    });

    assert.match(html, /status-pill-active/);
    assert.match(html, /Saving/);
  });

  it("shows a restoring label while a restore is running", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({
          status: "preparing",
          restore: {
            status: "extracting",
            job_id: "job-2",
            workspace_dir: "/tmp/workspaces/done",
            revision: "rev-1",
            aps_path: "workspaces/done/snapshot.zip",
            snapshot_path: "/tmp/workspaces/done/.snapshot-restore/snapshot.zip",
            source_updated_at: "2026-07-23T10:00:00Z",
            source_sha256: "a".repeat(64),
            snapshot_sha256: "b".repeat(64),
            snapshot_size_bytes: 2048,
            file_count: 4,
            attachments: [],
            force: false,
            mirror: null,
            last_synced_updated_at: null,
            last_synced_sha256: null,
            started_at: "2026-07-23T10:06:00Z",
            updated_at: "2026-07-23T10:06:00Z",
            completed_at: null,
            error: null,
          },
        }),
      },
    });

    assert.match(html, /status-pill-active/);
    assert.match(html, /Restoring/);
  });

  it("shows a failure label when the snapshot sync failed", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({ status: "failed", error: { message: "boom" } }),
      },
    });

    assert.match(html, /status-pill-error/);
    assert.match(html, /Save incomplete/);
  });

  it("shows a retry label while the engine is waiting for a bounded retry", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({
          retry: {
            change_seq: 1,
            attempts: 1,
            phase: "upload",
            next_retry_at: "2026-07-23T10:07:00Z",
            exhausted: false,
            last_error: "network unavailable",
            updated_at: "2026-07-23T10:06:00Z",
          },
        }),
      },
    });

    assert.match(html, /status-pill-warn/);
    assert.match(html, /Retrying later/);
  });

  it("shows failure rather than retry when the retry budget is exhausted", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({
          retry: {
            change_seq: 1,
            attempts: 4,
            phase: "upload",
            next_retry_at: null,
            exhausted: true,
            last_error: "network unavailable",
            updated_at: "2026-07-23T10:06:00Z",
          },
        }),
      },
    });

    assert.match(html, /status-pill-error/);
    assert.match(html, /Save incomplete/);
  });

  it("shows failure for a semantically rejected candidate even when retry state is present", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: {
        done: makeSyncState({
          semantic_validation_failed: {
            change_seq: 1,
            source_sha256: "a".repeat(64),
            source_updated_at: "2026-07-23T10:00:00Z",
            revision: "rev-1",
            failed_at: "2026-07-23T10:06:00Z",
            errors: [{ code: "snapshot_mismatch", message: "mismatch", paths: ["outline.json"] }],
          },
          retry: {
            change_seq: 1,
            attempts: 1,
            phase: "semantic_validation",
            next_retry_at: "2026-07-23T10:07:00Z",
            exhausted: false,
            last_error: "mismatch",
            updated_at: "2026-07-23T10:06:00Z",
          },
        }),
      },
    });

    assert.match(html, /status-pill-error/);
    assert.match(html, /Save incomplete/);
  });

  it("shows a neutral label when the workspace has no snapshot", () => {
    const html = renderMyWorkPage({
      locale: "en",
      syncStates: { done: null },
    });

    assert.match(html, /status-pill-neutral/);
    assert.match(html, /Saved locally only/);
  });

  it("keeps rendering when a running older engine omits newly added state fields", () => {
    const legacyState = {
      ...makeSyncState({
        synced_baseline: {
          revision: "rev-1",
          source_updated_at: "2026-07-23T10:00:00Z",
          source_sha256: "a".repeat(64),
          updated_at: "2026-07-23T10:05:00Z",
        },
      }),
      pending_change_seq: undefined,
      retry: undefined,
      semantic_validation_failed: undefined,
      publish: undefined,
      restore: undefined,
    } as unknown as WorkspaceSnapshotSyncState;
    const html = renderMyWorkPage({ locale: "en", syncStates: { done: legacyState } });

    assert.match(html, /status-pill-success/);
    assert.match(html, /Synced/);
  });

  it("renders no pill until the sync state has loaded", () => {
    const html = renderMyWorkPage({ locale: "en" });

    assert.doesNotMatch(html, /my-work-card-sync-pill/);
  });
});

describe("MyWorkPage cloud-only section", () => {
  const cloudEntries: ListMyWorkEntry[] = [
    {
      workspace_id: "cloud-only-1",
      revision: "rev-9",
      aps_path: "workspaces/cloud-only-1/snapshot.zip",
      source_sha256: "a".repeat(64),
      source_updated_at: "2026-07-28T08:00:00Z",
      size_bytes: 4096,
      file_count: 7,
      snapshot_updated_at: "2026-07-28T08:05:00Z",
      meta_updated_at: "2026-07-28T08:05:00Z",
      status: "ok",
    },
  ];

  it("lists only workspaces that are not present locally", () => {
    const html = renderMyWorkPage({ cloudWorkspaces: cloudEntries });

    assert.match(html, /其他设备/);
    assert.match(html, /cloud-only-1/);
    assert.match(html, /7 个文件/);
    assert.doesNotMatch(html, /正在上传/);
  });

  it("excludes local workspaces from the cloud-only section", () => {
    const html = renderMyWorkPage({
      cloudWorkspaces: [
        ...cloudEntries,
        {
          workspace_id: "done",
          revision: "rev-1",
          aps_path: "workspaces/done/snapshot.zip",
          source_sha256: "a".repeat(64),
          source_updated_at: "2026-07-23T10:00:00Z",
          size_bytes: 2048,
          file_count: 4,
          snapshot_updated_at: "2026-07-23T10:05:00Z",
          meta_updated_at: "2026-07-23T10:05:00Z",
          status: "ok",
        },
      ],
    });

    assert.match(html, /cloud-only-1/);
    assert.equal(html.match(/data-performance-id="my-work\.cloud\.open"/g)?.length, 1);
  });

  it("shows an empty message when there are no cloud-only workspaces", () => {
    const html = renderMyWorkPage({ locale: "en" });

    assert.match(html, /No cloud-only projects found\./);
  });
});

describe("buildMyWorkMenuItems", () => {
  it("hides the duplicate action until a backend contract is wired up", () => {
    const items = buildMyWorkMenuItems(messages.en, { canDuplicate: false });

    assert.deepEqual(items.map((item) => item.id), ["rename", "delete"]);
  });

  it("offers duplicate once the backend contract is available", () => {
    const items = buildMyWorkMenuItems(messages.en, { canDuplicate: true });

    assert.deepEqual(items.map((item) => item.id), ["rename", "duplicate", "delete"]);
  });

  it("separates the destructive action from the ordinary ones", () => {
    const items = buildMyWorkMenuItems(messages.zh, { canDuplicate: true });
    const remove = items.at(-1);

    assert.equal(remove?.id, "delete");
    assert.equal(remove?.tone, "danger");
    assert.equal(remove?.dividerBefore, true);
    assert.ok(items.slice(0, -1).every((item) => !item.dividerBefore));
  });
});
