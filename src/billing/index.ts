/**
 * 点数计费：API key 只存 SHA-256 哈希；单实例串行事务与原子文件替换。
 * 多实例部署必须迁移到支持事务与唯一约束的数据库。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { callRemoteAdmin, callRemoteBilling, remoteBillingEnabled } from "./remote.js";

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

interface ChargeReceipt { points: number; balance: number }
interface ApiKeyRecord {
  name: string;
  balance: number;
  key_prefix?: string;
  /** 有界幂等记录，防止导出重试重复扣费。 */
  charges?: Record<string, ChargeReceipt>;
}
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
let keysCacheFile = "";

export function runWithBilling<T>(ctx: BillingContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

export function reportUsage(usage?: { prompt_tokens?: number; completion_tokens?: number }) {
  const ctx = als.getStore();
  if (!ctx || !usage) return;
  ctx.promptTokens += usage.prompt_tokens ?? 0;
  ctx.completionTokens += usage.completion_tokens ?? 0;
}

export function billingEnabled(): boolean { return remoteBillingEnabled() || existsSync(keysFile()); }

export function apiKeyHash(apiKey: string | undefined): string | undefined {
  return apiKey ? createHash("sha256").update(apiKey).digest("hex") : undefined;
}

function normalizeKeys(raw: KeyStore): { keys: KeyStore; migrated: boolean } {
  const keys: KeyStore = {};
  let migrated = false;
  for (const [identity, record] of Object.entries(raw)) {
    const legacy = identity.startsWith("sk-");
    const hash = legacy ? apiKeyHash(identity)! : identity;
    keys[hash] = {
      ...record,
      key_prefix: record.key_prefix ?? (legacy ? identity.slice(0, 12) : `sha256:${hash.slice(0, 8)}`),
    };
    migrated ||= legacy;
  }
  return { keys, migrated };
}

async function readKeys(): Promise<KeyStore> {
  try {
    const file = keysFile();
    const metadata = await stat(file);
    if (!keysCache || keysCacheFile !== file || metadata.mtimeMs !== keysCacheMtime) {
      const raw = JSON.parse(await readFile(file, "utf8")) as KeyStore;
      const normalized = normalizeKeys(raw);
      keysCache = normalized.keys;
      keysCacheFile = file;
      keysCacheMtime = metadata.mtimeMs;
      if (normalized.migrated) await writeKeys(normalized.keys);
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
  keysCacheFile = file;
  keysCacheMtime = (await stat(file)).mtimeMs;
}

async function withKeyTransaction<T>(operation: (keys: KeyStore) => Promise<T> | T): Promise<T> {
  const run = keyWriteChain.catch(() => undefined).then(async () => {
    const keys = structuredClone(await readKeys());
    const result = await operation(keys);
    await writeKeys(keys);
    return result;
  });
  keyWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

function keyIdentity(apiKey: string | undefined): string {
  // 认证只接受原始高熵凭证，存储哈希本身不能反向充当 bearer token。
  return apiKeyHash(apiKey) ?? "";
}

function rechargeIdentity(keyOrHash: string): string {
  return keyOrHash.startsWith("sk-") ? apiKeyHash(keyOrHash)! : keyOrHash;
}

export async function checkKey(apiKey: string | undefined): Promise<{ ok: boolean; reason?: string }> {
  if (remoteBillingEnabled()) return callRemoteBilling("/auth/check", { api_key: apiKey ?? "" });
  if (!billingEnabled()) return { ok: true };
  if (!apiKey) return { ok: false, reason: "missing X-API-Key" };
  const record = (await readKeys())[keyIdentity(apiKey)];
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
  if (remoteBillingEnabled()) {
    return callRemoteBilling("/billing/settle", {
      api_key: ctx.apiKey, deck_id: ctx.deckId,
      prompt_tokens: ctx.promptTokens, completion_tokens: ctx.completionTokens,
      input_points_per_k: pricing.inputPointsPerK, output_points_per_k: pricing.outputPointsPerK,
    });
  }
  if (!billingEnabled()) return { points: 0 };
  const points = tokensToPoints(ctx, pricing);
  return withKeyTransaction(async (keys) => {
    const record = keys[keyIdentity(ctx.apiKey)];
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
  operationId?: string,
  ownerKeyHash?: string,
): Promise<{ points: number; balance?: number }> {
  const points = kind === "export" ? pricing.exportPoints : 0;
  if (remoteBillingEnabled()) {
    return callRemoteBilling("/billing/charge", {
      api_key: apiKey ?? "", deck_id: deckId, kind, points, operation_id: operationId,
      ...(!apiKey&&ownerKeyHash?{owner_key_hash:ownerKeyHash}:{}),
    });
  }
  if (!billingEnabled()) return { points: 0 };
  return withKeyTransaction(async (keys) => {
    const record = keys[!apiKey&&ownerKeyHash?ownerKeyHash:keyIdentity(apiKey)];
    if (!record) return { points: 0 };
    if (operationId && record.charges?.[operationId]) return record.charges[operationId];
    record.balance = Math.max(0, record.balance - points);
    const receipt = { points, balance: record.balance };
    if (operationId) {
      record.charges ??= {};
      record.charges[operationId] = receipt;
      const operationIds = Object.keys(record.charges);
      if (operationIds.length > 100) {
        for (const stale of operationIds.slice(0, operationIds.length - 100)) delete record.charges[stale];
      }
    }
    await appendLedger({
      ts: new Date().toISOString(), type: kind, deck_id: deckId, operation_id: operationId,
      key_name: record.name, key_hash: apiKeyHash(apiKey), points, balance: record.balance,
    });
    return receipt;
  });
}

export async function getUsage(apiKey: string | undefined): Promise<{ name: string; balance: number; entries: LedgerEntry[] } | null> {
  if (!apiKey) return null;
  if (remoteBillingEnabled()) return callRemoteBilling("/billing/usage", { api_key: apiKey });
  if (!billingEnabled()) return null;
  const record = (await readKeys())[keyIdentity(apiKey)];
  if (!record) return null;
  const { entries } = await readLedger(500);
  const hash = apiKeyHash(apiKey);
  return {
    name: record.name,
    balance: record.balance,
    entries: entries.filter((entry) => entry.key_hash ? entry.key_hash === hash : entry.key_name === record.name).slice(0, 50),
  };
}

export async function listKeys(): Promise<Array<{ key: string; key_prefix: string; name: string; balance: number }>> {
  if (remoteBillingEnabled()) return callRemoteAdmin("/admin/keys", "GET");
  if (!billingEnabled()) return [];
  return Object.entries(await readKeys()).map(([hash, record]) => ({
    key: hash, key_prefix: record.key_prefix ?? `sha256:${hash.slice(0, 8)}`,
    name: record.name, balance: record.balance,
  }));
}

export async function issueKey(name: string, points: number): Promise<{ key: string; balance: number }> {
  if (!Number.isFinite(points) || points < 0) throw new Error("points 必须为非负数字");
  if (remoteBillingEnabled()) return callRemoteAdmin("/admin/keys", "POST", { name, points });
  return withKeyTransaction((keys) => {
    const key = `sk-${randomBytes(16).toString("hex")}`;
    keys[apiKeyHash(key)!] = { name, balance: points, key_prefix: key.slice(0, 12) };
    return { key, balance: points };
  });
}

export async function rechargeKey(key: string, points: number): Promise<{ balance: number }> {
  if (!Number.isFinite(points) || points <= 0) throw new Error("points 必须为正数字");
  if (remoteBillingEnabled()) return callRemoteAdmin("/admin/keys/recharge", "POST", { key, points });
  return withKeyTransaction((keys) => {
    const identity = rechargeIdentity(key);
    if (!keys[identity]) throw new Error("key 不存在");
    keys[identity].balance += points;
    return { balance: keys[identity].balance };
  });
}

export interface LedgerEntry {
  ts: string;
  type: string;
  deck_id: string;
  key_name: string;
  key_hash?: string;
  operation_id?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  points: number;
  balance: number;
}

export async function readLedger(limit = 50): Promise<{ entries: LedgerEntry[]; totalPoints: number; totalTokens: number }> {
  if (remoteBillingEnabled()) return callRemoteBilling("/billing/ledger", { limit });
  if (!existsSync(ledgerFile())) return { entries: [], totalPoints: 0, totalTokens: 0 };
  const lines = (await readFile(ledgerFile(), "utf8")).trim().split("\n").filter(Boolean);
  const entries = lines.map((line) => JSON.parse(line) as LedgerEntry);
  return {
    entries: entries.slice(-limit).reverse(),
    totalPoints: entries.reduce((sum, entry) => sum + entry.points, 0),
    totalTokens: entries.reduce((sum, entry) => sum + (entry.prompt_tokens ?? 0) + (entry.completion_tokens ?? 0), 0),
  };
}
