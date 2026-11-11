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
import { currentAgentCall } from "../../src/server/agentClient.js";

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_RETRIES = 2;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}. Set OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL first.`);
  return value;
}

export interface LlmResult {
  text: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  provider?: string;
}

export interface LlmClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LlmProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
  name: string;
}

/** 主备 provider 列表：主用现有 OPENAI_*，备用 OPENAI_FALLBACK_*（可选）。 */
export function resolveProviders(): LlmProvider[] {
  const providers: LlmProvider[] = [{
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, ""),
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: process.env.OPENAI_MODEL ?? "deepseek-chat",
    name: process.env.OPENAI_BASE_URL ?? "deepseek",
  }];
  if (process.env.OPENAI_FALLBACK_API_KEY) {
    providers.push({
      baseUrl: (process.env.OPENAI_FALLBACK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, ""),
      apiKey: process.env.OPENAI_FALLBACK_API_KEY,
      model: process.env.OPENAI_FALLBACK_MODEL ?? process.env.OPENAI_MODEL ?? "deepseek-chat",
      name: process.env.OPENAI_FALLBACK_BASE_URL ?? "fallback",
    });
  }
  return providers;
}

export async function llmComplete(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: LlmClientOptions = {},
): Promise<LlmResult> {
  if (currentAgentCall()) {
    const { agentModelComplete } = await import("../../src/server/agentModel.js");
    return agentModelComplete(messages);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  const providers = resolveProviders();

  let lastError: unknown;
  for (const provider of providers) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${provider.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({ model: provider.model, messages, temperature: 0.4 }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const body = await response.text();
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
          return { text, usage: data.usage, provider: provider.name };
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        // 明确的 4xx 错误直接抛出（配置/请求问题，不值得切换）
        if (/LLM 4\d\d(?! \(retryable\))/.test(message) && !message.includes("retryable")) throw error;
        console.warn(`  [llm] ${provider.name} attempt ${attempt + 1} failed: ${message.slice(0, 140)}`);
      }
    }
    console.warn(`  [llm] ${provider.name} 不可用，尝试备用 provider…`);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
