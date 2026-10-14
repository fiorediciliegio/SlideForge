import { SlideThumbnail } from "../deck-workspace/components/SlideThumbnail";
import { ChevronDown, Download, FileArchive, FileText, Image, Search, Square, Trash2 } from "lucide-react";
import type { BatchTestCaseRecord, BatchTestRunRecord, PageProgress, PageProgressItem, PresentationRequirements, ResearchDiscoveryProgressPhaseRecord, TokenUsageBucket, TokenUsageSummary } from "../../api/types";
import { formatMessage, type Locale, type Messages } from "../../i18n/messages";
import { locales, pickLocale } from "../../i18n/locales";
import { addTokenUsageSummary, createEmptyTokenUsageSummary } from "../../performance/tokenUsage";
import { formatBatchTestDate, formatBatchTestDuration } from "./runTiming";
import { batchTestTargetIncludes, type BatchTestCaseDetailState, type BatchTestingState } from "./types";

interface BatchTestingRunPageProps {
  t: Messages;
  locale: Locale;
  state: BatchTestingState;
  run: BatchTestRunRecord;
  onBack: () => void;
  onDownload: (run: BatchTestRunRecord) => Promise<void>;
  onStop: () => Promise<void>;
  onDelete: (run: BatchTestRunRecord) => Promise<void>;
  onLoadCase: (caseId: string) => Promise<void>;
}

function selectionValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { label?: unknown; description?: unknown };
    if (typeof record.label === "string") return record.description ? `${record.label} - ${record.description}` : record.label;
  }
  return "-";
}

function groupCases(run: BatchTestRunRecord) {
  const groups = new Map<string, { brief: string; cases: BatchTestCaseRecord[] }>();
  for (const item of run.cases) {
    const group = groups.get(item.brief_id) ?? { brief: item.brief, cases: [] };
    group.cases.push(item);
    groups.set(item.brief_id, group);
  }
  return [...groups.entries()].map(([briefId, group]) => ({ briefId, ...group }));
}

function summarizeCases(cases: BatchTestCaseRecord[]): TokenUsageSummary {
  return cases.reduce(
    (summary, item) => item.token_usage ? addTokenUsageSummary(summary, item.token_usage) : summary,
    createEmptyTokenUsageSummary(),
  );
}

function readTemplateDetails(value: unknown): { id: string; name: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.selected_template_group === "string" ? record.selected_template_group : typeof record.template_group === "string" ? record.template_group : "";
  const name = typeof record.selected_template_group_name === "string" ? record.selected_template_group_name : typeof record.template_group_name === "string" ? record.template_group_name : "";
  return id || name ? { id: id || "-", name: name || "-" } : null;
}

function readVisualStylePresetDetails(value: unknown): { id: string; name: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const name = typeof record.name === "string" ? record.name : "";
  return id || name ? { id: id || "-", name: name || "-" } : null;
}

function readResearchRecord(progress: PageProgress | null, phase: "web-collection" | "visual-collection"): ResearchDiscoveryProgressPhaseRecord | null {
  return progress?.research_discovery?.records.find((record) => record.phase === phase) ?? null;
}

function researchChoiceValue(
  t: Messages,
  choice: PresentationRequirements["research"]["web"] | undefined,
  field: "enabled" | "recommended" | "reason",
): string {
  if (!choice) return "-";
  if (field === "reason") return choice.reason || "-";
  return choice[field] === null
    ? "-"
    : choice[field] ? t.requirements.enableResearch : t.requirements.disableResearch;
}

export function BatchTestingRunPage({
  t,
  locale,
  state,
  run,
  onBack,
  onDownload,
  onStop,
  onDelete,
  onLoadCase,
}: BatchTestingRunPageProps) {
  const completed = run.cases.filter((item) => item.status === "completed").length;
  const failed = run.cases.filter((item) => item.status === "failed" || item.status === "cancelled").length;
  const totalTokenUsage = summarizeCases(run.cases);
  return (
    <section className="page active batch-testing-run-page">
      <div className="batch-testing-run-header">
        <div>
          <div className="batch-testing-run-title-row">
            <h1>{run.test_id}</h1>
            <span className={`batch-testing-status ${run.status === "queued" ? "pending" : run.status}`}>
              {t.batchTesting.statuses[run.status === "queued" ? "pending" : run.status]}
            </span>
          </div>
          <p>{t.batchTesting.detailsDescription}</p>
        </div>
        <div className="batch-testing-header-actions">
          <button type="button" className="secondary-btn compact" onClick={onBack} disabled={state.busy}>
            {t.batchTesting.backToHistory}
          </button>
          <button type="button" className="secondary-btn compact" onClick={() => void onDownload(run)} disabled={state.bundleBusy}>
            <Download size={14} />
            {state.bundleBusy ? t.batchTesting.preparingBundle : t.batchTesting.download}
          </button>
          {state.busy ? (
            <button type="button" className="danger-btn compact" onClick={() => void onStop()}>
              <Square size={13} />
              {t.batchTesting.stop}
            </button>
          ) : null}
          <button type="button" className="icon-btn danger" onClick={() => void onDelete(run)} disabled={state.busy || run.status === "queued" || run.status === "running"} aria-label={t.batchTesting.delete} title={t.batchTesting.delete}>
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="batch-testing-run-summary">
        <SummaryMetric label={t.batchTesting.caseCount} value={String(run.cases.length)} />
        <SummaryMetric label={t.batchTesting.targetStage} value={t.batchTesting.targetStages[run.target_stage]} />
        <SummaryMetric label={t.batchTesting.successCount} value={String(completed)} />
        <SummaryMetric label={t.batchTesting.failedCount} value={String(failed)} />
        <SummaryMetric label={t.batchTesting.totalDuration} value={formatBatchTestDuration(run)} />
        <SummaryMetric label={t.batchTesting.completedAt} value={formatBatchTestDate(run.ended_at, locale)} />
      </div>
      <TokenUsagePanel t={t} locale={locale} summary={totalTokenUsage} />
      <BatchMetricsPanel metrics={run.performance_metrics ?? aggregateCaseMetrics(run.cases)} locale={locale} />

      {state.error ? <div className="batch-testing-workbench-error">{state.error}</div> : null}
      <div className="batch-testing-brief-list">
        {groupCases(run).map((group) => (
          <details className="batch-testing-brief-card" key={group.briefId} onToggle={(event) => {
            if (run.target_stage !== "attachment-context-created" && (event.currentTarget as HTMLDetailsElement).open) {
              const first = group.cases[0];
              if (first) void onLoadCase(first.case_id);
            }
          }}>
            <summary>
              <span className="batch-testing-summary-chevron"><ChevronDown size={16} /></span>
              <span className="batch-testing-brief-summary-copy">
                <strong>{group.briefId}</strong>
                <span>{group.cases.length} {t.batchTesting.caseCount} · {group.brief}</span>
              </span>
              <span className="batch-testing-brief-summary-status">
                {group.cases.filter((item) => item.status === "completed").length}/{group.cases.length}
              </span>
            </summary>
            <div className="batch-testing-brief-content">
              <div className="batch-testing-brief-source"><span>{t.batchTesting.caseBrief}</span><p>{group.brief}</p></div>
              <TokenUsagePanel t={t} locale={locale} summary={summarizeCases(group.cases)} compact />
              {group.cases.map((item) => (
                <BatchTestingCaseDetails
                  key={item.case_id}
                  t={t}
                  locale={locale}
                  item={item}
                  targetStage={run.target_stage}
                  detail={state.caseDetails[item.case_id]}
                  onLoad={() => onLoadCase(item.case_id)}
                />
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function aggregateCaseMetrics(cases: BatchTestCaseRecord[]) {
  const map = new Map<string, NonNullable<BatchTestCaseRecord["performance_metrics"]>[number]>();
  for (const item of cases) for (const metric of item.performance_metrics ?? []) {
    const current = map.get(metric.operation_name) ?? { ...metric, count: 0, wall_clock_ms: 0, total_duration_ms: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, calls: 0 };
    current.count += metric.count; current.wall_clock_ms += metric.wall_clock_ms; current.total_duration_ms += metric.total_duration_ms;
    current.input_tokens += metric.input_tokens; current.output_tokens += metric.output_tokens; current.total_tokens += metric.total_tokens; current.calls += metric.calls;
    map.set(metric.operation_name, current);
  }
  return [...map.values()].sort((a, b) => b.total_duration_ms - a.total_duration_ms);
}

function BatchMetricsPanel({ metrics, locale }: { metrics: NonNullable<BatchTestCaseRecord["performance_metrics"]>; locale: Locale }) {
  const definitions = pickLocale(locale, {
    zh: [
      ["附件分析", /attachment|uploaded_source/i],
      ["Outline", /outline/i],
      ["Web Search", /research\.web|web\./i],
      ["Image Search", /research\.image|image\./i],
      ["制作 PPT", /^(generation\.run|pptx_export\.run)$/i],
    ] as const,
    en: [
      ["Attachment analysis", /attachment|uploaded_source/i],
      ["Outline", /outline/i],
      ["Web Search", /research\.web|web\./i],
      ["Image Search", /research\.image|image\./i],
      ["PPT creation", /^(generation\.run|pptx_export\.run)$/i],
    ] as const,
    ja: [
      ["添付ファイル分析", /attachment|uploaded_source/i],
      ["Outline", /outline/i],
      ["Web Search", /research\.web|web\./i],
      ["Image Search", /research\.image|image\./i],
      ["PPT 作成", /^(generation\.run|pptx_export\.run)$/i],
    ] as const,
    de: [
      ["Anhangsanalyse", /attachment|uploaded_source/i],
      ["Outline", /outline/i],
      ["Web Search", /research\.web|web\./i],
      ["Image Search", /research\.image|image\./i],
      ["PPT-Erstellung", /^(generation\.run|pptx_export\.run)$/i],
    ] as const,
  });
  const labels = pickLocale(locale, {
    zh: { heading: "批量阶段统计", duration: "耗时 / Token", tokens: "累计 Token", calls: "调用" },
    en: { heading: "Batch stage metrics", duration: "Duration / tokens", tokens: "Tokens", calls: "Calls" },
    ja: { heading: "バッチステージ統計", duration: "時間 / トークン", tokens: "累計トークン", calls: "呼び出し" },
    de: { heading: "Batch-Phasen-Statistik", duration: "Dauer / Token", tokens: "Token gesamt", calls: "Aufrufe" },
  });
  const rows = definitions.map(([label, pattern]) => {
    const matching = metrics.filter((item) => pattern.test(item.operation_name));
    return { label, duration: matching.reduce((sum, item) => sum + item.wall_clock_ms, 0), total: matching.reduce((sum, item) => sum + item.total_tokens, 0), calls: matching.reduce((sum, item) => sum + (item.calls || item.count), 0) };
  }).filter((item) => item.duration > 0 || item.total > 0);
  if (!rows.length) return null;
  return <section className="batch-testing-token-usage"><div className="batch-testing-token-usage-heading"><strong>{labels.heading}</strong><span>{labels.duration}</span></div><div className="batch-testing-token-usage-table">{rows.map((item) => <div className="batch-testing-token-usage-row" key={item.label}><strong>{item.label}</strong><span>{Math.round(item.duration / 1000)}s</span><span>{labels.tokens}: {Math.round(item.total).toLocaleString()}</span><span>{labels.calls}: {item.calls}</span></div>)}</div></section>;
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <div className="batch-testing-summary-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function BatchTestingCaseDetails({
  t,
  locale,
  item,
  targetStage,
  detail,
  onLoad,
}: {
  t: Messages;
  locale: Locale;
  item: BatchTestCaseRecord;
  targetStage: BatchTestRunRecord["target_stage"];
  detail: BatchTestCaseDetailState | undefined;
  onLoad: () => Promise<void>;
}) {
  if (targetStage === "template-recommendation-completed") {
    const result = item.template_recommendation_result;
    return (
      <details className="batch-testing-case-card" open>
        <summary>
          <span className="batch-testing-summary-chevron"><ChevronDown size={15} /></span>
          <span className="batch-testing-case-summary-copy"><strong>{formatMessage(t.batchTesting.repetition, { current: item.repetition, total: item.total_repetitions })}</strong><span>{item.case_id}</span></span>
          <span className={`batch-testing-status ${item.status}`}>{t.batchTesting.statuses[item.status]}</span>
        </summary>
        <div className="batch-testing-case-content">
          {item.error ? <div className="batch-testing-case-error">{item.error}</div> : null}
          <DetailField label={t.batchTesting.templateId} value={result?.preset.id ?? "-"} />
          <DetailField label={t.batchTesting.templateName} value={result?.preset.name ?? "-"} />
          <details className="batch-testing-artifact-section"><summary><FileText size={14} />{t.batchTesting.recommendationTrace}</summary><pre>{JSON.stringify(result?.trace ?? null, null, 2)}</pre></details>
        </div>
      </details>
    );
  }
  if (targetStage === "attachment-context-created") {
    return (
      <details className="batch-testing-case-card">
        <summary>
          <span className="batch-testing-summary-chevron"><ChevronDown size={15} /></span>
          <span className="batch-testing-case-summary-copy">
            <strong>{formatMessage(t.batchTesting.repetition, { current: item.repetition, total: item.total_repetitions })}</strong>
            <span>{item.case_id}</span>
          </span>
          <span className={`batch-testing-status ${item.status}`}>{t.batchTesting.statuses[item.status]}</span>
        </summary>
        <div className="batch-testing-case-content">
          {item.error ? <div className="batch-testing-case-error">{item.error}</div> : null}
          <TokenUsagePanel t={t} locale={locale} summary={item.token_usage ?? null} compact />
          <details className="batch-testing-artifact-section" open>
            <summary><FileArchive size={14} />{t.batchTesting.attachmentParsingReport}</summary>
            <div className="batch-testing-file-note"><span>{t.batchTesting.attachmentParsingReportInBundle}</span></div>
          </details>
        </div>
      </details>
    );
  }
  const outlineItems = detail?.outline?.items ?? [];
  const pageItems = detail?.progress?.pages ?? [];
  const template = readTemplateDetails(detail?.template)
    ?? readVisualStylePresetDetails(detail?.requirements?.selections.visual_style_preset);
  const webResearch = readResearchRecord(detail?.progress ?? null, "web-collection");
  const imageResearch = readResearchRecord(detail?.progress ?? null, "visual-collection");
  const includesResearch = batchTestTargetIncludes(targetStage, "web-research-completed");
  const includesOutline = batchTestTargetIncludes(targetStage, "outline-confirmed");
  const includesFullPpt = targetStage === "pptx-exported";
  return (
    <details className="batch-testing-case-card" onToggle={(event) => {
      if ((event.currentTarget as HTMLDetailsElement).open) void onLoad();
    }}>
      <summary>
        <span className="batch-testing-summary-chevron"><ChevronDown size={15} /></span>
        <span className="batch-testing-case-summary-copy">
          <strong>{formatMessage(t.batchTesting.repetition, { current: item.repetition, total: item.total_repetitions })}</strong>
          <span>{item.case_id}</span>
        </span>
        <span className={`batch-testing-status ${item.status}`}>{t.batchTesting.statuses[item.status]}</span>
      </summary>
      <div className="batch-testing-case-content">
        {item.error ? <div className="batch-testing-case-error">{item.error}</div> : null}
        <TokenUsagePanel t={t} locale={locale} summary={item.token_usage ?? null} compact />
        {detail?.loading ? <div className="batch-testing-detail-loading">{t.batchTesting.loadingDetails}</div> : null}
        {detail?.error ? <div className="batch-testing-case-error">{detail.error}</div> : null}
        {detail && !detail.loading && !detail.error ? (
          <>
            <details className="batch-testing-artifact-section" open>
              <summary><FileText size={14} />{t.batchTesting.template}</summary>
              {template ? (
                <div className="batch-testing-requirements-grid">
                  <DetailField label={t.batchTesting.templateId} value={template.id} />
                  <DetailField label={t.batchTesting.templateName} value={template.name} />
                </div>
              ) : <div className="batch-testing-artifact-empty">{t.batchTesting.noDetails}</div>}
            </details>
            {includesResearch ? (
              <details className="batch-testing-artifact-section" open>
                <summary><Search size={14} />{t.batchTesting.research}</summary>
                {webResearch || imageResearch ? (
                  <div className="batch-testing-research-grid">
                    <ResearchChannel t={t} label={t.batchTesting.webSearch} record={webResearch} />
                    <ResearchChannel t={t} label={t.batchTesting.imageSearch} record={imageResearch} />
                  </div>
                ) : <div className="batch-testing-artifact-empty">{t.batchTesting.noResearchData}</div>}
              </details>
            ) : null}
            <details className="batch-testing-artifact-section" open>
              <summary><FileText size={14} />{t.batchTesting.requirements}</summary>
              <div className="batch-testing-requirements-grid">
                <DetailField label={t.batchTesting.detailLabels.slides} value={selectionValue(detail.requirements?.selections.slide_count)} />
                <DetailField label={t.batchTesting.detailLabels.outputLanguage} value={selectionValue(detail.requirements?.selections.output_language)} />
                <ResearchChoiceFields
                  t={t}
                  label={t.batchTesting.detailLabels.webResearch}
                  choice={detail.requirements?.research.web}
                />
                <ResearchChoiceFields
                  t={t}
                  label={t.batchTesting.detailLabels.imageResearch}
                  choice={detail.requirements?.research.images}
                />
              </div>
            </details>
            {includesOutline ? (
              <details className="batch-testing-artifact-section" open>
                <summary><FileText size={14} />{t.batchTesting.outline}</summary>
                {outlineItems.length > 0 ? (
                  <ol className="batch-testing-outline-list">
                    {outlineItems.map((outline) => <li key={outline.page_id ?? outline.title}><strong>{outline.title}</strong><small>{outline.content}</small></li>)}
                  </ol>
                ) : <div className="batch-testing-artifact-empty">{t.batchTesting.noDetails}</div>}
              </details>
            ) : null}
            {includesFullPpt ? (
              <details className="batch-testing-artifact-section">
                <summary><Image size={14} />{t.batchTesting.pagePreviews}<span className="batch-testing-section-count">{pageItems.length}</span></summary>
                {pageItems.length === 0 ? <div className="batch-testing-artifact-empty">{t.batchTesting.noPagePreviews}</div> : <PagePreviewGrid workspaceDir={item.workspace_dir} t={t} pageItems={pageItems} detail={detail} outlineItems={outlineItems} />}
              </details>
            ) : null}
            {includesFullPpt ? (
              <details className="batch-testing-artifact-section">
                <summary><FileArchive size={14} />{t.batchTesting.pptx}</summary>
                {item.pptx_path ? (
                  <div className="batch-testing-file-note"><strong>{item.pptx_path.split(/[\\/]/u).at(-1) ?? t.batchTesting.pptx}</strong><span>{t.batchTesting.pptxInBundle}</span></div>
                ) : <div className="batch-testing-artifact-empty">{t.batchTesting.noDetails}</div>}
              </details>
            ) : null}
            <details className="batch-testing-artifact-section">
              <summary><FileText size={14} />{t.batchTesting.performance}</summary>
              <div className="batch-testing-file-note"><strong>{item.performance_dir.split(/[\\/]/u).at(-1) ?? t.batchTesting.performance}</strong><span>{t.batchTesting.performanceInBundle}</span></div>
            </details>
          </>
        ) : null}
      </div>
    </details>
  );
}

function ResearchChoiceFields({
  t,
  label,
  choice,
}: {
  t: Messages;
  label: string;
  choice: PresentationRequirements["research"]["web"] | undefined;
}) {
  return (
    <div className="batch-testing-research-choice-group">
      <div className="batch-testing-research-choice-title">{label}</div>
      <DetailField label={t.batchTesting.detailLabels.researchEnabled} value={researchChoiceValue(t, choice, "enabled")} />
      <DetailField label={t.batchTesting.detailLabels.researchRecommended} value={researchChoiceValue(t, choice, "recommended")} />
      <DetailField label={t.batchTesting.detailLabels.researchReason} value={researchChoiceValue(t, choice, "reason")} />
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return <div className="batch-testing-detail-field"><span>{label}</span><strong>{value}</strong></div>;
}

function ResearchChannel({
  t,
  label,
  record,
}: {
  t: Messages;
  label: string;
  record: ResearchDiscoveryProgressPhaseRecord | null;
}) {
  const executed = Boolean(record && record.state !== "waiting" && record.state !== "skipped");
  const queries = record?.queries ?? [];
  return (
    <div className="batch-testing-research-channel">
      <div className="batch-testing-research-channel-heading">
        <strong>{label}</strong>
        <span className={executed ? "executed" : "not-executed"}>{executed ? t.batchTesting.searchExecuted : t.batchTesting.searchNotExecuted}</span>
      </div>
      <div className="batch-testing-research-query-label">{t.batchTesting.searchQueries}</div>
      {queries.length > 0 ? (
        <ul className="batch-testing-research-query-list">
          {queries.map((query) => (
            <li key={`${query.kind}-${query.query}`}>
              <span>{query.query}</span>
              <small>{t.batchTesting.researchQueryStatuses[query.status]}{typeof query.resultCount === "number" ? ` · ${query.resultCount}` : ""}</small>
            </li>
          ))}
        </ul>
      ) : <div className="batch-testing-research-no-query">{t.batchTesting.noSearchQueries}</div>}
    </div>
  );
}

function formatTokenNumber(value: number, locale: Locale) {
  return Math.round(value).toLocaleString(locales[locale].intl);
}

function formatTokenCost(value: number | null, locale: Locale) {
  return value === null ? "-" : value.toLocaleString(locales[locale].intl, {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  });
}

function TokenUsagePanel({
  t,
  locale,
  summary,
  compact = false,
}: {
  t: Messages;
  locale: Locale;
  summary: TokenUsageSummary | null;
  compact?: boolean;
}) {
  const usage = summary ?? createEmptyTokenUsageSummary();
  const rows: Array<[string, TokenUsageBucket]> = [
    [t.batchTesting.tokenUsage.session, usage.session],
    [t.batchTesting.tokenUsage.llm, usage.llm],
    [t.batchTesting.tokenUsage.total, usage.total],
  ];
  return (
    <section className={`batch-testing-token-usage ${compact ? "compact" : ""}`}>
      <div className="batch-testing-token-usage-heading">
        <strong>{t.batchTesting.tokenUsage.title}</strong>
        <span>{t.batchTesting.tokenUsage.inputTokens} / {t.batchTesting.tokenUsage.outputTokens}</span>
      </div>
      {usage.total.available ? (
        <div className="batch-testing-token-usage-table">
          {rows.map(([label, bucket]) => (
            <div className="batch-testing-token-usage-row" key={label}>
              <strong>{label}</strong>
              <span>{formatTokenNumber(bucket.input_tokens, locale)} / {formatTokenNumber(bucket.output_tokens, locale)}</span>
              <span>{t.batchTesting.tokenUsage.totalTokens}: {formatTokenNumber(bucket.total_tokens, locale)}</span>
              <span>{t.batchTesting.tokenUsage.calls}: {formatTokenNumber(bucket.calls, locale)}</span>
              <span>{t.batchTesting.tokenUsage.cacheReadTokens}: {formatTokenNumber(bucket.cache_read_tokens, locale)}</span>
              <span>{t.batchTesting.tokenUsage.estimatedCost}: {formatTokenCost(bucket.estimated_cost, locale)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="batch-testing-token-usage-empty">{t.batchTesting.tokenUsage.noData}</div>
      )}
    </section>
  );
}

function PagePreviewGrid({
  workspaceDir, t,
  pageItems,
  detail,
  outlineItems,
}: {
  t: Messages;
  workspaceDir: string;
  pageItems: PageProgressItem[];
  detail: BatchTestCaseDetailState;
  outlineItems: Array<{ page_id?: string; title: string }>;
}) {
  return (
    <div className="batch-testing-preview-grid">
      {pageItems.map((page, index) => {
        const image = detail.images[page.page_id];
        const title = outlineItems.find((item) => item.page_id === page.page_id)?.title
          ?? formatMessage(t.batchTesting.pageLabel, { index: index + 1 });
        return (
          <figure className="batch-testing-preview-card" key={page.page_id}>
            <div className="batch-testing-preview-image">
              {page.last_html_path ? <SlideThumbnail t={t} workspaceDir={workspaceDir} pageId={page.page_id} title={title} version={`${page.snapshot_source_sha256 ?? ""}:${page.updated_at ?? ""}`} /> : <span>{t.batchTesting.noPagePreviews}</span>}
            </div>
            <figcaption><strong>{index + 1}. {title}</strong><small>{page.status}</small></figcaption>
          </figure>
        );
      })}
    </div>
  );
}
