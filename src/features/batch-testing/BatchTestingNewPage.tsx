import { ArrowLeft } from "lucide-react";
import type { Locale, Messages } from "../../i18n/messages";
import { BatchTestingPanel } from "./BatchTestingPanel";
import type { BatchTestInput, BatchTestingState } from "./types";

interface BatchTestingNewPageProps {
  t: Messages;
  locale: Locale;
  state: BatchTestingState;
  onBack: () => void;
  onStart: (input: BatchTestInput) => Promise<void>;
  onStop: () => Promise<void>;
  onDownload: () => Promise<void>;
}

export function BatchTestingNewPage({
  t,
  locale,
  state,
  onBack,
  onStart,
  onStop,
  onDownload,
}: BatchTestingNewPageProps) {
  return (
    <section className="page active batch-testing-new-page">
      <button type="button" className="batch-testing-back-button" onClick={onBack} disabled={state.busy}>
        <ArrowLeft size={15} />
        {t.batchTesting.backToHistory}
      </button>
      <BatchTestingPanel
        t={t}
        locale={locale}
        state={state}
        onStart={onStart}
        onStop={onStop}
        onDownload={onDownload}
      />
    </section>
  );
}
