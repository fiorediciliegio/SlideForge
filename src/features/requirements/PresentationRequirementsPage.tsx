import { slideFormat } from "../../slideFormat";
import { ProcessPanel } from "../process-progress/ProcessProgress";
import type { ProcessStep } from "../process-progress/model";
import { ArrowLeft, ArrowRight, Check, ChevronDown, RefreshCw, Save, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import type {
  PresentationRequirements,
  PresentationRequirementsSelections,
  PresentationResearchRequirements,
  VisualStylePreset,
} from "../../api/types";
import type { Messages } from "../../i18n/messages";
import { ErrorNotice } from "../deck-workspace/components/ErrorNotice";
import { requirementsAreCompleteWithoutVisualSelection } from "./presentationRequirements";
import { IMAGE_RESEARCH_ENABLED } from "../deck-generation/featureFlags";

type SimpleField = "slide_count" | "output_language";
type RequirementField = SimpleField;

export interface PresentationRequirementsPageProps {
  t: Messages;
  progress?: ProcessStep[];
  brief: string;
  requirements: PresentationRequirements;
  status: "idle" | "loading" | "ready" | "error";
  error: string;
  errorDetail?: string;
  saving: boolean;
  confirming: boolean;
  dirty: boolean;
  hasSavedDraft: boolean;
  visualStylePresets: readonly VisualStylePreset[];
  onSelect: <K extends keyof PresentationRequirementsSelections>(
    field: K,
    value: PresentationRequirementsSelections[K],
  ) => void;
  onSelectResearch: (kind: keyof PresentationResearchRequirements, enabled: boolean) => void;
  onRetry: () => void;
  onManual: () => void;
  onBack: () => void;
  onForward?: () => void;
  onSave: () => void;
  onConfirm: () => void;
}

const GROUPS: Array<{ title: keyof Messages["requirements"]["groups"]; fields: Array<SimpleField> }> = [
  { title: "specifications", fields: ["slide_count", "output_language"] },
];

export function PresentationRequirementsPage(props: PresentationRequirementsPageProps) {
  const { t, brief, requirements, status, error, errorDetail, saving, confirming, dirty, hasSavedDraft, visualStylePresets, onSelect, onSelectResearch, onRetry, onManual, onBack, onForward, onSave, onConfirm } = props;
  const templateRecommendation = requirements.template_recommendation;
  const templateSelectionRequired = templateRecommendation?.selection_required === true
    && requirements.selections.visual_style_preset === null;
  const [customValues, setCustomValues] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = {};
    for (const field of ["slide_count", "output_language"] as const) {
      const selection = requirements.selections[field];
      if (selection !== null && !(requirements.candidates[field] as Array<number | string>).includes(selection)) {
        values[field] = String(selection);
      }
    }
    return values;
  });
  const [activeCustomFields, setActiveCustomFields] = useState<Set<RequirementField>>(() => {
    const active = new Set<RequirementField>();
    for (const field of ["slide_count", "output_language"] as const) {
      const selection = requirements.selections[field];
      if (selection !== null && !(requirements.candidates[field] as Array<number | string>).includes(selection)) {
        active.add(field);
      }
    }
    return active;
  });
  const customInputRefs = useRef<Partial<Record<RequirementField, HTMLInputElement | null>>>({});

  function setCustomFieldActive(field: RequirementField, active: boolean) {
    setActiveCustomFields((current) => {
      const next = new Set(current);
      if (active) next.add(field);
      else next.delete(field);
      return next;
    });
  }

  function clearSelection(field: RequirementField) {
    onSelect(field as never, null as never);
  }

  function setCustomSimple(field: SimpleField, value: string) {
    setCustomValues((current) => ({ ...current, [field]: value }));
    setCustomFieldActive(field, true);
    if (field === "slide_count") {
      const number = Number(value);
      onSelect(field, Number.isInteger(number) && number > 0 ? number : null);
      return;
    }
    const language = value.trim();
    onSelect(field, language && language.toLowerCase() !== "auto" ? language : null);
  }

  function activateCustomField(field: RequirementField, focusInput = false) {
    setCustomFieldActive(field, true);
    setCustomSimple(field, customValues[field] ?? "");
    if (focusInput) {
      window.setTimeout(() => customInputRefs.current[field]?.focus(), 0);
    }
  }

  function toggleCustomField(field: RequirementField) {
    if (activeCustomFields.has(field)) {
      setCustomFieldActive(field, false);
      clearSelection(field);
      return;
    }
    activateCustomField(field, true);
  }

  function selectCandidate(field: RequirementField, candidate: unknown) {
    setCustomFieldActive(field, false);
    onSelect(field as never, candidate as never);
  }

  if (status === "loading") {
    return (
      <section className="page active requirements-page requirements-loading">
        <div className="requirements-breathing-mark"><Sparkles size={26} /></div>
        <h1>{t.requirements.loadingTitle}</h1>
        <p>{t.requirements.loadingBody}</p>
        <ProcessPanel t={t} steps={props.progress ?? []} />
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className="page active requirements-page requirements-error">
        <h1>{t.requirements.errorTitle}</h1>
        <ErrorNotice
          t={t}
          tone="block"
          summary={error || t.requirements.errorBody}
          detail={errorDetail}
        />
        <ProcessPanel t={t} steps={props.progress ?? []} />
        <div className="requirements-error-actions">
          <button data-performance-id="requirements.create.retry" className="primary-btn" type="button" onClick={onRetry} disabled={saving || confirming}>
            <RefreshCw size={16} aria-hidden="true" />
            {t.requirements.retry}
          </button>
          <button data-performance-id="requirements.create-manually" className="secondary-btn" type="button" onClick={onManual} disabled={saving || confirming}>
            {t.requirements.manual}
          </button>
          <button data-performance-id="requirements.back" className="secondary-btn" type="button" onClick={onBack}>{t.requirements.back}</button>
        </div>
      </section>
    );
  }

  return (
    <section className="page active requirements-page">
      <header className="requirements-header">
        <div><h1>{t.requirements.title}</h1><p>{t.requirements.helper}</p></div>
      </header>

      <details className="requirements-brief">
        <summary>
          <span className="requirements-brief-label">{t.requirements.briefLabel}</span>
          <span className="requirements-brief-preview">{brief}</span>
          <ChevronDown size={17} />
        </summary>
        <p>{brief}</p>
      </details>

      <div className="requirements-groups">
        {GROUPS.map((group) => (
          <section className="requirements-group" key={group.title}>
            <h2>{t.requirements.groups[group.title]}</h2>
            <p className="requirements-page-size">{t.brief.pageAspectRatio}：{slideFormat(requirements.selections.aspect_ratio).aspectRatio}</p>
            {group.fields.map((field) => {
              const candidates = requirements.candidates[field];
              const selection = requirements.selections[field];
              const customValue = customValues[field] ?? "";
              const customSelected = activeCustomFields.has(field);
              return (
                <fieldset className="requirement-field" key={field}>
                  <legend>{t.requirements.fields[field]}</legend>
                  <div className="requirement-options">
                    {candidates.map((candidate, index) => {
                      const selected = selection === candidate;
                      const label = String(candidate);
                      return (
                        <button
                          data-performance-id={`requirements.${field}.select-candidate`}
                          type="button"
                          className={`requirement-option ${selected ? "selected" : ""}`}
                          onClick={() => selectCandidate(field, candidate)}
                          key={`${label}-${index}`}
                        >
                          <span className="requirement-radio">{selected ? <Check size={13} strokeWidth={3} /> : null}</span>
                          <span><strong>{label}</strong></span>
                          {index === 0 ? <em>{t.requirements.recommended}</em> : null}
                        </button>
                      );
                    })}
                    <div
                      className={`requirement-option requirement-custom${customSelected ? " selected" : ""}`}
                      role="radio"
                      aria-checked={customSelected}
                      tabIndex={0}
                      onClick={() => toggleCustomField(field)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                        event.preventDefault();
                        toggleCustomField(field);
                      }}
                    >
                      <span className="requirement-radio">{customSelected ? <Check size={13} strokeWidth={3} /> : null}</span>
                      <span><strong>{t.requirements.other}</strong>
                        <input
                          ref={(element) => { customInputRefs.current[field] = element; }}
                          type={field === "slide_count" ? "number" : "text"}
                          min={field === "slide_count" ? 1 : undefined}
                          value={customValue}
                          disabled={saving || confirming}
                          placeholder={t.requirements.customPlaceholders[field]}
                          onClick={(event) => event.stopPropagation()}
                          onFocus={() => {
                            if (!activeCustomFields.has(field)) activateCustomField(field);
                          }}
                          onChange={(event) => setCustomSimple(field, event.target.value)}
                        />
                      </span>
                    </div>
                  </div>
                </fieldset>
              );
            })}
          </section>
        ))}
      </div>

      {templateRecommendation ? (
        <section className="requirements-group template-recommendation-group">
          <div className="template-recommendation-heading">
            <div>
              <h2>{t.requirements.templateRecommendationTitle}</h2>
              <p>{templateRecommendation.trigger === "low_signal"
                ? t.requirements.templateRecommendationLowConfidence
                : t.requirements.templateRecommendationRulesFallback}</p>
            </div>
          </div>
          <p className="template-recommendation-choose">{t.requirements.templateRecommendationChoose}</p>
          <div className="template-recommendation-options" role="radiogroup" aria-label={t.requirements.templateRecommendationTitle}>
            {templateRecommendation.candidates.map((candidate) => {
              const selected = requirements.selections.visual_style_preset?.id === candidate.preset.id
                && requirements.selections.visual_style_preset?.version === candidate.preset.version;
              const preset = visualStylePresets.find((item) => item.id === candidate.preset.id);
              const reason = candidate.matched_axes.length > 0
                ? t.requirements.templateRecommendationMatchedReason.replace("{axes}", candidate.matched_axes.map((axis) => t.requirements.templateRecommendationAxes[axis]).join("、"))
                : t.requirements.templateRecommendationNeutralReason;
              return (
                <button
                  data-performance-id="requirements.template-recommendation.select"
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`template-recommendation-option${selected ? " selected" : ""}`}
                  disabled={saving || confirming}
                  onClick={() => onSelect("visual_style_preset", candidate.preset)}
                  key={`${candidate.preset.id}:${candidate.preset.version}`}
                >
                  {preset?.preview_images[0] ? <img src={preset.preview_images[0].url} alt={preset.preview_images[0].alt} /> : <div className="template-recommendation-preview-fallback" aria-hidden="true" />}
                  <span className="template-recommendation-card-copy">
                    <strong>{candidate.preset.name}</strong>
                    <small>{candidate.preset.description}</small>
                    <em>{reason}</em>
                  </span>
                  <span className="requirement-radio">{selected ? <Check size={13} strokeWidth={3} /> : null}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="requirements-group requirements-research-group">
        <h2>{t.requirements.researchTitle}</h2>
        <p>{t.requirements.researchHelper}</p>
        {(["web", "images"] as const).map((kind) => {
          const choice = requirements.research[kind];
          const label = kind === "web" ? t.requirements.webResearch : t.requirements.imageResearch;
          // 图片搜索关闭期间，这个开关只展示当前状态，不接受修改。
          const locked = kind === "images" && !IMAGE_RESEARCH_ENABLED;
          return (
            <fieldset className="requirement-field" key={kind}>
              <legend>{label}</legend>
              <div className="requirement-options">
                {[true, false].map((enabled) => (
                  <button
                    data-performance-id={`requirements.research.${kind}.${enabled ? "enable" : "disable"}`}
                    type="button"
                    className={`requirement-option ${choice.enabled === enabled ? "selected" : ""}`}
                    disabled={saving || confirming || locked}
                    onClick={() => onSelectResearch(kind, enabled)}
                    key={String(enabled)}
                  >
                    <span className="requirement-radio">{choice.enabled === enabled ? <Check size={13} strokeWidth={3} /> : null}</span>
                    <span><strong>{enabled ? t.requirements.enableResearch : t.requirements.disableResearch}</strong></span>
                    {choice.recommended === enabled ? <em>{t.requirements.recommended}</em> : null}
                  </button>
                ))}
              </div>
              {choice.reason ? (
                <p className="requirement-research-reason"><strong>{t.requirements.recommendationReason}</strong> {choice.reason}</p>
              ) : null}
            </fieldset>
          );
        })}
      </section>

      <footer className="requirements-footer">
        <div className="stage-navigation">
          <button data-performance-id="requirements.back" className="secondary-btn" type="button" onClick={onBack}><ArrowLeft size={16} />{t.requirements.back}</button>
          {onForward ? (
            <button data-performance-id="requirements.forward" className="secondary-btn" type="button" onClick={onForward} disabled={saving || confirming}>
              {t.controls.forward}<ArrowRight size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <span>{confirming ? t.requirements.confirming : saving ? t.requirements.saving : dirty ? t.requirements.unsaved : hasSavedDraft ? t.requirements.saved : ""}</span>
        <div className="requirements-footer-actions">
          <button data-performance-id="requirements.save" className="secondary-btn" type="button" disabled={saving || confirming || !dirty} onClick={onSave}>
            <Save size={16} />{t.controls.save}
          </button>
          <button data-performance-id="requirements.confirm" className="primary-btn" type="button" disabled={saving || confirming || templateSelectionRequired || !requirementsAreCompleteWithoutVisualSelection(requirements)} onClick={onConfirm}>
            <Check size={16} />{t.requirements.confirm}
          </button>
        </div>
      </footer>
    </section>
  );
}
