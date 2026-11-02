import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIdempotentExport } from "../../src/server/exportCoordinator.ts";

test("remote export publishes the artifact before charging and reuses its receipt", async () => {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request body */ }
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/files") {
      res.end(JSON.stringify({ file_id: "file-remote-1", download_url: "/files/file-remote-1" }));
    } else if (req.url === "/internal/billing/charge") {
      res.end(JSON.stringify({ points: 10, balance: 90 }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const previous = { ...process.env };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-remote-file-"));
  const runDir = path.join(dataDir, "deck-a");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "deck.html"), "<html>deck</html>");
  const root = `http://127.0.0.1:${address.port}/internal`;
  process.env.SLIDEFORGE_DATA_DIR = dataDir;
  process.env.SLIDEFORGE_FILE_API_URL = `${root}/files`;
  process.env.SLIDEFORGE_BILLING_API_URL = root;
  process.env.GATEWAY_INTERNAL_TOKEN = "internal-test";
  try {
    const input = {
      ownerKeyHash: "owner-hash", deckId: "deck-a", runDir, format: "pptx" as const,
      outPath: path.join(runDir, "deck.pptx"),
      execute: async () => {
        await writeFile(path.join(runDir, "deck.pptx"), "pptx");
        return { outPath: path.join(runDir, "deck.pptx"), slideCount: 1, sizeBytes: 4, warnings: [] };
      },
    };
    const first = await runIdempotentExport(input);
    assert.equal(first.file_id, "file-remote-1");
    assert.equal(first.download_url, "/files/file-remote-1");
    assert.deepEqual(calls, ["/internal/files", "/internal/billing/charge"]);
    const repeated = await runIdempotentExport(input);
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.file_id, "file-remote-1");
    assert.equal(calls.length, 2);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    server.close();
    await once(server, "close");
  }
});
