import path from "node:path";
import { readFile } from "node:fs/promises";
import { getDeckJob } from "./jobs.js";
import { mutateAgent, currentAgentCall, inputHash } from "./agentClient.js";
import { writeArtifact, projectPath } from "../capabilities/project.js";
import { resolveDeckRunDir } from "../capabilities/workspace.js";

export async function agentModelComplete(messages: unknown[]) {
  const context = currentAgentCall()!;
  const job = await getDeckJob(context.deck_id); if (!job?.agent) throw new Error("Agent 执行不存在");
  const run = job.agent, pricing = run.pricing;
  if(Object.values(run.calls).some(call=>call.status==="unknown"))throw new Error("存在结果未知的模型调用，需要用户明确处理后继续");
  if (!pricing || !Number.isFinite(pricing.input_cny_per_million) || !Number.isFinite(pricing.output_cny_per_million) || pricing.input_cny_per_million < 0 || pricing.output_cny_per_million <= 0) throw new Error("Agent 缺少有效模型价格配置");
  if((pricing.model&&pricing.model!==(process.env.OPENAI_MODEL??"deepseek-chat"))||(pricing.base_url&&pricing.base_url!==(process.env.OPENAI_BASE_URL??"https://api.deepseek.com").replace(/\/$/,"")))throw new Error("恢复任务的模型或端点与原报价不一致，请恢复原配置或开始新的执行");
  const maxTokens = 16000;
  const payload = { model: process.env.OPENAI_MODEL ?? "deepseek-chat", messages, temperature: 0.4, max_tokens: maxTokens };
  const cost = (Buffer.byteLength(JSON.stringify(payload), "utf8") * pricing.input_cny_per_million + maxTokens * pricing.output_cny_per_million) / 1e6;
  const baseId = `${context.operation_id}:llm:${context.counter++}`;
  const related = Object.keys(run.calls).filter(id => id === baseId || id.startsWith(`${baseId}:retry:`)).sort((a,b) => Number(a.split(":retry:")[1]??0)-Number(b.split(":retry:")[1]??0));
  let callId = related.at(-1) ?? baseId;
  if (["retry_approved","rejected"].includes(run.calls[callId]?.status)) callId=`${baseId}:retry:${related.length}`;
  const root = resolveDeckRunDir(path.resolve(import.meta.dirname, "../../artifacts/decks"), context.deck_id);
  const command = { deck_id: context.deck_id, run_seq: context.run_seq, runner_epoch: context.runner_epoch, call_id: callId, input_hash: inputHash(payload) };
  const existing = run.calls[callId];
  if (existing?.status === "completed" && existing.response_ref) {
    const result = JSON.parse(await readFile(projectPath(root, existing.response_ref), "utf8"));
    return { text: result.choices[0].message.content as string, usage: result.usage };
  }
  if (existing && existing.status !== "reserved" && existing.status !== "rejected") throw new Error(`模型调用 ${callId} 结果未知，禁止自动重发`);
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error("缺少 OPENAI_API_KEY");
  await mutateAgent({ action: "reserve_call", ...command, cost });
  await mutateAgent({ action: "send_call", ...command });
  try {
    const response = await fetch(`${(process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1, Math.min(240_000, (run.budget.limit_seconds - run.budget.active_seconds) * 1000))),
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) await mutateAgent({ action: "reject_call", ...command });
      throw new Error(`模型请求失败 HTTP ${response.status}`);
    }
    const result = await response.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };
    const responseRef = await writeArtifact(root, "responses", result, inputHash([context.run_seq,callId]));
    if (!result.usage || !Number.isFinite(result.usage.prompt_tokens) || !Number.isFinite(result.usage.completion_tokens)) throw new Error("模型未返回可结算 usage");
    const actual = (result.usage.prompt_tokens * pricing.input_cny_per_million + result.usage.completion_tokens * pricing.output_cny_per_million) / 1e6;
    await mutateAgent({ action: "settle_call", ...command, cost: actual, response_ref: responseRef, usage: result.usage });
    if (!result.choices?.[0]?.message?.content) throw new Error("模型未返回页面 HTML");
    return { text: result.choices[0].message.content, usage: result.usage };
  } catch (error) {
    await mutateAgent({ action: "mark_unknown", ...command });
    throw error;
  }
}
