import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { chargeFixed, checkKey, issueKey, readLedger } from "../../src/billing/index.ts";

test("remote billing delegates auth, charges and admin operations to Go", async () => {
  const requests: Array<{ path: string; internalToken?: string; adminToken?: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    requests.push({
      path: req.url!, body,
      internalToken: req.headers["x-internal-token"] as string | undefined,
      adminToken: req.headers["x-admin-token"] as string | undefined,
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/auth/check") res.end(JSON.stringify({ ok: true }));
    else if (req.url === "/internal/billing/charge") res.end(JSON.stringify({ points: 10, balance: 90 }));
    else if (req.url === "/internal/billing/ledger") res.end(JSON.stringify({ entries: [], totalPoints: 10, totalTokens: 0 }));
    else if (req.url === "/admin/keys") res.end(JSON.stringify({ key: "sk-remote-issued", balance: 100 }));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: "not found" })); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  const previous = { ...process.env };
  process.env.SLIDEFORGE_BILLING_API_URL = `http://127.0.0.1:${address.port}/internal`;
  process.env.GATEWAY_INTERNAL_TOKEN = "internal-test";
  process.env.SLIDEFORGE_ADMIN_TOKEN = "admin-test";
  try {
    assert.deepEqual(await checkKey("sk-remote"), { ok: true });
    assert.deepEqual(await chargeFixed("sk-remote", "deck-a", "export", undefined, "operation-a"), { points: 10, balance: 90 });
    assert.deepEqual(await issueKey("remote-user", 100), { key: "sk-remote-issued", balance: 100 });
    assert.deepEqual(await readLedger(), { entries: [], totalPoints: 10, totalTokens: 0 });
    assert.equal(requests[0].internalToken, "internal-test");
    assert.equal(requests[2].adminToken, "admin-test");
    assert.equal((requests[1].body as { operation_id?: string }).operation_id, "operation-a");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    server.close();
    await once(server, "close");
  }
});
