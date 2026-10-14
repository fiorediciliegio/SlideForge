import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Loader2, Palette, RefreshCw, RotateCcw, Sparkles, Trash2, Wand2, X } from "lucide-react";
import type { Messages } from "../../i18n/messages";
import type { MasterOptimization, MasterOptimizeIntensity, MasterOptimizeScope } from "./prompts";
import type { UserTemplateListEntry } from "./types";
import { compareMasters } from "./masterDrift";
import { extractRootBlock } from "./masterVarSync";

const SCOPE_OPTIONS: { key: MasterOptimizeScope; labelKey: "masterScopeHeader" | "masterScopeTitle" | "masterScopeContent" | "masterScopeFooter" | "masterScopeColors" | "masterScopeBackground" | "masterScopeTypography" }[] = [
  { key: "header", labelKey: "masterScopeHeader" },
  { key: "title", labelKey: "masterScopeTitle" },
  { key: "content", labelKey: "masterScopeContent" },
  { key: "footer", labelKey: "masterScopeFooter" },
  { key: "colors", labelKey: "masterScopeColors" },
  { key: "background", labelKey: "masterScopeBackground" },
  { key: "typography", labelKey: "masterScopeTypography" },
];

/** Generated masters/pages are fixed-pixel slide canvases (e.g. 1920x1080)
 *  authored for rasterization, not responsive web pages. Inject a small
 *  scale-to-fit script so the sandboxed iframe shows the whole slide at any
 *  window size: measure the design box (.slide, else meta viewport), scale by
 *  min(widthRatio, heightRatio), recalc on resize/load. */
export function withFitScript(html: string): string {
  const fit = `<script>(function(){function designSize(){var s=document.querySelector('.slide');if(s)return[s.offsetWidth,s.offsetHeight];var m=document.querySelector('meta[name="viewport"]');var c=m&&m.content.match(/width=([0-9.]+)[^,]*,\\s*height=([0-9.]+)/);return c?[Number(c[1]),Number(c[2])]:null;}
function fit(){var d=designSize();if(!d)return;var k=Math.min(innerWidth/d[0],innerHeight/d[1]);var s=document.querySelector('.slide');document.documentElement.style.overflow='hidden';if(s){s.style.transform='scale('+k+')';s.style.transformOrigin='top left';}document.body.style.display='block';document.body.style.margin='0 auto';document.body.style.width=d[0]*k+'px';document.body.style.height=d[1]*k+'px';document.body.style.minHeight='0';}
addEventListener('resize',fit);addEventListener('load',function(){setTimeout(fit,0);});fit();})();</scr` + `ipt>`;
  return /<\/html\s*>/i.test(html) ? html.replace(/<\/html\s*>/i, `${fit}</html>`) : `${html}${fit}`;
}

interface Props {
  t: Messages;
  record: UserTemplateListEntry;
  getTemplateHtmls: (id: string, pageNumber?: number) => Promise<{ html: string; previous_html: string | null }>;
  regenerate: (id: string, instruction: string, pageNumber?: number, onStream?: (text: string) => void, intensity?: MasterOptimizeIntensity, scope?: MasterOptimizeScope) => Promise<MasterOptimization>;
  applyHtml: (record: UserTemplateListEntry, html: string, pageNumber?: number) => Promise<void>;
  /** Variable cascade: push the master's :root variables into every
   *  reference page. Resolves to the number of pages actually changed. */
  syncVars: (id: string) => Promise<number>;
  /** PNG preview channel (same as the template preview dialog): millisecond
   *  browsing without rebuilding a sandboxed iframe per page switch. */
  previewUrl: (id: string, pageNumber?: number) => Promise<string>;
  onClose: () => void;
}

/** One-line drift verdict between the saved master and the pending proposal:
 * "改了 3 处颜色 · logo 原位 · 占位符完好" — the user adopts with numbers,
 * not gut feel. Pure regex-level comparison (see masterDrift). */
function DriftReport({ currentHtml, proposed, copy }: { currentHtml: string | null; proposed: MasterOptimization; copy: Messages["userTemplates"] }) {
  if (!currentHtml) return null;
  const drift = compareMasters(currentHtml, proposed.master_html);
  const colorCount = drift.colors.added + drift.colors.removed + drift.colors.changed;
  const fontCount = drift.fontSizes.added + drift.fontSizes.removed + drift.fontSizes.changed;
  const logoStatus = drift.logos.lost > 0 ? "lost" : drift.logos.moved > 0 || drift.logos.added > 0 ? "moved" : "ok";
  const markersOk = drift.markers.title && drift.markers.content;
  const parts: { text: string; tone: "ok" | "warn" | "bad" }[] = [
    { text: `${copy.masterDriftColors} ${colorCount ? copy.masterDriftChanged.replace("{n}", String(colorCount)) : copy.masterDriftUnchanged}`, tone: colorCount ? "warn" : "ok" },
    { text: `${copy.masterDriftFonts} ${fontCount ? copy.masterDriftChanged.replace("{n}", String(fontCount)) : copy.masterDriftUnchanged}`, tone: fontCount ? "warn" : "ok" },
    { text: `${copy.masterDriftLogo} ${logoStatus === "ok" ? copy.masterDriftLogoInPlace : logoStatus === "moved" ? copy.masterDriftLogoMoved : copy.masterDriftLogoLost}`, tone: logoStatus === "ok" ? "ok" : logoStatus === "moved" ? "warn" : "bad" },
    { text: `${copy.masterDriftMarkers} ${markersOk ? copy.masterDriftOk : copy.masterDriftLost}`, tone: markersOk ? "ok" : "bad" },
    { text: `${copy.masterDriftSkeleton} ${drift.skeletonChanged ? copy.masterDriftChanged.replace("{n}", "1") : copy.masterDriftUnchanged}`, tone: drift.skeletonChanged ? "warn" : "ok" },
  ];
  return (
    <p className="user-template-master-drift" aria-live="polite">
      <strong>{copy.masterDriftTitle}</strong>
      {parts.map((part, index) => (
        <span key={index} className={`user-template-master-drift-item drift-${part.tone}`}>{part.text}</span>
      ))}
    </p>
  );
}

/** Master/page workbench. The preview stage owns the whole dialog; the AI
 *  tuner and source tools live in a collapsible bottom drawer so browsing
 *  always gets maximum space. Dual-track stage: PNG for browsing, live
 *  iframe (scale-to-fit) for source editing and the not-yet-persisted AI
 *  proposal. Every page is editable, not just the master. */
export function MasterPreviewPanel({ t, record, getTemplateHtmls, regenerate, applyHtml, syncVars, previewUrl, onClose }: Props) {
  const copy = t.userTemplates;
  const [pageNumber, setPageNumber] = useState<number | undefined>(undefined);
  const [current, setCurrent] = useState<{ html: string; previous_html: string | null } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [intensity, setIntensity] = useState<MasterOptimizeIntensity>("balanced");
  const [scopeMode, setScopeMode] = useState<"overall" | "custom">("overall");
  const [scope, setScope] = useState<MasterOptimizeScope>("header");
  const [generating, setGenerating] = useState(false);
  const [streamTail, setStreamTail] = useState("");
  /** Un-adopted AI results, archived per document ("master" or page number) so
   *  switching tabs is a context switch, not a destruction: cross-page
   *  comparison keeps every pending proposal until adopted or discarded. */
  const [proposals, setProposals] = useState<ReadonlyMap<string, MasterOptimization>>(new Map());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [varsPrompt, setVarsPrompt] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"current" | "proposed">("current");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");
  // "image" = PNG browsing (default, fast); "iframe" = live HTML, required for
  // source editing and for rendering the not-yet-persisted AI proposal.
  const [stageMode, setStageMode] = useState<"image" | "iframe">("image");
  const [imageUrl, setImageUrl] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  /** The AI tuner is always visible below the stage (owner decision: no
   *  collapsible drawer); the dock button is a scroll-to anchor. */
  const drawerRef = useRef<HTMLDivElement>(null);
  const [pendingClose, setPendingClose] = useState(false);
  /** True between a page switch and the display-relevant fetch landing: the
   *  stage keeps the previous document visible but dimmed under a spinner —
   *  never passes stale content off as the current page. */
  const [switching, setSwitching] = useState(false);
  const closeDialogRef = useRef<HTMLDialogElement>(null);
  const htmlRequestRef = useRef(0);
  const imageBoxRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  /** The stage owns a STABLE height (the slide's natural 16:9 display size,
   *  width-driven, capped so short screens never blow up) instead of flexing
   *  with the AI section — content below extends the page downward and the
   *  panel scrolls as one, never squeezing the preview upward. The inner fit
   *  letterboxes inside that stable box. (CSS max-height:100% provably fails
   *  to resolve in this flex-inside-overflow:auto chain, so sizing is
   *  explicit.) */
  useEffect(() => {
    const resize = resizeRef.current;
    if (!resize || typeof ResizeObserver === "undefined") return;
    const setStageHeight = () => {
      const w = resize.clientWidth;
      if (!w) return;
      const natural = Math.round((w * 9) / 16);
      const cap = Math.round(window.innerHeight * 0.72);
      resize.style.height = `${Math.min(natural, cap)}px`;
    };
    setStageHeight();
    const observer = new ResizeObserver(setStageHeight);
    observer.observe(resize);
    window.addEventListener("resize", setStageHeight);
    return () => { observer.disconnect(); window.removeEventListener("resize", setStageHeight); };
  }, []);
  useEffect(() => {
    const box = imageBoxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const img = box.querySelector("img");
      if (!img) return;
      const { clientWidth: w, clientHeight: h } = box;
      if (!w || !h) return;
      const scale = Math.min(w / 16, h / 9);
      img.style.width = `${Math.floor(scale * 16)}px`;
      img.style.height = `${Math.floor(scale * 9)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [stageMode, pageNumber, imageUrl]);
  const stageModeRef = useRef(stageMode);
  useEffect(() => { stageModeRef.current = stageMode; }, [stageMode]);
  useEffect(() => { if (pendingClose && !closeDialogRef.current?.open) closeDialogRef.current?.showModal(); }, [pendingClose]);
  const pageKey = pageNumber === undefined ? "master" : String(pageNumber);
  const proposed = proposals.get(pageKey) ?? null;
  const setProposalFor = (key: string, value: MasterOptimization | null) => setProposals((map) => {
    const next = new Map(map);
    if (value) next.set(key, value);
    else next.delete(key);
    return next;
  });
  const load = useCallback((page?: number) => {
    const request = ++htmlRequestRef.current;
    setLoadFailed(false);
    getTemplateHtmls(record.id, page)
      .then((result) => {
        if (request !== htmlRequestRef.current) return; // stale response from an earlier page
        setCurrent(result);
        if (stageModeRef.current === "iframe") setSwitching(false);
      })
      .catch(() => { if (request === htmlRequestRef.current) setLoadFailed(true); });
  }, [record.id, getTemplateHtmls]);
  useEffect(() => { load(pageNumber); }, [pageNumber, load]);
  useEffect(() => {
    if (stageMode !== "image") return;
    let cancelled = false;
    setImageFailed(false);
    previewUrl(record.id, pageNumber)
      .then((url) => {
        if (cancelled) return;
        setImageUrl(url);
        setSwitching(false);
      })
      .catch(() => { if (!cancelled) setImageFailed(true); });
    return () => { cancelled = true; };
  }, [stageMode, pageNumber, record.id, previewUrl]);
  const switchPage = (page?: number) => {
    const nextKey = page === undefined ? "master" : String(page);
    const hasProposal = proposals.has(nextKey);
    setSwitching(true);
    setPageNumber(page);
    setView(hasProposal ? "proposed" : "current");
    setSourceOpen(false);
    setStageMode(hasProposal ? "iframe" : "image");
    setError("");
    setNotice("");
  };
  /** Preset suggestions tagged with the sections they make sense for, so the
   *  chip row follows the selected 调整范围 instead of offering irrelevant
   *  one-click fills. */
  const chips: { key: string; text: string; scopes: MasterOptimizeScope[] }[] = [
    { key: "masterChipDark", text: copy.masterChipDark, scopes: ["colors", "background"] },
    { key: "masterChipAccent", text: copy.masterChipAccent, scopes: ["colors"] },
    { key: "masterChipHeading", text: copy.masterChipHeading, scopes: ["title", "typography"] },
    { key: "masterChipCenter", text: copy.masterChipCenter, scopes: ["title"] },
    { key: "masterChipDecorate", text: copy.masterChipDecorate, scopes: ["background"] },
    { key: "masterChipBusiness", text: copy.masterChipBusiness, scopes: [] },
    { key: "masterChipCompact", text: copy.masterChipCompact, scopes: ["content"] },
    { key: "masterChipPageNum", text: copy.masterChipPageNum, scopes: ["footer"] },
    { key: "masterChipLoose", text: copy.masterChipLoose, scopes: ["typography", "content"] },
  ];
  const visibleChips = scopeMode === "custom" ? chips.filter((chip) => chip.scopes.includes(scope)) : chips;
  const appendChip = (text: string) => setInstruction((currentInstruction) => {
    const trimmed = currentInstruction.trim();
    return trimmed ? `${trimmed}，${text}` : text;
  });
  const regenerateCurrent = async () => {
    const text = instruction.trim();
    if (!text || generating || busy) return;
    setGenerating(true); setError(""); setNotice(""); setStreamTail("");
    try {
      const result = await regenerate(record.id, text, pageNumber, (streamed) => setStreamTail(streamed.slice(-160)), intensity, scopeMode === "custom" ? scope : undefined);
      setProposalFor(pageKey, result);
      setView("proposed");
      setStageMode("iframe");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setGenerating(false); }
  };
  /** Variable cascade: master :root -> every reference page (colors/fonts
   *  only). Refreshes previews of changed pages when done. */
  const cascadeVars = async () => {
    setBusy(true); setError(""); setNotice(""); setVarsPrompt(false);
    try {
      const changed = await syncVars(record.id);
      htmlRequestRef.current += 1;
      const [fresh, url] = await Promise.all([
        getTemplateHtmls(record.id, pageNumber),
        previewUrl(record.id, pageNumber),
      ]);
      const request = htmlRequestRef.current;
      setCurrent(fresh);
      setSourceDraft(fresh.html);
      setImageUrl(url);
      void request;
      setNotice(changed > 0 ? copy.masterVarsSynced.replace("{n}", String(changed)) : copy.masterVarsNone);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const persist = async (html: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await applyHtml(record, html, pageNumber);
      // Fetch BOTH fresh artifacts before switching the view, so the first
      // paint after adopt is the new version — never a stale frame.
      htmlRequestRef.current += 1;
      const [fresh, url] = await Promise.all([
        getTemplateHtmls(record.id, pageNumber),
        previewUrl(record.id, pageNumber),
      ]);
      setCurrent(fresh);
      setImageUrl(url);
      setProposalFor(pageKey, null);
      setView("current");
      setSourceOpen(false);
      setStageMode("image");
      setSwitching(false);
      setNotice(record.status === "ready" ? copy.masterRepublished : copy.masterSavedDraft);
      // Adopting a restyled master: offer the variable cascade inline (the
      // reference pages keep their snapshot identity unless the user says go).
      const rootBefore = extractRootBlock(current?.html ?? "");
      setVarsPrompt(pageNumber === undefined && rootBefore !== null && rootBefore !== extractRootBlock(html));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const discardProposal = () => {
    setProposalFor(pageKey, null);
    setView("current");
    setStageMode("image");
  };
  /** Closing with pending proposals anywhere loses them; ask once. */
  const requestClose = () => {
    if (proposals.size > 0) setPendingClose(true);
    else onClose();
  };
  const displayedHtml = view === "proposed" && proposed ? proposed.master_html : current?.html ?? "";
  const editablePages = record.pages.filter((p) => record.completed_pages.includes(p.page_number));
  return (
    <div className="user-template-editor-overlay">
      <div className="user-template-master-panel" role="dialog" aria-label={copy.masterPanelTitle}>
        <header>
          <strong>{copy.masterPanelTitle}</strong>
          <span className="user-template-master-badge">{record.name}{record.status === "ready" ? ` · v${record.version}` : ` · ${copy.masterBadgeDraft}`}</span>
          <button type="button" className="icon-btn" onClick={requestClose} aria-label={copy.editorCancel}><X size={18} /></button>
        </header>
        <nav className="user-template-master-nav" aria-label={copy.masterPanelTitle}>
          <button type="button" className={pageNumber === undefined ? "active" : ""} onClick={() => switchPage(undefined)}>{copy.master}</button>
          {editablePages.map((p) => (
            <button key={p.page_number} type="button" className={pageNumber === p.page_number ? "active" : ""} onClick={() => switchPage(p.page_number)}>{`${copy.page} ${p.page_number}`}</button>
          ))}
        </nav>
        <div className="user-template-master-resize" ref={resizeRef}>
          <div className="user-template-master-stage">
            {stageMode === "image" ? (
              <div className="user-template-master-image" ref={imageBoxRef}>
                {imageUrl && !imageFailed ? <img src={imageUrl} alt={pageNumber === undefined ? copy.master : `${copy.page} ${pageNumber}`} onError={() => setImageFailed(true)} /> : <p>{imageFailed ? copy.previewFailed : copy.loading}</p>}
              </div>
            ) : sourceOpen ? (
              <textarea className="user-template-master-source" rows={18} value={sourceDraft} spellCheck={false}
                onChange={(event) => setSourceDraft(event.target.value)} aria-label={copy.masterEditSource} />
            ) : (
              <iframe className="user-template-master-frame" sandbox="allow-scripts" title={copy.masterPanelTitle} srcDoc={withFitScript(displayedHtml)} />
            )}
            {proposed && !sourceOpen && stageMode === "iframe" ? (
              <div className="user-template-master-switch" role="tablist">
                <button type="button" role="tab" aria-selected={view === "current"} className={view === "current" ? "active" : ""} onClick={() => setView("current")}>{copy.masterViewCurrent}</button>
                <button type="button" role="tab" aria-selected={view === "proposed"} className={view === "proposed" ? "active" : ""} onClick={() => setView("proposed")}>{copy.masterViewProposed}</button>
              </div>
            ) : null}
            {switching || generating ? <div className="user-template-master-pending" aria-live="polite"><Loader2 className="user-template-spinner" size={22} />{generating ? <span>{copy.masterGenerating}</span> : null}</div> : null}
          </div>
        </div>
        {loadFailed ? <p role="alert" className="user-template-editor-invalid">{copy.masterLoadFailed}</p> : null}
        <div className="user-template-master-drawer" ref={drawerRef}>
            <div className="user-template-master-intensity" role="radiogroup" aria-label={copy.masterScopeLabel}>
              <span className="user-template-master-intensity-label">{copy.masterScopeLabel}</span>
              <button type="button" role="radio" aria-checked={scopeMode === "overall"}
                className={`user-template-master-chip${scopeMode === "overall" ? " active" : ""}`}
                onClick={() => setScopeMode("overall")}>{copy.masterScopeOverall}</button>
              <button type="button" role="radio" aria-checked={scopeMode === "custom"}
                className={`user-template-master-chip${scopeMode === "custom" ? " active" : ""}`}
                onClick={() => setScopeMode("custom")}>{copy.masterScopeCustom}</button>
              {scopeMode === "custom" ? (
                <select className="user-template-master-scope-select" value={scope} onChange={(event) => setScope(event.target.value as MasterOptimizeScope)} aria-label={copy.masterScopeCustom}>
                  {SCOPE_OPTIONS.map((option) => <option key={option.key} value={option.key}>{copy[option.labelKey]}</option>)}
                </select>
              ) : null}
            </div>
            <div className="user-template-master-intensity" role="radiogroup" aria-label={copy.masterIntensityLabel}>
              <span className="user-template-master-intensity-label">{copy.masterIntensityLabel}</span>
              {(["conservative", "balanced", "bold"] as const).map((level) => (
                <button key={level} type="button" role="radio" aria-checked={intensity === level}
                  className={`user-template-master-chip${intensity === level ? " active" : ""}`}
                  title={level === "conservative" ? copy.masterIntensityConservativeHint : undefined}
                  onClick={() => setIntensity(level)}>
                  {level === "conservative" ? copy.masterIntensityConservative : level === "balanced" ? copy.masterIntensityBalanced : copy.masterIntensityBold}
                </button>
              ))}
              <span className="user-template-master-intensity-desc" aria-live="polite">
                {intensity === "conservative" ? copy.masterIntensityConservativeDesc : intensity === "balanced" ? copy.masterIntensityBalancedDesc : copy.masterIntensityBoldDesc}
              </span>
            </div>
            <div className="user-template-master-chips">
              <span className="user-template-master-chips-hint">{visibleChips.length ? copy.masterChipsHint : copy.masterChipsEmpty}</span>
              {visibleChips.map((chip) => (
                <button key={chip.key} type="button" className="user-template-master-chip" disabled={generating || busy} onClick={() => appendChip(chip.text)}>{chip.text}</button>
              ))}
            </div>
            <div className="user-template-editor-chat-row">
              <input type="text" value={instruction} placeholder={copy.masterInstructionPlaceholderRich} disabled={generating || busy}
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void regenerateCurrent(); } }} />
              <button type="button" className="secondary-btn compact" disabled={generating || busy || !instruction.trim()} onClick={() => { void regenerateCurrent(); }}>
                {generating ? <Loader2 className="user-template-spinner" size={13} /> : <Sparkles size={13} />}{copy.masterRegenerate}
              </button>
            </div>
            {generating ? <p className="user-template-master-stream" aria-live="polite">{copy.masterGenerating}{streamTail ? ` · ${streamTail}` : ""}</p> : null}
            {proposed ? (
              <div className="user-template-master-proposed">
                <DriftReport currentHtml={current?.html ?? null} proposed={proposed} copy={copy} />
                <p><strong>{copy.masterSummaryTitle}</strong>{proposed.summary}</p>
                <p><strong>{copy.masterChangedTitle}</strong></p>
                <ul>{proposed.changed.map((item, index) => <li key={index}>{item}</li>)}</ul>
                <div className="user-template-master-actions">
                  <button type="button" className="primary-btn" disabled={busy || generating} onClick={() => { void persist(proposed.master_html); }}>
                    <Check size={15} />{copy.masterAdopt}
                  </button>
                  <button type="button" className="secondary-btn" disabled={busy || generating} onClick={discardProposal}>
                    <Trash2 size={15} />{copy.masterDiscard}
                  </button>
                </div>
              </div>
            ) : null}
            {notice ? <p role="status" className="user-template-editor-chat-notice">{notice}</p> : null}
            {varsPrompt ? (
              <div className="user-template-master-vars-prompt" role="group" aria-label={copy.masterVarsPromptTitle}>
                <span>{copy.masterVarsPrompt.replace("{n}", String(editablePages.length))}</span>
                <button type="button" className="secondary-btn compact" disabled={busy || generating} onClick={() => { void cascadeVars(); }}>
                  <Palette size={13} />{copy.masterSyncVars}
                </button>
                <button type="button" className="secondary-btn compact" onClick={() => setVarsPrompt(false)}>{copy.masterVarsLater}</button>
              </div>
            ) : null}
            {error ? <p role="alert" className="user-template-editor-invalid">{error}</p> : null}
          </div>
        <div className="user-template-master-dock">
          {sourceOpen ? (
            <>
              <button type="button" className="secondary-btn compact" disabled={busy || sourceDraft === (current?.html ?? "")} onClick={() => { void persist(sourceDraft); }}>
                <Check size={13} />{copy.masterSaveSource}
              </button>
              <button type="button" className="secondary-btn compact" onClick={() => { setSourceOpen(false); if (!proposed) setStageMode("image"); }}>{copy.masterCloseSource}</button>
            </>
          ) : (
            <button type="button" className="secondary-btn compact" disabled={!current} onClick={() => { setSourceDraft(current?.html ?? ""); setSourceOpen(true); setStageMode("iframe"); }}>
              <RefreshCw size={13} />{copy.masterEditSource}
            </button>
          )}
          {current?.previous_html ? (
            <button type="button" className="secondary-btn compact" disabled={busy || generating} onClick={() => { void persist(current.previous_html as string); }}>
              <RotateCcw size={13} />{copy.masterRollback}
            </button>
          ) : null}
          <button type="button" className="secondary-btn compact user-template-master-dock-ai" onClick={() => drawerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <Wand2 size={13} />{copy.masterOptimizeTitle}<ChevronUp size={13} />
          </button>
        </div>
        {pendingClose ? <dialog ref={closeDialogRef} className="user-template-dialog user-template-confirm" onCancel={() => setPendingClose(false)} onClose={() => setPendingClose(false)} aria-label={copy.masterCloseUnsaved}>
          <header><strong>{copy.masterCloseUnsaved}</strong></header>
          <p>{copy.masterCloseUnsavedBody.replace("{n}", String(proposals.size))}</p>
          <div className="user-template-confirm-actions">
            <button type="button" className="secondary-btn" autoFocus onClick={() => setPendingClose(false)}>{copy.masterCloseKeep}</button>
            <button type="button" className="danger-btn" onClick={() => { setPendingClose(false); onClose(); }}>{copy.masterCloseDiscard}</button>
          </div>
        </dialog> : null}
      </div>
    </div>
  );
}
