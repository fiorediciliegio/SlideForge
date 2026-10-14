import type { Messages } from "../../../i18n/messages";
import type { MainStage, PageId } from "../types";
import { stageOrder } from "../utils";

export interface ProgressLineVisibilityInput {
  page: PageId;
  stage: MainStage;
  requirementsStatus: "empty" | "draft" | "confirmed";
  hasGenerationProgress: boolean;
  hasGeneratedDeck: boolean;
  pageProgressCount: number;
}

/**
 * Keep the initial Brief page quiet, while preserving the stage rail when a
 * user returns to Brief after downstream workflow state already exists.
 */
export function shouldShowProgressLine(input: ProgressLineVisibilityInput) {
  if (input.page !== "main") return false;
  if (input.stage !== "brief") return true;

  return input.requirementsStatus !== "empty" ||
    input.hasGenerationProgress ||
    input.hasGeneratedDeck ||
    input.pageProgressCount > 0;
}

interface ProgressLineProps {
  stage: MainStage;
  t: Messages;
  requirementsEnabled: boolean;
  webResearchEnabled: boolean;
  outlineEnabled: boolean;
  generatingEnabled: boolean;
  generationInFlight: boolean;
  deckEnabled: boolean;
  onNavigate: (stage: MainStage) => void;
}

export type ProgressStage = Exclude<MainStage, "uploaded-source-analysis">;

export const progressStages: readonly ProgressStage[] = [
  "brief",
  "requirements",
  "web-research",
  "outline",
  "generating",
  "deck",
];

export type ProgressStageAvailability = Record<ProgressStage, boolean>;

export function adjacentEnabledStage(
  stage: MainStage,
  enabledStages: ProgressStageAvailability,
  direction: -1 | 1,
): ProgressStage | null {
  const currentIndex = progressStages.indexOf(stage as ProgressStage);
  if (currentIndex < 0) return null;

  for (
    let index = currentIndex + direction;
    index >= 0 && index < progressStages.length;
    index += direction
  ) {
    const candidate = progressStages[index];
    if (enabledStages[candidate]) return candidate;
  }
  return null;
}

export function ProgressLine({
  stage,
  t,
  requirementsEnabled,
  webResearchEnabled,
  outlineEnabled,
  generatingEnabled,
  generationInFlight,
  deckEnabled,
  onNavigate,
}: ProgressLineProps) {
  const currentIndex = Math.max(0, progressStages.indexOf(stage as ProgressStage));
  const progress = `${(currentIndex / (progressStages.length - 1)) * 100}%`;
  const enabledStages: ProgressStageAvailability = {
    brief: true,
    requirements: requirementsEnabled,
    "web-research": webResearchEnabled,
    outline: outlineEnabled,
    generating: generatingEnabled,
    deck: deckEnabled,
  };

  return (
    <nav className="progress-line-container" aria-label={t.appName}>
      <div className="progress-line-rail" aria-hidden="true">
        <div className="progress-line-track" />
        <div className="progress-line-fill" style={{ width: progress }} />
      </div>
      {progressStages.map((item) => {
        // A deck run must not be abandoned through the stage rail. Outside that
        // stage, retain the normal availability checks for each destination.
        const disabled = (stage === "generating" && generationInFlight) || !enabledStages[item];
        const label = t.progressStages[item];
        return (
          <button
            data-performance-id={`navigation.stage.${item}`}
            key={item}
            className={`progress-node ${
              item === stage ? "active" : stageOrder(item) < stageOrder(stage) ? "completed" : ""
            }`}
            aria-current={item === stage ? "step" : undefined}
            disabled={disabled}
            onClick={() => onNavigate(item)}
          >
            <span className="progress-node-dot" aria-hidden="true" />
            <span className="progress-node-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
