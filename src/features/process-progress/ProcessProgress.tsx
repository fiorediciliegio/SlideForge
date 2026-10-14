import { Check, ChevronDown, Circle, FileText, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { formatMessage, type Messages } from "../../i18n/messages";
import { safeExternalUrl, type ProcessState, type ProcessStep } from "./model";

export function ProcessPanel({ t, steps }: { t: Messages; steps: ProcessStep[] }) {
  if (!steps.length) return null;
  return <div className="process-timeline"><span className="process-sr-only" role="status">{steps.filter((step) => step.state === "running").map((step) => step.label).join(" · ")}</span>{steps.map((step) => <ProcessStepView key={step.id} t={t} step={step}>
    {step.previews?.length ? <div className="process-template-previews">{step.previews.map((preview) => <img key={preview.url} src={preview.url} alt={preview.alt} loading="lazy" />)}</div> : null}
    {step.fields?.length ? <dl className="process-fields">{step.fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl> : null}
    {step.files?.length ? <ul className="process-files">{step.files.map((file, index) => <li key={index}>
      <span className="process-file-name">{file.name}</span><span className="process-file-state">{t.processProgress[file.state]}</span>
    </li>)}</ul> : null}
    {step.rounds?.length ? <div className="process-rounds">{step.rounds.map((round) => <OriginalOutput key={round.id} t={t}
      title={round.stage === "header" ? t.processProgress.outlineHeader : formatMessage(t.processProgress.outlinePages, round.pageRange ?? { start: 1, end: 1 })}
      text={round.text} state={round.state} stateLabel={round.state === "failed" ? t.processProgress.outlineInterrupted : undefined} />)}</div>
      : step.text ? <OriginalOutput t={t} text={step.text} state={step.state} /> : !step.fields?.length && !step.files?.length && !step.summary ? <ProcessEmpty t={t} state={step.state} /> : null}
  </ProcessStepView>)}</div>;
}

/** User choices survive stream updates; untouched past rounds collapse automatically. */
export function OriginalOutput({ t, text, state, title, stateLabel }: {
  t: Messages; text: string; state: ProcessState; title?: string; stateLabel?: string;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? state === "running";
  const bodyId = useId();
  return <section className={`process-original is-${state}`}>
    <button type="button" className="process-original-heading" aria-expanded={open} aria-controls={bodyId}
      onClick={() => setChoice(!open)}>
      <FileText size={17} aria-hidden="true" />
      <span className="process-original-title"><strong>{title ?? t.processProgress.raw}</strong></span>
      <span className="process-original-state">{stateLabel ?? t.processProgress[state]}</span>
      <ChevronDown size={16} className={open ? "is-open" : ""} aria-hidden="true" />
    </button>
    <div id={bodyId} hidden={!open}>
      <LiveText t={t} text={text} running={state === "running"} />
    </div>
  </section>;
}

export function ProcessEmpty({ t, state }: { t: Messages; state: ProcessState }) {
  if (state === "completed") return null;
  return <p className="process-empty">{state === "running" ? t.processProgress.waitingOutput : t.processProgress[state]}</p>;
}

export function ProcessStepView({ t, step, children, open: controlledOpen, onToggle, performanceId = "process.step.toggle" }: {
  t: Messages; step: ProcessStep; children?: ReactNode; open?: boolean; onToggle?: () => void; performanceId?: string;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = controlledOpen ?? choice ?? (step.state === "running" || step.state === "failed");
  const bodyId = useId();
  const Icon = step.state === "running" ? LoaderCircle : step.state === "completed" ? Check
    : step.state === "failed" || step.state === "warning" ? TriangleAlert : Circle;
  return <article className={`process-step is-${step.state}`}>
    <button type="button" className="process-step-heading" aria-expanded={open} aria-controls={bodyId}
      data-performance-id={performanceId} onClick={() => onToggle ? onToggle() : setChoice(!open)}>
      <span className="process-step-marker"><Icon size={16} aria-hidden="true" /></span>
      <span className="process-step-copy"><strong>{step.label}</strong>{step.summary ? <span>{step.summary}</span> : null}</span>
      <span className="process-step-meta"><span className="process-state">{t.processProgress[step.state]}</span>
        <ElapsedTime startedAt={step.startedAt} endedAt={step.endedAt} state={step.state} />
        <ChevronDown size={16} className={open ? "is-open" : ""} aria-hidden="true" />
      </span>
    </button>
    <div id={bodyId} className="process-step-body" hidden={!open}>{children}</div>
  </article>;
}

function ElapsedTime({ startedAt, endedAt, state }: { startedAt?: number; endedAt?: number; state: ProcessState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt || state !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, state]);
  if (!startedAt) return null;
  const seconds = Math.max(0, Math.floor(((endedAt ?? now) - startedAt) / 1000));
  return <time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</time>;
}

export function LiveText({ t, text, running = false, report = false }: { t: Messages; text: string; running?: boolean; report?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (following.current && box.current) box.current.scrollTop = box.current.scrollHeight;
    else setUnread(true);
  }, [text, report]);
  return <div className={`process-live${report ? " process-live-report" : ""}`}>
    {!report || running ? <div className="process-live-toolbar"><small>{report ? t.processProgress.reportWriting : running ? t.processProgress.pendingValidation : formatMessage(t.processProgress.received, { count: text.length })}</small></div> : null}
    <div ref={box} className="process-live-scroll" tabIndex={0} aria-label={report ? t.processProgress.report : t.processProgress.raw}
      onScroll={() => { const el = box.current; if (el) { following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; if (following.current) setUnread(false); } }}>
      {text ? report ? <ReportText text={text} /> : <pre>{text}</pre> : <ProcessEmpty t={t} state={running ? "running" : "completed"} />}
    </div>
    {unread ? <button type="button" className="process-follow" onClick={() => { following.current = true; setUnread(false); if (box.current) box.current.scrollTop = box.current.scrollHeight; }}>{t.processProgress.latest}</button> : null}
  </div>;
}

export function SourceLink({ url, children }: { url?: string; children: ReactNode }) {
  const href = safeExternalUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}

/** A deliberately small Markdown presentation layer. All HTML remains escaped React text. */
export function ReportText({ text }: { text: string }) {
  return <div className="process-report">{text.split(/\n\s*\n/).map((block, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(block.trim());
    if (heading) return <h3 key={index}>{inlineText(heading[2])}</h3>;
    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, i) => <li key={i}>{inlineText(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
    return <p key={index}>{inlineText(block)}</p>;
  })}</div>;
}

function inlineText(text: string): ReactNode[] {
  return text.split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|https?:\/\/[^\s<>]+)/g).map((part, i) => {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <SourceLink key={i} url={link[2]}>{link[1]}</SourceLink>;
    if (/^https?:\/\//.test(part)) return <SourceLink key={i} url={part}>{part}</SourceLink>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/** Mount-time default only: streaming updates must not override a user's disclosure choice. */
export function ProcessDisclosure({ initiallyOpen = false, className = "process-details", children }: { initiallyOpen?: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className={className} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>{children}</details>;
}
