import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chargeFixed, issueKey, rechargeKey } from "../../src/billing/index.ts";

test("billing supports first key issuance and serializes concurrent charges", async () => {
  const previousDataDir = process.env.SLIDEFORGE_DATA_DIR;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-billing-"));
  process.env.SLIDEFORGE_DATA_DIR = dataDir;
  try {
    const issued = await issueKey("capacity-test", 100);
    await rechargeKey(issued.key, 20);
    const charges = await Promise.all(Array.from({ length: 5 }, (_, index) => (
      chargeFixed(issued.key, `deck-${index}`, "export")
    )));
    assert.equal(charges.at(-1)?.balance, 70);
    const stored = JSON.parse(await readFile(path.join(dataDir, "api-keys.json"), "utf8"));
    assert.equal(stored[issued.key].balance, 70);
    const ledger = await readFile(path.join(dataDir, "billing", "ledger.jsonl"), "utf8");
    assert.equal(ledger.trim().split("\n").length, 5);
  } finally {
    if (previousDataDir === undefined) delete process.env.SLIDEFORGE_DATA_DIR;
    else process.env.SLIDEFORGE_DATA_DIR = previousDataDir;
  }
});
