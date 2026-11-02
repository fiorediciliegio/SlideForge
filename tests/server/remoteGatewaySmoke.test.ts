import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const goBinary = process.env.SLIDEFORGE_GO_BINARY;

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitHealthy(url: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* process is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service did not become healthy: ${url}`);
}

test("Go owns credentials and jobs while Node delegates through internal APIs", { skip: !goBinary, timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-remote-gateway-"));
  const gatewayPort = 36_000 + Math.floor(Math.random() * 500);
  const nodePort = gatewayPort + 501;
  const gatewayRoot = `http://127.0.0.1:${gatewayPort}`;
  const nodeRoot = `http://127.0.0.1:${nodePort}`;
  const shared = {
    ...process.env,
    SLIDEFORGE_DATA_DIR: dataDir,
    SLIDEFORGE_ADMIN_TOKEN: "admin-integration",
    GATEWAY_INTERNAL_TOKEN: "internal-integration",
  };
  let gateway: ChildProcess | undefined;
  let node: ChildProcess | undefined;
  try {
    gateway = spawn(goBinary!, {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: {
        ...shared, GATEWAY_PORT: String(gatewayPort),
        ENGINE_UPSTREAM_URL: nodeRoot,
      },
      stdio: "ignore",
    });
    await waitHealthy(`${gatewayRoot}/healthz`);
    const issuedResponse = await fetch(`${gatewayRoot}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "admin-integration" },
      body: JSON.stringify({ name: "integration-user", points: 100 }),
    });
    assert.equal(issuedResponse.status, 200);
    const issued = await issuedResponse.json() as { key: string };
    const ownerKeyHash = createHash("sha256").update(issued.key).digest("hex");
    const created = await fetch(`${gatewayRoot}/internal/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "internal-integration" },
      body: JSON.stringify({
        action: "create",
        job: { id: "deck-a", status: "creating", events: [], overflowPages: [], ownerKeyHash },
      }),
    });
    assert.equal(created.status, 200);
    node = spawn(process.execPath, ["--import", "tsx/esm", "src/http/capabilityServer.ts"], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: {
        ...shared, NODE_ENV: "production", PORT: String(nodePort),
        SLIDEFORGE_BILLING_API_URL: `${gatewayRoot}/internal`,
        SLIDEFORGE_JOB_API_URL: `${gatewayRoot}/internal/jobs`,
      },
      stdio: "ignore",
    });
    // 此用例验证认证、任务和文件，不涉及独立引擎就绪；三上游就绪由 devServicesSmoke 覆盖。
    await waitHealthy(`${nodeRoot}/healthz`);
    const deck = await fetch(`${nodeRoot}/decks/deck-a`, { headers: { "x-api-key": issued.key } });
    assert.equal(deck.status, 200);
    const sse = await fetch(`${gatewayRoot}/decks/deck-a/events`, { headers: { "x-api-key": issued.key } });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = sse.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: job/);
    await reader.cancel();
    const cancelled = await fetch(`${gatewayRoot}/decks/deck-a/cancel`, {
      method: "POST", headers: { "x-api-key": issued.key },
    });
    assert.equal(cancelled.status, 200);
    const cancelledBody = await cancelled.json() as { status: string; cancelled: boolean };
    assert.equal(cancelledBody.status, "error");
    assert.equal(cancelledBody.cancelled, true);
    const published = await fetch(`${gatewayRoot}/internal/files`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "internal-integration" },
      body: JSON.stringify({
        deck_id: "deck-a", name: "deck.pptx",
        media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        content_base64: Buffer.from("pptx").toString("base64"), ownerKeyHash,
      }),
    });
    assert.equal(published.status, 200);
    const publishedBody = await published.json() as { file_id: string; download_url: string };
    const downloaded = await fetch(`${gatewayRoot}${publishedBody.download_url}`, {
      headers: { "x-api-key": issued.key },
    });
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "pptx");
    const usage = await fetch(`${gatewayRoot}/usage`, { headers: { "x-api-key": issued.key } });
    assert.equal(usage.status, 200);
    const usageBody = await usage.json() as { enabled: boolean; name: string; balance: number };
    assert.deepEqual(usageBody, { enabled: true, name: "integration-user", balance: 100, entries: [] });
    const stored = await readFile(path.join(dataDir, "api-keys.json"), "utf8");
    assert.equal(stored.includes(issued.key), false);
  } finally {
    await stop(node);
    await stop(gateway);
  }
});
