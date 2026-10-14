#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const [action, workspaceDirArg] = process.argv.slice(2);
const allowedActions = new Set(["arm", "release", "status", "clear"]);

if (!allowedActions.has(action) || !workspaceDirArg) {
  console.error("Usage: npm run snapshot-upload-test-gate -- <arm|release|status|clear> <absolute-workspace-dir>");
  process.exitCode = 1;
} else {
  const workspaceDir = path.resolve(workspaceDirArg);
  const gatePath = path.join(
    path.dirname(workspaceDir),
    ".snapshot-sync",
    path.basename(workspaceDir),
    "snapshot-upload-test-gate.json",
  );
  const readGate = async () => {
    try {
      return JSON.parse(await readFile(gatePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const print = (gate) => console.log(JSON.stringify({
    workspace_dir: workspaceDir,
    checkpoint: "after_zip_verified_before_meta",
    ...(gate ?? { status: "idle" }),
  }, null, 2));

  if (action === "status") {
    print(await readGate());
  } else if (action === "clear") {
    await rm(gatePath, { force: true });
    print(null);
  } else {
    const existing = await readGate();
    if (action === "arm" && existing?.status === "paused") {
      throw new Error("Gate is paused. Run release or clear before arming another upload.");
    }
    if (action === "release" && !existing) {
      throw new Error("No gate is armed or paused for this Workspace.");
    }
    const now = new Date().toISOString();
    const next = action === "arm"
      ? { status: "armed", job_id: null, armed_at: now, paused_at: null, released_at: null }
      : { ...existing, status: "released", released_at: now };
    await mkdir(path.dirname(gatePath), { recursive: true });
    await writeFile(gatePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    print(next);
  }
}
