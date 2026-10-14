/**
 * batch-writer-client.js — thin adapter over the bundled `batch-writer` Executa.
 *
 * The iframe cannot write local files, so batch output goes out over
 * `tools.invoke` to a local Executa process. This module only resolves the
 * tool_id and unwraps the reply; all path rules live in the Executa (which is
 * the process that actually touches the filesystem) and in batch-runner.js.
 */

// The manifest references the stable handle `bundled:batch-writer`. `anna-app
// dev` and `anna-app apps publish` both resolve it to a concrete tool_id in
// `bundle/anna-tool-ids.js`; the fallback below is only for a dev run without
// that sidecar and must match executas/batch-writer/executa.json "tool_id".
const DEV_FALLBACK_TOOL_ID = "tool-test-batch-writer-b1a2c3d4";

export function batchWriterToolId() {
  return (typeof window !== "undefined"
    && window.__ANNA_TOOL_IDS__
    && window.__ANNA_TOOL_IDS__["batch-writer"])
    || DEV_FALLBACK_TOOL_ID;
}

export function canUseBatchWriter(runtime) {
  return typeof runtime?.tools?.invoke === "function";
}

// Hosts that pass the Executa reply through verbatim wrap it as
// `{ tool, data }`; hosts that already unwrap hand back the payload itself.
function unwrapToolReply(reply) {
  if (reply && typeof reply === "object" && reply.data && reply.tool) return reply.data;
  return reply ?? {};
}

async function invokeBatchWriter(runtime, method, args) {
  if (!canUseBatchWriter(runtime)) {
    throw new Error("当前 Runtime 不提供 tools.invoke，无法写入输出文件。请通过 anna-app dev 打开。");
  }
  return unwrapToolReply(await runtime.tools.invoke({ tool_id: batchWriterToolId(), method, args }));
}

/** Validates and creates the output directory once, before any session is created. */
export async function ensureOutputDir(runtime, dir) {
  const result = await invokeBatchWriter(runtime, "ensure_output_dir", { dir });
  if (!result?.ok) throw new Error(`输出目录准备失败：${JSON.stringify(result)}`);
  return result;
}

/** Writes one result file; returns the absolute path the Executa actually wrote. */
export async function writeOutputFile(runtime, { dir, filename, content }) {
  const result = await invokeBatchWriter(runtime, "write_text_file", { dir, filename, content });
  if (!result?.ok || !result?.path) throw new Error(`写入输出文件失败：${JSON.stringify(result)}`);
  return result;
}
