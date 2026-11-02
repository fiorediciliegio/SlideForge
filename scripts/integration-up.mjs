import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const composeFile = path.join(root, "deploy", "integration", "docker-compose.yml");
const dockerBinary = process.env.DOCKER_BINARY ?? "docker";
const goBinary = process.env.GO_BINARY ?? path.join(root, ".tooling", "go", "bin", "go.exe");
const pythonBinary = process.env.PYTHON ?? "python";
const backend = process.env.OBJECT_STORE_BACKEND ?? "moto";
const environment = {
  ...process.env,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://slideforge:slideforge-test@127.0.0.1:55432/slideforge?sslmode=disable",
  TEST_S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:59000",
  TEST_S3_BUCKET: process.env.TEST_S3_BUCKET ?? "slideforge-exports",
  TEST_S3_REGION: process.env.TEST_S3_REGION ?? "us-east-1",
  TEST_S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? "slideforge-test",
  TEST_S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "slideforge-test-secret",
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await once(killer, "exit");
  } else {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

async function waitForS3() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await fetch(environment.TEST_S3_ENDPOINT, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("S3 backend did not become ready");
}

let started = false;
let objectBackend;
try {
  if (backend === "moto") {
    objectBackend = spawn(pythonBinary, ["-m", "moto.server", "-p", "59000"], {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: path.join(root, ".tooling", "python-packages"),
      },
      stdio: "inherit",
    });
    await waitForS3();
  }
  const composeArgs = ["compose", "-f", composeFile];
  if (backend === "minio") composeArgs.push("--profile", "minio");
  await run(dockerBinary, [...composeArgs, "up", "-d", "--wait"]);
  started = true;
  await run(goBinary, ["test", "-tags=integration", "./internal/integration", "-v", "-count=1", "-timeout=3m"], {
    cwd: path.join(root, "services", "gateway"),
    env: environment,
  });
} finally {
  if (started) await run(dockerBinary, ["compose", "-f", composeFile, "down", "-v"]);
  await stop(objectBackend);
}
