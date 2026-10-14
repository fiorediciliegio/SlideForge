import { useEffect, useState } from "react";
import { Beaker, CircleStop, Play, RotateCcw } from "lucide-react";
import type { Locale, Messages } from "../../i18n/messages";
import { LocaleSwitch } from "../deck-workspace/components/LocaleSwitch";
import { WEB_RESEARCH_AGENT_MODEL, WEB_RESEARCH_AGENT_SYSTEM_PROMPT } from "../../ai/webResearchAgent";
import type { WebResearchLabState } from "./types";

interface WebResearchLabPageProps {
  t: Messages;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  state: WebResearchLabState;
  onExit: () => Promise<void>;
  onRun: (input: { systemPrompt: string; userPrompt: string; modelPreference: string }) => Promise<void>;
  onStop: () => Promise<void>;
}

const MODEL_OPTIONS = [
  { group: "Claude", models: [
    { label: "Claude Opus 4.5", id: "anthropic/claude-opus-4.5" },
    { label: "Claude Sonnet 4.5", id: "anthropic/claude-sonnet-4.5" },
  ] },
  { group: "Gemini", models: [
    { label: "Gemini 2.5 Pro", id: "google/gemini-2.5-pro" },
    { label: "Gemini 3 Flash Preview", id: "google/gemini-3-flash-preview" },
    { label: "Gemini 3.1 Flash Lite Preview", id: "google/gemini-3.1-flash-lite-preview" },
    { label: "Gemini 3.5 Flash", id: "google/gemini-3.5-flash" },
  ] },
  { group: "GPT", models: [
    { label: "GPT-5 Mini", id: "openai/gpt-5-mini" },
    { label: "GPT-5.1", id: "openai/gpt-5.1" },
    { label: "GPT-5.3 Chat", id: "openai/gpt-5.3-chat" },
  ] },
  { group: "Kimi", models: [
    { label: "Kimi K2.5", id: "moonshotai/kimi-k2.5" },
    { label: "Kimi K2.6", id: "moonshotai/kimi-k2.6" },
  ] },
  { group: "MiMo", models: [
    { label: "MiMo-V2-Flash", id: "xiaomi/mimo-v2-flash" },
    { label: "MiMo-V2.5", id: "xiaomi/mimo-v2.5" },
    { label: "MiMo-V2.5-Pro", id: "xiaomi/mimo-v2.5-pro" },
  ] },
  { group: "MiniMax", models: [
    { label: "MiniMax M2.7", id: "minimax/minimax-m2.7" },
    { label: "MiniMax M3", id: "minimax/minimax-m3" },
  ] },
  { group: "Qwen", models: [
    { label: "Qwen3.6 Flash", id: "qwen3.6-flash" },
    { label: "Qwen3.7 Max", id: "qwen3.7-max" },
    { label: "Qwen3.7 Plus", id: "qwen3.7-plus" },
  ] },
];

export function WebResearchLabPage({ t, locale, setLocale, state, onExit, onRun, onStop }: WebResearchLabPageProps) {
  const [systemPrompt, setSystemPrompt] = useState(state.systemPrompt);
  const [userPrompt, setUserPrompt] = useState(state.userPrompt);
  const [modelPreference, setModelPreference] = useState(state.modelPreference);

  useEffect(() => {
    if (state.status === "idle" && !state.runId) {
      setSystemPrompt(state.systemPrompt);
      setModelPreference(state.modelPreference);
    }
  }, [state.modelPreference, state.runId, state.status, state.systemPrompt]);

  const running = state.status === "running";
  const canRun = !running && userPrompt.trim().length > 0;

  return (
    <div className="web-research-lab-shell">
      <div className="web-research-lab-topbar">
        <div className="web-research-lab-brand">
          <Beaker size={18} aria-hidden="true" />
          <div><span>{t.appName}</span><strong>{t.webResearchLab.title}</strong></div>
        </div>
        <div className="web-research-lab-controls">
          <LocaleSwitch t={t} locale={locale} setLocale={setLocale} />
          <button type="button" className="control-btn text" onClick={() => void onExit()} disabled={running}>
            {t.batchTesting.exit}
          </button>
        </div>
      </div>

      <div className="web-research-lab-scroll">
        <section className="web-research-lab-panel web-research-lab-config">
          <div className="web-research-lab-heading">
            <div><p className="web-research-lab-kicker">{t.webResearchLab.kicker}</p><h1>{t.webResearchLab.heading}</h1></div>
            <p>{t.webResearchLab.helper}</p>
          </div>
          <label className="web-research-lab-field">
            <span>{t.webResearchLab.systemPrompt}</span>
            <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={12} disabled={running} />
          </label>
          <label className="web-research-lab-field">
            <span>{t.webResearchLab.userPrompt}</span>
            <textarea value={userPrompt} onChange={(event) => setUserPrompt(event.target.value)} rows={8} disabled={running} placeholder={t.webResearchLab.userPlaceholder} />
          </label>
          <label className="web-research-lab-field web-research-lab-model-field">
            <span>{t.webResearchLab.modelPreference}</span>
            <select value={modelPreference} onChange={(event) => setModelPreference(event.target.value)} disabled={running}>
              {MODEL_OPTIONS.map((group) => <optgroup key={group.group} label={group.group}>{group.models.map((model) => <option key={model.id} value={model.id}>{model.label} · {model.id}</option>)}</optgroup>)}
            </select>
          </label>
          <div className="web-research-lab-actions">
            <button type="button" className="primary-btn" onClick={() => void onRun({ systemPrompt, userPrompt, modelPreference })} disabled={!canRun}>
              <Play size={15} aria-hidden="true" />{t.webResearchLab.run}
            </button>
            <button type="button" className="secondary-btn" onClick={() => void onStop()} disabled={!running}>
              <CircleStop size={15} aria-hidden="true" />{t.webResearchLab.stop}
            </button>
            <button type="button" className="secondary-btn" onClick={() => { setSystemPrompt(WEB_RESEARCH_AGENT_SYSTEM_PROMPT); setUserPrompt(""); setModelPreference(WEB_RESEARCH_AGENT_MODEL); }} disabled={running}>
              <RotateCcw size={15} aria-hidden="true" />{t.webResearchLab.reset}
            </button>
          </div>
          {state.error ? <p className="web-research-lab-error">{state.error}</p> : null}
          {state.runDir ? <p className="web-research-lab-run-dir">{t.webResearchLab.runDirectory}{state.runDir}</p> : null}
        </section>

        <section className="web-research-lab-panel">
          <div className="web-research-lab-section-heading"><h2>{t.webResearchLab.traceTitle}</h2><span>{state.events.length} {t.webResearchLab.events}</span></div>
          <div className="web-research-lab-events">
            {state.events.length === 0 ? <p className="web-research-lab-empty">{t.webResearchLab.emptyTrace}</p> : state.events.map((event, index) => (
              <details key={`${event.type}-${event.round ?? 0}-${index}`} className={`web-research-lab-event ${event.type}`} open={event.type === "failed" || event.type === "completed"}>
                <summary><span>{event.round ? `#${event.round} ` : ""}{t.webResearchLab.eventLabels[event.type] || event.type}</span><strong>{event.message}</strong></summary>
                {event.data !== undefined ? <pre>{typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2)}</pre> : null}
              </details>
            ))}
          </div>
        </section>

        <section className="web-research-lab-panel">
          <div className="web-research-lab-section-heading"><h2>{t.webResearchLab.resultTitle}</h2><span>{state.rounds.length} {t.webResearchLab.rounds}</span></div>
          {state.resultMarkdown ? <pre className="web-research-lab-result">{state.resultMarkdown}</pre> : <p className="web-research-lab-empty">{t.webResearchLab.emptyResult}</p>}
        </section>
      </div>
    </div>
  );
}
