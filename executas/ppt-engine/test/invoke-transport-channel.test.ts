import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInvokeTransportChannel } from "../invoke-transport-server.js";
import { INVOKE_CHUNK_BYTES, base64ToBytes, bytesToBase64 } from "../invoke-transport.js";
import { bindInvoke, getCurrentInvokeId } from "../invoke-context.js";
import { relayHostUpload, readInvokeUploadThroughEngine } from "../../../src/runtime/invokeTransportChannel.ts";

test("CORS relay uses bounded ordered chunks, cleans staging and retains the finish invoke context", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-invoke-test-"));
  const bytes = new Uint8Array(4 * 1024 * 1024 + 17).fill(127);
  let uploads = 0;
  const ref = { transport: "host_upload", r2_key: "test", url: "https://storage.test/file", mime_type: "application/json", size_bytes: bytes.length };
  const channel = createInvokeTransportChannel({ directory,
    uploadFile: async ({ filePath }: any) => {
      uploads++;
      assert.equal(getCurrentInvokeId(), "finish-context");
      assert.deepEqual(new Uint8Array(await readFile(filePath)), bytes);
      return ref;
    }, download: async () => bytes,
  });
  const actions: string[] = [];
  const runtime = { tools: { invoke: async (input: any) => {
    assert.equal(input.method, "app_invoke_transport_channel");
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < 3 * 1024 * 1024);
    actions.push(input.args.action);
    return bindInvoke(input.args.action === "finish" ? "finish-context" : "other-context", async () => ({ success: true, data: await channel.handle(input.args) }));
  } } } as any;
  try {
    assert.deepEqual(await relayHostUpload(runtime, "engine", new File([bytes], "test.json"), { filename: "test.json", mimeType: "application/json", purpose: "user_artifact" }), ref);
    assert.equal(uploads, 1);
    assert.ok(actions.filter((action) => action === "append").length > 1);
    assert.deepEqual(await readInvokeUploadThroughEngine(runtime, "engine", ref as any), bytes);
    assert.deepEqual(await readdir(directory), []);
    const { transfer_id } = await channel.handle({ action: "begin", filename: "bad.json", mime_type: "application/json", purpose: "user_artifact", size_bytes: 10 });
    await assert.rejects(channel.handle({ action: "append", transfer_id, offset: 1, content: bytesToBase64(new Uint8Array(2)) }), /offset/);
    await assert.rejects(channel.handle({ action: "finish", transfer_id }), /incomplete/);
    await assert.rejects(channel.handle({ action: "append", transfer_id, offset: 0, content: bytesToBase64(new Uint8Array(INVOKE_CHUNK_BYTES + 1)) }), /Base64|limit/);
    assert.equal(base64ToBytes("5Lit").length, 3);
  } finally { await channel.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed uploads and expired transfers release temporary files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppt-invoke-cleanup-"));
  let now = 0;
  const channel = createInvokeTransportChannel({ directory, now: () => now,
    uploadFile: async () => { throw new Error("permission denied"); },
  });
  const begin = () => channel.handle({ action: "begin", filename: "test.json", mime_type: "application/json", purpose: "user_artifact", size_bytes: 2 });
  try {
    const { transfer_id } = await begin();
    await channel.handle({ action: "append", transfer_id, offset: 0, content: bytesToBase64(new Uint8Array(2)) });
    await assert.rejects(channel.handle({ action: "finish", transfer_id }), /permission denied/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(channel.handle({ action: "read", transfer_id, offset: 0 }), /expired/);
    const expired = await begin();
    now = 11 * 60_000;
    await assert.rejects(channel.handle({ action: "append", transfer_id: expired.transfer_id, offset: 0, content: "e30=" }), /expired/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await channel.close(); await rm(directory, { recursive: true, force: true }); }
});
