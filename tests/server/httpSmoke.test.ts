import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const keyA = "sk-user-a";
const keyB = "sk-user-b";
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

test("production HTTP smoke enforces ownership and request limits", { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-http-"));
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "api-keys.json"), JSON.stringify({
    [keyA]: { name: "A", balance: 100 }, [keyB]: { name: "B", balance: 100 },
  }));
  await writeFile(path.join(dataDir, "deck-jobs.json"), JSON.stringify([
    { id: "deck-a", status: "creating", events: [], overflowPages: [], ownerKeyHash: hash(keyA) },
  ]));
  const port = 34_000 + Math.floor(Math.random() * 1_000);
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/http/capabilityServer.ts"], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(port),
      SLIDEFORGE_DATA_DIR: dataDir, SLIDEFORGE_ADMIN_TOKEN: "test-admin-token",
      MAX_BODY_BYTES: "1024",
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(`${base}/healthz`);
        if (response.ok) { healthy = true; break; }
      } catch { /* server is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true);
    const own = await fetch(`${base}/decks/deck-a`, { headers: { "x-api-key": keyA } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
    const other = await fetch(`${base}/decks/deck-a`, { headers: { "x-api-key": keyB } });
    assert.equal(other.status, 404);
    const otherError = await other.json();
    assert.equal(otherError.error, "deck 不存在");
    assert.equal(otherError.error_code, "not_found");
    assert.equal(otherError.retryable, false);
    const list = await fetch(`${base}/decks`, { headers: { "x-api-key": keyB } });
    assert.deepEqual(await list.json(), []);
    const invalidCreate = await fetch(`${base}/decks`, {
      method: "POST", headers: { "x-api-key": keyA, "content-type": "application/json" },
      body: JSON.stringify({ brief: "test", page_count: 1 }),
    });
    assert.equal(invalidCreate.status, 400);
    const invalidCreateError = await invalidCreate.json();
    assert.equal(invalidCreateError.error_code, "bad_request");
    assert.equal(invalidCreateError.retryable, false);
    assert.equal(Array.isArray(invalidCreateError.details), true);
    const oversized = await fetch(`${base}/research`, {
      method: "POST", headers: { "x-api-key": keyA, "content-type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(2_000) }),
    });
    assert.equal(oversized.status, 413);
    const oversizedError = await oversized.json();
    assert.equal(oversizedError.error_code, "payload_too_large");
    assert.equal(oversizedError.retryable, false);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
