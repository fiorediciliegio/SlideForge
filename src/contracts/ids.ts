import { randomUUID } from "node:crypto";
import { z } from "zod";

export const deckIdSchema = z.string()
  .regex(/^deck-[A-Za-z0-9-]+$/, "deck_id 格式无效")
  .max(80)
  .describe("Deck 任务标识");

export type DeckId = z.infer<typeof deckIdSchema>;

export function newDeckId(): DeckId {
  return deckIdSchema.parse(`deck-${randomUUID().slice(0, 8)}`);
}

export function assertDeckId(value: string): DeckId {
  return deckIdSchema.parse(value);
}
