import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDeckHttpSchema, createDeckMcpSchema, deckEventSchema,
  deckJobDtoSchema, toDeckJobDto,
} from "../../src/contracts/deck.ts";

test("create deck contracts accept valid input and trim briefs", () => {
  const input = createDeckHttpSchema.parse({
    brief: "  产品发布 PPT  ",
    page_count: 8,
    research: true,
    attachment_base64: "YWJj",
    filename: "brief.txt",
  });
  assert.equal(input.brief, "产品发布 PPT");
  assert.equal(input.page_count, 8);
  assert.equal(input.research, true);

  const mcpInput = createDeckMcpSchema.parse({ brief: "季度复盘", page_count: 2 });
  assert.equal(mcpInput.page_count, 2);
});

test("create deck contracts reject invalid boundaries", () => {
  for (const input of [
    { brief: "" },
    { brief: "   " },
    { brief: "test", page_count: 1 },
    { brief: "test", page_count: 21 },
    { brief: "test", page_count: 2.5 },
  ]) {
    assert.equal(createDeckHttpSchema.safeParse(input).success, false);
  }
});

test("deck job DTO limits events and excludes internal persistence fields", () => {
  const dto = toDeckJobDto({
    id: "deck-a",
    runDir: "/private/deck-a",
    status: "ready",
    title: "Demo",
    events: Array.from({ length: 10 }, (_, index) => `event-${index + 1}`),
    overflowPages: [2],
    billing: { points: 3, balance: 7 },
    ownerKeyHash: "secret-hash",
  });
  assert.deepEqual(dto.recent_events, Array.from({ length: 8 }, (_, index) => `event-${index + 3}`));
  assert.equal("runDir" in dto, false);
  assert.equal("ownerKeyHash" in dto, false);
  assert.deepEqual(deckJobDtoSchema.parse(dto), dto);
});

test("deck events use the shared stage and page constraints", () => {
  assert.deepEqual(deckEventSchema.parse({ stage: "page", message: "done", page: 1 }), {
    stage: "page", message: "done", page: 1,
  });
  assert.equal(deckEventSchema.safeParse({ stage: "unknown", message: "bad" }).success, false);
  assert.equal(deckEventSchema.safeParse({ stage: "page", message: "bad", page: 0 }).success, false);
});

test("contract modules do not depend on application layers", async () => {
  for (const file of ["deck.ts", "errors.ts", "ids.ts"]) {
    const source = await readFile(new URL(`../../src/contracts/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from ["'].*(capabilities|http|mcp|features|app\/)/);
  }
});
