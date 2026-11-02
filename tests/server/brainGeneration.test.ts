import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { runWithBilling } from "../../src/billing/index.ts";
import { extractDocumentViaBrain, generateOutlineViaBrain } from "../../src/server/brainClient.ts";

test("brain generation returns validated outline, usage and extracted document text", async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/brain/outline") {
      res.end(JSON.stringify({
        title: "远程大纲", pages: [{ title: "A", bullets: [] }, { title: "B", bullets: [] }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }));
    } else if (req.url === "/internal/brain/document-extract") {
      res.end(JSON.stringify({ kind: "txt", chars: 4, text: "资料正文", document_id: "doc-1" }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const previousUrl = process.env.SLIDEFORGE_BRAIN_API_URL;
  const previousToken = process.env.GATEWAY_INTERNAL_TOKEN;
  process.env.SLIDEFORGE_BRAIN_API_URL = `http://127.0.0.1:${address.port}/internal/brain`;
  process.env.GATEWAY_INTERNAL_TOKEN = "brain-test";
  try {
    const billing = { apiKey: "", deckId: "deck-a", promptTokens: 0, completionTokens: 0 };
    const outline = await runWithBilling(billing, () => generateOutlineViaBrain("测试", 2));
    assert.equal(outline.title, "远程大纲");
    assert.equal(billing.promptTokens, 12);
    assert.equal(billing.completionTokens, 34);
    const document = await extractDocumentViaBrain(Buffer.from("资料正文"), "source.txt");
    assert.equal(document.text, "资料正文");
    assert.equal(document.kind, "txt");
  } finally {
    server.close();
    await once(server, "close");
    if (previousUrl === undefined) delete process.env.SLIDEFORGE_BRAIN_API_URL;
    else process.env.SLIDEFORGE_BRAIN_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GATEWAY_INTERNAL_TOKEN;
    else process.env.GATEWAY_INTERNAL_TOKEN = previousToken;
  }
});
