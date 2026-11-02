import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildDeckHtml } from "../../scripts/m0/deck.ts";

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("engine API validates, previews and exports inside the deck workspace", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slideforge-engine-api-"));
  const runDir = path.join(root, "deck-engine");
  await mkdir(runDir, { recursive: true });
  const deckHtml = buildDeckHtml({
    title: "Engine API",
    slides: [{ styles: "h1 { color: #123456; }", body: '<main class="slide"><h1>Engine API</h1></main>' }],
  });
  await writeFile(path.join(runDir, "deck.html"), deckHtml, "utf8");
  await writeFile(path.join(runDir, "outline.json"), JSON.stringify({
    title: "Engine API", pages: [{ title: "Engine API", bullets: [] }],
  }), "utf8");

  const port = 37_000 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["--import", "tsx/esm", "src/http/engineServer.ts"], {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: {
        ...process.env,
        ENGINE_PORT: String(port),
        SLIDEFORGE_DECKS_ROOT: root,
        GATEWAY_INTERNAL_TOKEN: "engine-integration",
      },
      stdio: "ignore",
    });
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await fetch(`${base}/healthz`);
        if (response.ok) { healthy = true; break; }
      } catch { /* engine is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(healthy, true);

    const unauthorized = await fetch(`${base}/internal/engine/preview`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runDir }),
    });
    assert.equal(unauthorized.status, 404);

    const headers = { "content-type": "application/json", "x-internal-token": "engine-integration" };
    const validated = await fetch(`${base}/internal/engine/validate-page`, {
      method: "POST", headers, body: JSON.stringify({ html: deckHtml }),
    });
    assert.equal(validated.status, 200);
    assert.deepEqual(await validated.json(), { ok: true, issues: [] });

    const preview = await fetch(`${base}/internal/engine/preview`, {
      method: "POST", headers, body: JSON.stringify({ runDir, pages: [1] }),
    });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.images.length, 1);
    assert.equal(previewBody.images[0].page, 1);
    assert.ok(previewBody.images[0].base64.length > 100);

    const exported = await fetch(`${base}/internal/engine/export`, {
      method: "POST", headers, body: JSON.stringify({ runDir, format: "pptx" }),
    });
    assert.equal(exported.status, 200);
    const exportBody = await exported.json();
    assert.equal(exportBody.slideCount, 1);
    assert.ok(exportBody.sizeBytes > 0);
    assert.ok((await stat(exportBody.outPath)).size > 0);

    const traversal = await fetch(`${base}/internal/engine/export`, {
      method: "POST", headers, body: JSON.stringify({ runDir: path.join(root, "..", "escape") }),
    });
    assert.equal(traversal.status, 400);
  } finally {
    await stop(child);
  }
});
