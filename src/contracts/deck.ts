import { z } from "zod";
import { deckIdSchema } from "./ids.js";
import { agentOptionsSchema, publicAgent, type AgentRun } from "./agent.js";

export const deckStatusSchema = z.enum(["creating", "ready", "error"]);
export type DeckStatus = z.infer<typeof deckStatusSchema>;

export const deckEventSchema = z.object({
  stage: z.enum(["outline", "page", "assemble", "export", "done", "regenerate"]),
  message: z.string(),
  page: z.number().int().positive().optional(),
  totalPages: z.number().int().positive().optional(),
});
export type DeckEvent = z.infer<typeof deckEventSchema>;

export interface CreateDeckInput<TBrandProfile = unknown> {
  deckId?: string;
  brief: string;
  pageCount?: number;
  concurrency?: number;
  decksRoot?: string;
  brandProfile?: TBrandProfile;
  sourceText?: string;
  research?: boolean;
  templateId?: string;
  onEvent?: (event: DeckEvent) => void;
}

export const createDeckMcpShape = {
  brief: z.string().trim().min(1).describe("演示需求描述，越具体越好（主题、受众、关键数据）"),
  page_count: z.number().int().min(2).max(20).optional().describe("页数，默认 8"),
  brand_id: z.string().min(1).optional().describe("当前用户的品牌模板 id"),
  source_text: z.string().max(100_000).optional().describe("原始文档提取文本"),
  template_id: z.string().min(1).optional().describe("内置模板 id"),
} satisfies z.ZodRawShape;

export const createDeckMcpSchema = z.object(createDeckMcpShape);
export const createDeckHttpSchema = createDeckMcpSchema.extend({
  agent_options: agentOptionsSchema.optional(),
  research: z.boolean().optional(),
  attachment_base64: z.string().optional(),
  filename: z.string().optional(),
});

export type CreateDeckMcpInput = z.infer<typeof createDeckMcpSchema>;
export type CreateDeckHttpInput = z.infer<typeof createDeckHttpSchema>;

export const regeneratePageMcpShape = {
  deck_id: deckIdSchema,
  page: z.number().int().min(1).describe("1-based 页码"),
  instruction: z.string().trim().min(1),
} satisfies z.ZodRawShape;

export const deckPreviewMcpShape = {
  deck_id: deckIdSchema,
  pages: z.array(z.number().int().min(1)).max(4).optional(),
} satisfies z.ZodRawShape;

export const exportDeckMcpShape = {
  deck_id: deckIdSchema,
  out_path: z.string().optional().describe("仅本地 stdio 可指定输出路径"),
  idempotency_key: z.string().max(128).optional().describe("客户端重试使用的幂等键"),
} satisfies z.ZodRawShape;

export interface DeckBilling {
  points: number;
  balance?: number;
}

export interface DeckJobRecord {
  agent?: AgentRun;
  agent_history?: AgentRun[];
  id: string;
  runDir?: string;
  title?: string;
  status: DeckStatus;
  events: string[];
  error?: string;
  overflowPages: number[];
  billing?: DeckBilling;
  ownerKeyHash?: string;
  cancelled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const deckBillingSchema = z.object({
  points: z.number(),
  balance: z.number().optional(),
});

export const deckJobDtoSchema = z.object({
  agent: z.unknown().optional(),
  deck_id: deckIdSchema,
  status: deckStatusSchema,
  title: z.string().optional(),
  recent_events: z.array(z.string()),
  overflow_pages: z.array(z.number().int()),
  billing: deckBillingSchema.optional(),
  error: z.string().optional(),
  cancelled: z.boolean().optional(),
});

export type DeckJobDto = z.infer<typeof deckJobDtoSchema>;

export function toDeckJobDto(job: DeckJobRecord, recentEventLimit = 8): DeckJobDto {
  return {
    ...(job.agent ? { agent: publicAgent(job.agent) } : {}),
    deck_id: job.id,
    status: job.status,
    title: job.title,
    recent_events: job.events.slice(-recentEventLimit),
    overflow_pages: job.overflowPages,
    billing: job.billing,
    error: job.error,
    cancelled: job.cancelled,
  };
}
