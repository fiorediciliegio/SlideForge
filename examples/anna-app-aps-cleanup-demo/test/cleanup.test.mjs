import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { directoryPrefix, scanDirectory, clearSnapshot } from "../src/cleanup.js";

const file = (path, etag = "v1") => ({ path, etag, size_bytes: 10 });

test("拒绝根目录、路径穿越及歧义路径；始终添加目录分隔符", () => {
  for (const input of ["", "/", "/workspaces", "a//b", "a/../b", "a/./b", "a\\b", "a/ b", "a\u200bb"]) {
    assert.throws(() => directoryPrefix(input));
  }
  assert.equal(directoryPrefix("workspaces"), "workspaces/");
  assert.equal(directoryPrefix("workspaces/ppt-1/"), "workspaces/ppt-1/");
});

test("完整遍历分页，去重，清理时不漏文件也不重新扩大范围", async () => {
  const calls = [];
  const invoke = async (method, args) => {
    calls.push({ method, args });
    if (method === "list_directory") return args.cursor
      ? { items: [file("workspaces/b"), file("workspaces/c")], next_cursor: null }
      : { items: [file("workspaces/a"), file("workspaces/b")], next_cursor: "page2" };
    return { deleted: true };
  };
  const snapshot = await scanDirectory(invoke, "workspaces");
  assert.equal(snapshot.items.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.cursor, "page2");
  await clearSnapshot(invoke, snapshot, "workspaces/");
  assert.deepEqual(calls.slice(2).map(call => call.args.path), ["workspaces/a", "workspaces/b", "workspaces/c"]);
  assert.ok(calls.slice(2).every(call => call.method === "delete_file" && call.args.etag === "v1"));
});

test("部分扫描失败、越界响应、缺失 ETag 和重复游标不能生成预览", async () => {
  let page = 0;
  await assert.rejects(scanDirectory(async () => {
    if (++page === 2) throw new Error("network");
    return { items: [file("workspaces/a")], next_cursor: "next" };
  }, "workspaces"), /network/);
  for (const item of [file("workspaces-old/a"), file("workspaces/p/../a"), file("workspaces/a", "")]) {
    await assert.rejects(scanDirectory(async () => ({ items: [item] }), "workspaces"));
  }
  await assert.rejects(scanDirectory(async () => ({ items: [], next_cursor: "same" }), "workspaces"), /游标重复/);
});

test("删除前完整验证确认和范围，拒绝时不发送任何请求", async () => {
  let calls = 0;
  const invoke = async () => { calls++; return { deleted: true }; };
  await assert.rejects(clearSnapshot(invoke, { prefix: "workspaces/", items: [file("workspaces/a")] }, "workspaces"));
  await assert.rejects(clearSnapshot(invoke, { prefix: "workspaces/", items: [file("workspaces/a"), file("workspaces-other/b")] }, "workspaces/"));
  assert.equal(calls, 0);
});

test("停止允许当前请求结束，后续不删除；错误立即停止且不自动重试", async () => {
  const snapshot = { prefix: "workspaces/", items: [file("workspaces/a"), file("workspaces/b")] };
  let stopped = false;
  const results = await clearSnapshot(async () => { stopped = true; return { deleted: true }; }, snapshot, "workspaces/", { cancelled: () => stopped });
  assert.equal(results.length, 1);
  let calls = 0;
  const failures = await clearSnapshot(async () => { calls++; throw new Error("precondition_failed"); }, snapshot, "workspaces/");
  assert.equal(calls, 1);
  assert.equal(failures[0].ok, false);
  assert.match(failures[0].error, /precondition_failed/);
});

test("兼容实际 APS 删除响应 ok + path，成功后继续后续文件", async () => {
  const snapshot = { prefix: "workspaces/", items: [file("workspaces/a"), file("workspaces/b")] };
  const paths = [];
  const results = await clearSnapshot(async (_method, args) => {
    paths.push(args.path);
    // Matches the successful tools.invoke response captured in debug.log.
    return { ok: true, path: args.path };
  }, snapshot, "workspaces/");
  assert.deepEqual(paths, ["workspaces/a", "workspaces/b"]);
  assert.deepEqual(results, paths.map(path => ({ path, ok: true })));
});

test("空响应、失败响应、非布尔成功标志及路径不符不会被误报为成功", async () => {
  const snapshot = { prefix: "workspaces/", items: [file("workspaces/a"), file("workspaces/b")] };
  for (const response of [
    null, {}, { ok: true }, { ok: false, path: "workspaces/a" },
    { ok: "true", path: "workspaces/a" }, { deleted: "true" },
    { ok: true, path: "workspaces/b" }, { deleted: true, path: "workspaces/b" },
    { deleted: false, ok: true, path: "workspaces/a" }, { deleted: true, ok: false },
  ]) {
    let calls = 0;
    const results = await clearSnapshot(async () => { calls++; return response; }, snapshot, "workspaces/");
    assert.equal(calls, 1, JSON.stringify(response));
    assert.equal(results[0].ok, false, JSON.stringify(response));
  }
});

test("真实 stdio Executa：无需 initialize 的本地调用、user scope、invoke context、if_match 和越界拦截", { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [new URL("../executas/aps-cleanup/plugin.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const waiting = new Map();
  const reverse = [];
  let sequence = 0;
  const send = frame => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const call = (method, params = {}) => new Promise(resolve => {
    const id = ++sequence;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
  createInterface({ input: child.stdout }).on("line", line => {
    const frame = JSON.parse(line);
    if (frame.method) {
      reverse.push(frame);
      send({ jsonrpc: "2.0", id: frame.id, result: frame.method === "files/list" ? { items: [file("workspaces/a")], next_cursor: null } : { ok: true, path: frame.params.path } });
    } else {
      waiting.get(frame.id)?.(frame);
      waiting.delete(frame.id);
    }
  });
  const listed = await call("invoke", { tool: "list_directory", arguments: { directory: "workspaces" }, context: { invoke_id: "test-list" } });
  assert.equal(listed.result.data.items[0].path, "workspaces/a");
  assert.equal(reverse[0].method, "files/list");
  assert.deepEqual(reverse[0].params, { scope: "user", prefix: "workspaces/", limit: 50, context: { invoke_id: "test-list" } });
  const deleted = await call("invoke", { tool: "delete_file", arguments: { directory: "workspaces", confirmation: "workspaces/", path: "workspaces/a", etag: "v1" }, context: { invoke_id: "test-delete" } });
  assert.deepEqual(deleted.result.data, { ok: true, path: "workspaces/a" });
  assert.equal(reverse[1].method, "files/delete");
  assert.deepEqual(reverse[1].params, { scope: "user", path: "workspaces/a", if_match: "v1", context: { invoke_id: "test-delete" } });
  const denied = await call("invoke", { tool: "delete_file", arguments: { directory: "workspaces", confirmation: "workspaces/", path: "workspaces-other/a", etag: "v1" } });
  assert.ok(denied.error);
  assert.equal(reverse.length, 2);
  const initialized = await call("initialize", { protocolVersion: "2.0" });
  assert.deepEqual(initialized.result.capabilities, { storage: {} });
  const described = await call("describe");
  assert.deepEqual(described.result.host_capabilities, ["aps.files"]);
});
