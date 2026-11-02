import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { buildOutlineMessagesViaBrain, buildPageMessagesViaBrain } from "../../src/server/brainClient.ts";

test("brain client preserves local fallback and delegates both prompt types remotely", async () => {
  const previousUrl = process.env.SLIDEFORGE_BRAIN_API_URL;
  const previousToken = process.env.GATEWAY_INTERNAL_TOKEN;
  delete process.env.SLIDEFORGE_BRAIN_API_URL;
  const local = await buildOutlineMessagesViaBrain("本地大纲", 4);
  assert.match(local[1]!.content, /4 页/);

  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ path: req.url!, body });
    assert.equal(req.headers["x-internal-token"], "brain-test");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: [{ role: "user", content: `remote:${req.url}` }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  process.env.SLIDEFORGE_BRAIN_API_URL = `http://127.0.0.1:${address.port}/internal/brain`;
  process.env.GATEWAY_INTERNAL_TOKEN = "brain-test";
  try {
    const outline = await buildOutlineMessagesViaBrain("远程大纲", 6);
    assert.equal(outline[0]!.content, "remote:/internal/brain/outline-prompt");
    const page = await buildPageMessagesViaBrain({
      deckTitle: "季度复盘",
      brief: "保留数字",
      outlineJson: "{}",
      pageIndex: 1,
      pageCount: 3,
      pageTitle: "数据分析",
      bullets: ["营收 1200 万"],
      visualSpec: "品牌蓝",
      referenceHtml: "<main>参考</main>",
    });
    assert.equal(page[0]!.content, "remote:/internal/brain/page-prompt");
    assert.deepEqual(requests.map((request) => request.path), ["/internal/brain/outline-prompt", "/internal/brain/page-prompt"]);
    assert.equal(requests[0].body.page_count, 6);
    assert.equal(requests[1].body.deck_title, "季度复盘");
    assert.equal(requests[1].body.page_index, 1);
    assert.equal(requests[1].body.visual_spec, "品牌蓝");
    assert.equal(requests[1].body.reference_html, "<main>参考</main>");
  } finally {
    server.close();
    await once(server, "close");
    if (previousUrl === undefined) delete process.env.SLIDEFORGE_BRAIN_API_URL;
    else process.env.SLIDEFORGE_BRAIN_API_URL = previousUrl;
    if (previousToken === undefined) delete process.env.GATEWAY_INTERNAL_TOKEN;
    else process.env.GATEWAY_INTERNAL_TOKEN = previousToken;
  }
});
