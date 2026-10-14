import type { OutlineAttemptInfo } from "../../ai/types";

export type ProcessState = "waiting" | "running" | "completed" | "failed" | "warning" | "skipped";
export interface ProcessRound extends OutlineAttemptInfo {
  id: string;
  text: string;
  state: "running" | "completed" | "failed";
}

export interface ProcessStep {
  id: string;
  label: string;
  state: ProcessState;
  summary?: string;
  text?: string;
  rounds?: ProcessRound[];
  previews?: Array<{ url: string; alt: string }>;
  files?: Array<{ name: string; state: ProcessState }>;
  fields?: Array<{ label: string; value: string }>;
  startedAt?: number;
  endedAt?: number;
}

/** Each response keeps its own text, including failed attempts. */
export function appendProcessText(step: ProcessStep, text: string): Partial<ProcessStep> {
  const active = step.rounds?.at(-1);
  if (!active || active.state !== "running") return { text: (step.text ?? "") + text };
  return { rounds: step.rounds!.map((round) => round.id === active.id ? { ...round, text: round.text + text } : round) };
}

export function finishProcessRound(step: ProcessStep, state: "completed" | "failed", text?: string): Partial<ProcessStep> {
  const active = step.rounds?.at(-1);
  if (!active || active.state !== "running") return {};
  return { rounds: step.rounds!.map((round) => round.id === active.id ? { ...round, state, text: text || round.text } : round) };
}

export function beginProcessStep(step: ProcessStep, now: number, summary?: string): Partial<ProcessStep> {
  return { state: "running", startedAt: step.startedAt ?? now, endedAt: undefined, summary };
}

export function initializeProcessSteps(definitions: Array<Pick<ProcessStep, "id" | "label">>, previous: ProcessStep[] = []): ProcessStep[] {
  return definitions.map((definition) => {
    const prior = previous.find((step) => step.id === definition.id);
    return { ...definition, state: "waiting", startedAt: prior?.startedAt, rounds: prior?.rounds };
  });
}

export function updateProcessStep(steps: ProcessStep[], id: string, patch: Partial<ProcessStep>): ProcessStep[] {
  return steps.map((step) => step.id === id ? { ...step, ...patch } : step);
}

export function safeExternalUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** The finish header is control data, not part of the user-facing report. */
export function streamedResearchReport(text: string): string | undefined {
  const match = /(?:^|\n)\s*(?:```(?:json)?\s*\n)?\s*\{\s*"action"\s*:\s*"finish"\s*\}\s*(?:```\s*)?/i.exec(text);
  return match ? text.slice(match.index + match[0].length) : undefined;
}
