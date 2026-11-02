import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { runWithBilling } from "../../src/billing/index.ts";
import { generateOutlineViaBrain } from "../../src/server/brainClient.ts";
import { extractDocumentText } from "../../src/documents/extract.ts";

test("remote brain owns outline generation and document extraction with usage attribution", async () => {
  const previousUrl = process.env.SLIDEFORGE_BRAIN_API_URL;
  const previousToken = process.env.GATEWAY_INTERNAL_TOKEN;
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ path: req.url!, body });
    assert.equal(req.headers["x-internal-token"], "brain-responsibilities");
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/outline") {
      res.end(JSON.stringify({
        title: "远程大纲",
        pages: [{ title: "封面", bullets: ["A"] }, { title: "结论", bullets: ["B"] }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }));
      return;
    }
    if (req.url === "/document-extract") {
      assert.equal(Buffer.from(body.content_base64, "base64").toString(), "docx-content");
      res.end(JSON.stringify({ kind: "docx", chars: 8, text: "第一季度\n营收", document_id: "doc-hash" }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  process.env.SLIDEFORGE_BRAIN_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.GATEWAY_INTERNAL_TOKEN = "brain-responsibilities";
  try {
    const context = { apiKey: "", deckId: "deck-brain", promptTokens: 0, completionTokens: 0 };
    const { outline, extracted } = await runWithBilling(context, async () => {
      const generated = await generateOutlineViaBrain("测试需求", 2);
      assert.equal(generated.title, "远程大纲");
      assert.equal(generated.pages.length, 2);
      const document = await extractDocumentText(Buffer.from("docx-content"), "report.docx");
      assert.deepEqual(document, { text: "第一季度\n营收", chars: 8, kind: "docx" });
      return { outline: generated, extracted: document };
    });
    assert.equal(outline.title, "远程大纲");
    assert.equal(extracted.kind, "docx");
    assert.equal(context.promptTokens, 10);
    assert.equal(context.completionTokens, 20);
    assert.equal(requests[0].path, "/outline");
    assert.equal(requests[1].path, "/document-extract");
    assert.equal(requests[1].body.filename, "report.docx");
  } finally {
    server.close();
    await once(server, "close");
    if (previousUrl === undefined) delete process.env.SLIDEFORGE_BRAIN_API_URL;
    else process.env.SLIDEFORGE_BRAIN_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GATEWAY_INTERNAL_TOKEN;
    else process.env.GATEWAY_INTERNAL_TOKEN = previousToken;
  }
});
