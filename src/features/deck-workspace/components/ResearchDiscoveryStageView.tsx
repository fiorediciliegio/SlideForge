import { ProcessStepView } from "../../process-progress/ProcessProgress";
import { ResearchDetails } from "../../process-progress/ResearchDetails";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Messages } from "../../../i18n/messages";
import type { ResearchDiscoveryStageGroup, ResearchDiscoveryStageRecord } from "../researchDiscoveryStageRecords";

export interface ResearchDiscoveryDisclosure {
  isOpen: (record: ResearchDiscoveryStageRecord) => boolean;
  toggle: (recordId: string) => void;
}

export function ResearchDiscoveryStageGroupView(props: {
  group: ResearchDiscoveryStageGroup;
  t: Messages;
  disclosure: ResearchDiscoveryDisclosure;
  togglePerformanceId?: string;
}) {
  const {
    group,
    t,
    disclosure,
    togglePerformanceId = "generation.research-stage.toggle",
  } = props;
  return (
    <div className="process-timeline" role="region" aria-label={group.title}>
      {(["web", "visual"] as const).map((kind) => {
        const records = group.records.filter((record) => record.phase.startsWith(kind));
        if (!records.length || records.every((record) => record.detail?.state === "skipped")) return null;
        return <section key={kind}>
          <h3 className="process-research-header">{kind === "web" ? t.processProgress.web : t.processProgress.image}</h3>
          {records.map((record) => <ResearchDiscoveryStageRecordView key={record.id} record={record} t={t} disclosure={disclosure} togglePerformanceId={togglePerformanceId} />)}
        </section>;
      })}
    </div>
  );
}

function ResearchDiscoveryStageRecordView(props: {
  record: ResearchDiscoveryStageRecord;
  t: Messages;
  disclosure: ResearchDiscoveryDisclosure;
  togglePerformanceId: string;
}) {
  const { record, t, disclosure } = props;
  const detail = record.detail;
  const latest = detail?.liveRounds?.at(-1);
  return <ProcessStepView t={t} performanceId={props.togglePerformanceId} step={{
    id: record.id, label: record.label,
    state: record.state === "failed" ? "failed" : detail?.state === "warning" ? "completed" : detail?.state ?? (record.state === "active" ? "running" : record.state === "pending" ? "waiting" : record.state),
    summary: record.activities.filter(Boolean).join(" · "),
    startedAt: detail?.liveRounds?.[0]?.startedAt,
    endedAt: detail?.state !== "running" ? latest?.endedAt : undefined,
  }} open={disclosure.isOpen(record)} onToggle={() => disclosure.toggle(record.id)}>
    {detail ? <ResearchDetails t={t} record={{ ...detail, rationale: record.rationale }} /> : <>
      <ResearchDiscoveryLineList title={t.generating.researchDiscovery.queries} lines={record.queryLines} />
      <ResearchDiscoveryLineList title={t.generating.researchDiscovery.sources} lines={record.sourceLines} />
    </>}
  </ProcessStepView>;
}

function ResearchDiscoveryLineList(props: { title: string; lines: string[] }) {
  if (props.lines.length === 0) return null;
  return (
    <div className="research-discovery-line-list">
      <strong>{props.title}</strong>
      {props.lines.map((line, index) => <span key={`${props.title}-${index}`}>{line}</span>)}
    </div>
  );
}

export function useResearchDiscoveryDisclosure(group: ResearchDiscoveryStageGroup | null): ResearchDiscoveryDisclosure {
  const [openStages, setOpenStages] = useState<Record<string, boolean>>({});
  const userTouchedRef = useRef<Set<string>>(new Set());
  const records = useMemo(() => group?.records ?? [], [group]);

  useEffect(() => {
    setOpenStages((current) => {
      const next = { ...current };
      records.forEach((record) => {
        if (userTouchedRef.current.has(record.id)) return;
        if (record.state === "active" || record.state === "failed") {
          next[record.id] = true;
        } else {
          next[record.id] = false;
        }
      });
      return next;
    });
  }, [records]);

  return {
    isOpen(record) {
      return openStages[record.id] ?? (record.state === "active" || record.state === "failed");
    },
    toggle(recordId) {
      userTouchedRef.current.add(recordId);
      setOpenStages((current) => ({ ...current, [recordId]: !(current[recordId] ?? false) }));
    },
  };
}
