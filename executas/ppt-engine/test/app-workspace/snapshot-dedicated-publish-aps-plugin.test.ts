import { encodeToolRequest, decodeToolResponse } from "../helpers/invoke.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("dedicated snapshot invokes upload through the established queue and retain their invoke context", { timeout: 20_000 }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "ppt-engine-dedicated-snapshot-"));
  const workspaceRoot = path.join(homeDir, "slideforge-workspace");
  const previousHome = process.env.HOME;
  const previousWorkspaceRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  process.env.HOME = homeDir;
  process.env.SLIDEFORGE_WORKSPACE_DIR = workspaceRoot;
  // Exercise the same compiled engine module loaded by example_plugin.js;
  // source TypeScript is not directly executable in a production plugin test.
  const { createAppWorkspace } = await import("../../dist/index.js");
  const created = await createAppWorkspace({ title: "Dedicated upload" });
  const workspaceDir = created.workspace_dir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousWorkspaceRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
  else process.env.SLIDEFORGE_WORKSPACE_DIR = previousWorkspaceRoot;

  const uploads = new Map<string, Buffer>();
  const uploadServer = createServer(async (request, response) => {
    const key = decodeURIComponent((request.url ?? "/").split("/").at(-1) ?? "");
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      uploads.set(key, Buffer.concat(chunks));
      response.setHeader("ETag", '"put-etag"');
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET" && uploads.has(key)) {
      response.writeHead(200, { "Content-Type": "application/zip" }).end(uploads.get(key));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
  const address = uploadServer.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, ["example_plugin.js"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, HOME: homeDir, SLIDEFORGE_WORKSPACE_DIR: workspaceRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const apsCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let nextId = 1;
  lines.on("line", async (line) => {
    let message = JSON.parse(line) as Record<string, unknown>;
    const transportPath = message.__file_transport ?? message.__trans_file__;
    if (typeof transportPath === "string") message = JSON.parse(await readFile(transportPath, "utf8")) as Record<string, unknown>;
    if (typeof message.method === "string") {
      const method = message.method;
      const params = message.params as Record<string, unknown> | undefined;
      if (method.startsWith("files/")) apsCalls.push({ method, params });
      let result: Record<string, unknown> = {};
      if (method === "files/upload_begin") {
        const apsPath = String(params?.path ?? "");
        result = { put_url: `http://127.0.0.1:${address.port}/put/${encodeURIComponent(apsPath)}`, headers: {} };
      } else if (method === "files/upload_complete") result = { etag: "aps-etag", size_bytes: 1 };
      else if (method === "files/download_url") {
        const apsPath = String(params?.path ?? "");
        result = { url: `http://127.0.0.1:${address.port}/download/${encodeURIComponent(apsPath)}` };
      } else if (method === "files/list") result = { entries: [] };
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      return;
    }
    if (typeof message.id === "number") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = async (params: Record<string, unknown>) => {
    const id = nextId++;
    const response = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify(await encodeToolRequest({ jsonrpc: "2.0", id, method: "invoke", params }))}\n`);
    return response.then(decodeToolResponse);
  };
  try {
    const [first, second] = await Promise.all([
      request({ tool: "app_run_workspace_snapshot_publish_dedicated_invoke", arguments: { workspace_dir: workspaceDir, trigger: "test-first" }, context: { invoke_id: "dedicated-invoke-first" } }),
      request({ tool: "app_run_workspace_snapshot_publish_dedicated_invoke", arguments: { workspace_dir: workspaceDir, trigger: "test-second" }, context: { invoke_id: "dedicated-invoke-second" } }),
    ]);
    for (const response of [first, second]) assert.equal((response.result as { data?: { status?: unknown } })?.data?.status, "completed", JSON.stringify(response));
    assert.equal(uploads.size, 2, "one snapshot zip and one meta.json should be uploaded");
    // Both invokes await asynchronous lifecycle logs before claiming the
    // shared publisher, so either request can own the upload context.
    const uploadInvokeIds = new Set(apsCalls.map((call) =>
      (call.params?.context as { invoke_id?: string } | undefined)?.invoke_id,
    ));
    assert.equal(uploadInvokeIds.size, 1, "all APS calls must retain the shared publisher's invoke context");
    assert.ok(uploadInvokeIds.has("dedicated-invoke-first") || uploadInvokeIds.has("dedicated-invoke-second"));
    const logRows = (await readFile(path.join(workspaceDir, ".log", "storage-transport.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.source === "ppt-engine.workspace-snapshot-publish-dedicated-invoke");
    assert.equal(logRows.filter((entry) => entry.event === "snapshot.publish-dedicated-invoke.started").length, 2);
    const finished = logRows.filter((entry) => entry.event === "snapshot.publish-dedicated-invoke.finished");
    assert.equal(finished.length, 2);
    assert.equal(finished.every((entry) => entry.status === "completed" && entry.invoke_released === true), true);
    assert.equal(logRows.every((entry) => entry.invoke_id === "dedicated-invoke-first" || entry.invoke_id === "dedicated-invoke-second"), true);
    assert.equal(logRows.every((entry) => typeof entry.reuses_dedicated_publisher === "boolean"), true);
    assert.equal(finished.every((entry) => entry.publish_status === "completed" && typeof entry.publish_job_id === "string" && typeof entry.published_revision === "string"), true);
    // Log appends are asynchronous, so completion rows are not guaranteed to
    // be ordered by the moment each invoke released. The lifecycle is clean
    // when at least one terminal row observes the shared active set at zero.
    assert.equal(finished.some((entry) => entry.active_dedicated_invoke_count === 0), true);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    uploadServer.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
