import { Download, FileJson, Play, Square } from "lucide-react";
import { useRef, useState } from "react";
import { formatMessage, type Locale, type Messages } from "../../i18n/messages";
import { parseBatchTestJson, parseBatchTestText } from "./input";
import {
  BATCH_TEST_TARGET_STAGES,
  DEFAULT_BATCH_TEST_TARGET_STAGE,
  type BatchTestInput,
  type BatchTestTargetStage,
  type BatchTestingState,
} from "./types";
import { BatchTestingJsonHelp } from "./BatchTestingJsonHelp";

interface BatchTestingPanelProps {
  t: Messages;
  locale: Locale;
  state: BatchTestingState;
  onStart: (input: BatchTestInput) => Promise<void>;
  onStop: () => Promise<void>;
  onDownload: () => Promise<void>;
}

export function BatchTestingPanel({ t, locale, state, onStart, onStop, onDownload }: BatchTestingPanelProps) {
  const [briefs, setBriefs] = useState("");
  const [repeat, setRepeat] = useState(1);
  const [targetStage, setTargetStage] = useState<BatchTestTargetStage>(DEFAULT_BATCH_TEST_TARGET_STAGE);
  const [imported, setImported] = useState<BatchTestInput | null>(null);
  const [importedName, setImportedName] = useState("");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [inputError, setInputError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  if (!state.enabled) return null;

  async function importJson(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = parseBatchTestJson(await file.text(), locale);
      setImported(parsed);
      setImportedName(file.name);
      setBriefs(parsed.briefs.map((item) => item.brief).join("\n\n"));
      setRepeat(parsed.repeat ?? 1);
      setTargetStage(parsed.target_stage);
      setAttachmentFiles([]);
      setInputError("");
    } catch (error) {
      setImported(null);
      setImportedName("");
      setInputError(error instanceof Error ? error.message : t.batchTesting.invalidInput);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function start() {
    try {
      let input = imported
        ? { ...imported, target_stage: targetStage }
        : parseBatchTestText(briefs, repeat, locale, targetStage);
      if (input.briefs.some((brief) => brief.attachments?.length)) {
        const filesByName = new Map(attachmentFiles.map((attachment) => [attachment.name.toLocaleLowerCase(), attachment]));
        input = {
          ...input,
          briefs: input.briefs.map((brief) => ({
            ...brief,
            attachments: brief.attachments?.map((attachment) => ({
              ...attachment,
              file: filesByName.get(attachment.filename.toLocaleLowerCase()),
            })),
          })),
        };
      }
      setInputError("");
      await onStart(input);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : t.batchTesting.invalidInput);
    }
  }

  const completed = state.cases.filter((item) => item.status === "completed").length;
  const failed = state.cases.filter((item) => item.status === "failed").length;
  const hasAttachmentFixtures = Boolean(imported?.briefs.some((brief) => brief.attachments?.length));
  const currentStep = state.currentStep && state.currentStep in t.batchTesting.steps
    ? t.batchTesting.steps[state.currentStep as keyof typeof t.batchTesting.steps]
    : state.currentStep;
  const terminal = ["completed", "partial_failure", "failed", "cancelled"].includes(state.status);

  return (
    <div className="batch-testing-box" data-performance-control="true">
      <div className="batch-testing-header">
        <div><strong>{t.batchTesting.title}</strong><p>{t.batchTesting.description}</p></div>
        {state.run ? <code>{state.run.test_id}</code> : null}
      </div>
      <div className="batch-testing-input-label-row">
        <label className="batch-testing-input-label" htmlFor="batch-testing-briefs">{t.batchTesting.briefs}</label>
        <BatchTestingJsonHelp t={t} />
      </div>
      <textarea
        id="batch-testing-briefs"
        value={briefs}
        placeholder={t.batchTesting.placeholder}
        disabled={state.busy}
        onChange={(event) => {
          setBriefs(event.target.value);
          setImported(null);
          setImportedName("");
        }}
      />
      <div className="batch-testing-controls">
        <label className="batch-testing-repeat">
          <span>{t.batchTesting.repeat}</span>
          <input type="number" min={1} max={20} value={repeat} disabled={state.busy || imported !== null} onChange={(event) => setRepeat(Number(event.target.value))} />
        </label>
        <button type="button" className="secondary-btn compact" disabled={state.busy} onClick={() => fileInputRef.current?.click()}>
          <FileJson size={14} />{t.batchTesting.importJson}
        </button>
        <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importJson(event.target.files?.[0])} />
        {importedName ? <span className="batch-testing-imported">{formatMessage(t.batchTesting.imported, { name: importedName })}</span> : null}
      </div>
      {hasAttachmentFixtures ? (
        <div className="batch-testing-controls">
          <label className="secondary-btn compact">
            {t.batchTesting.selectAttachmentFixtures}
            <input
              type="file"
              accept=".md,.txt,.doc,.docx,.pdf,.xls,.xlsx,.csv"
              multiple
              hidden
              disabled={state.busy}
              onChange={(event) => setAttachmentFiles(Array.from(event.target.files ?? []))}
            />
          </label>
          <span className="batch-testing-imported">{formatMessage(t.batchTesting.selectedAttachmentFixtures, { count: attachmentFiles.length })}</span>
        </div>
      ) : null}
      <div className="batch-testing-launch-row">
        <fieldset className="batch-testing-target-stage" disabled={state.busy}>
          <legend>{t.batchTesting.targetStage}</legend>
          <div className="batch-testing-target-options">
            {BATCH_TEST_TARGET_STAGES.map((stage) => (
              <label key={stage}>
                <input
                  type="radio"
                  name="batch-testing-target-stage"
                  value={stage}
                  checked={targetStage === stage}
                  onChange={() => setTargetStage(stage)}
                />
                <span>{t.batchTesting.targetStages[stage]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="batch-testing-actions">
          {state.busy ? (
            <button type="button" className="secondary-btn" onClick={() => void onStop()}><Square size={14} />{t.batchTesting.stop}</button>
          ) : (
            <button type="button" className="primary-btn" disabled={!briefs.trim()} onClick={() => void start()}><Play size={14} />{t.batchTesting.start}</button>
          )}
          {terminal && state.run ? (
            <button type="button" className="secondary-btn" disabled={state.bundleBusy} onClick={() => void onDownload()}>
              <Download size={14} />{state.bundleBusy ? t.batchTesting.preparingBundle : t.batchTesting.download}
            </button>
          ) : null}
        </div>
      </div>
      {inputError || state.error || state.bundleError ? <div className="batch-testing-message error">{inputError || state.error || state.bundleError}</div> : null}
      {state.bundle ? <div className="batch-testing-message">{t.batchTesting.bundleReady}</div> : null}
      {state.run ? (
        <>
          <div className="batch-testing-summary">
            <strong>{t.batchTesting.statuses[state.status === "idle" ? "pending" : state.status]}</strong>
            <span>{formatMessage(t.batchTesting.summary, { completed, failed, total: state.cases.length })}</span>
          </div>
          {state.currentCaseId ? <div className="batch-testing-current"><span>{t.batchTesting.current}</span><strong>{state.currentCaseId}</strong><small>{currentStep}</small></div> : null}
          <div className="batch-testing-case-list">
            {state.cases.map((item) => (
              <div className="batch-testing-case" key={item.case_id}>
                <span>{item.case_id}</span>
                <strong className={item.status}>{t.batchTesting.statuses[item.status]}</strong>
                {item.error ? <small title={item.error}>{item.error}</small> : null}
              </div>
            ))}
          </div>
        </>
      ) : <div className="batch-testing-message">{t.batchTesting.empty}</div>}
    </div>
  );
}
