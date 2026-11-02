import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const goBinary = process.env.SLIDEFORGE_GO_BINARY;
const dockerBinary = process.env.SLIDEFORGE_DOCKER_BINARY;

function docker(...args: string[]) {
  const result = spawnSync(dockerBinary!, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitHealthy(url: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service did not become healthy: ${url}`);
}

test("two gateway replicas share jobs, outbox, billing and file objects", { skip: !goBinary || !dockerBinary, timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-replicas-"));
  const container = `slideforge-pg-${process.pid}-${Date.now()}`;
  const gatewayPortA = 40_000 + Math.floor(Math.random() * 400);
  const gatewayPortB = gatewayPortA + 401;
  const gatewayA = `http://127.0.0.1:${gatewayPortA}`;
  const gatewayB = `http://127.0.0.1:${gatewayPortB}`;
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  let s3: ReturnType<typeof createServer> | undefined;
  const objects = new Map<string, Buffer>();
  const webhooks: string[] = [];
  try {
    docker("run", "-d", "--name", container,
      "-e", "POSTGRES_PASSWORD=integration-password",
      "-e", "POSTGRES_DB=slideforge",
      "-p", "127.0.0.1:55432:5432",
      "docker.m.daocloud.io/library/postgres:16-alpine",
    );
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = spawnSync(dockerBinary!, ["exec", container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "slideforge"], { encoding: "utf8" });
      if (result.status === 0) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(ready, true);

    s3 = createServer((req, res) => {
      const key = req.url!;
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        });
        return;
      }
      if (req.method === "GET") {
        const content = objects.get(key);
        if (!content) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(content);
        return;
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(400).end();
    });
    s3.listen(0, "127.0.0.1");
    await once(s3, "listening");
    const address = s3.address();
    if (!address || typeof address === "string") throw new Error("missing S3 address");
    const dsn = "postgres://postgres:integration-password@127.0.0.1:55432/slideforge?sslmode=disable";
    const shared = {
      ...process.env,
      DATABASE_URL: dsn,
      JOBS_DATABASE_URL: dsn,
      FILES_DATABASE_URL: dsn,
      SLIDEFORGE_DATA_DIR: dataDir,
      SLIDEFORGE_ADMIN_TOKEN: "replica-admin",
      GATEWAY_INTERNAL_TOKEN: "replica-internal",
      GATEWAY_REPLICAS: "2",
      SLIDEFORGE_MIGRATE_JSON: "false",
      S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
      S3_BUCKET: "exports",
      S3_REGION: "test-region",
      S3_ACCESS_KEY_ID: "test-access",
      S3_SECRET_ACCESS_KEY: "test-secret",
      S3_FORCE_PATH_STYLE: "true",
    };
    first = spawn(goBinary!, { env: { ...shared, GATEWAY_PORT: String(gatewayPortA) }, stdio: "ignore" });
    second = spawn(goBinary!, { env: { ...shared, GATEWAY_PORT: String(gatewayPortB) }, stdio: "ignore" });
    await Promise.all([waitHealthy(`${gatewayA}/healthz`), waitHealthy(`${gatewayB}/healthz`)]);

    const issuedResponse = await fetch(`${gatewayA}/admin/keys`, {
      method: "POST", headers: { "content-type": "application/json", "x-admin-token": "replica-admin" },
      body: JSON.stringify({ name: "replica-user", points: 100 }),
    });
    assert.equal(issuedResponse.status, 200);
    const issued = await issuedResponse.json() as { key: string };
    const ownerKeyHash = createHash("sha256").update(issued.key).digest("hex");
    const usage = await fetch(`${gatewayB}/internal/billing/usage`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-token": "replica-internal" },
      body: JSON.stringify({ api_key: issued.key }),
    });
    assert.equal(usage.status, 200);
    assert.equal((await usage.json()).balance, 100);

    const create = await fetch(`${gatewayA}/internal/jobs`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-token": "replica-internal" },
      body: JSON.stringify({ action: "create", job: { id: "deck-a", status: "creating", events: [], overflowPages: [], ownerKeyHash } }),
    });
    assert.equal(create.status, 200);
    const sse = await fetch(`${gatewayB}/decks/deck-a/events`, { headers: { "x-api-key": issued.key } });
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    const firstEvent = await reader.read();
    assert.match(decoder.decode(firstEvent.value), /event: job/);

    const save = await fetch(`${gatewayA}/internal/jobs`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-token": "replica-internal" },
      body: JSON.stringify({ action: "save", job: { id: "deck-a", status: "ready", events: ["ready"], overflowPages: [], ownerKeyHash } }),
    });
    assert.equal(save.status, 200);
    const secondEvent = await reader.read();
    assert.match(decoder.decode(secondEvent.value), /ready/);
    await reader.cancel();

    const callback = createServer((req, res) => {
      webhooks.push(req.url!);
      res.writeHead(204).end();
    });
    callback.listen(0, "127.0.0.1");
    await once(callback, "listening");
    const callbackAddress = callback.address();
    if (!callbackAddress || typeof callbackAddress === "string") throw new Error("missing callback address");
    const webhook = await fetch(`${gatewayB}/decks/deck-a/webhooks`, {
      method: "POST", headers: { "x-api-key": issued.key, "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${callbackAddress.port}/hook`, secret: "replica-secret-16" }),
    });
    assert.equal(webhook.status, 200);
    const notify = await fetch(`${gatewayA}/internal/jobs`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-token": "replica-internal" },
      body: JSON.stringify({ action: "save", job: { id: "deck-a", status: "ready", events: ["webhook"], overflowPages: [], ownerKeyHash } }),
    });
    assert.equal(notify.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(webhooks.length, 1);

    const published = await fetch(`${gatewayA}/internal/files`, {
      method: "POST", headers: { "content-type": "application/json", "x-internal-token": "replica-internal" },
      body: JSON.stringify({
        deck_id: "deck-a", name: "deck.pptx", media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        content_base64: Buffer.from("pptx").toString("base64"), ownerKeyHash,
      }),
    });
    assert.equal(published.status, 200);
    const file = await published.json();
    const list = await fetch(`${gatewayB}/decks/deck-a/files`, { headers: { "x-api-key": issued.key } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).length, 1);
    const downloaded = await fetch(`${gatewayB}${file.download_url}`, { headers: { "x-api-key": issued.key } });
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), "pptx");

    const cancelled = await fetch(`${gatewayB}/decks/deck-a/cancel`, { method: "POST", headers: { "x-api-key": issued.key } });
    assert.equal(cancelled.status, 200);
    const current = await fetch(`${gatewayA}/decks/deck-a`, { headers: { "x-api-key": issued.key } });
    const currentBody = await current.json();
    assert.equal(currentBody.status, "error");
    assert.equal(currentBody.cancelled, true);
    callback.close();
  } finally {
    await Promise.all([stop(first), stop(second)]);
    if (s3) {
      s3.close();
      await once(s3, "close");
    }
    docker("rm", "-f", container);
  }
});
