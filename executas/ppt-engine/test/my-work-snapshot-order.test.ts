import { encodeToolRequest, decodeToolResponse } from "./helpers/invoke.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type RpcMessage = {
  id: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
  __file_transport?: string;
  __trans_file__?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Tied timestamps are the case the sort has to resolve on its own: every
// Workspace here shares one updated_at, and the two that cannot be read at all
// have no timestamp. Delays are deliberately adversarial against the listing
// order, so a completion-ordered result would look different from a sorted one.
const TIED_UPDATED_AT = "2026-09-18T08:00:00.000Z";
const entries = [
  { id: "ppt-zulu", delayMs: 20 },
  { id: "ppt-alpha", delayMs: 260 },
  { id: "ppt-broken-b", delayMs: 320 },
  { id: "ppt-mike", delayMs: 140 },
  { id: "ppt-broken-a", delayMs: 90 },
] as const;
const unreadable = new Set(["ppt-broken-a", "ppt-broken-b"]);

test("app_list_my_work orders tied timestamps deterministically by workspace_id", { timeout: 20_000 }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-my-work-order-"));

  const metaServer = createServer(async (request, response) => {
    const workspaceId = request.url?.split("/").at(-1) ?? "";
    const entry = entries.find((item) => item.id === workspaceId);
    if (!entry || unreadable.has(workspaceId)) {
      response.writeHead(404).end();
      return;
    }
    await sleep(entry.delayMs);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200).end(JSON.stringify({
      updated_at: TIED_UPDATED_AT,
      status: "synced",
      current_snapshot: { revision: "1", aps_path: `workspaces/${workspaceId}/snapshots/1.zip` },
    }));
  });
  await new Promise<void>((resolve) => metaServer.listen(0, "127.0.0.1", resolve));
  const address = metaServer.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, ["example_plugin.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, HOME: homeDir, ANNA_WORKSPACE_DIR: path.join(homeDir, "anna-workspace") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const downloadOrder: string[] = [];
  let response: RpcMessage | null = null;

  const result = new Promise<RpcMessage>((resolve) => {
    lines.on("line", async (line) => {
      let message = JSON.parse(line) as RpcMessage;
      const transportPath = message.__file_transport ?? message.__trans_file__;
      if (transportPath) message = JSON.parse(await readFile(transportPath, "utf8")) as RpcMessage;

      if (!message.method) {
        response = message;
        resolve(message);
        return;
      }

      if (message.method === "files/list") {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { entries: entries.map((item) => ({ path: `workspaces/${item.id}/meta.json` })), next_cursor: null },
        })}\n`);
        return;
      }

      assert.equal(message.method, "files/download_url");
      const apsPath = String(message.params?.path ?? "");
      const workspaceId = apsPath.split("/")[1];
      downloadOrder.push(workspaceId);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { get_url: `http://127.0.0.1:${address.port}/meta/${workspaceId}` },
      })}\n`);
    });
  });

  try {
    child.stdin.write(`${JSON.stringify(await encodeToolRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "invoke",
      params: { tool: "app_list_my_work", arguments: {} },
    }))}\n`);
    await result;
    response = await decodeToolResponse(response);

    assert.ok(!response?.error, String(response?.error));
    const workspaces = ((response?.result as { data?: { workspaces?: Array<Record<string, unknown>> } } | undefined)
      ?.data?.workspaces) ?? [];
    assert.deepEqual(workspaces.map((workspace) => workspace.workspace_id), [
      "ppt-alpha",
      "ppt-mike",
      "ppt-zulu",
      "ppt-broken-a",
      "ppt-broken-b",
    ]);

    // The unreadable Workspaces keep their card and report why they degraded.
    const broken = workspaces.filter((workspace) => String(workspace.workspace_id).startsWith("ppt-broken-"));
    assert.equal(broken.length, 2);
    for (const workspace of broken) assert.equal(typeof workspace.meta_error, "string");
    for (const workspace of workspaces.slice(0, 3)) assert.equal(workspace.meta_updated_at, TIED_UPDATED_AT);

    // Every Workspace is still read, and the reads overlap instead of queueing.
    assert.deepEqual([...downloadOrder].sort(), entries.map((item) => item.id).sort());
  } finally {
    lines.close();
    child.kill("SIGTERM");
    metaServer.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
