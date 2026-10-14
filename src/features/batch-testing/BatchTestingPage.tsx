import { LogOut } from "lucide-react";
import type { BatchTestRunRecord } from "../../api/types";
import { LocaleSwitch } from "../deck-workspace/components/LocaleSwitch";
import type { Locale, Messages } from "../../i18n/messages";
import { BatchTestingHistoryPage } from "./BatchTestingHistoryPage";
import { BatchTestingNewPage } from "./BatchTestingNewPage";
import { BatchTestingRunPage } from "./BatchTestingRunPage";
import type { BatchTestInput, BatchTestingState } from "./types";

interface BatchTestingPageProps {
  t: Messages;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  state: BatchTestingState;
  onExit: () => Promise<void>;
  onHistory: () => void;
  onNew: () => void;
  onRefresh: () => Promise<void>;
  onOpenRun: (run: BatchTestRunRecord) => void;
  onDeleteRun: (run: BatchTestRunRecord) => Promise<void>;
  onLoadCase: (caseId: string) => Promise<void>;
  onStart: (input: BatchTestInput) => Promise<void>;
  onStop: () => Promise<void>;
  onDownload: (run?: BatchTestRunRecord) => Promise<void>;
}

export function BatchTestingPage({
  t,
  locale,
  setLocale,
  state,
  onExit,
  onHistory,
  onNew,
  onRefresh,
  onOpenRun,
  onDeleteRun,
  onLoadCase,
  onStart,
  onStop,
  onDownload,
}: BatchTestingPageProps) {
  return (
    <div className="batch-testing-page-shell">
      <div className="batch-testing-page-topbar">
        <div className="batch-testing-page-brand"><span>{t.appName}</span><strong>{t.batchTesting.title}</strong></div>
        <div className="batch-testing-page-controls">
          <LocaleSwitch t={t} locale={locale} setLocale={setLocale} />
          <button type="button" className="control-btn text" onClick={() => void onExit()} disabled={state.busy} title={t.batchTesting.exit}>
            <LogOut size={14} aria-hidden="true" />
            {t.batchTesting.exit}
          </button>
        </div>
      </div>
      <div className="batch-testing-page-scroll">
        {state.view === "new" ? (
          <BatchTestingNewPage
            t={t}
            locale={locale}
            state={state}
            onBack={onHistory}
            onStart={onStart}
            onStop={onStop}
            onDownload={() => onDownload()}
          />
        ) : state.view === "detail" && state.selectedRun ? (
          <BatchTestingRunPage
            t={t}
            locale={locale}
            state={state}
            run={state.selectedRun}
            onBack={onHistory}
            onDownload={onDownload}
            onStop={onStop}
            onDelete={onDeleteRun}
            onLoadCase={onLoadCase}
          />
        ) : (
          <BatchTestingHistoryPage
            t={t}
            locale={locale}
            state={state}
            onNew={onNew}
            onOpen={onOpenRun}
            onDelete={onDeleteRun}
            onDownload={onDownload}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </div>
  );
}
