import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const localGo = path.join(root, ".tooling", "go", "bin", "go.exe");
const goBinary = process.env.GO_BINARY ?? (existsSync(localGo) ? localGo : "go");
const pythonBinary = process.env.PYTHON ?? "python";
const gatewayPort = process.env.GATEWAY_PORT ?? "8080";
const capabilityPort = process.env.PORT ?? "3210";
const enginePort = process.env.ENGINE_PORT ?? "3211";
const brainPort = process.env.BRAIN_PORT ?? "3212";
const shared = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? "development",
  GATEWAY_INTERNAL_TOKEN: process.env.GATEWAY_INTERNAL_TOKEN ?? "development-internal-token",
  SLIDEFORGE_DATA_DIR: process.env.SLIDEFORGE_DATA_DIR ?? path.join(root, "data"),
  ENGINE_UPSTREAM_URL: process.env.ENGINE_UPSTREAM_URL ?? `http://127.0.0.1:${capabilityPort}`,
  NODE_ENGINE_URL: process.env.NODE_ENGINE_URL ?? `http://127.0.0.1:${enginePort}`,
  BRAIN_URL: process.env.BRAIN_URL ?? `http://127.0.0.1:${brainPort}`,
  SLIDEFORGE_BILLING_API_URL: process.env.SLIDEFORGE_BILLING_API_URL ?? `http://127.0.0.1:${gatewayPort}/internal`,
  SLIDEFORGE_JOB_API_URL: process.env.SLIDEFORGE_JOB_API_URL ?? `http://127.0.0.1:${gatewayPort}/internal/jobs`,
  SLIDEFORGE_FILE_API_URL: process.env.SLIDEFORGE_FILE_API_URL ?? `http://127.0.0.1:${gatewayPort}/internal/files`,
  SLIDEFORGE_BRAIN_API_URL: process.env.SLIDEFORGE_BRAIN_API_URL ?? `http://127.0.0.1:${brainPort}/internal/brain`,
};
const definitions = [
  {
    name: "capability",
    command: process.execPath,
    args: ["--import", "tsx/esm", "src/http/capabilityServer.ts"],
    cwd: root,
    env: { ...shared, PORT: capabilityPort },
  },
  {
    name: "engine",
    command: process.execPath,
    args: ["--import", "tsx/esm", "src/http/engineServer.ts"],
    cwd: root,
    env: { ...shared, ENGINE_PORT: enginePort },
  },
  {
    name: "brain",
    command: pythonBinary,
    args: ["-m", "brain.app"],
    cwd: path.join(root, "services", "brain"),
    env: { ...shared, BRAIN_PORT: brainPort },
  },
  {
    name: "gateway",
    command: goBinary,
    args: ["run", "./cmd/gateway"],
    cwd: path.join(root, "services", "gateway"),
    env: { ...shared, GATEWAY_PORT: gatewayPort },
  },
];

let stopping = false;
const children = definitions.map((definition) => {
  console.log(`[slideforge] starting ${definition.name}`);
  const child = spawn(definition.command, definition.args, {
    cwd: definition.cwd,
    env: definition.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(`[slideforge] ${definition.name} failed to start: ${error.message}`);
    shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[slideforge] ${definition.name} exited (${code ?? signal})`);
      shutdown(code ? 1 : 0);
    }
  });
  return child;
});

function terminate(child, force) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/T"];
    if (force) args.push("/F");
    spawn("taskkill", args, { stdio: "ignore" });
  } else {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

async function shutdown(exitCode) {
  if (stopping) return;
  stopping = true;
  console.log("[slideforge] shutting down services", exitCode);
  const exits = children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  }));
  for (const child of children) terminate(child, false);
  await Promise.race([
    Promise.all(exits),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  for (const child of children) terminate(child, true);
  process.exit(exitCode);
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
console.log(`[slideforge] unified entry: http://localhost:${gatewayPort}/app`);
