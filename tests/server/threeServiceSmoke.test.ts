import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDeckHtml } from "../../scripts/m0/deck.ts";

const goBinary = process.env.SLIDEFORGE_GO_BINARY;

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitHealthy(url: string) {
  let latest = "no response";
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url);
      latest = `${response.status}: ${await response.text()}`;
      if (response.ok) return;
    } catch (error) {
      latest = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service did not become healthy: ${url} (${latest})`);
}

test("Go, Node engine and Python brain complete one export and download", { skip: !goBinary, timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-three-service-"));
  const decksRoot = path.join(dataDir, "decks");
  const runDir = path.join(decksRoot, "deck-a");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "deck.html"), buildDeckHtml({
    title: "Three Services",
    slides: [{ styles: "h1 { color: #123456; }", body: '<main class="slide"><h1>Three Services</h1></main>' }],
  }), "utf8");
  await writeFile(path.join(runDir, "outline.json"), JSON.stringify({
    title: "Three Services", pages: [{ title: "Three Services", bullets: [] }],
  }), "utf8");

  const gatewayPort = 38_000 + Math.floor(Math.random() * 400);
  const nodePort = gatewayPort + 401;
  const enginePort = gatewayPort + 402;
  const brainPort = gatewayPort + 403;
  const gatewayRoot = `http://127.0.0.1:${gatewayPort}`;
  const nodeRoot = `http://127.0.0.1:${nodePort}`;
  const engineRoot = `http://127.0.0.1:${enginePort}`;
  const brainRoot = `http://127.0.0.1:${brainPort}`;
  const shared = {
    ...process.env,
    SLIDEFORGE_DATA_DIR: dataDir,
    SLIDEFORGE_ADMIN_TOKEN: "three-admin",
    GATEWAY_INTERNAL_TOKEN: "three-internal",
  };
  let gateway: ChildProcess | undefined;
  let node: ChildProcess | undefined;
  let engine: ChildProcess | undefined;
  let brain: ChildProcess | undefined;
  try {
    gateway = spawn(goBinary!, {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: {
        ...shared,
        GATEWAY_PORT: String(gatewayPort),
        ENGINE_UPSTREAM_URL: nodeRoot,
        NODE_ENGINE_URL: engineRoot,
        BRAIN_URL: brainRoot,
      },
      stdio: "ignore",
    });
    await waitHealthy(`${gatewayRoot}/healthz`);
    const issuedResponse = await fetch(`${gatewayRoot}/admin/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "three-admin" },
      body: JSON.stringify({ name: "three-user", points: 100 }),
    });
    assert.equal(issuedResponse.status, 200);
    const issued = await issuedResponse.json() as { key: string };
    const ownerKeyHash = createHash("sha256").update(issued.key).digest("hex");
    const created = await fetch(`${gatewayRoot}/internal/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "three-internal" },
      body: JSON.stringify({
        action: "create",
        job: { id: "deck-a", runDir, status: "ready", events: [], overflowPages: [], ownerKeyHash },
      }),
    });
    assert.equal(created.status, 200);

    node = spawn(process.execPath, ["--import", "tsx/esm", "src/http/capabilityServer.ts"], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: {
        ...shared, NODE_ENV: "production", PORT: String(nodePort),
        SLIDEFORGE_BILLING_API_URL: `${gatewayRoot}/internal`,
        SLIDEFORGE_JOB_API_URL: `${gatewayRoot}/internal/jobs`,
        SLIDEFORGE_FILE_API_URL: `${gatewayRoot}/internal/files`,
      },
      stdio: "ignore",
    });
    engine = spawn(process.execPath, ["--import", "tsx/esm", "src/http/engineServer.ts"], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: { ...shared, ENGINE_PORT: String(enginePort), SLIDEFORGE_DECKS_ROOT: decksRoot },
      stdio: "ignore",
    });
    brain = spawn("python", ["-m", "brain.app"], {
      cwd: path.resolve(import.meta.dirname, "..", "..", "services", "brain"),
      env: { ...shared, BRAIN_PORT: String(brainPort) },
      stdio: "ignore",
    });
    await Promise.all([
      waitHealthy(`${gatewayRoot}/readyz`),
      waitHealthy(`${engineRoot}/healthz`),
      waitHealthy(`${brainRoot}/healthz`),
    ]);

    const exported = await fetch(`${nodeRoot}/decks/deck-a/export`, {
      method: "POST", headers: { "x-api-key": issued.key, "content-type": "application/json" }, body: "{}",
    });
    assert.equal(exported.status, 200);
    const exportBody = await exported.json();
    assert.equal(exportBody.slideCount, 1);
    assert.match(exportBody.file_id, /^file-/);
    assert.match(exportBody.download_url, /^\/files\//);

    const downloaded = await fetch(`${gatewayRoot}${exportBody.download_url}`, { headers: { "x-api-key": issued.key } });
    assert.equal(downloaded.status, 200);
    assert.ok((await downloaded.arrayBuffer()).byteLength > 0);

    const preview = await fetch(`${engineRoot}/internal/engine/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "three-internal" },
      body: JSON.stringify({ runDir, pages: [1] }),
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).images.length, 1);

    const prompt = await fetch(`${brainRoot}/internal/brain/page-prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "three-internal" },
      body: JSON.stringify({
        deck_title: "Three Services", brief: "test", outline_json: "{}",
        page_index: 0, page_count: 1, page_title: "Cover", bullets: [],
      }),
    });
    assert.equal(prompt.status, 200);
    assert.equal((await prompt.json()).messages.length, 2);

    const document = await fetch(`${brainRoot}/internal/brain/document-extract`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": "three-internal" },
      body: JSON.stringify({ filename: "note.txt", content_base64: Buffer.from("hello brain").toString("base64") }),
    });
    assert.equal(document.status, 200);
    assert.equal((await document.json()).text, "hello brain");
  } finally {
    await Promise.all([stop(brain), stop(engine), stop(node), stop(gateway)]);
  }
});
