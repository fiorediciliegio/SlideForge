import { ArrowLeft, RefreshCw } from "lucide-react";
import type { Messages } from "../../../i18n/messages";
import type { DeckGenerationProgress } from "../../deck-generation";
import { buildResearchDiscoveryStageRecords } from "../researchDiscoveryStageRecords";
import type { WebResearchStatus } from "../types";
import { ResearchDiscoveryStageGroupView, useResearchDiscoveryDisclosure } from "./ResearchDiscoveryStageView";
import { ThinkingStatusText } from "./BriefPage";
import { ErrorNotice } from "./ErrorNotice";

interface WebResearchPageProps {
  t: Messages;
  status: WebResearchStatus;
  error: string;
  errorDetail: string;
  progress: DeckGenerationProgress | null;
  onRetry: () => void;
  onBack: () => void;
}

export function WebResearchPage(props: WebResearchPageProps) {
  const { t, status, error, errorDetail, progress, onRetry, onBack } = props;
  const group = buildResearchDiscoveryStageRecords({ t, progress });
  const webGroup = group
    ? {
      ...group,
      title: t.webResearch.title,
      records: group.records.map((record) => status === "error" && record.state === "active" ? { ...record, state: "failed" as const } : record),
    }
    : null;
  const disclosure = useResearchDiscoveryDisclosure(webGroup);
  const active = status === "preparing" || status === "running";
  const message = status === "idle"
    ? t.webResearch.noHistory
    : status === "preparing"
      ? t.webResearch.preparing
      : status === "running"
        ? progress?.message || t.webResearch.running
        : status === "completed"
          ? t.webResearch.completed
          : t.webResearch.errorBody;

  if (status === "error") {
    return (
      <section className="page active requirements-page requirements-error">
        <h1>{t.webResearch.errorTitle}</h1>
        {webGroup ? <ResearchDiscoveryStageGroupView group={webGroup} t={t} disclosure={disclosure} /> : null}
        <ErrorNotice
          t={t}
          tone="block"
          summary={error || t.webResearch.errorBody}
          detail={errorDetail}
        />
        <div className="requirements-error-actions">
          <button data-performance-id="web-research.retry" className="primary-btn" type="button" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />{t.webResearch.retry}
          </button>
          <button data-performance-id="web-research.back" className="secondary-btn" type="button" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" />{t.webResearch.back}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="page active web-research-page">
      <div className="page-header compact">
        <div>
          <div className="page-title">{t.webResearch.title}</div>
          <p>{t.processProgress.parallel}</p>
        </div>
      </div>

      <div className="generation-progress-panel web-research-progress-panel">
        <div className="generation-progress-header">
          <div>
            <div className="section-label">{t.webResearch.title}</div>
            <strong role="status" aria-live="polite">
              <ThinkingStatusText text={message} active={active} />
            </strong>
          </div>
        </div>

        {webGroup && webGroup.records.length > 0 ? (
          <div className="generation-page-list generation-stage-record-list">
            <ResearchDiscoveryStageGroupView
              group={webGroup}
              t={t}
              disclosure={disclosure}
              togglePerformanceId="web-research.stage.toggle"
            />
          </div>
        ) : null}
      </div>

      <div className="generation-page-footer web-research-actions">
        <div className="stage-navigation">
          <button className="secondary-btn" type="button" onClick={onBack} disabled={active}>
            <ArrowLeft size={16} aria-hidden="true" />{t.webResearch.back}
          </button>
        </div>
      </div>
    </section>
  );
}
