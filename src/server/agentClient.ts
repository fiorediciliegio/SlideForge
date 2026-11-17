import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentCommand, AgentRun } from "../contracts/agent.js";
import type { DeckJobRecord } from "../contracts/deck.js";
import { HttpRequestError } from "./httpSecurity.js";

export const inputHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function internalPost<T>(url: string, body: unknown, timeoutMs = 300_000): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-internal-token": process.env.GATEWAY_INTERNAL_TOKEN ?? "" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json() as T & { error?: string; error_code?: string };
  if (!response.ok) throw new HttpRequestError(response.status, payload.error ?? `内部服务错误 ${response.status}`, payload.error_code);
  return payload;
}
export function agentJobsURL() {
  const base = process.env.SLIDEFORGE_JOB_API_URL?.replace(/\/$/, "");
  if (!base || !process.env.SLIDEFORGE_BRAIN_API_URL || !process.env.GATEWAY_INTERNAL_TOKEN) throw new HttpRequestError(503, "Agent 模式需要 Go 任务服务、Python Brain 和内部令牌；请使用 npm run dev");
  return `${base}/agent`;
}
export async function mutateAgent(command: AgentCommand): Promise<DeckJobRecord & { agent: AgentRun }> {
  return (await internalPost<{ job: DeckJobRecord & { agent: AgentRun } }>(agentJobsURL(), command)).job;
}
export async function enqueueAgent(deckId: string, runSeq: number) {
  agentJobsURL();
  return internalPost(`${process.env.SLIDEFORGE_BRAIN_API_URL!.replace(/\/$/, "")}/agent-runs/enqueue`, { deck_id: deckId, run_seq: runSeq }, 15_000);
}
export interface AgentExecution { deck_id: string; run_seq: number; runner_epoch: number; operation_id: string; counter: number }
const activeCall = new AsyncLocalStorage<AgentExecution>();
export const runWithAgent = <T>(context: AgentExecution, action: () => Promise<T>) => activeCall.run(context, action);
export const currentAgentCall = () => activeCall.getStore();
