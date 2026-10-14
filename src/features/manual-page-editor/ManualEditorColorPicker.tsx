import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import type { Messages } from "../../i18n/messages";
import { editorHexToHsv, editorHsvToHex, normalizeEditorHex, type EditorHsvColor } from "./manualEditorColor";

const PRESET_COLORS = [
  "#000000", "#454545", "#808080", "#bfbfbf", "#f2f2f2", "#ffffff",
  "#fff1a8", "#f7cda4", "#eba1a1", "#c9b2ee", "#adc5f1", "#b5dfbc",
  "#f7de5b", "#f3a14e", "#e65151", "#a264e7", "#638fe2", "#72be82",
  "#9b8626", "#995c2d", "#8f2520", "#632791", "#31518d", "#3e7746",
];

export function ManualEditorColorPicker({ value, label, t, onChange, clearLabel, onClear, isClear = false, children }: {
  value: string;
  label: string;
  t: Messages["manualEditor"];
  onChange: (value: string) => void;
  clearLabel?: string;
  onClear?: () => void;
  isClear?: boolean;
  children?: ReactNode;
}) {
  const [color, setColor] = useState(() => editorHexToHsv(value));
  const colorRef = useRef(color);
  const committedRef = useRef(isClear ? "" : value);
  const [hexDraft, setHexDraft] = useState(value.slice(1).toUpperCase());
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number>();
  const pointerRef = useRef<number | null>(null);
  useEffect(() => {
    const hex = normalizeEditorHex(value) ?? "#000000";
    committedRef.current = isClear ? "" : hex;
    if (editorHsvToHex(colorRef.current) !== hex) { colorRef.current = editorHexToHsv(hex); setColor(colorRef.current); }
    setHexDraft(hex.slice(1).toUpperCase());
  }, [isClear, value]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const update = (next: EditorHsvColor) => {
    colorRef.current = next;
    setColor(next);
    setHexDraft(editorHsvToHex(next).slice(1).toUpperCase());
  };
  const commit = () => {
    const hex = editorHsvToHex(colorRef.current);
    if (hex !== committedRef.current) { committedRef.current = hex; onChange(hex); }
  };
  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    update({
      ...colorRef.current,
      saturation: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      brightness: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
  };
  const choose = (hex: string) => { update(editorHexToHsv(hex)); commit(); };
  const commitHex = () => {
    const hex = normalizeEditorHex(hexDraft);
    if (hex) choose(hex);
    else setHexDraft(editorHsvToHex(colorRef.current).slice(1).toUpperCase());
  };
  const hex = editorHsvToHex(color);
  return (
    <div className="manual-color-picker" aria-label={label}>
      <div
        className="manual-color-spectrum" role="slider" tabIndex={0}
        aria-label={`${label}: ${t.saturation}, ${t.brightness}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(color.saturation * 100)}
        aria-valuetext={`${Math.round(color.saturation * 100)}%, ${Math.round(color.brightness * 100)}%`}
        style={{ backgroundColor: `hsl(${color.hue} 100% 50%)` }}
        onPointerDown={(event) => { event.preventDefault(); event.currentTarget.focus(); pointerRef.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); updateFromPointer(event); }}
        onPointerMove={(event) => { if (pointerRef.current === event.pointerId) updateFromPointer(event); }}
        onPointerUp={(event) => { if (pointerRef.current !== event.pointerId) return; updateFromPointer(event); pointerRef.current = null; commit(); event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { pointerRef.current = null; update(editorHexToHsv(committedRef.current || value)); }}
        onLostPointerCapture={() => { if (pointerRef.current !== null) { pointerRef.current = null; update(editorHexToHsv(committedRef.current || value)); } }}
        onKeyDown={(event) => {
          if (!event.key.startsWith("Arrow")) return;
          event.preventDefault();
          const step = event.shiftKey ? 0.1 : 0.01;
          update({
            ...colorRef.current,
            saturation: Math.max(0, Math.min(1, colorRef.current.saturation + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))),
            brightness: Math.max(0, Math.min(1, colorRef.current.brightness + (event.key === "ArrowDown" ? -step : event.key === "ArrowUp" ? step : 0))),
          });
        }}
        onKeyUp={commit} onBlur={commit}
      ><span className="manual-color-spectrum-cursor" style={{ left: `clamp(7px, ${color.saturation * 100}%, calc(100% - 7px))`, top: `clamp(7px, ${(1 - color.brightness) * 100}%, calc(100% - 7px))` }} /></div>
      <div className="manual-color-hue-row">
        <span className={`manual-color-current ${isClear ? "clear" : ""}`} style={{ backgroundColor: isClear ? undefined : hex }} aria-label={t.currentColor} />
        <input className="manual-color-hue" type="range" min="0" max="360" step="1" value={color.hue} aria-label={t.hue}
          onChange={(event) => update({ ...colorRef.current, hue: Number(event.target.value) })} onPointerUp={commit}
          onPointerCancel={() => update(editorHexToHsv(committedRef.current || value))} onKeyUp={commit} onBlur={commit} />
      </div>
      <div className="manual-color-hex-row">
        <span aria-hidden="true">#</span>
        <input type="text" value={hexDraft} aria-label={t.hexColor} spellCheck={false} maxLength={7}
          onChange={(event) => setHexDraft(event.target.value)} onBlur={commitHex}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitHex(); event.currentTarget.blur(); } }} />
        <button type="button" className="manual-editor-btn icon" aria-label={copied ? t.colorCopied : t.copyColor} data-editor-tooltip={copied ? t.colorCopied : t.copyColor}
          disabled={!navigator.clipboard?.writeText}
          onClick={() => { void navigator.clipboard.writeText(hex.toUpperCase()).then(() => { setCopied(true); window.clearTimeout(copyTimer.current); copyTimer.current = window.setTimeout(() => setCopied(false), 1500); }).catch(() => undefined); }}
        >{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      </div>
      <div className="manual-color-presets" role="group" aria-label={t.presetColors}>
        {onClear ? <button type="button" className={`manual-color-preset clear ${isClear ? "selected" : ""}`} aria-label={clearLabel} data-editor-tooltip={clearLabel} aria-pressed={isClear} onClick={onClear} /> : null}
        {PRESET_COLORS.map((preset) => <button type="button" key={preset} className={`manual-color-preset ${!isClear && preset === hex ? "selected" : ""}`} style={{ backgroundColor: preset }} aria-label={preset.toUpperCase()} aria-pressed={!isClear && preset === hex} onClick={() => choose(preset)} />)}
      </div>
      {children}
    </div>
  );
}
