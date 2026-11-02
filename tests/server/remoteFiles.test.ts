import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIdempotentExport } from "../../src/server/exportCoordinator.ts";
import { publishRemoteFile } from "../../src/server/fileClient.ts";

test("remote export publishes once and survives local artifact cleanup", async () => {
  const previous = {
    dataDir: process.env.SLIDEFORGE_DATA_DIR,
    fileApi: process.env.SLIDEFORGE_FILE_API_URL,
    internalToken: process.env.GATEWAY_INTERNAL_TOKEN,
  };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-remote-files-"));
  const runDir = path.join(dataDir, "deck-remote");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "deck.html"), "<html>remote</html>");
  let publishCount = 0;
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/internal/files") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.headers["x-internal-token"], "internal-file-test");
    assert.equal(body.deck_id, "deck-remote");
    assert.equal(body.ownerKeyHash, "owner-hash");
    assert.equal(body.name, "deck.pptx");
    assert.equal(body.media_type, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.equal(Buffer.from(body.content_base64, "base64").toString(), "pptx-remote");
    publishCount++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      file_id: "file-remote",
      deck_id: "deck-remote",
      name: "deck.pptx",
      media_type: body.media_type,
      size_bytes: 12,
      download_url: "/files/file-remote",
      created_at: "2026-11-01T00:00:00Z",
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  process.env.SLIDEFORGE_DATA_DIR = dataDir;
  process.env.SLIDEFORGE_FILE_API_URL = `http://127.0.0.1:${address.port}/internal/files`;
  process.env.GATEWAY_INTERNAL_TOKEN = "internal-file-test";
  let executions = 0;
  const input = {
    ownerKeyHash: "owner-hash",
    deckId: "deck-remote",
    runDir,
    format: "pptx" as const,
    outPath: path.join(runDir, "deck.pptx"),
    execute: async () => {
      executions++;
      await writeFile(path.join(runDir, "deck.pptx"), "pptx-remote");
      return { outPath: path.join(runDir, "deck.pptx"), slideCount: 2, sizeBytes: 12, warnings: [] };
    },
  };
  try {
    const first = await runIdempotentExport(input);
    assert.equal(first.file_id, "file-remote");
    assert.equal(first.download_url, "/files/file-remote");
    assert.equal(first.idempotent, false);
    assert.equal(publishCount, 1);
    assert.equal(executions, 1);

    await rm(input.outPath);
    const persisted = await runIdempotentExport(input);
    assert.equal(persisted.idempotent, true);
    assert.equal(persisted.download_url, "/files/file-remote");
    assert.equal(publishCount, 1);
    assert.equal(executions, 1);
    const receipts = JSON.parse(await readFile(path.join(dataDir, "export-receipts.json"), "utf8"));
    assert.equal(Object.values(receipts)[0].result.download_url, "/files/file-remote");
  } finally {
    server.close();
    await once(server, "close");
    if (previous.dataDir === undefined) delete process.env.SLIDEFORGE_DATA_DIR;
    else process.env.SLIDEFORGE_DATA_DIR = previous.dataDir;
    if (previous.fileApi === undefined) delete process.env.SLIDEFORGE_FILE_API_URL;
    else process.env.SLIDEFORGE_FILE_API_URL = previous.fileApi;
    if (previous.internalToken === undefined) delete process.env.GATEWAY_INTERNAL_TOKEN;
    else process.env.GATEWAY_INTERNAL_TOKEN = previous.internalToken;
  }
});

test("remote file publish rejects missing ownership before reading or uploading", async () => {
  await assert.rejects(
    () => publishRemoteFile({ filePath: "/does/not/exist", deckId: "deck-a", format: "pptx" }),
    /文件归属/,
  );
});
