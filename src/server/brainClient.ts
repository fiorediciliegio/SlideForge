import { buildOutlineMessages as buildLocalOutlineMessages, buildPageMessages as buildLocalPageMessages } from "../../scripts/m0/prompts.js";
import { reportUsage } from "../billing/index.js";

export interface BrainMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type PageMessageInput = Parameters<typeof buildLocalPageMessages>[0];

export function remoteBrainEnabled(): boolean {
  return Boolean(process.env.SLIDEFORGE_BRAIN_API_URL?.trim());
}

async function callBrain(path: string, body: unknown): Promise<BrainMessage[]> {
  const base = process.env.SLIDEFORGE_BRAIN_API_URL!.trim().replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.GATEWAY_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { messages?: BrainMessage[]; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Brain API ${response.status}`);
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error("Brain API 未返回有效 messages");
  }
  return payload.messages;
}

export async function buildOutlineMessagesViaBrain(brief: string, pageCount: number): Promise<BrainMessage[]> {
  if (!remoteBrainEnabled()) return buildLocalOutlineMessages(brief, pageCount);
  return callBrain("/outline-prompt", { brief, page_count: pageCount, language: "中文" });
}

export async function buildPageMessagesViaBrain(input: PageMessageInput): Promise<BrainMessage[]> {
  if (!remoteBrainEnabled()) return buildLocalPageMessages(input);
  return callBrain("/page-prompt", {
    deck_title: input.deckTitle,
    brief: input.brief,
    outline_json: input.outlineJson,
    page_index: input.pageIndex,
    page_count: input.pageCount,
    page_title: input.pageTitle,
    bullets: input.bullets,
    visual_spec: input.visualSpec,
    reference_html: input.referenceHtml,
  });
}

async function postBrain<T>(path: string, body: unknown): Promise<T> {
  const base = process.env.SLIDEFORGE_BRAIN_API_URL!.trim().replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.GATEWAY_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Brain API ${response.status}`);
  return payload as T;
}

interface RemoteOutline {
  title: string;
  pages: Array<{ title: string; bullets: string[] }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function generateOutlineViaBrain(brief: string, pageCount: number): Promise<RemoteOutline> {
  const result = await postBrain<RemoteOutline>("/outline", {
    brief, page_count: pageCount, language: "中文",
  });
  reportUsage(result.usage);
  return result;
}

export async function extractDocumentViaBrain(
  content: Buffer,
  filename: string,
): Promise<{ kind: string; chars: number; text: string; document_id: string }> {
  return postBrain("/document-extract", {
    filename, content_base64: content.toString("base64"),
  });
}

export interface BrainImageDrift {
  original_size: { before: number[]; after: number[] };
  resized: boolean;
  width: number;
  height: number;
  mean_absolute_difference: number;
  rms_difference: number;
  changed_pixel_ratio: number;
  changed_pixels: number;
  threshold: number;
  difference_bbox: number[] | null;
}

export async function analyzeImageDriftViaBrain(input: {
  before: Buffer;
  after: Buffer;
  threshold?: number;
}): Promise<BrainImageDrift> {
  return postBrain("/image-drift", {
    before_base64: input.before.toString("base64"),
    after_base64: input.after.toString("base64"),
    threshold: input.threshold ?? 16,
  });
}

export async function runEvalsViaBrain(cases: Array<Record<string, unknown>>): Promise<{
  summary: { total: number; passed: number; failed: number };
  results: Array<Record<string, unknown>>;
}> {
  return postBrain("/evals/run", { cases });
}
