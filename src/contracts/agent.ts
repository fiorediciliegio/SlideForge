import { z } from "zod";

export const pagePolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("fixed"), count: z.number().int().min(2).max(20) }),
  z.object({ mode: z.literal("range"), min: z.number().int().min(2).max(20), max: z.number().int().min(2).max(20) })
    .refine(value => value.min <= value.max, "最少页数不能大于最多页数"),
  z.object({ mode: z.literal("auto") }),
]);
export const agentBudgetSchema = z.object({
  active_seconds: z.number().positive().default(600),
  estimated_cost_cny: z.number().positive().default(2),
});
export const agentOptionsSchema = z.object({
  version: z.literal(1), generation_mode: z.enum(["direct", "outline_first"]).default("direct"),
  page_policy: pagePolicySchema.default({ mode: "auto" }), research_allowed: z.boolean().default(false),
  budget: agentBudgetSchema.default({ active_seconds: 600, estimated_cost_cny: 2 }),
});
export const outlinePageSchema = z.object({
  page_id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80), title: z.string().trim().min(1), bullets: z.array(z.string()),
});
export const outlineDraftSchema = z.object({
  draft_revision: z.number().int().nonnegative(), title: z.string().trim().min(1),
  pages: z.array(outlinePageSchema).min(2).max(20),
}).refine(value => new Set(value.pages.map(page => page.page_id)).size === value.pages.length, "页面标识不能重复");
export const agentPhases = ["queued", "planning", "waiting_outline", "generating", "checking", "revising", "waiting_user", "paused_budget", "interrupted", "completed", "failed", "cancelled"] as const;
export type AgentOptions = z.infer<typeof agentOptionsSchema>;
export type OutlineDraft = z.infer<typeof outlineDraftSchema>;
export type PagePolicy = z.infer<typeof pagePolicySchema>;
export interface ProjectRef { revision_id: string; artifact_ref: string; outline_revision: number; constraints_revision: number }
export interface AgentRun {
  version: 1; run_seq: number; runner_epoch: number; checkpoint_seq: number; phase: typeof agentPhases[number];
  options: AgentOptions; project_ref?: ProjectRef; draft_ref?: string; draft_revision: number;
  context_ref?: string; messages?: unknown[]; request?: { request_id: string; question: string; reason_code: string; proposal?: unknown };
  messages_ref?: string;
  budget: { active_seconds: number; limit_seconds: number; spent_cny: number; reserved_cny: number; limit_cny: number };
  calls: Record<string, { status: string; cost: number; input_hash: string; response_ref?: string }>;
  operations: Record<string, { status: string; input_hash: string; result?: unknown }>;
  instance_id?: string; lease_until?: string; last_active_at?: string; error?: string;
  pricing?: { input_cny_per_million: number; output_cny_per_million: number; version: string;model?:string;base_url?:string;currency?:string };
  quality_revision?: string;
}
export interface AgentCommand {
  action: string; deck_id: string; run_seq?: number; runner_epoch?: number; expected_checkpoint?: number;
  [key: string]: unknown;
}
export function effectiveGenerationMode(brief: string, selected: AgentOptions["generation_mode"]) {
  return /先(?:规划|看大纲|确认大纲|做大纲)|等我确认/.test(brief) ? "outline_first" : selected;
}
export function assertPageCount(policy: PagePolicy, count: number): void {
  if (count < 2 || count > 20 || (policy.mode === "fixed" && count !== policy.count)
    || (policy.mode === "range" && (count < policy.min || count > policy.max))) throw new Error("大纲页数与已选页数策略冲突");
}
export function explicitPageConflict(brief: string, policy: PagePolicy) {
  const numeral="(?:[0-9]+|二十|十九|十八|十七|十六|十五|十四|十三|十二|十一|十|九|八|七|六|五|四|三|两|二|一)";
  const match=brief.match(new RegExp(`(?:生成|制作|做|需要|要求|总共|固定|恰好)\\s*(${numeral})\\s*页`))??brief.match(new RegExp(`^\\s*(${numeral})\\s*页`));
  if(!match)return;
  const values:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const text=match[1],requested=/^\d+$/.test(text)?Number(text):text==="二十"?20:text.startsWith("十")?10+(values[text.slice(1)]??0):values[text];
  if(requested<2||requested>20||(policy.mode==="fixed"&&policy.count!==requested)||(policy.mode==="range"&&(requested<policy.min||requested>policy.max)))return {requested,policy};
}
export function explicitExportFormats(brief:string):Array<"pptx"|"pdf"> {
  const clauses=brief.split(/[，。,；;\n]/).filter(clause=>!/(?:不要|无需|不用|禁止|不必|不需要|不)(?:自动)?导出/.test(clause));
  const requested=clauses.filter(clause=>/(?:请|帮我|并|然后|完成后|生成后|需要|要求|直接|同时|我要|想要)\s*导出|^\s*导出/.test(clause));
  if(!requested.length)return[];
  const formats=requested.join(" ")+clauses.filter(clause=>/格式(?:为|是|[:：])/.test(clause)).join(" ");
  return /pdf/i.test(formats)?["pdf",...(/pptx|ppt/i.test(formats)?["pptx" as const]:[])]:["pptx"];
}
export function publicAgent(run: AgentRun) {
  return { version: run.version, run_seq: run.run_seq, checkpoint_seq: run.checkpoint_seq, phase: run.phase,
    options: run.options, preview_revision: run.project_ref?.revision_id, draft_revision: run.draft_revision,
    budget: run.budget, request: run.request, error: run.error,
    quality_state: run.quality_revision && run.quality_revision === run.project_ref?.revision_id ? "checked" : "draft",
    unknown_calls: Object.entries(run.calls ?? {}).filter(([, call]) => call.status === "unknown").map(([id, call]) => ({ call_id: id, reserved_cny: call.cost })),
  };
}
