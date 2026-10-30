/**
 * M0 · 最小 OpenAI 兼容 LLM 客户端（DeepSeek 等）。
 * 配置全部走环境变量：OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL。
 * key 不落仓库、不落日志。
 */

export interface LlmResult {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface LlmClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

import { reportUsage } from "../../src/billing/index.js";

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_RETRIES = 2;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}. Set OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL first.`);
  return value;
}

export async function llmComplete(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: LlmClientOptions = {},
): Promise<LlmResult> {
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL ?? "deepseek-chat";
  const apiKey = requireEnv("OPENAI_API_KEY");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages, temperature: 0.4 }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text();
          // 4xx（除 429）不重试：多半是请求本身的问题
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new Error(`LLM ${response.status}: ${body.slice(0, 300)}`);
          }
          throw new Error(`LLM ${response.status} (retryable): ${body.slice(0, 200)}`);
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: LlmResult["usage"];
        };
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error("LLM returned empty content");
        reportUsage(data.usage);
        return { text, usage: data.usage };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // 明确的 4xx 错误直接抛出
      if (/LLM 4\d\d(?! \(retryable\))/.test(message) && !message.includes("retryable")) throw error;
      console.warn(`  [llm] attempt ${attempt + 1} failed: ${message.slice(0, 160)}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
