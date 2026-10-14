import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInvokeTransport } from "../../../src/runtime/invokeTransport.ts";
import { INVOKE_INLINE_BYTES, INVOKE_TRANSPORT_TOOL } from "../invoke-transport.js";

test("real stdio enforces the gateway and carries large responses, gzip and upload retries", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-invoke-stdio-"));
  const uploaded = new Map<string, Buffer>();
  const uploadServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    uploaded.set(request.url!.slice(1), Buffer.concat(chunks));
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
  const address = uploadServer.address();
  assert.ok(address && typeof address === "object");
  const child = spawn(process.execPath, ["app_stdio.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, HOME: directory, ANNA_WORKSPACE_DIR: path.join(directory, "workspaces") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let negotiateCount = 0;
  let retryNextConfirm = false;
  const hostCalls: Array<{ mode: string; invokeId: string; key: string }> = [];
  const wireResponses: any[] = [];
  const send = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const fail = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on("error", fail);
  child.on("exit", () => fail(new Error(`Engine exited: ${stderr}`)));
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.method === "host/uploadFile") {
        const { mode, context, r2_key } = message.params;
        const key = mode === "negotiate" ? `upload-${++negotiateCount}.json` : r2_key;
        hostCalls.push({ mode, invokeId: context?.invoke_id, key });
        if (mode === "confirm" && retryNextConfirm) {
          retryNextConfirm = false;
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32208, message: "temporary confirmation failure" } });
          return;
        }
        const result = mode === "negotiate"
          ? { put_url: `http://127.0.0.1:${address.port}/${key}`, r2_key: key, headers: {} }
          : { url: `https://upload.test/${key}`, r2_key: key, bytes: uploaded.get(key)?.length, expires_in: 1800 };
        send({ jsonrpc: "2.0", id: message.id, result });
        return;
      }
      assert.equal(message.__file_transport, undefined, "stdio must resolve legacy pointers and pass new frames directly");
      assert.ok(Buffer.byteLength(line) <= INVOKE_INLINE_BYTES, "every actual stdout response stays within 3 MiB");
      wireResponses.push(message);
      const item = pending.get(message.id);
      assert.ok(item, `unexpected response id: ${message.id}`);
      pending.delete(message.id);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), message.error));
      else item.resolve(message.result);
    } catch (error) { fail(error as Error); }
  });
  t.after(async () => {
    lines.close();
    child.kill("SIGTERM");
    await exited;
    uploadServer.closeAllConnections();
    await new Promise<void>((resolve) => uploadServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const bytes = uploaded.get(new URL(String(input)).pathname.slice(1));
    assert.ok(bytes, `missing uploaded result ${input}`);
    return new Response(bytes);
  });
  const request = (method: string, params?: object) => {
    const id = nextId++;
    const result = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ jsonrpc: "2.0", id, method, params });
    return result;
  };
  const requests: any[] = [];
  const runtime = { tools: { invoke: async (input: any) => {
    requests.push(input);
    return request("invoke", { tool: input.method, arguments: input.args, context: { invoke_id: `invoke-${nextId}` } });
  } } } as any;
  const invoke = createInvokeTransport(runtime);
  await request("initialize", { protocolVersion: "2.0" });
  const workspace = await invoke<any>("engine", "app_create_workspace", { title: "Invoke integration" });
  const workspace_dir = workspace.workspace_dir as string;
  assert.ok(workspace_dir.startsWith(directory));
  for (const [content, encoding] of [["x".repeat(2 * 1024 * 1024), "json"], ['中文😀"\\\n'.repeat(400_000), "gzip-base64"]]) {
    await invoke("engine", "app_commit_visual_rhythm", { workspace_dir, content });
    assert.equal(requests.at(-1).args.payload.encoding, encoding);
    const result = await invoke<any>("engine", "app_get_visual_rhythm", { workspace_dir });
    assert.equal(result.content, content);
    const response = wireResponses.at(-1);
    assert.equal(response.result.data.encoding, encoding);
    if (encoding === "json") assert.ok(Buffer.byteLength(JSON.stringify(response)) > 1024 * 1024);
  }
  assert.equal(hostCalls.length, 0, "small and compressible business content never uploads");

  const large = randomBytes(3 * 1024 * 1024).toString("base64");
  await writeFile(path.join(workspace_dir, "visual-rhythm.md"), large);
  retryNextConfirm = true;
  const expectedInvokeId = `invoke-${nextId}`;
  const before = requests.length;
  assert.equal((await invoke<any>("engine", "app_get_visual_rhythm", { workspace_dir })).content, large);
  assert.equal(requests.length, before + 1, "upload retries must not execute the business tool twice");
  assert.equal(wireResponses.at(-1).result.data.encoding, "upload");
  assert.deepEqual(hostCalls.map((call) => call.mode), ["negotiate", "confirm", "negotiate", "confirm"]);
  assert.ok(hostCalls.every((call) => call.invokeId === expectedInvokeId));
  assert.notEqual(hostCalls[0].key, hostCalls[2].key, "confirmation retry negotiates a fresh upload key");

  hostCalls.length = 0;
  const beforeFiles = await readdir(path.dirname(workspace_dir));
  const [ordinary] = await Promise.all([
    invoke<any>("engine", "app_open_workspace", { workspace_dir }),
    assert.rejects(request("invoke", { tool: "app_create_workspace", arguments: { title: "Must not create", async: true, cwd: workspace_dir }, context: { invoke_id: "bypass", async: true } }), { code: -32601 }),
  ]);
  assert.equal(ordinary.workspace_dir, workspace_dir);
  assert.equal(ordinary.workspace_upload, undefined);
  assert.deepEqual(await readdir(path.dirname(workspace_dir)), beforeFiles, "rejected direct calls must have no business side effects");
  await assert.rejects(stat(path.join(workspace_dir, ".executa-file-transport")), { code: "ENOENT" });
  assert.equal(hostCalls.length, 0);
  const described = await request("describe");
  assert.deepEqual(described.tools.map((tool: any) => tool.name).sort(), [
    "app_invoke_transport", "app_invoke_transport_channel", "app_run_export_artifact_publish", "app_run_pdf_export",
  ]);
  const project_dir = path.join(directory, "task-project");
  await assert.rejects(request("invoke", { tool: "create_task_project", arguments: { project_dir, title: "Blocked" } }), { code: -32601 });
  await assert.rejects(stat(project_dir), { code: "ENOENT" });
  await invoke("engine", "create_task_project", { project_dir, title: "Gateway task" });
  assert.ok((await stat(project_dir)).isDirectory());
  for (const tool of [
    "app_resolve_host_upload_json_reference", "app_resolve_host_upload_text_reference", "app_upload_host_file_fallback",
    "app_commit_workspace_style_guide_host_upload", "app_commit_workspace_visual_master_html_host_upload",
    "app_commit_workspace_page_html_host_upload", "app_commit_visual_rhythm_host_upload", "app_commit_page_visual_plan_host_upload",
    "toString", "constructor",
  ]) {
    await assert.rejects(request("invoke", { tool, arguments: {} }), { code: -32601 });
    await assert.rejects(invoke("engine", tool, {}), /Invalid invoke transport target/);
  }
  // These failures are business validation, using the unchanged direct error envelope.
  for (const tool of ["app_run_pdf_export", "app_run_export_artifact_publish"]) {
    await assert.rejects(request("invoke", { tool, arguments: {} }), { code: -32602 });
    await assert.rejects(invoke("engine", tool, {}), /Invalid invoke transport target/);
  }
  await assert.rejects(request("invoke", { tool: "app_run_pptx_export", arguments: {} }), { code: -32601 });
  for (const asset of ["master", "page", "snapshot"]) {
    await assert.rejects(invoke("engine", "app_get_user_template_asset", { id: "unused", asset }), /asset.*must be/);
  }
  await assert.rejects(invoke("engine", INVOKE_TRANSPORT_TOOL, {}), /Invalid invoke transport target/);
  await assert.rejects(invoke("engine", "app_invoke_transport_channel", {}), /Invalid invoke transport target/);
  await assert.rejects(invoke("engine", "unknown_tool", {}), /Invalid invoke transport target/);
  await assert.rejects(invoke("engine", "app_commit_visual_rhythm", { workspace_dir, content: "" }), /Content exceeds/);
  await assert.rejects(runtime.tools.invoke({ method: INVOKE_TRANSPORT_TOOL, args: { tool: "app_get_visual_rhythm", payload: { version: 2 } } }), /version or size/);
});
