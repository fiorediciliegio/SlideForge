import { Download, File, FileText, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { formatMessage, type Messages } from "../../../i18n/messages";
import { useDownloadUrlAvailability } from "../useDownloadUrlAvailability";
import type { ExportArtifact, ExportDownloadState, ExportProgressState, LoadingKind } from "../types";
import { CopyableDownloadLink } from "./CopyableDownloadLink";

export interface ExportFileSelection {
  type: "PPTX" | "PDF";
  pageNumbers?: number[];
}

interface ExportPageProps {
  t: Messages;
  progress: ExportProgressState;
  artifact: ExportArtifact | null;
  download: ExportDownloadState;
  loading: LoadingKind;
  totalPages?: number;
  onBack: () => void;
  onExport: (selection: ExportFileSelection) => void;
  onDownload: () => Promise<void>;
}

function downloadLabel(t: Messages, artifact: ExportArtifact | null) {
  return artifact ? `${t.exportPage.download} ${artifact.type}` : t.exportPage.download;
}

function downloadButtonLabel(t: Messages, artifact: ExportArtifact | null, download: ExportDownloadState) {
  if (download.status === "preparing") return t.exportPage.downloadPreparing;
  if (download.status === "error") return t.exportPage.retryDownload;
  return downloadLabel(t, artifact);
}

function isDeterminateProgress(progress: ExportProgressState) {
  return progress.mode === "determinate" || progress.mode === "complete" || progress.mode === "error";
}

export function ExportPage({ t, progress, artifact, download, loading, totalPages = 1, onBack, onExport, onDownload }: ExportPageProps) {
  const titleId = useId();
  const maxPage = Math.max(1, totalPages);
  const pageOptions = Array.from({ length: maxPage }, (_, index) => index + 1);
  const [type, setType] = useState<"PPTX" | "PDF">("PPTX");
  const [rangeMode, setRangeMode] = useState<"all" | "custom">("all");
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(maxPage);
  const exporting = progress.active || loading === "export";
  const customRangeEnabled = true;
  // A completed PDF must not masquerade as an available PPTX after the
  // format selector changes (and vice versa).
  const selectedArtifact = artifact?.type === type ? artifact : null;
  const selectedDownload: ExportDownloadState = selectedArtifact ? download : { status: "idle", message: "" };
  const selectedProgress = exporting || (
    progress.type === type && (progress.mode !== "complete" || selectedArtifact !== null)
  )
    ? progress
    : { type, mode: "idle" as const, message: t.exportPage.noFile, percent: 0, active: false };
  const downloadAvailability = useDownloadUrlAvailability(selectedDownload);

  useEffect(() => {
    setStartPage((current) => Math.min(Math.max(1, current), maxPage));
    setEndPage((current) => Math.min(Math.max(1, current), maxPage));
  }, [maxPage]);
  useEffect(() => { if (endPage < startPage) setEndPage(startPage); }, [startPage, endPage]);

  const progressClass = ["export-progress-track", `mode-${selectedProgress.mode}`, selectedProgress.active ? "active" : ""].filter(Boolean).join(" ");
  const fillStyle = isDeterminateProgress(selectedProgress) ? { width: `${selectedProgress.percent}%` } : undefined;
  const ariaValueNow = isDeterminateProgress(selectedProgress) ? selectedProgress.percent : undefined;
  const selectedPageNumbers = rangeMode === "custom"
    ? pageOptions.filter((pageNumber) => pageNumber >= startPage && pageNumber <= endPage)
    : undefined;
  const startExport = () => onExport({ type, ...(selectedPageNumbers === undefined ? {} : { pageNumbers: selectedPageNumbers }) });
  const showExportAction = selectedProgress.mode !== "error" && !exporting;
  const exportButton = (
    <button data-performance-id="export.start" className="primary-btn export-modal-submit" type="button" onClick={startExport}>
      {selectedArtifact ? t.exportPage.reExport : t.exportPage.exportNow} {type}
    </button>
  );
  const downloadButton = selectedArtifact ? (
    <button data-performance-id="export.download.prepare" className="export-download-btn" type="button" disabled={selectedDownload.status === "preparing"} aria-busy={selectedDownload.status === "preparing"} onClick={() => { void onDownload(); }}>
      <Download size={16} aria-hidden="true" /><span>{downloadButtonLabel(t, selectedArtifact, selectedDownload)}</span>
    </button>
  ) : null;

  return (
    <div className="export-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={() => { if (!exporting) onBack(); }}>
      <section className="export-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="export-modal-header">
          <h2 id={titleId}>{t.exportPage.title}</h2>
          <button type="button" className="export-modal-close" aria-label={t.controls.close} title={t.controls.close} disabled={exporting} onClick={onBack}><X size={20} aria-hidden="true" /></button>
        </header>

        <div className="export-modal-body">
          <fieldset className="export-format-fieldset" disabled={exporting}>
            <legend>{t.exportPage.format}</legend>
            <div className="export-format-grid">
              <button type="button" className={`export-format-card ${type === "PPTX" ? "selected" : ""}`} aria-pressed={type === "PPTX"} onClick={() => setType("PPTX")}>
                <FileText size={28} aria-hidden="true" /><strong>{t.controls.pptx}</strong><span>{t.exportPage.pptxDescription}</span>
              </button>
              <button type="button" className={`export-format-card ${type === "PDF" ? "selected" : ""}`} aria-pressed={type === "PDF"} onClick={() => setType("PDF")}>
                <File size={28} aria-hidden="true" /><strong>{t.controls.pdf}</strong><span>{t.exportPage.pdfDescription}</span>
              </button>
            </div>
          </fieldset>

          <fieldset className="export-range-fieldset" disabled={exporting}>
            <legend>{t.exportPage.pageRange}</legend>
            <label className="export-range-option">
              <input type="radio" name="export-page-range" checked={rangeMode === "all"} onChange={() => setRangeMode("all")} />
              <span>{formatMessage(t.exportPage.allPages, { start: 1, end: maxPage })}</span>
            </label>
            <label className={`export-range-option ${customRangeEnabled ? "" : "disabled"}`}>
              <input type="radio" name="export-page-range" disabled={!customRangeEnabled} checked={rangeMode === "custom"} onChange={() => setRangeMode("custom")} />
              <span>{t.exportPage.customRange}</span>
            </label>
            {rangeMode === "custom" && customRangeEnabled ? (
              <div className="export-range-selects">
                <label><span>{t.exportPage.fromPage}</span><select value={startPage} onChange={(event) => setStartPage(Number(event.target.value))}>{pageOptions.map((pageNumber) => <option key={pageNumber} value={pageNumber}>{pageNumber}</option>)}</select></label>
                <label><span>{t.exportPage.toPage}</span><select value={endPage} onChange={(event) => setEndPage(Number(event.target.value))}>{pageOptions.filter((pageNumber) => pageNumber >= startPage).map((pageNumber) => <option key={pageNumber} value={pageNumber}>{pageNumber}</option>)}</select></label>
              </div>
            ) : null}
            {!customRangeEnabled ? <p className="export-range-hint">{t.exportPage.customRangePptxHint}</p> : null}
          </fieldset>

          <div className={`export-progress-panel ${selectedProgress.mode === "error" ? "error" : ""}`}>
            <div className={`export-progress-message ${selectedProgress.active ? "breathing" : ""}`} role="status" aria-live="polite">{selectedProgress.message}</div>
            <div className="export-progress-row"><div className={progressClass} role="progressbar" aria-label={selectedProgress.message} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ariaValueNow}><div className="export-progress-fill" style={fillStyle} /></div></div>
          </div>
          {selectedProgress.mode === "error" ? <button className="secondary-btn compact export-retry-row" type="button" disabled={exporting} onClick={startExport}>{t.exportPage.retryExport}</button> : null}
          {showExportAction && selectedArtifact ? <div className="export-modal-actions">{exportButton}{downloadButton}</div> : null}
          {showExportAction && !selectedArtifact ? exportButton : null}
          {!showExportAction && selectedArtifact ? <div className="export-download-action-row">{downloadButton}</div> : null}
          {selectedArtifact && downloadAvailability.active && selectedDownload.href ? <div className="export-modal-download-link"><CopyableDownloadLink href={selectedDownload.href} inputLabel={t.exportPage.downloadLinkLabel} copyLabel={t.exportPage.copyDownloadLink} copiedMessage={t.exportPage.downloadLinkCopied} copyHint={t.exportPage.downloadFallbackHint} /></div> : null}
          {selectedDownload.message ? <div className={`export-download-status ${selectedDownload.status === "error" ? "error" : ""}`} role="status" aria-live="polite">{selectedDownload.message}</div> : null}
        </div>
      </section>
    </div>
  );
}
