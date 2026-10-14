import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { directoryPrefix, validateItem } from "../../src/cleanup.js";

const manifest = JSON.parse(readFileSync(new URL("manifest.json", import.meta.url), "utf8"));
const pending = new Map();
let sequence = 0;
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);

function hostCall(method, params, context) {
  // Local ExecutaPool invokes directly without initialize; the host enforces APS grants.
  const id = `aps-cleanup-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("APS 请求超时；如为删除请求，结果可能已生效，请重新扫描核实。"));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    send({ jsonrpc: "2.0", id, method, params: { ...params, context } });
  });
}

async function invoke(params) {
  const args = params.arguments ?? {};
  const prefix = directoryPrefix(args.directory);
  const context = { ...(params.context ?? {}), ...(params.invoke_id ? { invoke_id: params.invoke_id } : {}) };
  if (params.tool === "list_directory") {
    if (args.cursor != null && typeof args.cursor !== "string") throw new Error("cursor 必须为字符串。");
    const page = await hostCall("files/list", { scope: "user", prefix, limit: 50, ...(args.cursor ? { cursor: args.cursor } : {}) }, context);
    if (!Array.isArray(page?.items)) throw new Error("APS 文件列表格式无效。");
    return { items: page.items.map(item => validateItem(item, prefix)), next_cursor: page.next_cursor ?? null };
  }
  if (params.tool === "delete_file") {
    if (args.confirmation !== prefix) throw new Error("确认目录与目标目录不一致。");
    const item = validateItem({ path: args.path, etag: args.etag }, prefix);
    return hostCall("files/delete", { scope: "user", path: item.path, if_match: item.etag }, context);
  }
  throw new Error(`Unknown tool: ${params.tool}`);
}

async function handle(frame) {
  if (!frame.method) {
    const request = pending.get(frame.id);
    if (request) {
      clearTimeout(request.timeout);
      pending.delete(frame.id);
      if (frame.error) request.reject(new Error(frame.error.message || "APS 请求失败"));
      else request.resolve(frame.result);
    }
    return;
  }
  if (frame.id == null) return;
  try {
    let result;
    switch (frame.method) {
      case "initialize":
        result = { protocolVersion: "2.0", serverInfo: { name: manifest.display_name, version: manifest.version }, capabilities: { storage: {} } };
        break;
      case "describe": result = manifest; break;
      case "health": result = { status: "healthy" }; break;
      case "invoke": result = { success: true, data: await invoke(frame.params ?? {}), tool: frame.params?.tool }; break;
      case "shutdown": result = {}; break;
      default: throw new Error(`Unknown method: ${frame.method}`);
    }
    send({ jsonrpc: "2.0", id: frame.id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: error.message || String(error) } });
  }
}

// Do not await an invoke in the input loop: its reverse-RPC response arrives on stdin.
createInterface({ input: process.stdin }).on("line", line => {
  try { void handle(JSON.parse(line)); }
  catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); }
});
