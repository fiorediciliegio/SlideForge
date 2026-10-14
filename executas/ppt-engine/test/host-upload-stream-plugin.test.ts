import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

// Chunked Host Upload relay (app_*_host_upload_stream) protocol checks against
// the real plugin process. The finalize happy-path needs a live Host Upload
// endpoint, so here we only cover validation, ordering and cleanup behavior.

type JsonRpcResponse = {
  id: string | number | null;
  __trans_file__?: string;
  __file_transport?: string;
  result?: { success?: boolean; data?: Record<string, unknown>; tools?: Array<{ name?: string }> };
  error?: { message?: string };
};

class PluginProcess {
  private nextId = 1;
  private readonly pending = new Map<string | number, (response: JsonRpcResponse) => void>();
  private readonly lines: Interface;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", async (line) => {
      let response = JSON.parse(line) as JsonRpcResponse;
      // Large payloads (e.g. describe) travel via file transport envelopes.
      const transportPath = response.__trans_file__ ?? response.__file_transport;
      if (transportPath) {
        response = JSON.parse(await readFile(transportPath, "utf8")) as JsonRpcResponse;
      }
      const resolve = this.pending.get(response.id ?? "");
      if (resolve) {
        this.pending.delete(response.id ?? "");
        resolve(response);
      }
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async invoke(tool: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    return this.request("invoke", { tool, arguments: args });
  }

  async close() {
    this.lines.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill();
    // Windows cannot deliver POSIX signals to piped children; SIGKILL fallback.
    const grace = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, 3000);
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 4000))]);
    clearTimeout(grace);
  }
}

async function startPlugin(): Promise<PluginProcess> {
  const child = spawn(process.execPath, ["example_plugin.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  return new PluginProcess(child);
}

const STREAM_TOOLS = [
  "app_begin_host_upload_stream",
  "app_append_host_upload_stream",
  "app_finalize_host_upload_stream",
  "app_abort_host_upload_stream",
];

test("describe exposes the chunked upload stream tools", async () => {
  const plugin = await startPlugin();
  try {
    const describe = await plugin.request("describe");
    assert.ok(!describe.error, describe.error?.message);
    const names = describe.result?.tools?.map((tool) => tool.name) ?? [];
    for (const name of STREAM_TOOLS) assert.ok(names.includes(name), `missing tool ${name}`);
  } finally {
    await plugin.close();
  }
});

test("begin validates inputs and append enforces the declared size", async () => {
  const plugin = await startPlugin();
  try {
    const bad = await plugin.invoke("app_begin_host_upload_stream", {
      transfer_id: "t1", filename: "a.pptx", mime_type: "application/octet-stream", size_bytes: 10,
    });
    assert.match(bad.error?.message ?? "", /mime_type/);

    const negative = await plugin.invoke("app_begin_host_upload_stream", {
      transfer_id: "t1", filename: "a.pptx", mime_type: "application/pdf", size_bytes: -1,
    });
    assert.match(negative.error?.message ?? "", /size_bytes/);

    const begun = await plugin.invoke("app_begin_host_upload_stream", {
      transfer_id: "t1", filename: "a.bin", mime_type: "application/pdf", size_bytes: 4,
    });
    assert.equal(begun.error, undefined);
    assert.equal(begun.result?.data?.received, 0);

    const tooBig = await plugin.invoke("app_append_host_upload_stream", {
      transfer_id: "t1", content_base64: Buffer.alloc(8).toString("base64"),
    });
    assert.match(tooBig.error?.message ?? "", /exceed/);

    const unknown = await plugin.invoke("app_append_host_upload_stream", {
      transfer_id: "missing", content_base64: "AAAA",
    });
    assert.match(unknown.error?.message ?? "", /Unknown or expired/);
  } finally {
    await plugin.close();
  }
});

test("finalize rejects an incomplete stream and abort cleans it up", async () => {
  const plugin = await startPlugin();
  try {
    await plugin.invoke("app_begin_host_upload_stream", {
      transfer_id: "t2", filename: "a.bin", mime_type: "application/pdf", size_bytes: 8,
    });
    await plugin.invoke("app_append_host_upload_stream", {
      transfer_id: "t2", content_base64: Buffer.alloc(4).toString("base64"),
    });
    const finalize = await plugin.invoke("app_finalize_host_upload_stream", { transfer_id: "t2" });
    assert.match(finalize.error?.message ?? "", /incomplete/);

    const aborted = await plugin.invoke("app_abort_host_upload_stream", { transfer_id: "t2" });
    assert.equal(aborted.error, undefined);
    const after = await plugin.invoke("app_finalize_host_upload_stream", { transfer_id: "t2" });
    assert.match(after.error?.message ?? "", /Unknown or expired/);
  } finally {
    await plugin.close();
  }
});
