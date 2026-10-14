import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInvokeTransport } from "../../../src/runtime/invokeTransport.ts";

/** Regression for the "executa process exited" root cause: concurrent invokes
 *  used to interleave at the byte level in process.stdout.write, corrupting
 *  JSON-RPC frames and getting the plugin killed by the host. Every frame now
 *  passes through a single serialized write chain; this test fires concurrent
 *  invokes with large responses and asserts each response arrives intact. */
test("concurrent invokes with large responses keep every frame intact", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-stdio-concurrency-"));
  const child = spawn(process.execPath, ["app_stdio.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, HOME: directory, ANNA_WORKSPACE_DIR: path.join(directory, "workspaces") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let exited = false;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const exitEvent = once(child, "exit").then(() => { exited = true; });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  const send = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const fail = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on("error", fail);
  lines.on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch (error) { fail(error as Error); return; }
    const item = pending.get(message.id);
    if (!item) return; // host/uploadFile or stray frame
    pending.delete(message.id);
    if (message.error) item.reject(Object.assign(new Error(message.error.message), message.error));
    else item.resolve(message.result);
  });
  t.after(async () => {
    lines.close();
    child.kill("SIGTERM");
    await exitEvent;
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("no uploads expected in this test"); });
  const request = (method: string, params?: object) => {
    const id = nextId++;
    const result = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
    send({ jsonrpc: "2.0", id, method, params });
    return result;
  };
  const runtime = { tools: { invoke: async (input: any) =>
    request("invoke", { tool: input.method, arguments: input.args, context: { invoke_id: `invoke-${nextId}` } }) } } as any;
  const invoke = createInvokeTransport(runtime);
  await request("initialize", { protocolVersion: "2.0" });
  const { workspace_dir } = await invoke<any>("engine", "app_create_workspace", { title: "Concurrency" });

  // Two distinct large payloads so interleaving would produce visibly wrong content.
  const payloadA = "A".repeat(1024 * 1024) + "-alpha";
  const payloadB = "B".repeat(1024 * 1024) + "-bravo";
  await invoke("engine", "app_commit_visual_rhythm", { workspace_dir, content: payloadA });
  await writeFile(path.join(workspace_dir, "visual-rhythm.md"), payloadB);

  const burst = await Promise.all([
    ...Array.from({ length: 6 }, () => invoke<any>("engine", "app_get_visual_rhythm", { workspace_dir })),
    invoke<any>("engine", "app_list_workspaces", {}),
    invoke<any>("engine", "app_get_workspace_defaults", {}),
  ]);
  const rhythms = burst.slice(0, 6).map((result) => result.content);
  assert.ok(rhythms.every((content) => content === payloadB),
    "every concurrent large response must be byte-identical - interleaved writes would corrupt frames");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(exited, false, `engine must survive the burst (stderr: ${stderr.slice(-400)})`);
});

test("example_plugin has a single serialized stdout writer", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../example_plugin.js", import.meta.url)), "utf8");
  const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  const writes = code.match(/process\.stdout\.write/g) ?? [];
  assert.equal(writes.length, 1, "all plugin output must flow through the one serialized writeStdoutLine");
  assert.ok(code.includes("let stdoutWriteChain = Promise.resolve()"),
    "writeStdoutLine must serialize frames through a promise chain");
});
