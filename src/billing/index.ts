/**
 * M2-3 · 点数计费：对内按 token 计量，对外按点数结算。
 *
 * - data/api-keys.json（gitignored）存在时启用鉴权与计费；不存在则本地开发模式（全放行）。
 * - LLM 用量经 AsyncLocalStorage 归属到 deck 任务，完成后按价目表折算点数。
 * - 台账：data/billing/ledger.jsonl（每笔一行，含 tokens/points/balance）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";

const DATA_DIR = path.resolve(import.meta.dirname, "..", "..", "data");
const KEYS_FILE = path.join(DATA_DIR, "api-keys.json");
const LEDGER_FILE = path.join(DATA_DIR, "billing", "ledger.jsonl");

export interface Pricing {
  /** 每 1000 input tokens 折算点数 */
  inputPointsPerK: number;
  /** 每 1000 output tokens 折算点数 */
  outputPointsPerK: number;
  /** 每次导出固定点数 */
  exportPoints: number;
}

export const DEFAULT_PRICING: Pricing = {
  inputPointsPerK: 0.2,
  outputPointsPerK: 0.8,
  exportPoints: 10,
};

interface ApiKeyRecord {
  name: string;
  balance: number;
}

type KeyStore = Record<string, ApiKeyRecord>;

export interface BillingContext {
  apiKey: string;
  deckId: string;
  promptTokens: number;
  completionTokens: number;
}

const als = new AsyncLocalStorage<BillingContext>();

export function runWithBilling<T>(ctx: BillingContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/** llmClient 每次调用后上报 usage（无计费上下文时静默丢弃）。 */
export function reportUsage(usage?: { prompt_tokens?: number; completion_tokens?: number }) {
  const ctx = als.getStore();
  if (!ctx || !usage) return;
  ctx.promptTokens += usage.prompt_tokens ?? 0;
  ctx.completionTokens += usage.completion_tokens ?? 0;
}

export function billingEnabled(): boolean {
  return existsSync(KEYS_FILE);
}

async function readKeys(): Promise<KeyStore> {
  return JSON.parse(await readFile(KEYS_FILE, "utf8")) as KeyStore;
}

async function writeKeys(keys: KeyStore): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), "utf8");
}

export async function checkKey(apiKey: string | undefined): Promise<{ ok: boolean; reason?: string }> {
  if (!billingEnabled()) return { ok: true };
  if (!apiKey) return { ok: false, reason: "missing X-API-Key" };
  const keys = await readKeys();
  const record = keys[apiKey];
  if (!record) return { ok: false, reason: "invalid api key" };
  if (record.balance <= 0) return { ok: false, reason: "点数余额不足，请充值" };
  return { ok: true };
}

function tokensToPoints(ctx: BillingContext, pricing: Pricing): number {
  const points =
    (ctx.promptTokens / 1000) * pricing.inputPointsPerK +
    (ctx.completionTokens / 1000) * pricing.outputPointsPerK;
  return Math.max(1, Math.ceil(points));
}

async function appendLedger(entry: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(LEDGER_FILE), { recursive: true });
  await appendFile(LEDGER_FILE, `${JSON.stringify(entry)}\n`, "utf8");
}

/** 任务完成结算：按 tokens 折算点数并扣减余额。 */
export async function settleDeck(ctx: BillingContext, pricing: Pricing = DEFAULT_PRICING): Promise<{ points: number; balance?: number }> {
  if (!billingEnabled()) return { points: 0 };
  const points = tokensToPoints(ctx, pricing);
  const keys = await readKeys();
  const record = keys[ctx.apiKey];
  if (!record) return { points: 0 };
  record.balance = Math.max(0, record.balance - points);
  await writeKeys(keys);
  await appendLedger({
    ts: new Date().toISOString(),
    type: "deck",
    deck_id: ctx.deckId,
    key_name: record.name,
    prompt_tokens: ctx.promptTokens,
    completion_tokens: ctx.completionTokens,
    points,
    balance: record.balance,
  });
  return { points, balance: record.balance };
}

/** 固定点数收费（导出等）。 */
export async function chargeFixed(apiKey: string | undefined, deckId: string, kind: "export", pricing: Pricing = DEFAULT_PRICING): Promise<{ points: number; balance?: number }> {
  if (!billingEnabled()) return { points: 0 };
  const points = kind === "export" ? pricing.exportPoints : 0;
  const keys = await readKeys();
  const record = keys[apiKey!];
  if (!record) return { points: 0 };
  record.balance = Math.max(0, record.balance - points);
  await writeKeys(keys);
  await appendLedger({
    ts: new Date().toISOString(),
    type: kind,
    deck_id: deckId,
    key_name: record.name,
    points,
    balance: record.balance,
  });
  return { points, balance: record.balance };
}
