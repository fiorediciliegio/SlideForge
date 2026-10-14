import { useEffect, useRef, useState } from "react";

export function ManualEditorNumericControl({ label, value, max, step, unit, onChange }: {
  label: string;
  value: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const draftRef = useRef(String(value));
  const committedRef = useRef(value);
  useEffect(() => {
    committedRef.current = value;
    draftRef.current = String(value);
    setDraft(String(value));
  }, [value]);
  const update = (next: string) => { draftRef.current = next; setDraft(next); };
  const commit = () => {
    const next = Number(draftRef.current);
    if (!draftRef.current.trim() || !Number.isFinite(next) || next < 0) { update(String(committedRef.current)); return; }
    update(String(next));
    if (next !== committedRef.current) { committedRef.current = next; onChange(next); }
  };
  const sliderValue = Number(draft);
  return (
    <label className="manual-numeric-control">
      <span>{label}</span>
      <div className="manual-numeric-control-inputs">
        <input
          type="range" min="0" max={Math.max(max, value)} step={step}
          aria-label={label} value={Number.isFinite(sliderValue) ? Math.max(0, sliderValue) : value}
          onChange={(event) => update(event.target.value)}
          onPointerUp={commit} onPointerCancel={() => update(String(committedRef.current))}
          onKeyUp={commit} onBlur={commit}
        />
        <span className="manual-numeric-value">
          <input
            type="number" min="0" step={step} aria-label={label} value={draft}
            onChange={(event) => update(event.target.value)} onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); } }}
          />
          {unit ? <span>{unit}</span> : null}
        </span>
      </div>
    </label>
  );
}
