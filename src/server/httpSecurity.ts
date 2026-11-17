import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpRequestError(413, `请求体超过 ${maxBytes} 字节上限`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpRequestError(400, "JSON 请求体必须是对象");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "JSON 请求体格式错误");
  }
}

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

interface RateBucket {
  startedAt: number;
  count: number;
}

/** 单实例固定窗口限流；多实例部署时应替换为 Redis 共享限流。 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const current = this.buckets.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      this.prune(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count++;
    const retryAfterSeconds = Math.max(1, Math.ceil((current.startedAt + this.windowMs - now) / 1000));
    return { allowed: current.count <= this.limit, retryAfterSeconds };
  }

  private prune(now: number): void {
    if (this.buckets.size < 20_000) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= this.windowMs) this.buckets.delete(key);
    }
  }
}

export function requestIdentity(req: IncomingMessage): string {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return `key:${apiKey}`;
  const forwarded = process.env.SLIDEFORGE_TRUST_PROXY === "true"
    ? req.headers["x-forwarded-for"]
    : undefined;
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return `ip:${firstForwarded?.trim() || req.socket.remoteAddress || "unknown"}`;
}
