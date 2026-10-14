import { FolderOpen, FolderPlus, X } from "lucide-react";
import { useState } from "react";
import type {
  ListWorkspacesResult,
  WorkspaceResult
} from "../../../api/types";
import type { Locale } from "../../../i18n/messages";

interface WorkspaceDialogProps {
  locale: Locale;
  scan: ListWorkspacesResult | null;
  task: WorkspaceResult | null;
  loading: boolean;
  error: string;
  onUseLatest: () => void;
  onCreate: () => void;
  onOpen: (taskDir: string) => Promise<void>;
}

function formatTaskName(value: string) {
  return value.replace(/^ppt-/, "PPT ");
}

const enCopy = {
  title: "Choose task",
  rootPrefix: "Default workspace",
  loading: "Checking local tasks...",
  found: "Last task found",
  missing: "No existing task found",
  createRequired: "Create a new PPT task",
  createHint: "Anna will initialize an html-authoring-v1 Workspace with standalone HTML page sources.",
  open: "Open project",
  recent: "Recent projects",
  noRecent: "No recent tasks",
  useLatest: "Open latest task",
  create: "Create new",
  close: "Close"
};

const copy = {
  en: enCopy,
  zh: {
    title: "选择 PPT 任务",
    rootPrefix: "默认工作目录为",
    loading: "正在检查本地任务...",
    found: "找到上次的任务",
    missing: "没有找到已有任务",
    createRequired: "需要新建一个 PPT 任务",
    createHint: "会自动创建 html-authoring-v1 工作区，并使用独立 HTML 页面源文件。",
    open: "打开项目",
    recent: "最近项目",
    noRecent: "暂无最近任务",
    useLatest: "打开上次任务",
    create: "新建任务",
    close: "关闭"
  },
  ja: {
    title: "タスクを選択",
    rootPrefix: "既定のワークスペース",
    loading: "ローカルタスクを確認中…",
    found: "前回のタスクが見つかりました",
    missing: "既存のタスクはありません",
    createRequired: "新しい PPT タスクを作成",
    createHint: "独立した HTML ページソースを持つ html-authoring-v1 ワークスペースを初期化します。",
    open: "プロジェクトを開く",
    recent: "最近のプロジェクト",
    noRecent: "最近のタスクはありません",
    useLatest: "最新のタスクを開く",
    create: "新規作成",
    close: "閉じる"
  },
  de: {
    title: "Aufgabe auswählen",
    rootPrefix: "Standardarbeitsbereich",
    loading: "Lokale Aufgaben werden geprüft …",
    found: "Letzte Aufgabe gefunden",
    missing: "Keine vorhandene Aufgabe gefunden",
    createRequired: "Neue PPT-Aufgabe erstellen",
    createHint: "Ein html-authoring-v1-Arbeitsbereich mit eigenständigen HTML-Seitenquellen wird initialisiert.",
    open: "Projekt öffnen",
    recent: "Letzte Projekte",
    noRecent: "Keine letzten Aufgaben",
    useLatest: "Letzte Aufgabe öffnen",
    create: "Neu erstellen",
    close: "Schließen"
  }
} satisfies Record<Locale, Record<string, string>>;

export function WorkspaceDialog({
  locale,
  scan,
  task,
  loading,
  error,
  onUseLatest,
  onCreate,
  onOpen
}: WorkspaceDialogProps) {
  const [openPicker, setOpenPicker] = useState(false);

  if (task) {
    return null;
  }

  const latest = scan?.latest_task ?? scan?.latest_workspace ?? null;
  const tasks = scan?.tasks ?? scan?.workspaces ?? [];
  const text = copy[locale];

  return (
    <div className="task-overlay" role="dialog" aria-modal="true">
      <section className="task-dialog">
        <header className="task-dialog-copy">
          <h2>{text.title}</h2>
          <p>
            {text.rootPrefix}
            <strong>{scan?.task_root ?? scan?.workspace_root ?? "~/anna-workspace/ppt"}</strong>
          </p>
        </header>

        <div className="task-dialog-body">
          {loading ? (
            <div className="task-state">{text.loading}</div>
          ) : (
            <div className="task-launch-grid">
              <button data-performance-id="workspace.create" className="task-launch-card" onClick={onCreate} disabled={loading}>
                <FolderPlus size={22} />
                <strong>{text.create}</strong>
              </button>
              <button
                data-performance-id="workspace.picker.open"
                className="task-launch-card"
                onClick={() => setOpenPicker(true)}
                disabled={loading || tasks.length === 0}
              >
                <FolderOpen size={22} />
                <strong>{text.open}</strong>
              </button>
            </div>
          )}

          {error ? <div className="task-error">{error}</div> : null}
        </div>

        <section className="task-recent">
          <div className="task-recent-header">
            <span>{text.recent}</span>
            {latest ? (
              <button data-performance-id="workspace.open-latest" onClick={onUseLatest} disabled={loading}>
                {text.useLatest}
              </button>
            ) : null}
          </div>
          {latest ? (
            <button data-performance-id="workspace.open-latest" className="task-recent-row" onClick={onUseLatest} disabled={loading}>
              <strong>{latest.title || formatTaskName(latest.task_id ?? latest.workspace_id)}</strong>
              <span>{latest.task_dir ?? latest.workspace_dir}</span>
            </button>
          ) : (
            <div className="task-recent-empty">{text.noRecent}</div>
          )}
        </section>

        {openPicker ? (
          <div className="task-picker-backdrop" role="dialog" aria-modal="true">
            <section className="task-picker">
              <div className="task-picker-header">
                <strong>{text.open}</strong>
                <button data-performance-id="workspace.picker.close" aria-label={text.close} onClick={() => setOpenPicker(false)}>
                  <X size={16} />
                </button>
              </div>
              <div className="task-picker-list">
                {tasks.map((item) => {
                  const taskDir = item.task_dir ?? item.workspace_dir;
                  return (
                    <button
                      data-performance-id="workspace.picker.select"
                      key={taskDir}
                      onClick={() => {
                        setOpenPicker(false);
                        void onOpen(taskDir);
                      }}
                      disabled={loading}
                    >
                      <strong>{item.title || formatTaskName(item.task_id ?? item.workspace_id)}</strong>
                      <span>{taskDir}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );
}
