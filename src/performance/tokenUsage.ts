import type { TokenUsageBucket, TokenUsageSource, TokenUsageSummary } from "../api/types";

type UsageRecord = Record<string, unknown>;

function recordValue(value: unknown): UsageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as UsageRecord;
  if (record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)) {
    return record.usage as UsageRecord;
  }
  return record;
}

function readFiniteNumber(record: UsageRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function emptyBucket(): TokenUsageBucket {
  return {
    available: false,
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    estimated_cost: null,
  };
}

export function createEmptyTokenUsageSummary(): TokenUsageSummary {
  return {
    session: emptyBucket(),
    llm: emptyBucket(),
    total: emptyBucket(),
  };
}

export function normalizeTokenUsage(usage: unknown, source: TokenUsageSource): TokenUsageBucket | null {
  const record = recordValue(usage);
  const input = source === "session"
    ? readFiniteNumber(record, ["total_prompt_tokens", "prompt_tokens", "input_tokens"])
    : readFiniteNumber(record, ["inputTokens", "input_tokens", "prompt_tokens"]);
  const output = source === "session"
    ? readFiniteNumber(record, ["total_completion_tokens", "completion_tokens", "output_tokens"])
    : readFiniteNumber(record, ["outputTokens", "output_tokens", "completion_tokens"]);
  const total = source === "session"
    ? readFiniteNumber(record, ["total_tokens", "tokens"])
    : readFiniteNumber(record, ["totalTokens", "total_tokens", "tokens"]);
  const calls = readFiniteNumber(record, ["total_calls", "calls"]);
  const cacheCreation = readFiniteNumber(record, ["total_cache_creation_tokens", "cache_creation_tokens"]);
  const cacheRead = readFiniteNumber(record, ["total_cache_read_tokens", "cache_read_tokens"]);
  const estimatedCost = readFiniteNumber(record, ["total_estimated_cost", "estimated_cost", "cost"]);
  const hasTokenValue = [input, output, total, calls, cacheCreation, cacheRead, estimatedCost].some((value) => value !== null);
  if (!hasTokenValue) return null;
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  const totalTokens = total ?? inputTokens + outputTokens;
  return {
    available: true,
    calls: calls ?? 1,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_creation_tokens: cacheCreation ?? 0,
    cache_read_tokens: cacheRead ?? 0,
    estimated_cost: estimatedCost,
  };
}

function addBucket(left: TokenUsageBucket, right: TokenUsageBucket): TokenUsageBucket {
  const estimatedCost = left.estimated_cost === null && right.estimated_cost === null
    ? null
    : (left.estimated_cost ?? 0) + (right.estimated_cost ?? 0);
  return {
    available: left.available || right.available,
    calls: left.calls + right.calls,
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    cache_creation_tokens: left.cache_creation_tokens + right.cache_creation_tokens,
    cache_read_tokens: left.cache_read_tokens + right.cache_read_tokens,
    estimated_cost: estimatedCost,
  };
}

export function addTokenUsageSummary(target: TokenUsageSummary, next: TokenUsageSummary): TokenUsageSummary {
  const session = addBucket(target.session, next.session);
  const llm = addBucket(target.llm, next.llm);
  return { session, llm, total: addBucket(session, llm) };
}

export function summaryFromTokenUsage(source: TokenUsageSource, bucket: TokenUsageBucket): TokenUsageSummary {
  const empty = emptyBucket();
  return source === "session"
    ? { session: bucket, llm: empty, total: bucket }
    : { session: empty, llm: bucket, total: bucket };
}
