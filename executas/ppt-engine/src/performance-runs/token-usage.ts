export type PerformanceTokenUsageSource = "session" | "llm";

export interface PerformanceTokenUsageBucket {
  available: boolean;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  estimated_cost: number | null;
}

export interface PerformanceTokenUsageSummary {
  session: PerformanceTokenUsageBucket;
  llm: PerformanceTokenUsageBucket;
  total: PerformanceTokenUsageBucket;
}

interface TokenEventLike {
  event_type?: string;
  attributes?: Record<string, unknown>;
}

function emptyBucket(): PerformanceTokenUsageBucket {
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

export function emptyPerformanceTokenUsage(): PerformanceTokenUsageSummary {
  return {
    session: emptyBucket(),
    llm: emptyBucket(),
    total: emptyBucket(),
  };
}

function readSource(value: unknown): PerformanceTokenUsageSource | null {
  return value === "session" || value === "llm" ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addBucket(left: PerformanceTokenUsageBucket, right: PerformanceTokenUsageBucket): PerformanceTokenUsageBucket {
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

export function summarizePerformanceTokenUsage(events: TokenEventLike[]): PerformanceTokenUsageSummary {
  let session = emptyBucket();
  let llm = emptyBucket();
  for (const event of events) {
    if (event.event_type !== "token.usage") continue;
    const source = readSource(event.attributes?.token_source);
    if (!source) continue;
    const attributes = event.attributes ?? {};
    const bucket: PerformanceTokenUsageBucket = {
      available: true,
      calls: readNumber(attributes.token_calls),
      input_tokens: readNumber(attributes.input_tokens),
      output_tokens: readNumber(attributes.output_tokens),
      total_tokens: readNumber(attributes.total_tokens),
      cache_creation_tokens: readNumber(attributes.cache_creation_tokens),
      cache_read_tokens: readNumber(attributes.cache_read_tokens),
      estimated_cost: typeof attributes.estimated_cost === "number" && Number.isFinite(attributes.estimated_cost)
        ? attributes.estimated_cost
        : null,
    };
    if (source === "session") session = addBucket(session, bucket);
    else llm = addBucket(llm, bucket);
  }
  return { session, llm, total: addBucket(session, llm) };
}
