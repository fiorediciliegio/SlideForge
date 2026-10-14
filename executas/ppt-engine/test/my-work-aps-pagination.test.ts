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

test("app_list_my_work follows every APS Files list page", { timeout: 20_000 }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-my-work-pagination-"));
  const metaByWorkspace = {
    "ppt-first": { updated_at: "2026-09-18T08:00:00.000Z", status: "synced", current_snapshot: { revision: "1", aps_path: "workspaces/ppt-first/snapshots/1.zip" } },
    "ppt-second": { updated_at: "2026-09-18T08:01:00.000Z", status: "synced", current_snapshot: { revision: "2", aps_path: "workspaces/ppt-second/snapshots/2.zip" } },
    "ppt-later-page": { updated_at: "2026-09-18T08:02:00.000Z", status: "synced", current_snapshot: { revision: "3", aps_path: "workspaces/ppt-later-page/snapshots/3.zip" } },
  } as const;

  const metaServer = createServer((request, response) => {
    const workspaceId = request.url?.split("/").at(-1) ?? "";
    const meta = metaByWorkspace[workspaceId as keyof typeof metaByWorkspace];
    if (!meta) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200).end(JSON.stringify(meta));
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
  const listCursors: Array<string | null> = [];
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
        const cursor = typeof message.params?.cursor === "string" ? message.params.cursor : null;
        listCursors.push(cursor);
        const page = cursor === null
          ? {
              entries: [
                { path: "workspaces/ppt-first/meta.json" },
                { path: "workspaces/ppt-second/snapshots/2.zip" },
              ],
              next_cursor: "page-2",
            }
          : {
              entries: [{ path: "workspaces/ppt-later-page/meta.json" }],
              next_cursor: null,
            };
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: page })}\n`);
        return;
      }

      assert.equal(message.method, "files/download_url");
      const apsPath = String(message.params?.path ?? "");
      const workspaceId = apsPath.split("/")[1];
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

    assert.deepEqual(listCursors, [null, "page-2"]);
    assert.ok(!response?.error, String(response?.error));
    const workspaces = (response?.result as { data?: { workspaces?: Array<{ workspace_id: string }> } } | undefined)
      ?.data?.workspaces ?? [];
    assert.deepEqual(workspaces.map((workspace) => workspace.workspace_id), [
      "ppt-later-page",
      "ppt-second",
      "ppt-first",
    ]);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    metaServer.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
