import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apiKeyHash, issueKey } from "../../src/billing/index.ts";
import { runIdempotentExport } from "../../src/server/exportCoordinator.ts";

test("concurrent and persisted export retries execute and charge only once", async () => {
  const previousDataDir = process.env.SLIDEFORGE_DATA_DIR;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-export-"));
  const runDir = path.join(dataDir, "deck-a");
  process.env.SLIDEFORGE_DATA_DIR = dataDir;
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "deck.html"), "<html>v1</html>");
  try {
    const issued = await issueKey("export-user", 100);
    let executions = 0;
    const input = {
      apiKey: issued.key,
      ownerKeyHash: apiKeyHash(issued.key),
      deckId: "deck-a",
      runDir,
      format: "pptx" as const,
      outPath: path.join(runDir, "deck.pptx"),
      execute: async () => {
        executions++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await writeFile(path.join(runDir, "deck.pptx"), "pptx");
        return { outPath: path.join(runDir, "deck.pptx"), slideCount: 2, sizeBytes: 4, warnings: [] };
      },
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => runIdempotentExport(input)));
    assert.equal(executions, 1);
    assert.ok(results.every((result) => result.billing.balance === 90));
    const persisted = await runIdempotentExport(input);
    assert.equal(persisted.idempotent, true);
    assert.equal(executions, 1);

    await writeFile(path.join(runDir, "deck.html"), "<html>v2</html>");
    const changed = await runIdempotentExport({ ...input, idempotencyKey: "client-retry-1" });
    assert.equal(changed.idempotent, false);
    assert.equal(changed.billing.balance, 80);
    const sameClientRetry = await runIdempotentExport({ ...input, idempotencyKey: "client-retry-1" });
    assert.equal(sameClientRetry.idempotent, true);
    await writeFile(path.join(runDir, "deck.html"), "<html>v3</html>");
    await assert.rejects(
      () => runIdempotentExport({ ...input, idempotencyKey: "client-retry-1" }),
      /不能用于不同内容/,
    );
    const keys = JSON.parse(await readFile(path.join(dataDir, "api-keys.json"), "utf8"));
    assert.equal(keys[apiKeyHash(issued.key)!].balance, 80);
  } finally {
    if (previousDataDir === undefined) delete process.env.SLIDEFORGE_DATA_DIR;
    else process.env.SLIDEFORGE_DATA_DIR = previousDataDir;
  }
});
