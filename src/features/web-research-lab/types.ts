import type { WebResearchLabEvent, WebResearchLabRound } from "./webResearchLabWorkflow";

export interface WebResearchLabState {
  enabled: boolean;
  status: "idle" | "running" | "completed" | "failed";
  systemPrompt: string;
  userPrompt: string;
  modelPreference: string;
  events: WebResearchLabEvent[];
  rounds: WebResearchLabRound[];
  resultMarkdown: string;
  runId: string;
  runDir: string;
  error: string;
}
