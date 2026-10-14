import { SlideThumbnail } from "./SlideThumbnail";
import { Copy, Loader2, MoreHorizontal, Pencil, Plus, Trash2, X, Cloud } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type {
  ListMyWorkEntry,
  ListWorkspacesResult,
  WorkspaceSnapshotSyncState,
  WorkspaceSummary,
} from "../../../api/types";
import { formatMessage, type Locale, type Messages } from "../../../i18n/messages";
import { locales } from "../../../i18n/locales";
import { buildMyWorkMenuItems, type MyWorkMenuItemId } from "../myWorkMenu";
import { ErrorNotice } from "./ErrorNotice";

const MENU_ICONS: Record<MyWorkMenuItemId, typeof Pencil> = {
  rename: Pencil,
  duplicate: Copy,
  delete: Trash2,
};

interface MyWorkPageProps {
  t: Messages;
  locale: Locale;
  workspaceScan: ListWorkspacesResult | null;
  /** WORK-006: per-workspace cloud snapshot sync state for the badge. */
  syncStates: Record<string, WorkspaceSnapshotSyncState | null>;
  /** WORK-006: workspaces that have a published snapshot in APS (from listMyWork). */
  cloudWorkspaces: ListMyWorkEntry[];
  openingWorkspaceDir: string | null;
  /** WORK-005: the copy just created, so the user can find it in the list. */
  highlightedWorkspaceId?: string | null;
  loading: boolean;
  error: string;
  errorDetail?: string;
  onRetry: () => Promise<void>;
  onOpen: (workspaceDir: string) => Promise<void>;
  onNew: () => Promise<void>;
  onRename: (workspaceDir: string, title: string) => Promise<void>;
  /** Confirmation is owned by the workspace-level dialog, not by this page. */
  onDelete: (workspaceDir: string, title: string) => Promise<void>;
  /**
   * WORK-005: the duplicate action only renders once a backend contract is
   * wired up, so the menu never shows an entry that cannot do anything.
   */
  onDuplicate?: (workspaceDir: string, sourceTitle: string) => Promise<void>;
}

const DEFAULT_COVER = new URL(
  "../assets/default-project-cover.svg",
  import.meta.url,
).href;

function formatUpdatedAt(value: string, locale: Locale) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locales[locale].intl, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function projectTitle(project: WorkspaceSummary, t: Messages) {
  const match = /^(?:新建工作区|新建任务|New Workspace|New Task)-\d{4}-\d{2}-\d{2}$/.exec(project.title);
  return match ? formatMessage(t.library.defaultWorkspaceTitle, { date: match[0].slice(-10) }) : project.title;
}

function workspaceDirOf(project: WorkspaceSummary) {
  return project.task_dir ?? project.workspace_dir;
}

function syncPill(
  state: WorkspaceSnapshotSyncState | null | undefined,
  t: Messages,
): { label: string; variant: "success" | "warn" | "active" | "error" | "neutral" } | null {
  // undefined means the sync state has not loaded yet — render nothing.
  if (state === undefined) return null;
  if (state === null) return { label: t.myWork.syncNotInCloud, variant: "neutral" };

  // Existing workspaces can be served by an already-running engine that
  // predates these optional state fields. Normalize every optional segment
  // before reading it so a delayed status refresh can never blank the page.
  const retry = state.retry ?? null;
  const publish = state.publish ?? null;
  const restore = state.restore ?? null;
  const semanticFailure = state.semantic_validation_failed ?? null;
  const retryScheduled = retry !== null && !retry.exhausted;
  const publishRunning = publish !== null &&
    ["queued", "preparing", "uploading", "committing"].includes(publish.status);
  const restoreRunning = restore !== null &&
    ["queued", "downloading", "extracting", "committing"].includes(restore.status);

  // A rejected candidate or exhausted retry budget takes precedence over
  // activity so the badge never claims an invalid snapshot is still saving.
  if (
    semanticFailure !== null ||
    retry?.exhausted === true ||
    restore?.status === "failed" ||
    (publish?.status === "failed" && !retryScheduled)
  ) {
    return { label: t.myWork.syncFailed, variant: "error" };
  }
  if (restoreRunning) return { label: t.myWork.syncRestoring, variant: "active" };
  if (retryScheduled) return { label: t.myWork.syncRetrying, variant: "warn" };
  if (state.status === "failed") return { label: t.myWork.syncFailed, variant: "error" };
  if (publishRunning || state.pending_change_seq != null || state.status === "queued" || state.status === "preparing") {
    return { label: t.myWork.syncPublishing, variant: "active" };
  }
  if (
    state.synced_baseline?.source_sha256 &&
    state.synced_baseline.source_sha256 === state.source_sha256
  ) {
    return { label: t.myWork.syncSynced, variant: "success" };
  }
  if (state.source_sha256 != null && state.synced_baseline?.source_sha256 !== state.source_sha256) {
    return { label: t.myWork.syncPublishing, variant: "active" };
  }
  return { label: t.myWork.syncNotInCloud, variant: "neutral" };
}

export function MyWorkPage({
  t,
  locale,
  workspaceScan,
  syncStates,
  cloudWorkspaces,
  openingWorkspaceDir,
  highlightedWorkspaceId,
  loading,
  error,
  errorDetail,
  onRetry,
  onOpen,
  onNew,
  onRename,
  onDelete,
  onDuplicate,
}: MyWorkPageProps) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<WorkspaceSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lastOpenAttemptRef = useRef<string | null>(null);

  const projects = workspaceScan?.tasks ?? workspaceScan?.workspaces ?? [];
  const presentations = projects.filter((project) => project.generation_completed ?? project.has_deck_html);
  const inProgress = projects.filter((project) => !(project.generation_completed ?? project.has_deck_html));
  const localIds = new Set(projects.map((project) => project.workspace_id));
  const cloudProjects = cloudWorkspaces.filter((entry) => !localIds.has(entry.workspace_id));
  const hasList = workspaceScan !== null;
  const busy = actionLoading || openingWorkspaceDir !== null || duplicatingId !== null;

  useEffect(() => {
    if (!menuId) return;

    const menu = menuRef.current;
    menu?.querySelector<HTMLButtonElement>("button")?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuId(null);
      // Dismissing with the keyboard hands focus back to the trigger instead of
      // dropping it on the node that is about to unmount.
      const trigger = menuTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuId]);

  function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>, step: 1 | -1) {
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + step + items.length) % items.length;
    items[next]?.focus();
  }

  async function openProject(dir: string) {
    lastOpenAttemptRef.current = dir;
    await onOpen(dir);
  }

  async function submitRename() {
    if (!renameTarget || !renameDraft.trim()) return;
    setActionLoading(true);
    try {
      await onRename(workspaceDirOf(renameTarget), renameDraft.trim());
      setRenameTarget(null);
    } finally {
      setActionLoading(false);
    }
  }

  async function deleteProject(target: WorkspaceSummary) {
    setActionLoading(true);
    try {
      await onDelete(workspaceDirOf(target), projectTitle(target, t));
    } finally {
      setActionLoading(false);
    }
  }

  async function duplicateProject(project: WorkspaceSummary) {
    if (!onDuplicate || duplicatingId) return;
    setDuplicatingId(project.workspace_id);
    try {
      await onDuplicate(workspaceDirOf(project), projectTitle(project, t));
    } finally {
      setDuplicatingId(null);
    }
  }

  function renderCover(project: WorkspaceSummary, completed: boolean) {
    if (completed) return <span className="my-work-card-cover">
      <SlideThumbnail t={t} workspaceDir={project.task_dir ?? project.workspace_dir} pageId=""
        title={projectTitle(project, t)} version={project.updated_at ?? project.workspace_id} />
    </span>;

    return (
      <span className="my-work-card-cover">
        <img src={DEFAULT_COVER} alt="" />
      </span>
    );
  }

  function renderSyncPill(workspaceId: string) {
    const pill = syncPill(syncStates[workspaceId], t);
    if (!pill) return null;
    return (
      <span className={`my-work-card-sync-pill status-pill status-pill-${pill.variant}`} aria-label={pill.label}>
        <Cloud size={12} aria-hidden="true" />
        {pill.label}
      </span>
    );
  }

  function renderProject(project: WorkspaceSummary, completed: boolean, index: number) {
    const dir = workspaceDirOf(project);
    const opening = openingWorkspaceDir === dir;
    const duplicating = duplicatingId === project.workspace_id;
    const highlighted = highlightedWorkspaceId === project.workspace_id;
    const menuOpen = menuId === project.workspace_id;

    return (
      <article
        className={`my-work-card${opening || duplicating ? " busy" : ""}${highlighted ? " highlighted" : ""}${menuOpen ? " menu-open" : ""}`}
        key={project.workspace_id}
      >
        <button
          data-performance-id="my-work.workspace.open"
          className="my-work-card-main"
          type="button"
          onClick={() => void openProject(dir)}
          disabled={loading || busy}
        >
          {renderCover(project, completed)}
          <span className="my-work-card-copy">
            <strong>{projectTitle(project, t)}</strong>
            <small>{formatUpdatedAt(project.updated_at, locale)}</small>
            {renderSyncPill(project.workspace_id)}
          </span>
        </button>
        {opening || duplicating ? (
          <span className="my-work-card-busy" aria-live="polite">
            <Loader2 size={14} aria-hidden="true" />
            {opening ? t.myWork.opening : t.myWork.duplicating}
          </span>
        ) : null}
        <button
          data-performance-id="my-work.workspace.menu.toggle"
          type="button"
          className="my-work-card-menu-trigger"
          aria-label={t.myWork.menu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            menuTriggerRef.current = event.currentTarget;
            setMenuId((current) => (current === project.workspace_id ? null : project.workspace_id));
          }}
          disabled={loading || busy}
        >
          <MoreHorizontal size={17} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div
            className="my-work-card-menu"
            role="menu"
            ref={menuRef}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") moveMenuFocus(event, 1);
              if (event.key === "ArrowUp") moveMenuFocus(event, -1);
            }}
          >
            {buildMyWorkMenuItems(t, { canDuplicate: Boolean(onDuplicate) }).map((item) => {
              const Icon = MENU_ICONS[item.id];
              return (
                <Fragment key={item.id}>
                  {item.dividerBefore ? <span className="my-work-card-menu-divider" role="separator" /> : null}
                  <button
                    data-performance-id={`my-work.workspace.${item.id}`}
                    type="button"
                    role="menuitem"
                    className={item.tone ?? ""}
                    disabled={item.id === "duplicate" && duplicatingId !== null}
                    onClick={() => {
                      setMenuId(null);
                      if (item.id === "rename") {
                        setRenameDraft(project.title);
                        setRenameTarget(project);
                        return;
                      }
                      if (item.id === "duplicate") {
                        void duplicateProject(project);
                        return;
                      }
                      void deleteProject(project);
                    }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    {item.label}
                  </button>
                </Fragment>
              );
            })}
          </div>
        ) : null}
      </article>
    );
  }

  function cloudDirOf(entry: ListMyWorkEntry) {
    const root = workspaceScan?.workspace_root ?? "";
    return `${root.replace(/[\\/]+$/, "")}/${entry.workspace_id}`;
  }

  function renderCloudProject(entry: ListMyWorkEntry) {
    const dir = cloudDirOf(entry);
    const opening = openingWorkspaceDir === dir;
    return (
      <article className={`my-work-card my-work-cloud-card${opening ? " busy" : ""}`} key={entry.workspace_id}>
        <button
          data-performance-id="my-work.cloud.open"
          className="my-work-card-main"
          type="button"
          onClick={() => void openProject(dir)}
          disabled={loading || busy}
        >
          <span className="my-work-card-cover my-work-card-cover-cloud">
            <Cloud size={24} aria-hidden="true" />
          </span>
          <span className="my-work-card-copy">
            <strong>{entry.workspace_id}</strong>
            <small>
              {entry.snapshot_updated_at
                ? formatMessage(t.myWork.cloudUpdatedAt, { date: formatUpdatedAt(entry.snapshot_updated_at, locale) })
                : ""}
            </small>
            <small>
              {entry.file_count != null
                ? formatMessage(t.myWork.cloudFileCount, { count: entry.file_count })
                : ""}
            </small>
          </span>
        </button>
        {opening ? (
          <span className="my-work-card-busy" aria-live="polite">
            <Loader2 size={14} aria-hidden="true" />
            {t.myWork.opening}
          </span>
        ) : null}
      </article>
    );
  }

  return (
    <section className="page active my-work-page">
      <header className="my-work-header">
        <div>
          <h1>{t.myWork.title}</h1>
        </div>
      </header>

      {loading && !hasList ? (
        <div className="my-work-loading" aria-live="polite">
          <div className="my-work-section-skeleton">
            <span />
            <div className="my-work-skeleton-grid"><i /><i /><i /></div>
          </div>
          <div className="my-work-section-skeleton">
            <span />
            <div className="my-work-skeleton-grid"><i /><i /></div>
          </div>
        </div>
      ) : error && !hasList ? (
        <div className="my-work-error">
          <ErrorNotice
            t={t}
            tone="block"
            summary={error || t.myWork.loadFailed}
            detail={errorDetail}
            actions={
              <button data-performance-id="my-work.list.retry" type="button" className="secondary-btn" onClick={() => void onRetry()}>
                {t.myWork.retry}
              </button>
            }
          />
        </div>
      ) : (
        <>
          {error ? (
            <ErrorNotice
              t={t}
              summary={error}
              detail={errorDetail}
              actions={
                lastOpenAttemptRef.current ? (
                  <button
                    data-performance-id="my-work.workspace.open-retry"
                    type="button"
                    className="secondary-btn"
                    disabled={busy}
                    onClick={() => {
                      const dir = lastOpenAttemptRef.current;
                      if (dir) void openProject(dir);
                    }}
                  >
                    {t.myWork.openRetry}
                  </button>
                ) : (
                  <button data-performance-id="my-work.list.retry" type="button" className="secondary-btn" onClick={() => void onRetry()}>
                    {t.myWork.retry}
                  </button>
                )
              }
            />
          ) : null}
          <section className="my-work-section">
            <div className="my-work-section-heading"><h2>{t.myWork.presentations}</h2></div>
            <div className="my-work-grid">
              <button data-performance-id="my-work.new-presentation" type="button" className="my-work-new-card" onClick={() => void onNew()} disabled={busy}>
                <Plus size={22} aria-hidden="true" />
                <strong>{t.myWork.newPresentation}</strong>
              </button>
              {presentations.map((project, index) => renderProject(project, true, index))}
            </div>
            {presentations.length === 0 ? <p className="my-work-empty">{t.myWork.emptyPresentations}</p> : null}
          </section>
          <section className="my-work-section my-work-in-progress-section">
            <div className="my-work-section-heading"><h2>{t.myWork.inProgress}</h2></div>
            <div className="my-work-grid">{inProgress.map((project, index) => renderProject(project, false, index))}</div>
            {inProgress.length === 0 ? <p className="my-work-empty">{t.myWork.emptyInProgress}</p> : null}
          </section>
          <section className="my-work-section my-work-cloud-section">
            <div className="my-work-section-heading"><h2>{t.myWork.cloudSectionTitle}</h2></div>
            <div className="my-work-grid">
              {cloudProjects.map((entry) => renderCloudProject(entry))}
            </div>
            {cloudProjects.length === 0 ? <p className="my-work-empty">{t.myWork.cloudSectionEmpty}</p> : null}
          </section>
        </>
      )}

      {renameTarget ? (
        <div className="my-work-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="my-work-rename-title">
          <section className="my-work-modal">
            <button data-performance-id="my-work.rename.close" type="button" className="my-work-modal-close" onClick={() => setRenameTarget(null)} aria-label={t.controls.close}><X size={16} aria-hidden="true" /></button>
            <h2 id="my-work-rename-title">{t.myWork.renameTitle}</h2>
            <input autoFocus value={renameDraft} placeholder={t.myWork.renamePlaceholder} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void submitRename(); if (event.key === "Escape") setRenameTarget(null); }} />
            <div className="my-work-modal-actions"><button data-performance-id="my-work.rename.cancel" type="button" className="secondary-btn" onClick={() => setRenameTarget(null)} disabled={actionLoading}>{t.controls.cancel}</button><button data-performance-id="my-work.rename.save" type="button" className="primary-btn" onClick={() => void submitRename()} disabled={!renameDraft.trim() || actionLoading}>{t.controls.save}</button></div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
