import { Clock3, Download, Play, RefreshCw, Trash2 } from "lucide-react";
import type { BatchTestRunRecord } from "../../api/types";
import { formatMessage, type Locale, type Messages } from "../../i18n/messages";
import { formatBatchTestDate, formatBatchTestDuration } from "./runTiming";
import type { BatchTestingState } from "./types";

interface BatchTestingHistoryPageProps {
  t: Messages;
  locale: Locale;
  state: BatchTestingState;
  onNew: () => void;
  onOpen: (run: BatchTestRunRecord) => void;
  onDelete: (run: BatchTestRunRecord) => Promise<void>;
  onDownload: (run: BatchTestRunRecord) => Promise<void>;
  onRefresh: () => Promise<void>;
}

function statusKey(run: BatchTestRunRecord): keyof Messages["batchTesting"]["statuses"] {
  return run.status === "queued" ? "pending" : run.status;
}

function completedCount(run: BatchTestRunRecord) {
  return run.cases.filter((item) => item.status === "completed").length;
}

function failedCount(run: BatchTestRunRecord) {
  return run.cases.filter((item) => item.status === "failed" || item.status === "cancelled").length;
}

export function BatchTestingHistoryPage({
  t,
  locale,
  state,
  onNew,
  onOpen,
  onDelete,
  onDownload,
  onRefresh,
}: BatchTestingHistoryPageProps) {
  return (
    <section className="page active batch-testing-history-page">
      <div className="batch-testing-workbench-header">
        <div>
          <span className="batch-testing-eyebrow">{t.batchTesting.title}</span>
          <h1>{t.batchTesting.historyTitle}</h1>
          <p>{t.batchTesting.historyDescription}</p>
        </div>
        <div className="batch-testing-header-actions">
          <button type="button" className="secondary-btn compact" onClick={() => void onRefresh()} disabled={state.historyLoading}>
            <RefreshCw size={14} className={state.historyLoading ? "spin" : undefined} />
            {t.batchTesting.refreshHistory}
          </button>
          <button type="button" className="primary-btn" onClick={onNew}>
            <Play size={14} />
            {t.batchTesting.newTest}
          </button>
        </div>
      </div>

      {state.historyError ? <div className="batch-testing-workbench-error">{state.historyError}</div> : null}
      {state.historyLoading && state.history.length === 0 ? (
        <div className="batch-testing-history-empty">{t.batchTesting.historyLoading}</div>
      ) : state.history.length === 0 ? (
        <div className="batch-testing-history-empty">{t.batchTesting.historyEmpty}</div>
      ) : (
        <div className="batch-testing-history-list">
          {state.history.map((run) => {
            const completed = completedCount(run);
            const failed = failedCount(run);
            return (
              <article className="batch-testing-history-card" key={run.test_id}>
                <button type="button" className="batch-testing-history-main" onClick={() => onOpen(run)}>
                  <span className="batch-testing-history-title-row">
                    <strong>{run.test_id}</strong>
                    <span className={`batch-testing-status ${statusKey(run)}`}>
                      {t.batchTesting.statuses[statusKey(run)]}
                    </span>
                  </span>
                  <span className="batch-testing-history-meta">
                    <span>{t.batchTesting.targetStage}: {t.batchTesting.targetStages[run.target_stage]}</span>
                    <span>{formatMessage(t.batchTesting.summary, { completed, failed, total: run.cases.length })}</span>
                    <span><Clock3 size={13} />{formatBatchTestDuration(run)}</span>
                    <span>{formatBatchTestDate(run.ended_at, locale)}</span>
                  </span>
                </button>
                <div className="batch-testing-history-actions">
                  <button type="button" className="secondary-btn compact" onClick={() => onOpen(run)}>
                    {t.batchTesting.viewDetails}
                  </button>
                  <button type="button" className="secondary-btn compact" onClick={() => void onDownload(run)} disabled={state.bundleBusy}>
                    <Download size={13} />
                    {t.batchTesting.download}
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    aria-label={t.batchTesting.delete}
                    title={t.batchTesting.delete}
                    onClick={() => void onDelete(run)}
                    disabled={run.status === "queued" || run.status === "running"}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
