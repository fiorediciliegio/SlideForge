import { useEffect, useRef, useState } from "react";
import { Check, ImageIcon, Loader2, Palette, Plus, RefreshCw, SendHorizonal, Sparkles, Trash2, Type, LayoutGrid, MessageSquareText, X } from "lucide-react";
import type { Messages } from "../../i18n/messages";
import type { DesignProfile, DesignProfileColor, DesignProfileFixedAsset, ProfileAssetMeta } from "./types";
import type { ProfileSection } from "./useUserTemplates";
import type { ProfileOpsResult } from "./profile-ops";
import { AssetRegionPicker } from "./AssetRegionPicker";
import type { AssetRegionKey } from "./assetRegions";

const REGION_KEYS: AssetRegionKey[] = ["top-left", "top-center", "top-right", "mid-left", "center", "mid-right", "bottom-left", "bottom-center", "bottom-right"];

interface Props {
  t: Messages;
  profile: DesignProfile;
  reextracting: ProfileSection | "";
  onReextract: (section: ProfileSection) => Promise<Partial<DesignProfile> | null>;
  onSuggest: (profile: DesignProfile, instruction: string) => Promise<ProfileOpsResult>;
  importAsset: (file: File) => Promise<ProfileAssetMeta>;
  assetUrl: (filename: string) => Promise<string>;
  onConfirm: (profile: DesignProfile) => void;
  onCancel: () => void;
}

function SectionHeader({ icon, title, section, reextracting, onRefresh }: { icon: React.ReactNode; title: string; section: ProfileSection; reextracting: ProfileSection | ""; onRefresh: (s: ProfileSection) => void }) {
  return (
    <h4 className="user-template-editor-section-head">
      <span className="user-template-editor-section-title">{icon}{title}</span>
      <button type="button" className="secondary-btn compact" disabled={Boolean(reextracting)} onClick={() => onRefresh(section)}>
        {reextracting === section ? <Loader2 className="user-template-spinner" size={13} /> : <RefreshCw size={13} />}
      </button>
    </h4>
  );
}

/** Grow a textarea to exactly fit its content (min-height in CSS is the floor).
 *  Inline height is measurement-driven, i.e. behavior — the outer modal owns
 *  the only scrollbar, textareas never scroll on their own. Runs after every
 *  render so programmatic value changes (e.g. AI-suggested edits) resize too. */
function useAutoGrowTextarea() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => { element.style.height = "0"; element.style.height = `${element.scrollHeight}px`; };
    resize();
    element.addEventListener("input", resize);
    return () => element.removeEventListener("input", resize);
  });
  return ref;
}

/** Editable review surface for the extracted design profile (Step 4b). */
export function ProfileEditor({ t, profile, reextracting, onReextract, onSuggest, importAsset, assetUrl, onConfirm, onCancel }: Props) {
  const copy = t.userTemplates;
  const [draft, setDraft] = useState<DesignProfile>(profile);
  const [invalid, setInvalid] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatNotice, setChatNotice] = useState("");
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [assetError, setAssetError] = useState("");
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const importIndexRef = useRef(-1);
  const layoutRulesRef = useAutoGrowTextarea();
  const voiceRef = useAutoGrowTextarea();
  const doRef = useAutoGrowTextarea();
  const dontRef = useAutoGrowTextarea();
  useEffect(() => setDraft(profile), [profile]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all((draft.fixed_assets ?? []).map(async (asset) => {
      const filename = asset.image?.filename;
      if (!filename || cancelled) return;
      try {
        const url = await assetUrl(filename);
        if (!cancelled) setAssetUrls((current) => current[filename] ? current : { ...current, [filename]: url });
      } catch { /* thumbnail degrades to the icon placeholder */ }
    }));
    return () => { cancelled = true; };
  }, [draft.fixed_assets, assetUrl]);
  const startImport = (index: number) => {
    if (importing) return;
    importIndexRef.current = index;
    setAssetError("");
    importInputRef.current?.click();
  };
  const onImportFile = async (file: File | undefined) => {
    const index = importIndexRef.current;
    if (!file || index < 0) return;
    setImporting(true);
    setAssetError("");
    try {
      const meta = await importAsset(file);
      try { const url = await assetUrl(meta.filename); setAssetUrls((current) => ({ ...current, [meta.filename]: url })); }
      catch { /* keep icon placeholder until the next render cycle */ }
      setAsset(index, { image: meta });
    } catch (cause) {
      setAssetError(cause instanceof Error && cause.message ? cause.message : copy.editorAssetImportFailed);
    } finally { setImporting(false); }
  };
  const patch = (part: Partial<DesignProfile>) => setDraft((current) => ({ ...current, ...part }));
  const refreshSection = async (section: ProfileSection) => {
    const partial = await onReextract(section);
    if (partial && partial[section] !== undefined) setDraft((current) => ({ ...current, [section]: partial[section] }));
  };
  const sendChat = async () => {
    const instruction = chatInput.trim();
    if (!instruction || chatBusy) return;
    setChatBusy(true);
    setChatNotice("");
    try {
      const result = await onSuggest(draft, instruction);
      setDraft(result.profile);
      setChatInput("");
      const skipped = result.skipped.length ? ` ${copy.editorChatSkipped}: ${result.skipped.join("; ")}` : "";
      setChatNotice(`${copy.editorChatApplied.replace("{n}", String(result.applied))}${skipped}`);
    } catch (cause) {
      setChatNotice(cause instanceof Error ? cause.message : String(cause));
    } finally { setChatBusy(false); }
  };
  const setColor = (index: number, part: Partial<DesignProfileColor>) =>
    setDraft((current) => ({ ...current, colors: current.colors.map((color, i) => (i === index ? { ...color, ...part } : color)) }));
  const setAsset = (index: number, part: Partial<DesignProfileFixedAsset>) =>
    setDraft((current) => ({ ...current, fixed_assets: (current.fixed_assets ?? []).map((asset, i) => (i === index ? { ...asset, ...part } : asset)) }));
  const lines = (value: string | undefined) => (value ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const confirm = () => {
    if (!draft.colors.length || draft.colors.length > 6) { setInvalid(copy.editorInvalidColors); return; }
    if (draft.colors.some((color) => !color.token.trim() || !/^#[0-9A-Fa-f]{6}$/.test(color.hex) || !color.role.trim())) { setInvalid(copy.editorInvalidColors); return; }
    if (new Set(draft.colors.map((color) => color.token.trim())).size !== draft.colors.length) { setInvalid(copy.editorInvalidColors); return; }
    if ((draft.fixed_assets ?? []).some((asset) => !asset.label?.trim())) { setInvalid(copy.editorInvalidAssets); return; }
    setInvalid("");
    onConfirm({ ...draft, colors: draft.colors.map((color) => ({ ...color, hex: color.hex.toUpperCase() })) });
  };
  return (
    <div className="user-template-editor" role="dialog" aria-label={copy.editorTitle}>
      <header>
        <strong>{copy.editorTitle}</strong>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label={copy.editorCancel}><X size={18} /></button>
      </header>
      <div className="user-template-editor-body">
        <section>
          <SectionHeader icon={<Palette size={14} />} title={copy.profileColors} section="colors" reextracting={reextracting} onRefresh={(section) => { void refreshSection(section); }} />
          <ul className="user-template-editor-colors">
            {draft.colors.map((color, index) => (
              <li key={index}>
                <input type="color" value={/^#[0-9A-Fa-f]{6}$/.test(color.hex) ? color.hex : "#000000"} onChange={(event) => setColor(index, { hex: event.target.value })} aria-label={copy.editorHex} />
                <input type="text" className="user-template-editor-token" value={color.token} placeholder="primary" maxLength={40} onChange={(event) => setColor(index, { token: event.target.value })} aria-label={copy.editorToken} />
                <input type="text" className="user-template-editor-role" value={color.role} placeholder={copy.editorRole} maxLength={80} onChange={(event) => setColor(index, { role: event.target.value })} />
                <button type="button" className="icon-btn danger" disabled={draft.colors.length <= 1} onClick={() => setDraft((current) => ({ ...current, colors: current.colors.filter((_, i) => i !== index) }))} aria-label={copy.editorRemove}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
          {draft.colors.length < 6 ? (
            <button type="button" className="secondary-btn compact" onClick={() => setDraft((current) => ({ ...current, colors: [...current.colors, { token: "", hex: "#000000", role: "" }] }))}>
              <Plus size={13} />{copy.editorAddColor}
            </button>
          ) : null}
        </section>
        <section>
          <SectionHeader icon={<Type size={14} />} title={copy.profileTypography} section="typography" reextracting={reextracting} onRefresh={(section) => { void refreshSection(section); }} />
          <div className="user-template-editor-grid">
            <label>{copy.profileHeadingFont}<input type="text" value={draft.typography?.heading_font ?? ""} maxLength={80} onChange={(event) => patch({ typography: { ...draft.typography, heading_font: event.target.value || undefined } })} /></label>
            <label>{copy.profileBodyFont}<input type="text" value={draft.typography?.body_font ?? ""} maxLength={80} onChange={(event) => patch({ typography: { ...draft.typography, body_font: event.target.value || undefined } })} /></label>
            <label>{copy.profileFallbackFonts}<input type="text" value={(draft.typography?.fallback_fonts ?? []).join(", ")} placeholder="Microsoft YaHei, sans-serif" onChange={(event) => patch({ typography: { ...draft.typography, fallback_fonts: event.target.value.split(",").map((font) => font.trim()).filter(Boolean).slice(0, 4) } })} /></label>
            <label className="user-template-editor-wide">{copy.editorFontNotes}<input type="text" value={draft.typography?.notes ?? ""} maxLength={300} onChange={(event) => patch({ typography: { ...draft.typography, notes: event.target.value || undefined } })} /></label>
          </div>
        </section>
        <section>
          <SectionHeader icon={<LayoutGrid size={14} />} title={copy.profileLayoutRules} section="layout_rules" reextracting={reextracting} onRefresh={(section) => { void refreshSection(section); }} />
          <textarea ref={layoutRulesRef} value={(draft.layout_rules ?? []).join("\n")} placeholder={copy.editorLayoutPlaceholder} onChange={(event) => patch({ layout_rules: lines(event.target.value).slice(0, 12) })} />
        </section>
        <section>
          <SectionHeader icon={<ImageIcon size={14} />} title={copy.profileFixedAssets} section="fixed_assets" reextracting={reextracting} onRefresh={(section) => { void refreshSection(section); }} />
          <ul className="user-template-editor-assets">
            {(draft.fixed_assets ?? []).map((asset, index) => (
              <li key={index}>
                <button type="button" className="user-template-editor-asset-thumb" disabled={importing} onClick={() => startImport(index)} title={copy.editorImportImage} aria-label={copy.editorImportImage}>
                  {asset.image && assetUrls[asset.image.filename] ? <img src={assetUrls[asset.image.filename]} alt={asset.label ?? copy.editorImportImage} /> : importing ? <Loader2 className="user-template-spinner" size={14} /> : <ImageIcon size={15} />}
                </button>
                <input type="text" className="user-template-editor-asset-label" value={asset.label ?? ""} placeholder={copy.editorAssetLabel} maxLength={80} onChange={(event) => setAsset(index, { label: event.target.value || undefined })} aria-label={copy.editorAssetLabel} />
                <input type="text" className="user-template-editor-asset-rule" value={asset.position_rule ?? ""} placeholder={copy.editorAssetPositionRule} maxLength={200} onChange={(event) => setAsset(index, { position_rule: event.target.value || undefined })} />
                <input type="text" className="user-template-editor-asset-notes" value={asset.notes ?? ""} placeholder={copy.editorAssetNotes} maxLength={300} onChange={(event) => setAsset(index, { notes: event.target.value || undefined })} />
                <button type="button" className="icon-btn danger" onClick={() => setDraft((current) => ({ ...current, fixed_assets: (current.fixed_assets ?? []).filter((_, i) => i !== index) }))} aria-label={copy.editorRemove}>
                  <Trash2 size={14} />
                </button>
                <div className="user-template-asset-row-sub">
                  <AssetRegionPicker
                    rule={asset.position_rule}
                    onChange={(rule) => setAsset(index, { position_rule: rule })}
                    title={copy.editorAssetRegionHint}
                    labels={Object.fromEntries(REGION_KEYS.map((key) => [key, copy[({ "top-left": "editorRegionTL", "top-center": "editorRegionTC", "top-right": "editorRegionTR", "mid-left": "editorRegionML", center: "editorRegionC", "mid-right": "editorRegionMR", "bottom-left": "editorRegionBL", "bottom-center": "editorRegionBC", "bottom-right": "editorRegionBR" } as const)[key]]])) as Record<AssetRegionKey, string>}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="user-template-editor-hint">{copy.editorAssetImportHint}</p>
          <input ref={importInputRef} type="file" hidden accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
            onChange={(event) => { const selected = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void onImportFile(selected ?? undefined); }} />
          {assetError ? <p role="alert" className="user-template-editor-invalid">{assetError}</p> : null}
          {(draft.fixed_assets ?? []).length < 4 ? (
            <button type="button" className="secondary-btn compact" onClick={() => setDraft((current) => ({ ...current, fixed_assets: [...(current.fixed_assets ?? []), { kind: "logo" as const, label: "" }] }))}>
              <Plus size={13} />{copy.editorAddAsset}
            </button>
          ) : null}
        </section>
        <section>
          <SectionHeader icon={<MessageSquareText size={14} />} title={copy.profileVoice} section="voice" reextracting={reextracting} onRefresh={(section) => { void refreshSection(section); }} />
          <textarea ref={voiceRef} value={draft.voice ?? ""} maxLength={300} placeholder={copy.editorVoicePlaceholder} onChange={(event) => patch({ voice: event.target.value || undefined })} />
        </section>
        <section className="user-template-editor-dodont">
          <div>
            <h4 className="user-template-editor-section-title"><Check size={14} />{copy.profileDo}</h4>
            <textarea ref={doRef} value={(draft.do ?? []).join("\n")} placeholder={copy.editorDoPlaceholder} onChange={(event) => patch({ do: lines(event.target.value).slice(0, 10) })} />
          </div>
          <div>
            <h4 className="user-template-editor-section-title"><X size={14} />{copy.profileDont}</h4>
            <textarea ref={dontRef} value={(draft.dont ?? []).join("\n")} placeholder={copy.editorDontPlaceholder} onChange={(event) => patch({ dont: lines(event.target.value).slice(0, 10) })} />
          </div>
        </section>
      </div>
      <div className="user-template-editor-chat">
        {chatOpen ? (
          <div className="user-template-editor-chat-panel">
            <div className="user-template-editor-chat-head">
              <Sparkles size={14} />
              <span>{copy.editorChatTitle}</span>
              <button type="button" className="icon-btn" onClick={() => setChatOpen(false)} aria-label={copy.editorChatClose}><X size={14} /></button>
            </div>
            <p className="user-template-editor-chat-hint">{copy.editorChatHint}</p>
            <div className="user-template-editor-chat-row">
              <input
                type="text"
                value={chatInput}
                placeholder={copy.editorChatPlaceholder}
                disabled={chatBusy}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void sendChat(); } }}
              />
              <button type="button" className="secondary-btn compact" disabled={chatBusy || !chatInput.trim()} onClick={() => { void sendChat(); }}>
                {chatBusy ? <Loader2 className="user-template-spinner" size={13} /> : <SendHorizonal size={13} />}{copy.editorChatSend}
              </button>
            </div>
            {chatNotice ? <p className="user-template-editor-chat-notice" role="status">{chatNotice}</p> : null}
          </div>
        ) : (
          <button type="button" className="secondary-btn compact" onClick={() => setChatOpen(true)}>
            <Sparkles size={13} />{copy.editorChatOpen}
          </button>
        )}
      </div>
      {invalid ? <p role="alert" className="user-template-editor-invalid">{invalid}</p> : null}
      <footer>
        <button type="button" className="secondary-btn" onClick={onCancel}>{copy.editorCancel}</button>
        <button type="button" className="primary-btn" onClick={confirm}><Check size={16} />{copy.editorConfirm}</button>
      </footer>
    </div>
  );
}
