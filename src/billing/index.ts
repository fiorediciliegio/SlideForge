/**
 * 点数计费：单实例下使用串行事务与原子文件替换，避免并发扣费相互覆盖。
 * 多实例部署必须迁移到支持事务与唯一约束的数据库。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

function dataDir(): string {
  return process.env.SLIDEFORGE_DATA_DIR
    ? path.resolve(process.env.SLIDEFORGE_DATA_DIR)
    : path.resolve(import.meta.dirname, "..", "..", "data");
}
function keysFile(): string { return path.join(dataDir(), "api-keys.json"); }
function ledgerFile(): string { return path.join(dataDir(), "billing", "ledger.jsonl"); }

export interface Pricing {
  inputPointsPerK: number;
  outputPointsPerK: number;
  exportPoints: number;
}

export const DEFAULT_PRICING: Pricing = {
  inputPointsPerK: 0.2,
  outputPointsPerK: 0.8,
  exportPoints: 10,
};

interface ApiKeyRecord { name: string; balance: number }
type KeyStore = Record<string, ApiKeyRecord>;

export interface BillingContext {
  apiKey: string;
  deckId: string;
  promptTokens: number;
  completionTokens: number;
}

const als = new AsyncLocalStorage<BillingContext>();
let keyWriteChain: Promise<void> = Promise.resolve();
let keysCache: KeyStore | undefined;
let keysCacheMtime = -1;

export function runWithBilling<T>(ctx: BillingContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function reportUsage(usage?: { prompt_tokens?: number; completion_tokens?: number }) {
  const ctx = als.getStore();
  if (!ctx || !usage) return;
  ctx.promptTokens += usage.prompt_tokens ?? 0;
  ctx.completionTokens += usage.completion_tokens ?? 0;
}

export function billingEnabled(): boolean { return existsSync(keysFile()); }

export function apiKeyHash(apiKey: string | undefined): string | undefined {
  return apiKey ? createHash("sha256").update(apiKey).digest("hex") : undefined;
}

async function readKeys(): Promise<KeyStore> {
  try {
    const metadata = await stat(keysFile());
    if (!keysCache || metadata.mtimeMs !== keysCacheMtime) {
      keysCache = JSON.parse(await readFile(keysFile(), "utf8")) as KeyStore;
      keysCacheMtime = metadata.mtimeMs;
    }
    return keysCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeKeys(keys: KeyStore): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const file = keysFile();
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(keys, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  keysCache = keys;
  keysCacheMtime = (await stat(file)).mtimeMs;
}

async function withKeyTransaction<T>(operation: (keys: KeyStore) => Promise<T> | T): Promise<T> {
  const run = keyWriteChain.catch(() => undefined).then(async () => {
    // 在副本上执行，失败时不能让缓存余额先于磁盘提交而变化。
    const keys = structuredClone(await readKeys());
    const result = await operation(keys);
    await writeKeys(keys);
    return result;
  });
  keyWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

export async function checkKey(apiKey: string | undefined): Promise<{ ok: boolean; reason?: string }> {
  if (!billingEnabled()) return { ok: true };
  if (!apiKey) return { ok: false, reason: "missing X-API-Key" };
  const record = (await readKeys())[apiKey];
  if (!record) return { ok: false, reason: "invalid api key" };
  if (record.balance <= 0) return { ok: false, reason: "点数余额不足，请充值" };
  return { ok: true };
}

function tokensToPoints(ctx: BillingContext, pricing: Pricing): number {
  const points = (ctx.promptTokens / 1000) * pricing.inputPointsPerK
    + (ctx.completionTokens / 1000) * pricing.outputPointsPerK;
  return Math.max(1, Math.ceil(points));
}

async function appendLedger(entry: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(ledgerFile()), { recursive: true });
  await appendFile(ledgerFile(), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function settleDeck(
  ctx: BillingContext,
  pricing: Pricing = DEFAULT_PRICING,
): Promise<{ points: number; balance?: number }> {
  if (!billingEnabled()) return { points: 0 };
  const points = tokensToPoints(ctx, pricing);
  return withKeyTransaction(async (keys) => {
    const record = keys[ctx.apiKey];
    if (!record) return { points: 0 };
    record.balance = Math.max(0, record.balance - points);
    await appendLedger({
      ts: new Date().toISOString(), type: "deck", deck_id: ctx.deckId,
      key_name: record.name, key_hash: apiKeyHash(ctx.apiKey),
      prompt_tokens: ctx.promptTokens, completion_tokens: ctx.completionTokens,
      points, balance: record.balance,
    });
    return { points, balance: record.balance };
  });
}

export async function chargeFixed(
  apiKey: string | undefined,
  deckId: string,
  kind: "export",
  pricing: Pricing = DEFAULT_PRICING,
): Promise<{ points: number; balance?: number }> {
  if (!billingEnabled()) return { points: 0 };
  const points = kind === "export" ? pricing.exportPoints : 0;
  return withKeyTransaction(async (keys) => {
    const record = keys[apiKey!];
    if (!record) return { points: 0 };
    record.balance = Math.max(0, record.balance - points);
    await appendLedger({
      ts: new Date().toISOString(), type: kind, deck_id: deckId,
      key_name: record.name, key_hash: apiKeyHash(apiKey), points, balance: record.balance,
    });
    return { points, balance: record.balance };
  });
}

export async function getUsage(apiKey: string | undefined): Promise<{ name: string; balance: number; entries: LedgerEntry[] } | null> {
  if (!billingEnabled() || !apiKey) return null;
  const record = (await readKeys())[apiKey];
  if (!record) return null;
  const { entries } = await readLedger(500);
  const hash = apiKeyHash(apiKey);
  return {
    name: record.name,
    balance: record.balance,
    entries: entries.filter((entry) => entry.key_hash ? entry.key_hash === hash : entry.key_name === record.name).slice(0, 50),
  };
}

export async function listKeys(): Promise<Array<{ key: string; name: string; balance: number }>> {
  if (!billingEnabled()) return [];
  return Object.entries(await readKeys()).map(([key, record]) => ({ key, name: record.name, balance: record.balance }));
}

export async function issueKey(name: string, points: number): Promise<{ key: string; balance: number }> {
  if (!Number.isFinite(points) || points < 0) throw new Error("points 必须为非负数字");
  return withKeyTransaction((keys) => {
    const key = `sk-${randomBytes(16).toString("hex")}`;
    keys[key] = { name, balance: points };
    return { key, balance: points };
  });
}

export async function rechargeKey(key: string, points: number): Promise<{ balance: number }> {
  if (!Number.isFinite(points) || points <= 0) throw new Error("points 必须为正数字");
  return withKeyTransaction((keys) => {
    if (!keys[key]) throw new Error("key 不存在");
    keys[key].balance += points;
    return { balance: keys[key].balance };
  });
}

export interface LedgerEntry {
  ts: string;
  type: string;
  deck_id: string;
  key_name: string;
  key_hash?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  points: number;
  balance: number;
}

export async function readLedger(limit = 50): Promise<{ entries: LedgerEntry[]; totalPoints: number; totalTokens: number }> {
  if (!existsSync(ledgerFile())) return { entries: [], totalPoints: 0, totalTokens: 0 };
  const lines = (await readFile(ledgerFile(), "utf8")).trim().split("\n").filter(Boolean);
  const entries = lines.map((line) => JSON.parse(line) as LedgerEntry);
  return {
    entries: entries.slice(-limit).reverse(),
    totalPoints: entries.reduce((sum, entry) => sum + entry.points, 0),
    totalTokens: entries.reduce((sum, entry) => sum + (entry.prompt_tokens ?? 0) + (entry.completion_tokens ?? 0), 0),
  };
}
