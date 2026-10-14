import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { getPptWorkspaceRoot } from "../src/workspace-root.ts";

test("uses SLIDEFORGE_WORKSPACE_DIR as the Cloud Agent workspace base", () => {
  const previous = process.env.SLIDEFORGE_WORKSPACE_DIR;
  try {
    process.env.SLIDEFORGE_WORKSPACE_DIR = "/mnt/slideforge-persistent";
    assert.equal(getPptWorkspaceRoot(), "/mnt/slideforge-persistent/ppt");
  } finally {
    if (previous === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previous;
  }
});

test("keeps the historical local fallback when SLIDEFORGE_WORKSPACE_DIR is unset", () => {
  const previous = process.env.SLIDEFORGE_WORKSPACE_DIR;
  try {
    delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    assert.equal(getPptWorkspaceRoot(), path.join(os.homedir(), "slideforge-workspace", "ppt"));
  } finally {
    if (previous === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previous;
  }
});

test("rejects a configured relative workspace directory", () => {
  const previous = process.env.SLIDEFORGE_WORKSPACE_DIR;
  try {
    process.env.SLIDEFORGE_WORKSPACE_DIR = "relative/workspace";
    assert.throws(() => getPptWorkspaceRoot(), /SLIDEFORGE_WORKSPACE_DIR must be an absolute path/);
  } finally {
    if (previous === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previous;
  }
});
