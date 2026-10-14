import {
  clearCallRecords,
  deleteCallRecord,
  listCallRecords,
  markUnfinishedRecordsInterrupted,
  putCallRecord,
} from "./record-store.js";
import {
  RECORD_SCHEMA_VERSION,
  createRecordId,
  elapsedMs,
  extractLlmDiagnostics,
  extractSessionDiagnostics,
  isTimeoutError,
  nowIso,
  toSerializable,
} from "./record-utils.js";
import { buildLlmInput, invokeAnnaLlm, selectLlmInvocationPath, readLlmImage, summarizeLlmInput } from "./anna-llm.js";
import {
  buildOutputFilename,
  normalizeBatchConfig,
  runBatch,
  summarizeBatch,
} from "./batch-runner.js";
import { canUseBatchWriter, ensureOutputDir, writeOutputFile } from "./batch-writer-client.js";
import {
  buildSessionImageAttachments, imageFileMetadata, uploadSessionImage, validateImageSelection,
} from "./image-attachments.js";
import {
  DEFAULT_SELECTED_TOOLS,
  MODEL_OPTIONS,
  PLATFORM_TOOL_OPTIONS,
  TOOL_MODES,
  buildSessionCreateInput,
  buildSessionRunInput,
  selectedToolsForMode,
  unknownToolNames,
} from "./session-config.js";

const ANNA_RUNTIME_SDK_URLS = [
  "/static/anna-apps/_sdk/latest/index.js",
  "/static/anna-apps/_sdk/0.2.0/index.js",
  "/static/anna-apps/_sdk/0.1.0/index.js",
];
const SESSION_STORAGE_KEY = "test-session-app.saved-session-ids.v1";
const SETTINGS_STORAGE_KEY = "test-session-app.settings.v1";

const els = Object.fromEntries(
  [
    "conn-dot", "conn-label", "background-count", "record-count", "refresh-runtime",
    "selected-tools-panel", "manual-tools-panel", "manual-tools", "tool-checkbox-list",
    "select-read-only-tools", "select-file-read-write-tools", "select-all-tools", "clear-selected-tools",
    "catalog-status", "refresh-catalog", "catalog-json", "tool-policy-warning",
    "create-session", "delete-selected", "delete-all", "stop-session-wait",
    "manual-session-id", "attach-manual", "save-selected", "clear-saved",
    "session-count", "saved-count", "session-list", "saved-list",
    "selected-session-id", "selected-session-source", "selected-session-state", "selected-session-tool-policy",
    "selected-session-system-prompt", "active-session-record",
    "create-system-prompt", "run-system-prompt", "run-content", "run-selected", "run-manual",
    "session-model",
    "session-images", "upload-session-images", "clear-session-images", "session-image-list",
    "session-image-status", "session-image-detail",
    "session-summary", "session-records", "copy-session-report",
    "batch-selected-tools-panel", "batch-manual-tools-panel", "batch-manual-tools",
    "batch-tool-checkbox-list", "batch-tool-policy-warning", "batch-create-system-prompt",
    "batch-concurrency", "batch-output-dir", "batch-output-prefix", "batch-output-suffix",
    "batch-session-model", "batch-run-system-prompt", "batch-run-content",
    "batch-start", "batch-config-error", "batch-status", "batch-tally", "batch-duration",
    "batch-progress-list", "batch-copy-summary",
    "llm-system-prompt", "llm-user-prompt",
    "llm-images", "clear-llm-images", "llm-image-list", "llm-image-status",
    "llm-timeout-seconds", "run-llm", "stop-llm-wait", "copy-llm-result",
    "active-llm-record", "llm-invocation-path", "llm-duration",
    "llm-result-view", "llm-result-empty", "llm-result-status", "llm-result-metrics", "llm-output-text",
    "record-category-filter", "record-status-filter", "refresh-records",
    "copy-all-records", "clear-records", "record-list", "record-json",
    "clear-records-confirmation", "confirm-clear-records", "cancel-clear-records", "record-action-status",
    "copy-record", "delete-record",
  ].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)])
);

let anna = null;
let connected = false;
let selectedSessionId = "";
let sessions = [];
let savedSessionIds = [];
let logs = [];
let lastLlmResult = null;
let callRecords = [];
let selectedRecordId = "";
let activeSessionRecordId = "";
let activeLlmRecordId = "";
let toolCatalog = null;
let catalogLoading = false;
let sessionImages = [];
let llmImages = [];
let llmImageReadBusy = false;
let imageUploadBusy = false;
let clearingRecords = false;
let batchRunning = false;
let batchRows = [];
let batchSummary = null;

const liveOperations = new Map();
const saveQueues = new Map();

function getAnnaAppRuntime() {
  return globalThis.AnnaAppRuntime || null;
}

async function loadAnnaRuntimeSdk() {
  const existingRuntime = getAnnaAppRuntime();
  if (existingRuntime) return existingRuntime;
  for (const sdkUrl of ANNA_RUNTIME_SDK_URLS) {
    try {
      const runtimeModule = await import(sdkUrl);
      const runtime = runtimeModule?.AnnaAppRuntime || runtimeModule?.default || getAnnaAppRuntime();
      if (runtime) {
        globalThis.AnnaAppRuntime = runtime;
        return runtime;
      }
    } catch {
      // Try the next SDK path; production staging currently serves `latest`.
    }
  }
  return null;
}

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function stringifyDetail(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(toSerializable(detail));
  } catch {
    return String(detail);
  }
}

function addLog(level, source, message, detail) {
  logs.push({ time: nowTime(), level, source, message, detail: stringifyDetail(detail) });
  if (logs.length > 800) logs = logs.slice(-800);
  renderLogs();
}

function renderLogs() {
  if (!els.logs) return;
  els.logs.innerHTML = "";
  for (const item of logs) {
    const li = document.createElement("li");
    li.className = `log log--${item.level}`;
    const time = document.createElement("span");
    time.className = "log__time";
    time.textContent = item.time;
    const source = document.createElement("span");
    source.className = "log__source";
    source.textContent = item.source;
    const message = document.createElement("span");
    message.className = "log__message";
    message.textContent = item.detail ? `${item.message} ${item.detail}` : item.message;
    li.append(time, source, message);
    els.logs.appendChild(li);
  }
  els.logs.scrollTop = els.logs.scrollHeight;
}

function queueRecordSave(record) {
  const snapshot = toSerializable(record);
  const previous = saveQueues.get(record.record_id) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => putCallRecord(snapshot))
    .catch((error) => {
      addLog("error", "IndexedDB", "保存调用记录失败，当前页面中的结果仍然保留", error);
    });
  saveQueues.set(record.record_id, next);
  void next.finally(() => {
    if (saveQueues.get(record.record_id) === next) saveQueues.delete(record.record_id);
  });
  return next;
}

function appendRecordEvent(entry, event, detail = {}) {
  entry.record.events.push({
    event,
    at: nowIso(),
    elapsed_ms: elapsedMs(entry.startedPerf),
    ...toSerializable(detail),
  });
}

function beginOperation(category, operation, request) {
  const recordId = createRecordId(category);
  const startedAt = nowIso();
  const record = {
    schema_version: RECORD_SCHEMA_VERSION,
    record_id: recordId,
    category,
    operation,
    status: "running",
    started_at: startedAt,
    ended_at: null,
    duration_ms: null,
    request: toSerializable(request),
    response: null,
    error: null,
    events: [{ event: `${operation}.started`, at: startedAt, elapsed_ms: 0 }],
  };
  const entry = { record, startedPerf: performance.now(), background: false };
  liveOperations.set(recordId, entry);
  if (category === "session") activeSessionRecordId = recordId;
  if (category === "llm") activeLlmRecordId = recordId;
  void queueRecordSave(record);
  void loadRecords();
  render();
  return entry;
}

async function finishOperation(entry, status, patch = {}) {
  const { record } = entry;
  Object.assign(record, toSerializable(patch));
  record.status = status;
  record.ended_at = nowIso();
  record.duration_ms = elapsedMs(entry.startedPerf);
  appendRecordEvent(entry, `${record.operation}.${status}`, { duration_ms: record.duration_ms });
  liveOperations.delete(record.record_id);
  if (activeSessionRecordId === record.record_id) activeSessionRecordId = "";
  if (activeLlmRecordId === record.record_id) activeLlmRecordId = "";
  await queueRecordSave(record);
  await loadRecords();
  render();
  return record;
}

function stopWaiting(category) {
  const recordId = category === "session" ? activeSessionRecordId : activeLlmRecordId;
  const entry = liveOperations.get(recordId);
  if (!entry) return;
  entry.background = true;
  entry.record.status = "waiting_stopped";
  appendRecordEvent(entry, "ui.waiting_stopped", {
    message: "用户停止前端等待；平台请求和后台记录继续运行",
  });
  if (category === "session") activeSessionRecordId = "";
  if (category === "llm") activeLlmRecordId = "";
  void queueRecordSave(entry.record);
  addLog("warn", entry.record.operation, "已停止前端等待，后台仍会记录最终返回", entry.record.record_id);
  void loadRecords();
  render();
}

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readSavedSessionIds() {
  const parsed = readJsonStorage(SESSION_STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item.trim()) : [];
}

function writeSavedSessionIds(ids) {
  savedSessionIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(savedSessionIds));
  render();
}

function getToolMode() {
  return document.querySelector('input[name="tool-mode"]:checked')?.value || TOOL_MODES.ALL;
}

function getCheckedToolNames() {
  return [...els.tool_checkbox_list.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function currentRequestedTools() {
  return selectedToolsForMode({
    mode: getToolMode(),
    selectedTools: getCheckedToolNames(),
    manualTools: els.manual_tools.value,
  });
}

function toolPolicyLabel(mode, tools = []) {
  if (mode === TOOL_MODES.ALL) return "全部 Host 工具（继承）";
  if (tools.length === 0) return "无工具（不继承 Host 工具）";
  return `${mode === TOOL_MODES.MANUAL ? "手动" : "部分"}：${tools.join(", ")}`;
}

function catalogToolsByName() {
  return new Map((toolCatalog?.platform_tools || [])
    .filter((item) => item?.name)
    .map((item) => [item.name, item]));
}

// Shared by the Session tab and the batch tab, which offer the same three tool
// policies over independent selections.
function renderToolCheckboxList(container, checkedNames) {
  const checked = new Set(checkedNames);
  const catalogByName = catalogToolsByName();
  container.innerHTML = "";
  let currentGroup = "";
  for (const tool of PLATFORM_TOOL_OPTIONS) {
    if (tool.group !== currentGroup) {
      currentGroup = tool.group;
      const heading = document.createElement("div");
      heading.className = "tool-group-title";
      heading.textContent = currentGroup;
      container.appendChild(heading);
    }
    const catalogEntry = catalogByName.get(tool.name);
    const label = document.createElement("label");
    label.className = `tool-checkbox${catalogEntry && !catalogEntry.eligible ? " tool-checkbox--blocked" : ""}`;
    if (catalogEntry?.blocked_by) label.title = `当前不可用：blocked_by=${catalogEntry.blocked_by}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = tool.name;
    input.checked = checked.has(tool.name);
    input.addEventListener("change", () => {
      saveSettings();
      render();
    });
    const name = document.createElement("span");
    name.className = "tool-checkbox__name";
    name.textContent = tool.name;
    const access = document.createElement("span");
    access.className = "tool-access";
    access.textContent = catalogEntry && !catalogEntry.eligible
      ? `blocked:${catalogEntry.blocked_by || "unknown"}`
      : tool.access;
    label.append(input, name, access);
    container.appendChild(label);
  }
}

function renderToolCheckboxes(checkedNames = getCheckedToolNames()) {
  renderToolCheckboxList(els.tool_checkbox_list, checkedNames);
}

function renderBatchToolCheckboxes(checkedNames = getBatchCheckedToolNames()) {
  renderToolCheckboxList(els.batch_tool_checkbox_list, checkedNames);
}

function renderModelOptions(select) {
  for (const group of MODEL_OPTIONS) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.group;
    for (const model of group.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = `${model.label} · ${model.id}`;
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
}

/**
 * Diagnostics for a requested tool policy, shared by both tabs: the catalog can
 * report that host inheritance is ungranted, that a name is absent (the
 * platform drops it silently) or that a tool is currently blocked.
 */
function toolPolicyWarnings(mode, requestedTools) {
  const warnings = [];
  if (mode === TOOL_MODES.ALL && toolCatalog && toolCatalog.inherit_host_tools_granted === false) {
    warnings.push("当前用户授权不允许继承 Host 工具，全部工具模式可能创建失败或被降级。");
  }
  const unknown = unknownToolNames(requestedTools, toolCatalog);
  if (unknown.length > 0) warnings.push(`目录中不存在的工具会被静默丢弃：${unknown.join(", ")}`);
  const catalogByName = catalogToolsByName();
  const blocked = requestedTools
    .map((name) => catalogByName.get(name))
    .filter((item) => item && !item.eligible)
    .map((item) => `${item.name} (${item.blocked_by || "unknown"})`);
  if (blocked.length > 0) warnings.push(`当前不可用：${blocked.join(", ")}`);
  return warnings;
}

function renderToolConfiguration() {
  const mode = getToolMode();
  els.selected_tools_panel.hidden = mode !== TOOL_MODES.SELECTED;
  els.manual_tools_panel.hidden = mode !== TOOL_MODES.MANUAL;
  els.refresh_catalog.disabled = !canUseSession() || catalogLoading;

  const warnings = toolPolicyWarnings(mode, currentRequestedTools());
  els.tool_policy_warning.hidden = warnings.length === 0;
  els.tool_policy_warning.textContent = warnings.join(" ");
}

function setCheckedTools(names) {
  renderToolCheckboxes(names);
  saveSettings();
  render();
}

function getBatchToolMode() {
  return document.querySelector('input[name="batch-tool-mode"]:checked')?.value || TOOL_MODES.ALL;
}

function getBatchCheckedToolNames() {
  return [...els.batch_tool_checkbox_list.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function currentBatchRequestedTools() {
  return selectedToolsForMode({
    mode: getBatchToolMode(),
    selectedTools: getBatchCheckedToolNames(),
    manualTools: els.batch_manual_tools.value,
  });
}

function saveSettings() {
  const settings = {
    tool_mode: getToolMode(),
    selected_tools: getCheckedToolNames(),
    manual_tools: els.manual_tools.value,
    session_model: els.session_model.value,
    create_system_prompt: els.create_system_prompt.value,
    run_system_prompt: els.run_system_prompt.value,
    run_content: els.run_content.value,
    llm_system_prompt: els.llm_system_prompt.value,
    llm_user_prompt: els.llm_user_prompt.value,
    llm_timeout_seconds: els.llm_timeout_seconds.value,
    batch_tool_mode: getBatchToolMode(),
    batch_selected_tools: getBatchCheckedToolNames(),
    batch_manual_tools: els.batch_manual_tools.value,
    batch_create_system_prompt: els.batch_create_system_prompt.value,
    batch_concurrency: els.batch_concurrency.value,
    batch_output_dir: els.batch_output_dir.value,
    batch_output_prefix: els.batch_output_prefix.value,
    batch_output_suffix: els.batch_output_suffix.value,
    batch_session_model: els.batch_session_model.value,
    batch_run_system_prompt: els.batch_run_system_prompt.value,
    batch_run_content: els.batch_run_content.value,
  };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function restoreSettings() {
  const settings = readJsonStorage(SETTINGS_STORAGE_KEY, {});
  const mode = Object.values(TOOL_MODES).includes(settings.tool_mode) ? settings.tool_mode : TOOL_MODES.ALL;
  const modeInput = document.querySelector(`input[name="tool-mode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  renderToolCheckboxes(Array.isArray(settings.selected_tools) ? settings.selected_tools : DEFAULT_SELECTED_TOOLS);
  if (typeof settings.manual_tools === "string") els.manual_tools.value = settings.manual_tools;
  if (typeof settings.session_model === "string") els.session_model.value = settings.session_model;
  const legacySystemPrompt = typeof settings.session_system_prompt === "string" ? settings.session_system_prompt : "";
  if (typeof settings.create_system_prompt === "string") els.create_system_prompt.value = settings.create_system_prompt;
  else if (legacySystemPrompt) els.create_system_prompt.value = legacySystemPrompt;
  if (typeof settings.run_system_prompt === "string") els.run_system_prompt.value = settings.run_system_prompt;
  if (typeof settings.run_content === "string") els.run_content.value = settings.run_content;
  if (typeof settings.llm_system_prompt === "string") els.llm_system_prompt.value = settings.llm_system_prompt;
  if (typeof settings.llm_user_prompt === "string") els.llm_user_prompt.value = settings.llm_user_prompt;
  if (typeof settings.llm_timeout_seconds === "string") els.llm_timeout_seconds.value = settings.llm_timeout_seconds;

  const batchMode = Object.values(TOOL_MODES).includes(settings.batch_tool_mode)
    ? settings.batch_tool_mode
    : TOOL_MODES.ALL;
  const batchModeInput = document.querySelector(`input[name="batch-tool-mode"][value="${batchMode}"]`);
  if (batchModeInput) batchModeInput.checked = true;
  renderBatchToolCheckboxes(Array.isArray(settings.batch_selected_tools)
    ? settings.batch_selected_tools
    : DEFAULT_SELECTED_TOOLS);
  for (const [key, element] of [
    ["batch_manual_tools", els.batch_manual_tools],
    ["batch_create_system_prompt", els.batch_create_system_prompt],
    ["batch_concurrency", els.batch_concurrency],
    ["batch_output_dir", els.batch_output_dir],
    ["batch_output_prefix", els.batch_output_prefix],
    ["batch_output_suffix", els.batch_output_suffix],
    ["batch_session_model", els.batch_session_model],
    ["batch_run_system_prompt", els.batch_run_system_prompt],
    ["batch_run_content", els.batch_run_content],
  ]) {
    if (typeof settings[key] === "string") element.value = settings[key];
  }
}

function setConnection(nextConnected, label) {
  connected = nextConnected;
  els.conn_dot.classList.toggle("dot--on", connected);
  els.conn_dot.classList.toggle("dot--off", !connected);
  els.conn_label.textContent = label;
  render();
}

function upsertSession(session) {
  const index = sessions.findIndex((item) => item.app_session_uuid === session.app_session_uuid);
  const next = {
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    state: "held", last_run_at: "", last_error: "", ...session,
  };
  if (index >= 0) sessions = sessions.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item);
  else sessions = [...sessions, next];
  if (!selectedSessionId) selectedSessionId = session.app_session_uuid;
  render();
}

function updateSession(id, patch) {
  sessions = sessions.map((item) => item.app_session_uuid === id
    ? { ...item, ...patch, updated_at: new Date().toISOString() }
    : item);
  render();
}

function removeSession(id) {
  sessions = sessions.filter((item) => item.app_session_uuid !== id);
  if (selectedSessionId === id) selectedSessionId = sessions[0]?.app_session_uuid || "";
  render();
}

function findSelectedSession() {
  return sessions.find((item) => item.app_session_uuid === selectedSessionId) || null;
}

function getManualSessionId() {
  return els.manual_session_id.value.trim();
}

function canUseSession() {
  return connected && anna?.agent?.session;
}

function canUseLlm() {
  return connected && selectLlmInvocationPath(anna) !== "unavailable";
}

function imageStatus(message, failed = false) {
  els.session_image_status.textContent = message;
  els.session_image_status.classList.toggle("image-status--error", failed);
}

function removeSessionImages(ids) {
  sessionImages = sessionImages.filter((image) => {
    if (!ids.has(image.id)) return true;
    URL.revokeObjectURL(image.previewUrl);
    return false;
  });
  imageStatus(sessionImages.length ? "图片列表已更新，请确认后运行。" : "未添加图片，将按纯文本运行。");
  render();
}

function renderSessionImages() {
  els.session_images.disabled = imageUploadBusy;
  els.clear_session_images.disabled = imageUploadBusy || !sessionImages.length;
  els.upload_session_images.disabled = imageUploadBusy || !connected || !sessionImages.length;
  els.upload_session_images.textContent = imageUploadBusy ? "正在上传…" : "上传／重新上传图片";
  els.session_image_list.replaceChildren();
  for (const image of sessionImages) {
    const item = document.createElement("li");
    item.className = "session-image";
    const preview = document.createElement("img");
    preview.src = image.previewUrl;
    preview.alt = image.file.name;
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = image.file.name;
    const status = document.createElement("p");
    const labels = { pending: "待上传", uploading: "上传中", uploaded: "已上传", failed: "上传失败" };
    const expiry = image.upload?.expires_at_ms;
    status.textContent = `${(image.file.size / 1024).toFixed(1)} KB · ${labels[image.status]}`
      + (expiry != null ? ` · 地址有效至 ${new Date(expiry).toLocaleString("zh-CN")}` : "")
      + (image.error ? `：${image.error}` : "");
    info.append(name, status);
    const remove = createMiniButton("移除", () => removeSessionImages(new Set([image.id])));
    remove.setAttribute("aria-label", `移除图片 ${image.file.name}`);
    remove.disabled = imageUploadBusy;
    item.append(preview, info, remove);
    els.session_image_list.appendChild(item);
  }
}

async function uploadSelectedImages() {
  if (imageUploadBusy || !connected || !sessionImages.length) return;
  imageUploadBusy = true;
  const runtime = anna;
  const images = [...sessionImages];
  // Re-upload always starts a fresh transaction; stale URLs cannot survive a failed attempt.
  for (const image of images) Object.assign(image, { status: "pending", upload: null, error: "" });
  imageStatus("正在上传图片，全部成功后可运行会话。");
  const entry = beginOperation("upload", "session.images.upload", { files: images.map((image) => imageFileMetadata(image.file)) });
  const results = [];
  try {
    for (const image of images) {
      image.status = "uploading";
      renderSessionImages();
      const started = performance.now();
      let phase = "negotiate";
      try {
        image.upload = await uploadSessionImage(runtime, image.file, {
          onPhase(nextPhase, status) {
            phase = nextPhase;
            appendRecordEvent(entry, `upload.${phase}.${status}`, { filename: image.file.name });
            void queueRecordSave(entry.record);
          },
        });
        image.status = "uploaded";
        image.uploadRecordId = entry.record.record_id;
        results.push({ ...image.upload, duration_ms: elapsedMs(started), status: "succeeded" });
      } catch (error) {
        image.status = "failed";
        image.error = error?.message || String(error);
        results.push({ filename: image.file.name, phase, duration_ms: elapsedMs(started), status: "failed", error: toSerializable(error) });
        appendRecordEvent(entry, `upload.${phase}.failed`, results.at(-1));
      }
      entry.record.response = { images: results };
      await queueRecordSave(entry.record);
      renderSessionImages();
    }
    const failures = results.filter((result) => result.status === "failed").length;
    imageStatus(failures
      ? `${results.length - failures} 张上传成功，${failures} 张失败。请重新上传或移除失败图片后再运行。`
      : `已上传 ${results.length} 张图片，运行会话时会附上列表中的全部图片。`, failures > 0);
    await finishOperation(entry, failures ? "failed" : "succeeded", {
      response: { images: results },
      ...(failures ? { error: { message: `${failures} 张图片上传失败` } } : {}),
    });
  } finally {
    imageUploadBusy = false;
    render();
  }
}

function llmImageStatus(message, failed = false) {
  els.llm_image_status.textContent = message;
  els.llm_image_status.classList.toggle("image-status--error", failed);
}

function removeLlmImages(ids) {
  llmImages = llmImages.filter((image) => {
    if (!ids.has(image.id)) return true;
    URL.revokeObjectURL(image.previewUrl);
    return false;
  });
  llmImageStatus(llmImages.length ? "图片列表已更新，调用时会附上全部图片。" : "未添加图片，将按纯文本调用。");
  render();
}

function renderLlmImages() {
  els.llm_images.disabled = llmImageReadBusy;
  els.clear_llm_images.disabled = llmImageReadBusy || !llmImages.length;
  els.llm_image_list.replaceChildren();
  for (const image of llmImages) {
    const item = document.createElement("li");
    item.className = "session-image";
    const preview = document.createElement("img");
    preview.src = image.previewUrl;
    preview.alt = image.file.name;
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = image.file.name;
    const status = document.createElement("p");
    const labels = { reading: "读取中", ready: "待发送", failed: "读取失败" };
    status.textContent = `${(image.file.size / 1024).toFixed(1)} KB · ${labels[image.status]}`
      + (image.error ? `：${image.error}` : "");
    info.append(name, status);
    const remove = createMiniButton("移除", () => removeLlmImages(new Set([image.id])));
    remove.setAttribute("aria-label", `移除图片 ${image.file.name}`);
    remove.disabled = llmImageReadBusy;
    item.append(preview, info, remove);
    els.llm_image_list.appendChild(item);
  }
}

async function selectLlmImages() {
  const files = [...els.llm_images.files];
  els.llm_images.value = "";
  if (llmImageReadBusy || !files.length) return;
  try {
    validateImageSelection([...llmImages.map((image) => image.file), ...files]);
  } catch (error) {
    llmImageStatus(error.message, true);
    return;
  }
  llmImageReadBusy = true;
  const added = files.map((file) => ({
    id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "reading",
  }));
  llmImages.push(...added);
  llmImageStatus("正在读取图片…");
  render();
  try {
    for (const image of added) {
      try {
        image.content = await readLlmImage(image.file);
        image.status = "ready";
      } catch (error) {
        image.status = "failed";
        image.error = error.message;
      }
      renderLlmImages();
    }
    const failed = llmImages.some((image) => image.status === "failed");
    llmImageStatus(failed ? "部分图片读取失败，请移除后重新选择。" : `已准备 ${llmImages.length} 张图片，调用 LLM 时发送。`, failed);
  } finally {
    llmImageReadBusy = false;
    render();
  }
}

function renderSessionList() {
  els.session_list.innerHTML = "";
  els.session_count.textContent = String(sessions.length);
  if (sessions.length === 0) {
    els.session_list.innerHTML = '<li class="empty">当前页面还没有持有 session。</li>';
    return;
  }
  for (const session of sessions) {
    const li = document.createElement("li");
    li.className = `session-item${session.app_session_uuid === selectedSessionId ? " session-item--active" : ""}`;
    const button = document.createElement("button");
    button.className = "session-item__button";
    button.type = "button";
    button.addEventListener("click", () => {
      selectedSessionId = session.app_session_uuid;
      if (typeof session.model_id === "string") els.session_model.value = session.model_id;
      render();
      addLog("ok", "ui", "已选中 session", session.app_session_uuid);
    });
    const id = document.createElement("span");
    id.className = "session-item__id";
    id.textContent = session.app_session_uuid;
    const meta = document.createElement("span");
    meta.className = "session-item__meta";
    meta.textContent = [session.source || "created", session.state || "held", session.tool_policy || "",
      session.model_id ? `model=${session.model_id}` : "model=auto",
      session.expires_in == null ? "" : `expires_in=${session.expires_in}s`].filter(Boolean).join(" · ");
    button.append(id, meta);
    li.appendChild(button);
    els.session_list.appendChild(li);
  }
}

function renderSavedList() {
  els.saved_list.innerHTML = "";
  els.saved_count.textContent = String(savedSessionIds.length);
  if (savedSessionIds.length === 0) {
    els.saved_list.innerHTML = '<li class="empty">localStorage 中没有保存的 session id。</li>';
    return;
  }
  for (const id of savedSessionIds) {
    const li = document.createElement("li");
    li.className = "saved-item";
    const text = document.createElement("span");
    text.textContent = id;
    const actions = document.createElement("span");
    actions.className = "saved-item__actions";
    const useButton = createMiniButton("加入", () => {
      upsertSession({ app_session_uuid: id, source: "localStorage", state: "restored" });
      selectedSessionId = id;
      els.manual_session_id.value = id;
    });
    const runButton = createMiniButton("run", () => runSessionById(id, "saved"));
    useButton.disabled = !canUseSession();
    runButton.disabled = !canUseSession() || Boolean(activeSessionRecordId) || imageUploadBusy;
    const deleteButton = createMiniButton("移除", () => {
      writeSavedSessionIds(savedSessionIds.filter((item) => item !== id));
    }, "mini-btn mini-btn--danger");
    actions.append(useButton, runButton, deleteButton);
    li.append(text, actions);
    els.saved_list.appendChild(li);
  }
}

function createMiniButton(label, handler, className = "mini-btn") {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderResult(element, result) {
  element.textContent = JSON.stringify(toSerializable(result || {}), null, 2);
}

function formatMetricValue(value, suffix = "") {
  if (value == null || value === "") return "未返回";
  if (typeof value === "number" && Number.isFinite(value)) return `${value.toLocaleString()}${suffix}`;
  return `${String(value)}${suffix}`;
}

function llmStatusLabel(status) {
  return {
    succeeded: "成功",
    failed: "失败",
    interrupted: "已中断",
    waiting_stopped: "已停止等待",
    running: "运行中",
  }[status] || status || "未知";
}

function buildLlmSummary(record) {
  if (!record) return "";
  const diagnostics = extractLlmDiagnostics(record);
  const usage = diagnostics.token_usage || {};
  const tokenSummary = formatTokenUsage(usage);
  return [
    `最终返回：${diagnostics.output_text || "（没有文字返回）"}`,
    `模型：${diagnostics.model || "未返回"}`,
    `Token：${tokenSummary}`,
    `停止原因：${diagnostics.stop_reason || "未返回"}`,
    `服务商：${diagnostics.provider || "未返回"}`,
    `Provider 延迟：${formatMetricValue(diagnostics.latency_ms, " ms")}`,
    `配额消耗：${formatMetricValue(diagnostics.quota_consumed)}`,
    `调用耗时：${formatMetricValue(record.duration_ms, " ms")}`,
  ].join("\n");
}

function renderLlmResult(record) {
  const hasRecord = Boolean(record);
  els.llm_result_empty.hidden = hasRecord;
  els.llm_result_status.hidden = !hasRecord;
  els.llm_result_metrics.hidden = !hasRecord;
  els.llm_output_text.hidden = !hasRecord;
  els.llm_result_metrics.innerHTML = "";
  els.llm_output_text.textContent = "";
  if (!hasRecord) return;

  const diagnostics = extractLlmDiagnostics(record);
  const status = record.status || "unknown";
  els.llm_result_status.className = `llm-result__status llm-result__status--${status}`;
  els.llm_result_status.textContent = llmStatusLabel(status);
  els.llm_output_text.className = `llm-output-text llm-output-text--${status}`;
  els.llm_output_text.textContent = diagnostics.output_text
    || (record.error ? `调用失败：${record.error.message || String(record.error)}` : "（没有提取到文字返回）");

  const usage = diagnostics.token_usage || {};
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? usage.tokens;
  const metrics = [
    ["使用模型", diagnostics.model],
    ["输入 Token", formatMetricValue(inputTokens)],
    ["输出 Token", formatMetricValue(outputTokens)],
    ["总 Token", formatMetricValue(totalTokens)],
    ["停止原因", diagnostics.stop_reason],
    ["服务商", diagnostics.provider],
    ["Provider 延迟", diagnostics.latency_ms == null ? null : `${formatMetricValue(diagnostics.latency_ms)} ms`],
    ["配额消耗", diagnostics.quota_consumed],
  ];
  for (const [label, value] of metrics) els.llm_result_metrics.appendChild(createMetric(label, value));
}

function sessionIdForRecord(record) {
  return record?.request?.app_session_uuid
    || record?.session?.app_session_uuid
    || record?.response?.app_session_uuid
    || "";
}

function formatJsonValue(value) {
  if (value == null || value === "") return "-";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(toSerializable(value), null, 2);
  } catch {
    return String(value);
  }
}

function formatTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return "未返回";
  const prompt = usage.total_prompt_tokens ?? usage.prompt_tokens ?? usage.input_tokens
    ?? usage.inputTokens ?? usage.promptTokens;
  const completion = usage.total_completion_tokens ?? usage.completion_tokens ?? usage.output_tokens
    ?? usage.outputTokens ?? usage.completionTokens;
  const total = usage.total_tokens ?? usage.tokens ?? usage.totalTokens;
  const parts = [];
  if (prompt != null) parts.push(`输入 ${formatMetricValue(prompt)}`);
  if (completion != null) parts.push(`输出 ${formatMetricValue(completion)}`);
  if (total != null) parts.push(`总计 ${formatMetricValue(total)}`);
  return parts.length > 0 ? parts.join(" · ") : "未返回";
}

function createMetric(label, value) {
  const item = document.createElement("div");
  item.className = "session-metric";
  const title = document.createElement("span");
  title.className = "session-metric__label";
  title.textContent = label;
  const content = document.createElement("strong");
  content.className = "session-metric__value";
  content.textContent = value == null || value === "" ? "-" : String(value);
  item.append(title, content);
  return item;
}

function appendLazyCode(container, label, value, className = "session-code") {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  details.appendChild(summary);
  details.addEventListener("toggle", () => {
    if (!details.open || details.dataset.hydrated === "true") return;
    const pre = document.createElement("pre");
    pre.className = className;
    pre.textContent = formatJsonValue(value);
    details.appendChild(pre);
    details.dataset.hydrated = "true";
  });
  container.appendChild(details);
  return details;
}

function createToolCallDetails(tool) {
  const details = document.createElement("details");
  details.className = "tool-call";
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "tool-call__title";
  title.textContent = `${tool.index + 1}. ${tool.name || "unknown"}`;
  const status = document.createElement("span");
  status.className = `tool-call__status tool-call__status--${tool.status || "started"}`;
  status.textContent = tool.status === "completed" ? "已完成" : "未完成";
  summary.append(title, status);
  details.appendChild(summary);

  const meta = document.createElement("div");
  meta.className = "tool-call__meta";
  const toolStartedMs = Date.parse(tool.started_at || "");
  const toolEndedMs = Date.parse(tool.ended_at || "");
  const toolDuration = Number.isFinite(toolStartedMs) && Number.isFinite(toolEndedMs)
    ? `${Math.max(0, toolEndedMs - toolStartedMs)} ms`
    : "";
  meta.textContent = [
    tool.id ? `id=${tool.id}` : "",
    toolDuration ? `耗时 ${toolDuration}` : "",
    tool.started_at ? `开始 ${tool.started_at}` : "",
    tool.ended_at ? `结束 ${tool.ended_at}` : "",
  ].filter(Boolean).join(" · ");
  details.appendChild(meta);

  const body = document.createElement("div");
  body.className = "tool-call__body";
  appendLazyCode(body, "输入（点击展开）", tool.input);
  appendLazyCode(body, "输出（点击展开）", tool.output);
  details.appendChild(body);
  return details;
}

function createSessionRecordCard(record) {
  const card = document.createElement("article");
  card.className = `session-record session-record--${record.status || "unknown"}`;

  const header = document.createElement("div");
  header.className = "session-record__header";
  const heading = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = record.operation || "session 调用";
  const subtitle = document.createElement("p");
  subtitle.className = "session-record__subtitle";
  subtitle.textContent = [record.started_at || "-", record.record_id || ""].filter(Boolean).join(" · ");
  heading.append(title, subtitle);
  const status = document.createElement("span");
  status.className = `record-status record-status--${record.status || "unknown"}`;
  status.textContent = record.status || "unknown";
  header.append(heading, status);
  card.appendChild(header);

  const diagnostics = record.operation === "session.run" ? extractSessionDiagnostics(record) : null;
  const metrics = document.createElement("div");
  metrics.className = "session-record__metrics";
  metrics.appendChild(createMetric("耗时", record.duration_ms == null ? "-" : `${record.duration_ms} ms`));
  if (diagnostics) {
    const usage = diagnostics.token_usage || {};
    metrics.appendChild(createMetric("图片附件", `${record.request?.attachments?.length || 0} 张`));
    metrics.appendChild(createMetric("请求模型", record.request?.requested_model || "自动选择"));
    metrics.appendChild(createMetric("实际模型", diagnostics.model || "未返回"));
    metrics.appendChild(createMetric("实际工具集", Array.isArray(diagnostics.run_meta?.granted_tools)
      ? diagnostics.run_meta.granted_tools.join(", ") || "空工具集"
      : "未返回"));
    metrics.appendChild(createMetric("继承 Host 工具", diagnostics.run_meta?.inherit_host_tools == null
      ? "未返回"
      : String(diagnostics.run_meta.inherit_host_tools)));
    metrics.appendChild(createMetric("Token", formatTokenUsage(usage)));
    metrics.appendChild(createMetric("Agent 调用", usage.total_calls == null ? "未返回" : `${usage.total_calls} 次`));
    metrics.appendChild(createMetric("工具调用", `${diagnostics.tools.length} 次`));
    metrics.appendChild(createMetric("缓存读取 Token", usage.total_cache_read_tokens == null ? "未返回" : usage.total_cache_read_tokens.toLocaleString()));
    metrics.appendChild(createMetric("估算成本（Anna 返回）", usage.total_estimated_cost == null ? "未返回" : String(usage.total_estimated_cost)));
    metrics.appendChild(createMetric("首个 Stream Frame", record.metrics?.first_frame_ms == null ? "-" : `${record.metrics.first_frame_ms} ms`));
    metrics.appendChild(createMetric("首个文字", diagnostics.first_text_ms == null ? "-" : `${diagnostics.first_text_ms} ms`));
  }
  card.appendChild(metrics);

  if (diagnostics) {
    const responseSection = document.createElement("section");
    responseSection.className = "session-response";
    const responseTitle = document.createElement("h4");
    responseTitle.textContent = "最终 Session 文字返回";
    responseSection.appendChild(responseTitle);
    const output = document.createElement("pre");
    output.className = "session-output";
    output.textContent = diagnostics.output_text || "（没有提取到文字返回）";
    responseSection.appendChild(output);
    card.appendChild(responseSection);

    const toolsSection = document.createElement("section");
    toolsSection.className = "session-tools";
    const toolsTitle = document.createElement("div");
    toolsTitle.className = "session-section-title";
    toolsTitle.textContent = `工具调用（${diagnostics.tools.length}）`;
    toolsSection.appendChild(toolsTitle);
    if (diagnostics.tools.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "本次 session.run 没有捕获到工具调用。";
      toolsSection.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "tool-call-list";
      diagnostics.tools.forEach((tool) => list.appendChild(createToolCallDetails(tool)));
      toolsSection.appendChild(list);
    }
    card.appendChild(toolsSection);
  } else {
    const rawResponse = document.createElement("div");
    rawResponse.className = "session-raw-response";
    appendLazyCode(rawResponse, "原始响应（点击展开）", record.response);
    card.appendChild(rawResponse);
  }

  return card;
}

function selectedSessionRecords() {
  if (!selectedSessionId) return [];
  const recordsById = new Map(callRecords
    .filter((record) => record.category === "session" && sessionIdForRecord(record) === selectedSessionId)
    .map((record) => [record.record_id, record]));
  for (const entry of liveOperations.values()) {
    const record = entry.record;
    if (record.category === "session" && sessionIdForRecord(record) === selectedSessionId) {
      recordsById.set(record.record_id, record);
    }
  }
  return [...recordsById.values()]
    .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)));
}

function buildSessionReport(records) {
  return records.map((record) => {
    const diagnostics = record.operation === "session.run" ? extractSessionDiagnostics(record) : null;
    return {
      operation: record.operation,
      status: record.status,
      started_at: record.started_at,
      duration_ms: record.duration_ms,
      requested_model: record.request?.requested_model || null,
      actual_model: diagnostics?.model || null,
      run_meta: diagnostics?.run_meta || null,
      token_usage: diagnostics?.token_usage || null,
      output_text: diagnostics?.output_text || null,
      tool_calls: diagnostics?.tools || [],
      request: record.request || null,
      response: record.response || null,
    };
  });
}

function renderSessionInspector() {
  if (!els.session_summary || !els.session_records) return;
  const records = selectedSessionRecords();
  els.session_summary.innerHTML = "";
  els.session_records.innerHTML = "";
  els.copy_session_report.disabled = records.length === 0;
  if (!selectedSessionId) {
    els.session_summary.appendChild(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: "请先从左侧选择一个 session。",
    }));
    return;
  }
  const selected = findSelectedSession();
  const runCount = records.filter((record) => record.operation === "session.run").length;
  const latest = records[0];
  const summary = document.createElement("div");
  summary.className = "session-summary__grid";
  summary.append(
    createMetric("Session ID", selectedSessionId),
    createMetric("调用次数", `${records.length} 次`),
    createMetric("run 次数", `${runCount} 次`),
    createMetric("当前状态", selected?.state || latest?.status || "-"),
    createMetric("工具策略", selected?.tool_policy || "未知（恢复的 Session）"),
    createMetric("请求模型", selected?.model_id || "自动选择"),
  );
  els.session_summary.appendChild(summary);
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty session-empty-state";
    empty.textContent = "这个 session 还没有已持久化的调用记录。运行一次 session.run 后，工具调用和最终返回会显示在这里。";
    els.session_records.appendChild(empty);
    return;
  }
  for (const record of records) els.session_records.appendChild(createSessionRecordCard(record));
}

function render() {
  const sessionReady = canUseSession();
  const sessionBusy = Boolean(activeSessionRecordId);
  const manualId = getManualSessionId();
  els.create_session.disabled = !sessionReady || sessionBusy;
  els.delete_selected.disabled = !sessionReady || !selectedSessionId || sessionBusy;
  els.delete_all.disabled = !sessionReady || sessions.length === 0 || sessionBusy;
  els.stop_session_wait.disabled = !sessionBusy;
  els.attach_manual.disabled = !sessionReady || !manualId || sessionBusy;
  els.save_selected.disabled = !selectedSessionId;
  els.run_selected.disabled = !sessionReady || !selectedSessionId || sessionBusy || imageUploadBusy;
  els.run_manual.disabled = !sessionReady || !manualId || sessionBusy || imageUploadBusy;
  els.run_llm.disabled = !canUseLlm() || Boolean(activeLlmRecordId) || llmImageReadBusy;
  els.stop_llm_wait.disabled = !activeLlmRecordId;
  els.copy_llm_result.disabled = !lastLlmResult;
  els.clear_records.disabled = liveOperations.size > 0 || batchRunning || clearingRecords;
  els.confirm_clear_records.disabled = liveOperations.size > 0 || batchRunning || clearingRecords;
  els.cancel_clear_records.disabled = clearingRecords;
  els.background_count.textContent = String([...liveOperations.values()].filter((entry) => entry.background).length);
  els.active_session_record.textContent = activeSessionRecordId || "-";
  els.active_llm_record.textContent = activeLlmRecordId || "-";
  const selected = findSelectedSession();
  els.selected_session_id.textContent = selectedSessionId || "-";
  els.selected_session_source.textContent = selected?.source || "-";
  els.selected_session_state.textContent = selected?.state || "-";
  els.selected_session_tool_policy.textContent = selected?.tool_policy || (selectedSessionId ? "未知（恢复的 Session）" : "-");
  els.selected_session_system_prompt.textContent = selectedSessionId
    ? (selected?.system_prompt || "未设置或恢复时未知")
    : "-";
  renderToolConfiguration();
  renderBatchControls();
  renderSessionImages();
  renderLlmImages();
  renderSessionList();
  renderSavedList();
  renderSessionInspector();
}

function normalizeCreateResult(raw) {
  return {
    app_session_uuid: raw?.app_session_uuid || raw?.appSessionUuid || "",
    expires_in: raw?.expires_in ?? raw?.expiresIn ?? null,
    submode: raw?.submode || "",
    fixed_client_id: raw?.fixed_client_id || raw?.fixedClientId || "",
    system_prompt: raw?.system_prompt ?? raw?.systemPrompt ?? null,
    granted_tools: Array.isArray(raw?.granted_tools) ? raw.granted_tools : [],
    inherit_host_tools: raw?.inherit_host_tools ?? raw?.inheritHostTools ?? null,
  };
}

async function refreshSessionCatalog() {
  if (!canUseSession() || typeof anna.agent.session.catalog !== "function") {
    toolCatalog = null;
    els.catalog_status.textContent = "当前 Runtime 不提供 agent.session.catalog。";
    renderResult(els.catalog_json, null);
    render();
    return;
  }
  catalogLoading = true;
  els.catalog_status.textContent = "正在读取 Session 工具目录...";
  render();
  try {
    const result = await anna.agent.session.catalog();
    toolCatalog = result || null;
    const eligibleCount = (toolCatalog?.platform_tools || []).filter((item) => item?.eligible).length;
    const totalCount = (toolCatalog?.platform_tools || []).length;
    els.catalog_status.textContent = `目录已加载：${eligibleCount}/${totalCount} 个工具当前可用。`;
    renderResult(els.catalog_json, toolCatalog);
    renderToolCheckboxes(getCheckedToolNames());
    renderBatchToolCheckboxes(getBatchCheckedToolNames());
    addLog("ok", "session.catalog", "Session 工具目录已刷新", { eligible: eligibleCount, total: totalCount });
  } catch (error) {
    toolCatalog = null;
    els.catalog_status.textContent = `目录读取失败：${error?.message || error}`;
    renderResult(els.catalog_json, { error: toSerializable(error) });
    addLog("warn", "session.catalog", "读取 Session 工具目录失败", error);
  } finally {
    catalogLoading = false;
    render();
  }
}

async function connectAnna() {
  setConnection(false, "连接中...");
  try {
    const runtime = await loadAnnaRuntimeSdk();
    if (!runtime) throw new Error("AnnaAppRuntime SDK 未加载。请通过 anna-app dev 打开。");
    anna = await runtime.connect();
    setConnection(true, "已连接 Anna");
    addLog("ok", "runtime", "Anna runtime 连接成功");
    await refreshSessionCatalog();
    try {
      await anna.window?.set_title?.({ title: "Session 生命周期测试" });
    } catch (error) {
      addLog("warn", "runtime", "设置窗口标题失败", error);
    }
  } catch (error) {
    anna = null;
    setConnection(false, "未连接");
    addLog("error", "runtime", "Anna runtime 连接失败，操作已禁用", error);
  }
}

async function createSession() {
  if (!canUseSession()) return;
  const mode = getToolMode();
  const requestedTools = currentRequestedTools();
  let createInput;
  try {
    createInput = buildSessionCreateInput({
      mode,
      selectedTools: getCheckedToolNames(),
      manualTools: els.manual_tools.value,
      systemPrompt: els.create_system_prompt.value,
    });
  } catch (error) {
    addLog("warn", "session.create", error?.message || String(error));
    if (mode === TOOL_MODES.MANUAL) els.manual_tools.focus();
    return;
  }
  saveSettings();
  const modelId = els.session_model.value.trim();
  const policyLabel = toolPolicyLabel(mode, requestedTools);
  const entry = beginOperation("session", "session.create", {
    ...createInput,
    ui_selection: {
      tool_mode: mode,
      requested_tools: requestedTools,
      default_model_preference: modelId || null,
    },
  });
  addLog("ok", "session.create", "开始创建 raw agent session", entry.record.record_id);
  try {
    const raw = await anna.agent.session.create(createInput);
    appendRecordEvent(entry, "session.create.response_received");
    const normalized = normalizeCreateResult(raw);
    if (!normalized.app_session_uuid) throw new Error("session.create 结果缺少 app_session_uuid");
    upsertSession({
      ...normalized,
      system_prompt: normalized.system_prompt ?? createInput.systemPrompt ?? "",
      source: "created",
      state: "held",
      tool_mode: mode,
      requested_tools: requestedTools,
      tool_policy: policyLabel,
      model_id: modelId,
    });
    selectedSessionId = normalized.app_session_uuid;
    writeSavedSessionIds([...savedSessionIds, normalized.app_session_uuid]);
    const record = await finishOperation(entry, "succeeded", { response: raw, session: normalized });
    addLog("ok", "session.create", "session.create 完成", { record_id: record.record_id, duration_ms: record.duration_ms });
  } catch (error) {
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    addLog("error", "session.create", "创建 session 失败", error);
  }
}

function attachManualSession() {
  const id = getManualSessionId();
  if (!id) return;
  upsertSession({
    app_session_uuid: id,
    source: "manual",
    state: "attached",
    model_id: els.session_model.value.trim(),
  });
  selectedSessionId = id;
  addLog("ok", "ui", "手动 session id 已加入持有列表", id);
  render();
}

function saveSelectedSession() {
  if (!selectedSessionId) return;
  writeSavedSessionIds([...savedSessionIds, selectedSessionId]);
  addLog("ok", "storage", "已保存选中 session id 到 localStorage", selectedSessionId);
}

function extractFrameText(frame) {
  if (!frame || typeof frame !== "object") return "";
  if (typeof frame.text === "string") return frame.text;
  if (typeof frame.content === "string") return frame.content;
  if (typeof frame.delta === "string") return frame.delta;
  if (Array.isArray(frame.choices)) {
    return frame.choices.map((choice) => {
      const delta = choice?.delta || {};
      const message = choice?.message || {};
      return [delta.content, delta.text, message.content]
        .filter((item) => typeof item === "string").join("");
    }).join("");
  }
  return "";
}

function isSessionDiagnosticFrame(frame) {
  if (!frame || typeof frame !== "object") return false;
  if (["run_meta", "tool_call", "tool_result", "task_complete"].includes(frame.event)) return true;
  const choices = Array.isArray(frame.choices) ? frame.choices : [];
  return choices.some((choice) => {
    const delta = choice?.delta || {};
    return Boolean(delta.tool_start || delta.tool_end || delta.task_complete || delta.run_meta);
  });
}

function createRawSessionRunCollector(entry) {
  const earlyFrames = [];
  const textChunks = [];
  let targetStreamId = "";
  let settled = false;
  let unsubscribe = null;
  let resolveDone;
  let rejectDone;
  let lastFramePerf = null;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => undefined);

  function cleanup() {
    if (typeof unsubscribe === "function") unsubscribe();
    unsubscribe = null;
  }

  function consumeCaptured(captured) {
    const { payload, receivedAt, receivedPerf } = captured;
    if (settled || !payload || typeof payload !== "object") return;
    if (!targetStreamId) {
      earlyFrames.push(captured);
      return;
    }
    if (payload.stream_id !== targetStreamId) return;
    const frame = payload.payload;
    const frameElapsed = elapsedMs(entry.startedPerf, receivedPerf);
    const gap = lastFramePerf == null ? null : elapsedMs(lastFramePerf, receivedPerf);
    lastFramePerf = receivedPerf;
    const frameEntry = {
      index: entry.record.stream_frames.length,
      received_at: receivedAt,
      elapsed_ms: frameElapsed,
      gap_ms: gap,
      envelope: payload,
    };
    entry.record.stream_frames.push(toSerializable(frameEntry));
    entry.record.metrics.frame_count = entry.record.stream_frames.length;
    if (frame != null && entry.record.metrics.first_frame_ms == null) {
      entry.record.metrics.first_frame_ms = frameElapsed;
      entry.record.metrics.first_frame_at = receivedAt;
    }
    if (gap != null) entry.record.metrics.max_frame_gap_ms = Math.max(entry.record.metrics.max_frame_gap_ms || 0, gap);
    appendRecordEvent(entry, "session.run.stream_frame", {
      frame_index: frameEntry.index, stream_id: targetStreamId, done: payload.done === true,
    });
    if (frame != null) {
      addLog("ok", "stream", "收到 stream frame", frame);
      const text = extractFrameText(frame);
      if (text) {
        textChunks.push(text);
        if (entry.record.metrics.first_text_ms == null) {
          entry.record.metrics.first_text_ms = frameElapsed;
          entry.record.metrics.first_text_at = receivedAt;
        }
      }
      if (frame?.event === "error") {
        settled = true;
        cleanup();
        rejectDone(new Error(frame.message || "session.run stream error"));
        return;
      }
    }
    void queueRecordSave(entry.record);
    if (isSessionDiagnosticFrame(frame)) renderSessionInspector();
    if (payload.done) {
      settled = true;
      cleanup();
      resolveDone({ frames: entry.record.stream_frames, text: textChunks.join("") });
    }
  }

  return {
    start(runtime) {
      unsubscribe = runtime.on("rpc.stream", (payload) => consumeCaptured({
        payload, receivedAt: nowIso(), receivedPerf: performance.now(),
      }));
    },
    attach(streamId) {
      targetStreamId = streamId;
      for (const captured of earlyFrames.splice(0)) consumeCaptured(captured);
    },
    cancel(error) {
      if (settled) return;
      settled = true;
      cleanup();
      rejectDone(error);
    },
    done,
  };
}

// The stream-derived fields a session.run record carries beyond the shared
// operation shape. Both the Session tab and the batch tab fill them the same
// way, so the collector can be reused verbatim.
function prepareSessionRunRecord(entry) {
  entry.record.stream_id = "";
  entry.record.run_id = "";
  entry.record.stream_frames = [];
  entry.record.output_text = "";
  entry.record.metrics = {
    run_rpc_ms: null, first_frame_ms: null, first_frame_at: null,
    first_text_ms: null, first_text_at: null,
    stream_complete_ms: null, frame_count: 0, max_frame_gap_ms: 0,
  };
}

async function runSessionById(id, source) {
  if (!canUseSession() || !id || activeSessionRecordId || imageUploadBusy) return;
  const content = els.run_content.value.trim();
  if (!content) {
    addLog("warn", "session.run", "User prompt 为空，已跳过");
    return;
  }
  saveSettings();
  const session = sessions.find((item) => item.app_session_uuid === id) || null;
  const modelId = (session?.model_id ?? els.session_model.value).trim();
  let attachments;
  try {
    attachments = buildSessionImageAttachments(sessionImages, els.session_image_detail.value);
  } catch (error) {
    imageStatus(error.message, true);
    return;
  }
  const rpcInput = buildSessionRunInput({
    appSessionUuid: id,
    userPrompt: content,
    systemPrompt: els.run_system_prompt.value,
    modelId,
    attachments,
  });
  const runInput = {
    ...rpcInput,
    source,
    requested_model: modelId || null,
    ...(attachments.length ? { image_upload_record_ids: [...new Set(sessionImages.map((image) => image.uploadRecordId))] } : {}),
  };
  const entry = beginOperation("session", "session.run", runInput);
  prepareSessionRunRecord(entry);
  selectedSessionId = id;
  updateSession(id, { state: "running", last_error: "" });
  addLog("ok", "session.run", "开始 raw session.run", { record_id: entry.record.record_id, app_session_uuid: id });
  const collector = createRawSessionRunCollector(entry);
  try {
    collector.start(anna);
    const runResult = await anna.agent.session.run(rpcInput);
    entry.record.metrics.run_rpc_ms = elapsedMs(entry.startedPerf);
    entry.record.response = { rpc_response: toSerializable(runResult) };
    appendRecordEvent(entry, "session.run.rpc_response", { duration_ms: entry.record.metrics.run_rpc_ms });
    const streamId = runResult?.stream_id || runResult?.streamId || "";
    if (!streamId) throw new Error("session.run 结果缺少 stream_id");
    entry.record.stream_id = streamId;
    entry.record.run_id = runResult?.run_id || runResult?.runId || "";
    collector.attach(streamId);
    void queueRecordSave(entry.record);
    const collected = await collector.done;
    entry.record.metrics.stream_complete_ms = elapsedMs(entry.startedPerf);
    entry.record.output_text = collected.text;
    updateSession(id, { state: "held", last_run_at: new Date().toISOString(), last_error: "" });
    const record = await finishOperation(entry, "succeeded");
    addLog("ok", "session.run", "session.run 完成", {
      record_id: record.record_id, stream_id: streamId, duration_ms: record.duration_ms,
      first_frame_ms: record.metrics.first_frame_ms, frame_count: record.metrics.frame_count,
    });
  } catch (error) {
    collector.cancel(error instanceof Error ? error : new Error(String(error)));
    updateSession(id, { state: "error", last_error: String(error?.message || error) });
    const record = await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    addLog("error", "session.run", "session.run 失败", { record_id: record.record_id, error });
  }
}

// ─── Batch tab ──────────────────────────────────────────────────────────────
//
// Every batch RPC is recorded under the `batch` category rather than `session`,
// which keeps `activeSessionRecordId` — the Session tab's single-flight guard —
// out of the way while N pipelines run at once, and lets the records page filter
// batch traffic apart from hand-driven calls.

const BATCH_ROW_LABELS = Object.freeze({
  pending: "等待开始",
  creating: "创建 Session",
  running: "运行中",
  writing: "写入文件",
  cleaning: "清理 Session",
  succeeded: "成功",
  failed: "失败",
});

function batchStatusText() {
  if (batchRunning) {
    const done = batchRows.filter((row) => row.status === "succeeded" || row.status === "failed").length;
    return `运行中：${done}/${batchRows.length} 已结束`;
  }
  if (batchSummary) return batchSummary.failed > 0 ? "已结束（有失败）" : "已完成";
  return "未开始";
}

function renderBatchProgress() {
  els.batch_status.textContent = batchStatusText();
  els.batch_tally.textContent = batchSummary
    ? `${batchSummary.succeeded} 成功 / ${batchSummary.failed} 失败`
    : (batchRunning ? "统计中…" : "-");
  els.batch_duration.textContent = batchSummary?.duration_ms == null
    ? (batchRunning ? "计时中…" : "-")
    : `${batchSummary.duration_ms} ms`;
  els.batch_copy_summary.disabled = batchRows.length === 0;

  els.batch_progress_list.replaceChildren();
  if (batchRows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "还没有运行过批量测试。填好配置后点击“开始批量测试”。";
    els.batch_progress_list.appendChild(empty);
    return;
  }
  for (const row of batchRows) {
    els.batch_progress_list.appendChild(createBatchRowItem(row));
  }
}

function createBatchRowItem(row) {
  const item = document.createElement("li");
  item.className = `batch-row batch-row--${row.status}`;

  const head = document.createElement("div");
  head.className = "batch-row__head";
  const title = document.createElement("strong");
  title.textContent = `第 ${row.index} 次`;
  const status = document.createElement("span");
  status.className = `record-status record-status--${row.status}`;
  status.textContent = BATCH_ROW_LABELS[row.status] || row.status;
  head.append(title, status);
  item.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "batch-row__meta";
  meta.textContent = [
    row.session_id ? `session=${row.session_id}` : "",
    row.run_ms == null ? "" : `run ${row.run_ms} ms`,
    row.total_ms == null ? "" : `总计 ${row.total_ms} ms`,
    row.bytes == null ? "" : `${row.bytes} B`,
    row.deleted === false ? "未能删除 Session" : "",
  ].filter(Boolean).join(" · ") || "等待中";
  item.appendChild(meta);

  if (row.output_path) {
    const path = document.createElement("p");
    path.className = "batch-row__path";
    path.textContent = row.output_path;
    item.appendChild(path);
  }
  if (row.error) {
    const error = document.createElement("p");
    error.className = "batch-row__error";
    error.textContent = row.error;
    item.appendChild(error);
  }
  return item;
}

function setBatchRow(row, patch) {
  Object.assign(row, patch);
  renderBatchProgress();
}

async function createBatchSession(index, createInput) {
  const entry = beginOperation("batch", "session.create", { ...createInput, batch_index: index });
  try {
    const raw = await anna.agent.session.create(createInput);
    const normalized = normalizeCreateResult(raw);
    if (!normalized.app_session_uuid) throw new Error("session.create 结果缺少 app_session_uuid");
    await finishOperation(entry, "succeeded", { response: raw, session: normalized });
    return normalized.app_session_uuid;
  } catch (error) {
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    throw error;
  }
}

async function runBatchSession(index, appSessionUuid, runTemplate) {
  const rpcInput = buildSessionRunInput({ appSessionUuid, ...runTemplate });
  const entry = beginOperation("batch", "session.run", { ...rpcInput, batch_index: index });
  prepareSessionRunRecord(entry);
  // Each collector filters `rpc.stream` by its own stream_id, so N of them can
  // listen at once; frames that arrive before the RPC returns are buffered and
  // replayed on attach.
  const collector = createRawSessionRunCollector(entry);
  try {
    collector.start(anna);
    const runResult = await anna.agent.session.run(rpcInput);
    entry.record.metrics.run_rpc_ms = elapsedMs(entry.startedPerf);
    entry.record.response = { rpc_response: toSerializable(runResult) };
    const streamId = runResult?.stream_id || runResult?.streamId || "";
    if (!streamId) throw new Error("session.run 结果缺少 stream_id");
    entry.record.stream_id = streamId;
    entry.record.run_id = runResult?.run_id || runResult?.runId || "";
    collector.attach(streamId);
    void queueRecordSave(entry.record);
    const collected = await collector.done;
    entry.record.metrics.stream_complete_ms = elapsedMs(entry.startedPerf);
    entry.record.output_text = collected.text;
    const record = await finishOperation(entry, "succeeded");
    return { text: collected.text, duration_ms: record.duration_ms };
  } catch (error) {
    collector.cancel(error instanceof Error ? error : new Error(String(error)));
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    throw error;
  }
}

async function deleteBatchSession(index, appSessionUuid) {
  const entry = beginOperation("batch", "session.delete", { app_session_uuid: appSessionUuid, batch_index: index });
  try {
    const result = await anna.agent.session.delete({ app_session_uuid: appSessionUuid });
    await finishOperation(entry, "succeeded", { response: result });
    return true;
  } catch (error) {
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    addLog("error", "batch", `第 ${index} 次的 session.delete 失败，Session 可能仍然存在`, error);
    return false;
  }
}

async function writeBatchOutput(index, config, { content, failed }) {
  const filename = buildOutputFilename({
    prefix: config.outputPrefix,
    suffix: config.outputSuffix,
    index,
    failed,
  });
  // The Executa reports the real UTF-8 byte count in its response; the request
  // only records the JS string length so the two are not confused.
  const entry = beginOperation("batch", "batch.write_file", {
    dir: config.outputDir, filename, content_length: content.length, batch_index: index, failed,
  });
  try {
    const written = await writeOutputFile(anna, { dir: config.outputDir, filename, content });
    await finishOperation(entry, "succeeded", { response: written });
    return written;
  } catch (error) {
    await finishOperation(entry, "failed", { error });
    throw error;
  }
}

function describeBatchFailure(index, error) {
  return [
    `第 ${index} 次批量运行失败`,
    `时间：${nowIso()}`,
    `错误：${error?.message || String(error)}`,
  ].join("\n");
}

/**
 * One independent pipeline: create → run → write → delete.
 *
 * The delete runs in `finally` so a failed run still releases its Session; the
 * whole point of the batch tab is that the user never manages Session lifetime
 * by hand. A failure is written out as `<prefix>_<n>.error.<suffix>` so the
 * output directory records what happened rather than just omitting the index.
 */
async function runBatchPipeline(index, { config, createInput, runTemplate }) {
  const row = batchRows[index - 1];
  const startedPerf = performance.now();
  let appSessionUuid = "";
  try {
    setBatchRow(row, { status: "creating" });
    appSessionUuid = await createBatchSession(index, createInput);
    setBatchRow(row, { status: "running", session_id: appSessionUuid });

    const run = await runBatchSession(index, appSessionUuid, runTemplate);
    setBatchRow(row, { status: "writing", run_ms: run.duration_ms });

    const written = await writeBatchOutput(index, config, { content: run.text, failed: false });
    setBatchRow(row, { output_path: written.path, bytes: written.bytes });
    return { output_path: written.path, bytes: written.bytes };
  } catch (error) {
    const message = error?.message || String(error);
    setBatchRow(row, { error: message });
    // A write failure here almost certainly repeats (bad directory, missing
    // Executa), so the .error file is best-effort and its own failure is
    // appended to the row rather than replacing the original cause.
    try {
      const written = await writeBatchOutput(index, config, {
        content: describeBatchFailure(index, error),
        failed: true,
      });
      setBatchRow(row, { output_path: written.path, bytes: written.bytes });
    } catch (writeError) {
      setBatchRow(row, { error: `${message}（错误文件也未能写入：${writeError?.message || writeError}）` });
    }
    throw error;
  } finally {
    if (appSessionUuid) {
      setBatchRow(row, { status: row.error ? "failed" : "cleaning" });
      const deleted = await deleteBatchSession(index, appSessionUuid);
      setBatchRow(row, { deleted });
    }
    setBatchRow(row, { status: row.error ? "failed" : "succeeded", total_ms: elapsedMs(startedPerf) });
  }
}

function buildBatchSummaryReport() {
  return {
    summary: batchSummary,
    rows: batchRows.map((row) => ({ ...row })),
  };
}

async function startBatchRun() {
  if (batchRunning || !canUseSession()) return;
  els.batch_config_error.hidden = true;

  let config;
  let createInput;
  const userPrompt = els.batch_run_content.value.trim();
  try {
    if (!canUseBatchWriter(anna)) {
      throw new Error("当前 Runtime 不提供 tools.invoke，无法写入输出文件。请通过 anna-app dev 打开。");
    }
    if (!userPrompt) throw new Error("User prompt 不能为空");
    config = normalizeBatchConfig({
      concurrency: els.batch_concurrency.value,
      outputDir: els.batch_output_dir.value,
      outputPrefix: els.batch_output_prefix.value,
      outputSuffix: els.batch_output_suffix.value,
    });
    createInput = buildSessionCreateInput({
      mode: getBatchToolMode(),
      selectedTools: getBatchCheckedToolNames(),
      manualTools: els.batch_manual_tools.value,
      systemPrompt: els.batch_create_system_prompt.value,
    });
  } catch (error) {
    els.batch_config_error.hidden = false;
    els.batch_config_error.textContent = error?.message || String(error);
    return;
  }
  saveSettings();

  const runTemplate = {
    userPrompt,
    systemPrompt: els.batch_run_system_prompt.value,
    modelId: els.batch_session_model.value.trim(),
  };

  batchRunning = true;
  batchSummary = null;
  batchRows = Array.from({ length: config.concurrency }, (_unused, offset) => ({
    index: offset + 1,
    status: "pending",
    session_id: "",
    output_path: "",
    error: "",
    run_ms: null,
    total_ms: null,
    bytes: null,
    deleted: null,
  }));
  render();
  renderBatchProgress();

  const startedPerf = performance.now();
  try {
    // Fail before any Session is created if the directory is unusable — a bad
    // path should cost zero platform calls.
    await ensureOutputDir(anna, config.outputDir);
  } catch (error) {
    batchRunning = false;
    batchRows = [];
    els.batch_config_error.hidden = false;
    els.batch_config_error.textContent = error?.message || String(error);
    render();
    renderBatchProgress();
    return;
  }

  addLog("ok", "batch", "开始批量测试", { ...config, user_prompt_length: userPrompt.length });
  try {
    const results = await runBatch({
      total: config.concurrency,
      task: (index) => runBatchPipeline(index, { config, createInput, runTemplate }),
    });
    batchSummary = {
      ...summarizeBatch(results),
      duration_ms: elapsedMs(startedPerf),
      output_dir: config.outputDir,
      filename_pattern: buildOutputFilename({
        prefix: config.outputPrefix, suffix: config.outputSuffix, index: "<第几次>",
      }),
    };
    addLog(batchSummary.failed > 0 ? "warn" : "ok", "batch", "批量测试结束", batchSummary);
  } finally {
    batchRunning = false;
    render();
    renderBatchProgress();
    await loadRecords();
  }
}

function renderBatchControls() {
  const mode = getBatchToolMode();
  els.batch_selected_tools_panel.hidden = mode !== TOOL_MODES.SELECTED;
  els.batch_manual_tools_panel.hidden = mode !== TOOL_MODES.MANUAL;
  const warnings = toolPolicyWarnings(mode, currentBatchRequestedTools());
  els.batch_tool_policy_warning.hidden = warnings.length === 0;
  els.batch_tool_policy_warning.textContent = warnings.join(" ");
  els.batch_start.disabled = !canUseSession() || batchRunning;
  els.batch_start.textContent = batchRunning ? "批量测试运行中…" : "开始批量测试";
  for (const element of [
    els.batch_concurrency, els.batch_output_dir, els.batch_output_prefix, els.batch_output_suffix,
    els.batch_session_model, els.batch_run_system_prompt, els.batch_run_content,
    els.batch_create_system_prompt, els.batch_manual_tools,
  ]) {
    element.disabled = batchRunning;
  }
}

async function deleteSessionById(id, source = "session.delete") {
  if (!canUseSession() || !id) return false;
  const entry = beginOperation("session", "session.delete", { app_session_uuid: id, source });
  addLog("ok", source, "开始 raw session.delete", { record_id: entry.record.record_id, app_session_uuid: id });
  try {
    const result = await anna.agent.session.delete({ app_session_uuid: id });
    removeSession(id);
    const record = await finishOperation(entry, "succeeded", { response: result });
    addLog("ok", source, "session.delete 完成", { record_id: record.record_id, duration_ms: record.duration_ms });
    return true;
  } catch (error) {
    updateSession(id, { state: "delete_error", last_error: String(error?.message || error) });
    await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    addLog("error", source, "session.delete 失败", error);
    return false;
  }
}

async function deleteSelectedSession() {
  const id = selectedSessionId;
  if (!id) return;
  if (await deleteSessionById(id)) writeSavedSessionIds(savedSessionIds.filter((item) => item !== id));
}

async function deleteAllSessions() {
  const ids = sessions.map((session) => session.app_session_uuid);
  addLog("warn", "cleanup", "开始清理当前持有的全部 sessions", { count: ids.length });
  for (const id of ids) await deleteSessionById(id, "cleanup");
  writeSavedSessionIds(savedSessionIds.filter((id) => !ids.includes(id)));
  addLog("ok", "cleanup", "全部清理流程结束");
}

async function runLlm() {
  if (!canUseLlm() || activeLlmRecordId || llmImageReadBusy) return;
  const systemPrompt = els.llm_system_prompt.value.trim();
  const userPrompt = els.llm_user_prompt.value.trim();
  const timeoutSeconds = Number(els.llm_timeout_seconds.value);
  if (!userPrompt) {
    addLog("warn", "llm.complete", "User prompt 不能为空");
    els.llm_user_prompt.focus();
    return;
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) {
    addLog("warn", "llm.complete", "超时时间必须在 10～600 秒之间");
    els.llm_timeout_seconds.focus();
    return;
  }
  saveSettings();
  let input;
  try {
    input = buildLlmInput(systemPrompt, userPrompt, llmImages);
  } catch (error) {
    llmImageStatus(error.message, true);
    return;
  }
  const invocationPath = selectLlmInvocationPath(anna);
  const timeoutMs = Math.round(timeoutSeconds * 1000);
  const entry = beginOperation("llm", "llm.complete", {
    input: summarizeLlmInput(input), images: llmImages.map((image) => imageFileMetadata(image.file)),
    timeout_ms: timeoutMs, invocation_path: invocationPath,
    timeout_applied_by_runtime: invocationPath === "runtime.call",
  });
  entry.record.invocation_path = invocationPath;
  entry.record.timeout_ms = timeoutMs;
  els.llm_invocation_path.textContent = invocationPath;
  els.llm_duration.textContent = "等待返回中...";
  addLog("ok", "llm.complete", "开始 LLM 调用", { record_id: entry.record.record_id, invocation_path: invocationPath });
  try {
    const invocation = await invokeAnnaLlm(anna, input, timeoutMs);
    const result = invocation.result;
    const diagnostics = extractLlmDiagnostics(result);
    const record = await finishOperation(entry, "succeeded", {
      response: result,
      output_text: diagnostics.output_text,
      response_metadata: {
        model: diagnostics.model,
        usage: diagnostics.token_usage,
        stop_reason: diagnostics.stop_reason,
        provider: diagnostics.provider,
        latency_ms: diagnostics.latency_ms,
        quota_consumed: diagnostics.quota_consumed,
        app_session_uuid: diagnostics.app_session_uuid,
      },
      timed_out: false,
    });
    lastLlmResult = record;
    if (!activeLlmRecordId) {
      renderLlmResult(record);
      els.llm_duration.textContent = `${record.duration_ms} ms`;
    }
    render();
    addLog("ok", "llm.complete", "LLM 调用完成", { record_id: record.record_id, duration_ms: record.duration_ms });
  } catch (error) {
    const record = await finishOperation(entry, "failed", { error, timed_out: isTimeoutError(error) });
    lastLlmResult = record;
    if (!activeLlmRecordId) {
      renderLlmResult(record);
      els.llm_duration.textContent = `${record.duration_ms} ms（失败）`;
    }
    render();
    addLog("error", "llm.complete", "LLM 调用失败", { record_id: record.record_id, error });
  }
}

async function loadRecords() {
  try {
    callRecords = await listCallRecords();
    if (selectedRecordId && !callRecords.some((record) => record.record_id === selectedRecordId)) selectedRecordId = "";
    renderRecords();
    renderSessionInspector();
  } catch (error) {
    addLog("error", "IndexedDB", "读取调用记录失败", error);
  }
}

function filteredRecords() {
  const category = els.record_category_filter.value;
  const status = els.record_status_filter.value;
  return callRecords.filter((record) =>
    (category === "all" || record.category === category) &&
    (status === "all" || record.status === status));
}

function renderRecords() {
  els.record_count.textContent = String(callRecords.length);
  els.record_list.innerHTML = "";
  const records = filteredRecords();
  if (records.length === 0) {
    els.record_list.innerHTML = '<li class="empty">当前筛选条件下没有调用记录。</li>';
  } else {
    for (const record of records) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `record-item${record.record_id === selectedRecordId ? " record-item--active" : ""}`;
      const title = document.createElement("span");
      title.className = "record-item__title";
      title.textContent = `${record.operation} · ${record.status}`;
      const meta = document.createElement("span");
      meta.className = "record-item__meta";
      meta.textContent = `${record.started_at || "-"} · ${record.duration_ms ?? "-"} ms`;
      const id = document.createElement("span");
      id.className = "record-item__id";
      id.textContent = record.stream_id ? `${record.record_id} · stream=${record.stream_id}` : record.record_id;
      button.append(title, meta, id);
      button.addEventListener("click", () => {
        selectedRecordId = record.record_id;
        renderRecords();
      });
      li.appendChild(button);
      els.record_list.appendChild(li);
    }
  }
  const selected = callRecords.find((record) => record.record_id === selectedRecordId) || null;
  renderResult(els.record_json, selected);
  els.copy_record.disabled = !selected;
  els.delete_record.disabled = !selected || liveOperations.has(selected.record_id);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    addLog("ok", "clipboard", `${label}已复制`);
  } catch (error) {
    addLog("error", "clipboard", `${label}复制失败`, error);
  }
}

async function clearRecordsConfirmed() {
  if (els.clear_records_confirmation.hidden || clearingRecords || batchRunning || liveOperations.size > 0) return;
  clearingRecords = true;
  els.record_action_status.hidden = false;
  els.record_action_status.textContent = "正在清空调用记录…";
  render();
  try {
    // Finish outstanding writes before clearing so an older snapshot cannot
    // restore records after the clear transaction.
    await Promise.all([...saveQueues.values()]);
    if (liveOperations.size > 0 || batchRunning) throw new Error("仍有请求或批量测试运行中，请等待结束后再清空。");
    await clearCallRecords();
    selectedRecordId = "";
    await loadRecords();
    els.clear_records_confirmation.hidden = true;
    els.record_action_status.textContent = "已清空全部调用记录。";
    addLog("ok", "IndexedDB", "已清空全部调用记录");
  } catch (error) {
    els.record_action_status.textContent = `清空失败：${error?.message || String(error)}`;
    addLog("error", "IndexedDB", "清空调用记录失败", error);
  } finally {
    clearingRecords = false;
    render();
    if (els.clear_records_confirmation.hidden) els.clear_records.focus();
  }
}

function switchTab(name) {
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("tab--active", button.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".tab-panel")) {
    panel.classList.toggle("tab-panel--active", panel.id === `tab-${name}`);
  }
  if (name === "records") void loadRecords();
}

function bindEvents() {
  els.llm_images.addEventListener("change", selectLlmImages);
  els.clear_llm_images.addEventListener("click", () => removeLlmImages(new Set(llmImages.map((image) => image.id))));
  els.session_images.addEventListener("change", () => {
    const files = [...els.session_images.files];
    els.session_images.value = "";
    if (imageUploadBusy || !files.length) return;
    try {
      validateImageSelection([...sessionImages.map((image) => image.file), ...files]);
      sessionImages.push(...files.map((file) => ({
        id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), status: "pending", upload: null,
      })));
      imageStatus(`已选择 ${sessionImages.length} 张图片，请先上传。`);
      render();
    } catch (error) {
      imageStatus(error.message, true);
    }
  });
  els.upload_session_images.addEventListener("click", uploadSelectedImages);
  els.clear_session_images.addEventListener("click", () => removeSessionImages(new Set(sessionImages.map((image) => image.id))));
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  }
  els.refresh_runtime.addEventListener("click", connectAnna);
  els.refresh_catalog.addEventListener("click", refreshSessionCatalog);
  for (const input of document.querySelectorAll('input[name="tool-mode"]')) {
    input.addEventListener("change", () => {
      saveSettings();
      render();
    });
  }
  els.manual_tools.addEventListener("input", () => {
    saveSettings();
    render();
  });
  els.select_read_only_tools.addEventListener("click", () => setCheckedTools([
    "fs_read_file", "fs_list_directory", "fs_search", "fs_get_info", "fs_exists",
  ]));
  els.select_file_read_write_tools.addEventListener("click", () => setCheckedTools([
    "fs_read_file", "fs_write_file", "fs_list_directory", "fs_search", "fs_get_info", "fs_exists", "fs_mkdir",
  ]));
  els.select_all_tools.addEventListener("click", () => setCheckedTools(PLATFORM_TOOL_OPTIONS.map((tool) => tool.name)));
  els.clear_selected_tools.addEventListener("click", () => setCheckedTools([]));
  els.create_session.addEventListener("click", createSession);
  els.attach_manual.addEventListener("click", attachManualSession);
  els.save_selected.addEventListener("click", saveSelectedSession);
  els.clear_saved.addEventListener("click", () => writeSavedSessionIds([]));
  els.delete_selected.addEventListener("click", deleteSelectedSession);
  els.delete_all.addEventListener("click", deleteAllSessions);
  els.stop_session_wait.addEventListener("click", () => stopWaiting("session"));
  els.run_selected.addEventListener("click", () => runSessionById(selectedSessionId, "selected"));
  els.run_manual.addEventListener("click", () => runSessionById(getManualSessionId(), "manual"));
  els.manual_session_id.addEventListener("input", render);
  els.session_model.addEventListener("change", () => {
    const modelId = els.session_model.value;
    if (selectedSessionId) updateSession(selectedSessionId, { model_id: modelId });
    saveSettings();
    render();
  });
  els.create_system_prompt.addEventListener("change", saveSettings);
  els.run_system_prompt.addEventListener("change", saveSettings);
  els.run_content.addEventListener("change", saveSettings);
  els.copy_session_report.addEventListener("click", () => {
    const records = selectedSessionRecords();
    if (records.length > 0) void copyText(JSON.stringify(buildSessionReport(records), null, 2), "Session 摘要");
  });
  for (const input of document.querySelectorAll('input[name="batch-tool-mode"]')) {
    input.addEventListener("change", () => {
      saveSettings();
      render();
    });
  }
  els.batch_manual_tools.addEventListener("input", () => {
    saveSettings();
    render();
  });
  els.batch_start.addEventListener("click", startBatchRun);
  els.batch_copy_summary.addEventListener("click", () => {
    if (batchRows.length > 0) void copyText(JSON.stringify(buildBatchSummaryReport(), null, 2), "批量摘要");
  });
  for (const input of [
    els.batch_concurrency, els.batch_output_dir, els.batch_output_prefix, els.batch_output_suffix,
    els.batch_session_model, els.batch_create_system_prompt, els.batch_run_system_prompt,
    els.batch_run_content,
  ]) {
    input.addEventListener("change", saveSettings);
  }
  els.run_llm.addEventListener("click", runLlm);
  els.stop_llm_wait.addEventListener("click", () => stopWaiting("llm"));
  els.copy_llm_result.addEventListener("click", () => copyText(buildLlmSummary(lastLlmResult), "LLM 摘要"));
  for (const input of [els.llm_system_prompt, els.llm_user_prompt, els.llm_timeout_seconds]) {
    input.addEventListener("change", saveSettings);
  }
  els.record_category_filter.addEventListener("change", renderRecords);
  els.record_status_filter.addEventListener("change", renderRecords);
  els.refresh_records.addEventListener("click", loadRecords);
  els.copy_all_records.addEventListener("click", async () => {
    await loadRecords();
    await copyText(JSON.stringify(callRecords, null, 2), "全部调用记录");
  });
  els.clear_records.addEventListener("click", () => {
    if (clearingRecords || batchRunning || liveOperations.size > 0) return;
    els.record_action_status.hidden = true;
    els.clear_records_confirmation.hidden = false;
    els.cancel_clear_records.focus();
  });
  els.cancel_clear_records.addEventListener("click", () => {
    if (clearingRecords) return;
    els.clear_records_confirmation.hidden = true;
    els.record_action_status.hidden = true;
    els.clear_records.focus();
  });
  els.confirm_clear_records.addEventListener("click", clearRecordsConfirmed);
  els.copy_record.addEventListener("click", () => {
    const record = callRecords.find((item) => item.record_id === selectedRecordId);
    if (record) void copyText(JSON.stringify(record, null, 2), "当前调用记录");
  });
  els.delete_record.addEventListener("click", async () => {
    if (!selectedRecordId) return;
    await deleteCallRecord(selectedRecordId);
    selectedRecordId = "";
    await loadRecords();
    addLog("ok", "IndexedDB", "已删除当前调用记录");
  });
}

function restoreSavedSessions() {
  savedSessionIds = readSavedSessionIds();
  for (const id of savedSessionIds) {
    upsertSession({ app_session_uuid: id, source: "localStorage", state: "restored" });
  }
  if (savedSessionIds.length > 0) {
    selectedSessionId = savedSessionIds[0];
    els.manual_session_id.value = savedSessionIds[0];
    addLog("ok", "storage", "从 localStorage 读取到持久化 session id", savedSessionIds);
  } else {
    addLog("ok", "storage", "localStorage 中没有持久化 session id");
  }
}

async function initialize() {
  renderModelOptions(els.session_model);
  renderModelOptions(els.batch_session_model);
  renderToolCheckboxes(DEFAULT_SELECTED_TOOLS);
  renderBatchToolCheckboxes(DEFAULT_SELECTED_TOOLS);
  bindEvents();
  restoreSettings();
  restoreSavedSessions();
  renderLlmResult(null);
  renderBatchProgress();
  renderResult(els.record_json, null);
  try {
    const interrupted = await markUnfinishedRecordsInterrupted();
    if (interrupted > 0) addLog("warn", "IndexedDB", "已将上次页面遗留的未完成记录标记为 interrupted", { count: interrupted });
  } catch (error) {
    addLog("error", "IndexedDB", "初始化调用记录存储失败", error);
  }
  await loadRecords();
  render();
  await connectAnna();
}

void initialize();
