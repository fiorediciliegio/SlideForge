import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apiKeyHash, chargeFixed, checkKey, issueKey, rechargeKey } from "../../src/billing/index.ts";

async function withDataDir(run: (dataDir: string) => Promise<void>) {
  const previousDataDir = process.env.SLIDEFORGE_DATA_DIR;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-billing-"));
  process.env.SLIDEFORGE_DATA_DIR = dataDir;
  try { await run(dataDir); } finally {
    if (previousDataDir === undefined) delete process.env.SLIDEFORGE_DATA_DIR;
    else process.env.SLIDEFORGE_DATA_DIR = previousDataDir;
  }
}

test("billing stores only hashes and serializes concurrent charges", async () => {
  await withDataDir(async (dataDir) => {
    const issued = await issueKey("capacity-test", 100);
    await rechargeKey(issued.key, 20);
    const charges = await Promise.all(Array.from({ length: 5 }, (_, index) => (
      chargeFixed(issued.key, `deck-${index}`, "export")
    )));
    assert.equal(charges.at(-1)?.balance, 70);
    const raw = await readFile(path.join(dataDir, "api-keys.json"), "utf8");
    const stored = JSON.parse(raw);
    assert.equal(stored[apiKeyHash(issued.key)!].balance, 70);
    assert.equal(stored[issued.key], undefined);
    assert.equal(raw.includes(issued.key), false);
    assert.deepEqual(await checkKey(apiKeyHash(issued.key)), { ok: false, reason: "invalid api key" });
    await rechargeKey(apiKeyHash(issued.key)!, 1);
    const ledger = await readFile(path.join(dataDir, "billing", "ledger.jsonl"), "utf8");
    assert.equal(ledger.trim().split("\n").length, 5);
  });
});

test("legacy plaintext keys migrate without changing the client credential", async () => {
  await withDataDir(async (dataDir) => {
    const legacyKey = "sk-legacy-user-key";
    await writeFile(path.join(dataDir, "api-keys.json"), JSON.stringify({
      [legacyKey]: { name: "legacy", balance: 88 },
    }));
    assert.deepEqual(await checkKey(legacyKey), { ok: true });
    const raw = await readFile(path.join(dataDir, "api-keys.json"), "utf8");
    const stored = JSON.parse(raw);
    assert.equal(stored[apiKeyHash(legacyKey)!].balance, 88);
    assert.equal(stored[apiKeyHash(legacyKey)!].key_prefix, legacyKey.slice(0, 12));
    assert.equal(raw.includes(legacyKey), false);
  });
});

test("charge operation id prevents duplicate export charges", async () => {
  await withDataDir(async () => {
    const issued = await issueKey("idempotency", 100);
    const first = await chargeFixed(issued.key, "deck-a", "export", undefined, "export-operation-a");
    const repeated = await chargeFixed(issued.key, "deck-a", "export", undefined, "export-operation-a");
    assert.deepEqual(repeated, first);
    assert.equal(repeated.balance, 90);
  });
});
