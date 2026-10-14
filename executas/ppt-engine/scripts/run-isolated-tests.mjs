import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "slideforge-ppt-engine-test-workspace-"));
const args = ["--import", "tsx/esm", "--test", "test/*.test.ts", "test/**/*.test.ts"];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    SLIDEFORGE_WORKSPACE_DIR: workspaceRoot,
  },
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});

await rm(workspaceRoot, { recursive: true, force: true });
process.exit(Number(exitCode));
