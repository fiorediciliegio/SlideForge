import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INVOKE_INLINE_BYTES, encodeInvokePayload, decodeInvokePayload, jsonBytes,
  type InvokePayload, type InvokeUpload,
} from "../../executas/ppt-engine/invoke-transport.js";
import { createInvokeTransport } from "../../src/runtime/invokeTransport.ts";
import type { HostRuntime } from "../../src/runtime/hostRuntime.ts";
import { createInvokeTransportChannel } from "../../executas/ppt-engine/invoke-transport-server.js";

const envelope = (payload: InvokePayload) => ({ tool_id: "engine", method: "app_invoke_transport", args: { tool: "save", payload } });
const fits = (frame: InvokePayload) => jsonBytes(envelope(frame)).length <= INVOKE_INLINE_BYTES;
const noUpload = async (): Promise<InvokeUpload> => { throw new Error("must not upload"); };
const noDownload = async (): Promise<Uint8Array<ArrayBuffer>> => { throw new Error("must not download"); };

test("ordinary invoke budgets the exact 3 MiB wire boundary, including metadata", async () => {
  assert.equal(INVOKE_INLINE_BYTES, 3_145_728);
  let value = { content: "x".repeat(INVOKE_INLINE_BYTES - 200) };
  for (let i = 0; i < 3; i++) {
    const frame = await encodeInvokePayload(value, { fits: () => true, upload: noUpload });
    value.content += "x".repeat(Math.max(0, INVOKE_INLINE_BYTES - jsonBytes(envelope(frame)).length));
  }
  const plain = await encodeInvokePayload(value, { fits, upload: noUpload });
  assert.equal(plain.encoding, "json");
  assert.equal(jsonBytes(envelope(plain)).length, INVOKE_INLINE_BYTES);
  const zipped = await encodeInvokePayload({ content: value.content + "x" }, { fits, upload: noUpload });
  assert.equal(zipped.encoding, "gzip-base64");
  assert.deepEqual(await decodeInvokePayload(zipped, { download: noDownload }), { content: value.content + "x" });
});

test("UTF-8, JSON escaping, gzip and incompressible uploads round-trip without business fields", async () => {
  const stored = new Map<string, Uint8Array<ArrayBuffer>>();
  const upload = async (bytes: Uint8Array<ArrayBuffer>): Promise<InvokeUpload> => {
    stored.set("payload", bytes);
    return { transport: "host_upload", r2_key: "payload", url: "https://storage.test/payload", mime_type: "application/json", size_bytes: bytes.length };
  };
  for (const [value, encoding] of [
    [{ value: '中文😀"\\\n', empty: null }, "json"],
    [{ value: '中文😀"\\\n'.repeat(350_000) }, "gzip-base64"],
    [{ value: randomBytes(3 * 1024 * 1024).toString("base64") }, "upload"],
  ] as const) {
    const frame = await encodeInvokePayload(value, { fits, upload });
    assert.equal(frame.encoding, encoding);
    assert.ok(fits(frame));
    assert.deepEqual(await decodeInvokePayload(frame, { download: async () => stored.get("payload")! }), value);
  }
});

test("decoder rejects wrong versions, truncated downloads and decompression beyond declared size", async () => {
  const frame = await encodeInvokePayload({ value: "中".repeat(2_000_000) }, { fits, upload: noUpload });
  await assert.rejects(decodeInvokePayload({ ...frame, version: 2 } as never, { download: noDownload }), /version/);
  await assert.rejects(decodeInvokePayload({ ...frame, original_size_bytes: 10 }, { download: noDownload }), /declared size/);
  await assert.rejects(decodeInvokePayload({ ...frame, content: "%%%=" } as never, { download: noDownload }), /Base64/);
  await assert.rejects(decodeInvokePayload({ ...frame, original_size_bytes: 128 * 1024 * 1024 + 1 }, { download: noDownload }), /version or size/);
  await assert.rejects(decodeInvokePayload({ version: 1, encoding: "upload", original_size_bytes: 10,
    upload: { transport: "host_upload", r2_key: "x", url: "http://storage.test/x", mime_type: "application/json", size_bytes: 10 } },
  { download: noDownload }), /Invalid invoke upload/);
  await assert.rejects(decodeInvokePayload({ version: 1, encoding: "upload", original_size_bytes: 10,
    upload: { transport: "host_upload", r2_key: "x", url: "https://storage.test/x", mime_type: "application/json", size_bytes: 10 } },
  { download: async () => new Uint8Array(5) }), /size mismatch/);
});

for (const cors of [false, true]) {
  test(`large ordinary requests and responses round-trip with ${cors ? "CORS chunk relay" : "fresh-key upload and download retries"}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-invoke-browser-"));
    const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __BUNDLED_TOOL_IDS__: { "ppt-engine": "engine" } } });
    const stored = new Map<string, Uint8Array<ArrayBuffer>>();
    let sequence = 0;
    let confirmations = 0;
    let downloads = 0;
    let businessCalls = 0;
    const actions: string[] = [];
    const reference = (key: string): InvokeUpload => ({ transport: "host_upload", r2_key: key,
      url: `https://storage.test/${key}`, mime_type: "application/json", size_bytes: stored.get(key)!.length });
    const store = async (bytes: Uint8Array<ArrayBuffer>) => {
      const key = `payload-${++sequence}`;
      stored.set(key, bytes);
      return reference(key);
    };
    const channel = createInvokeTransportChannel({ directory,
      uploadFile: async ({ filePath }: { filePath: string }) => store(new Uint8Array(await readFile(filePath))),
      download: async (ref: InvokeUpload) => stored.get(ref.r2_key)!,
    });
    t.after(async () => {
      await channel.close();
      await rm(directory, { recursive: true, force: true });
      if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore);
      else Reflect.deleteProperty(globalThis, "window");
    });
    t.mock.method(globalThis, "fetch", async (input: any, init?: RequestInit) => {
      if (cors) throw new TypeError("Failed to fetch");
      const key = new URL(String(input)).pathname.slice(1);
      if (init?.method === "PUT") {
        stored.set(key, new Uint8Array(await (init.body as File).arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (++downloads === 1) return new Response("temporarily unavailable", { status: 503 });
      return new Response(stored.get(key)!);
    });
    const runtime = { tools: { invoke: async (input: any) => {
      assert.ok(jsonBytes(input).length <= INVOKE_INLINE_BYTES);
      if (input.method === "app_invoke_transport_channel") {
        actions.push(input.args.action);
        return { success: true, data: await channel.handle(input.args) };
      }
      assert.equal(input.method, "app_invoke_transport");
      assert.equal(input.args.payload.encoding, "upload");
      const args = await decodeInvokePayload(input.args.payload, { download: async (ref) => stored.get(ref.r2_key)! });
      businessCalls++;
      return { success: true, data: await encodeInvokePayload({ result: { success: true, data: args } }, { fits, upload: store }) };
    } }, upload: {
      negotiate: async () => { const key = `request-${++sequence}`; return { put_url: `https://storage.test/${key}`, r2_key: key, headers: {} }; },
      confirm: async ({ r2_key }: { r2_key: string }) => {
        if (++confirmations === 1) throw Object.assign(new Error("temporary confirmation failure"), { code: -32208 });
        return { download_url: reference(r2_key).url, r2_key, size_bytes: stored.get(r2_key)!.length };
      },
    } } as unknown as HostRuntime;
    const value = { html: randomBytes(3 * 1024 * 1024).toString("base64"), base_revision: 7, workspace_dir: "/workspace/中文" };
    assert.deepEqual(await createInvokeTransport(runtime)("engine", "save", value), value);
    assert.equal(businessCalls, 1);
    if (cors) {
      for (const action of ["begin", "append", "finish", "download", "read", "release"]) assert.ok(actions.includes(action), action);
      assert.ok(actions.filter((action) => action === "append").length > 12);
      assert.ok(actions.filter((action) => action === "read").length > 12);
      assert.equal(confirmations, 0);
    } else {
      assert.equal(confirmations, 2);
      assert.equal(downloads, 2);
      assert.equal(actions.length, 0);
      assert.deepEqual(stored.get("request-1"), stored.get("request-2"));
    }
    assert.deepEqual(await readdir(directory), []);
  });
}

test("request and response use the same codec and business errors execute only once", async () => {
  let calls = 0;
  const result = { html: "<p>中文</p>".repeat(400_000) };
  const runtime = { tools: { invoke: async (input: any) => {
    calls++;
    assert.equal(input.method, "app_invoke_transport");
    assert.ok(jsonBytes(input).length <= INVOKE_INLINE_BYTES);
    assert.equal(input.timeoutMs, 12345);
    assert.deepEqual(await decodeInvokePayload(input.args.payload, { download: noDownload }), { content: result.html });
    const outcome = input.args.tool === "fail" ? { error: { code: -32602, message: "invalid content", data: { reason: "test" } } }
      : { result: { success: true, data: result, tool: input.args.tool } };
    return { success: true, data: await encodeInvokePayload(outcome, { fits, upload: noUpload }) };
  } } } as unknown as HostRuntime;
  const invoke = createInvokeTransport(runtime);
  assert.deepEqual(await invoke("engine", "save", { content: result.html }, { timeoutMs: 12345 }), result);
  await assert.rejects(invoke("engine", "fail", { content: result.html }, { timeoutMs: 12345 }), { code: -32602, message: "invalid content" });
  assert.equal(calls, 2);
});
