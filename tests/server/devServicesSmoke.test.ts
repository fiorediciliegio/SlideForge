import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const goBinary = process.env.SLIDEFORGE_GO_BINARY;

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await once(killer, "exit");
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("default dev entry serves the app through Go after all services become ready", { skip: !goBinary, timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slideforge-dev-services-"));
  const gatewayPort = 39_000 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ["scripts/dev-services.mjs"], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    env: {
      ...process.env,
      GO_BINARY: goBinary,
      NODE_ENV: "development",
      GATEWAY_PORT: String(gatewayPort),
      PORT: String(gatewayPort + 501),
      ENGINE_PORT: String(gatewayPort + 502),
      BRAIN_PORT: String(gatewayPort + 503),
      SLIDEFORGE_DATA_DIR: dataDir,
      GATEWAY_INTERNAL_TOKEN: "dev-services-test",
    },
    stdio: "inherit",
  });
  try {
    const base = `http://127.0.0.1:${gatewayPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await fetch(`${base}/readyz`);
        if (response.ok) { ready = true; break; }
      } catch { /* services are starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const app = await fetch(`${base}/app`);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /SlideForge/);
  } finally {
    await stop(child);
  }
});
