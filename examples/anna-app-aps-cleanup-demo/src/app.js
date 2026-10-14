import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";
import { scanDirectory, clearSnapshot } from "./cleanup.js";

const $ = id => document.getElementById(id);
let anna;
let toolId;
let busy = false;
let stopped = false;
let snapshot = null;
let pageIndex = 0;
const pageSize = 100;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function controls() {
  $("directory").disabled = busy;
  $("scan").disabled = busy || !anna || !toolId;
  $("confirmation").disabled = busy || !snapshot?.items.length;
  $("clear").disabled = busy || !snapshot?.items.length || $("confirmation").value !== snapshot.prefix;
  $("stop").disabled = !busy || stopped;
  $("previous").disabled = busy || pageIndex === 0;
  $("next").disabled = busy || !snapshot || (pageIndex + 1) * pageSize >= snapshot.items.length;
}

function renderFiles() {
  const items = snapshot?.items ?? [];
  $("files").replaceChildren();
  for (const item of items.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize)) {
    const row = document.createElement("tr");
    for (const value of [item.path, formatBytes(item.size_bytes)]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    $("files").append(row);
  }
  $("page").textContent = items.length ? `${pageIndex + 1} / ${Math.ceil(items.length / pageSize)} 页` : "";
  controls();
}

function invalidate() {
  snapshot = null;
  pageIndex = 0;
  $("confirmation").value = "";
  $("confirmation-label").textContent = "扫描完成后，输入完整目录（包含末尾 /）";
  renderFiles();
}

async function invoke(method, args) {
  const reply = await anna.tools.invoke({ tool_id: toolId, method, args }, { timeoutMs: 45000 });
  if (reply?.success === false) throw new Error(typeof reply.error === "string" ? reply.error : reply.error?.message || "Executa 调用失败");
  const result = reply?.data ?? reply;
  if (!result || typeof result !== "object") throw new Error("Executa 返回格式无效。");
  return result;
}

async function scan() {
  const directory = $("directory").value;
  invalidate();
  busy = true;
  stopped = false;
  $("errors").hidden = true;
  $("progress").value = 0;
  $("status").textContent = "正在扫描，尚未删除任何文件…";
  controls();
  try {
    snapshot = await scanDirectory(invoke, directory, {
      cancelled: () => stopped,
      onProgress: count => { $("summary").textContent = `已扫描 ${count} 个文件…`; },
    });
    const total = snapshot.items.reduce((sum, item) => sum + item.size_bytes, 0);
    $("directory").value = snapshot.prefix;
    $("summary").textContent = `${snapshot.prefix} · ${snapshot.items.length} 个文件 · ${formatBytes(total)}`;
    $("confirmation-label").textContent = `请输入 ${snapshot.prefix} 以确认清空`;
    $("status").textContent = snapshot.items.length ? "扫描完成。请核对文件列表和目录，再确认清空。" : "目录下没有可清理的文件。";
  } catch (error) {
    snapshot = null;
    $("summary").textContent = "预览未完成，禁止删除。";
    $("status").textContent = error.message;
  } finally {
    busy = false;
    renderFiles();
  }
}

async function clear() {
  if (busy || !snapshot || $("confirmation").value !== snapshot.prefix) return;
  const target = snapshot;
  const confirmation = $("confirmation").value;
  busy = true;
  stopped = false;
  $("errors").hidden = true;
  $("progress").max = target.items.length;
  $("progress").value = 0;
  controls();
  const update = results => {
    const deleted = results.filter(item => item.ok).length;
    $("progress").value = results.length;
    $("status").textContent = `已删除 ${deleted} / ${target.items.length}，失败 ${results.length - deleted}。`;
  };
  try {
    const results = await clearSnapshot(invoke, target, confirmation, { cancelled: () => stopped, onProgress: update });
    const failures = results.filter(item => !item.ok);
    $("errors").textContent = failures.map(item => `${item.path}\n${item.error}`).join("\n\n");
    $("errors").hidden = failures.length === 0;
    update(results);
    $("status").textContent += ` ${stopped || failures.length ? "清理已停止。" : "本次清理完成。"}请重新扫描核实剩余文件。`;
  } catch (error) {
    $("status").textContent = `${error.message} 请重新扫描核实。`;
  } finally {
    busy = false;
    invalidate();
    $("summary").textContent = `${target.prefix} 的旧预览已失效，请重新扫描。`;
  }
}

$("scan").addEventListener("click", scan);
$("clear").addEventListener("click", clear);
$("confirmation").addEventListener("input", controls);
$("directory").addEventListener("input", () => { invalidate(); $("summary").textContent = "目录已修改，请重新扫描。"; });
$("stop").addEventListener("click", () => { stopped = true; $("status").textContent = "正在停止，等待当前请求结束…"; controls(); });
$("previous").addEventListener("click", () => { pageIndex--; renderFiles(); });
$("next").addEventListener("click", () => { pageIndex++; renderFiles(); });
window.addEventListener("beforeunload", event => { if (busy) { event.preventDefault(); event.returnValue = ""; } });

try {
  toolId = window.__ANNA_TOOL_IDS__?.["aps-cleanup"];
  if (!toolId) throw new Error("缺少 anna-tool-ids.js 中的 aps-cleanup 映射，请从本 demo 目录启动 anna-app dev --storage aps。");
  anna = await AnnaAppRuntime.connect();
  $("connection").textContent = "Anna Runtime 已连接 · 个人 APS（当前 CLI 登录账号）";
} catch (error) {
  $("connection").textContent = `连接失败：${error.message}`;
}
controls();
