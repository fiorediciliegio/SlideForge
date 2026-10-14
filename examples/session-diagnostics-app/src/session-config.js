export const TOOL_MODES = Object.freeze({
  ALL: "all",
  SELECTED: "selected",
  MANUAL: "manual",
});

export const PLATFORM_TOOL_OPTIONS = Object.freeze([
  { name: "web_search", group: "Web", access: "read" },
  { name: "sheet_read", group: "Documents", access: "read" },
  { name: "doc_read", group: "Documents", access: "read" },
  { name: "fs_read_file", group: "Filesystem", access: "read" },
  { name: "fs_write_file", group: "Filesystem", access: "write" },
  { name: "fs_list_directory", group: "Filesystem", access: "read" },
  { name: "fs_copy_file", group: "Filesystem", access: "write" },
  { name: "fs_move_file", group: "Filesystem", access: "write" },
  { name: "fs_delete_file", group: "Filesystem", access: "destructive" },
  { name: "fs_search", group: "Filesystem", access: "read" },
  { name: "fs_get_info", group: "Filesystem", access: "read" },
  { name: "fs_exists", group: "Filesystem", access: "read" },
  { name: "fs_mkdir", group: "Filesystem", access: "write" },
  { name: "exec_run", group: "Commands", access: "destructive" },
  { name: "exec_run_commands", group: "Commands", access: "destructive" },
  { name: "browser_create_instance", group: "Browser", access: "browser" },
  { name: "browser_navigate", group: "Browser", access: "browser" },
  { name: "browser_get_html", group: "Browser", access: "read" },
  { name: "browser_click", group: "Browser", access: "browser" },
  { name: "browser_fill", group: "Browser", access: "browser" },
  { name: "browser_screenshot", group: "Browser", access: "read" },
  { name: "browser_scroll", group: "Browser", access: "browser" },
  { name: "browser_execute_script", group: "Browser", access: "destructive" },
  { name: "browser_wait_for_element", group: "Browser", access: "read" },
  { name: "browser_toolkit", group: "Browser", access: "browser" },
]);

export const DEFAULT_SELECTED_TOOLS = Object.freeze(["fs_read_file"]);

export const MODEL_OPTIONS = Object.freeze([
  {
    group: "Claude",
    models: [
      { label: "Claude Fable 5.1", id: "anthropic/claude-fable-5.1" },
      { label: "Claude Opus 4.5", id: "anthropic/claude-opus-4.5" },
      { label: "Claude Opus 5", id: "anthropic/claude-opus-5" },
      { label: "Claude Sonnet 4.5", id: "anthropic/claude-sonnet-4.5" },
      { label: "Claude Sonnet 5", id: "anthropic/claude-sonnet-5" },
    ],
  },
  {
    group: "Gemini",
    models: [
      { label: "Gemini 2.5 Pro", id: "google/gemini-2.5-pro" },
      { label: "Gemini 3 Flash Preview", id: "google/gemini-3-flash-preview" },
      { label: "Gemini 3.1 Flash Lite Preview", id: "google/gemini-3.1-flash-lite-preview" },
      { label: "Gemini 3.5 Flash", id: "google/gemini-3.5-flash" },
      { label: "Gemini 3.8 Flash", id: "google/gemini-3.8-flash" },
    ],
  },
  {
    group: "Gemma",
    models: [
      { label: "Gemma 4 E4B-it", id: "gemma-4-E4B-it" },
    ],
  },
  {
    group: "GPT",
    models: [
      { label: "GPT-5 Mini", id: "openai/gpt-5-mini" },
      { label: "GPT-5.1", id: "openai/gpt-5.1" },
      { label: "GPT-5.3 Chat", id: "openai/gpt-5.3-chat" },
      { label: "GPT-5.6 Luna", id: "openai/gpt-5.6-luna" },
      { label: "GPT-5.6 Luna Pro", id: "openai/gpt-5.6-luna-pro" },
    ],
  },
  {
    group: "Kimi",
    models: [
      { label: "Kimi K2.5", id: "moonshotai/kimi-k2.5" },
      { label: "Kimi K2.6", id: "moonshotai/kimi-k2.6" },
    ],
  },
  {
    group: "MiMo",
    models: [
      { label: "MiMo-V2.5", id: "xiaomi/mimo-v2.5" },
      { label: "MiMo-V2.5-Pro", id: "xiaomi/mimo-v2.5-pro" },
    ],
  },
  {
    group: "MiniMax",
    models: [
      { label: "MiniMax M2.7", id: "minimax/minimax-m2.7" },
      { label: "MiniMax M3", id: "minimax/minimax-m3" },
    ],
  },
  {
    group: "Qwen",
    models: [
      { label: "Qwen3.6 Flash", id: "qwen3.6-flash" },
      { label: "Qwen3.7 Max", id: "qwen3.7-max" },
      { label: "Qwen3.7 Plus", id: "qwen3.7-plus" },
      { label: "Qwen3.8 Flash", id: "qwen3.8-flash" },
      { label: "Qwen3.8 Max", id: "qwen3.8-max" },
    ],
  },
]);

export function uniqueToolNames(values) {
  return [...new Set((values || [])
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

export function parseManualTools(value) {
  if (typeof value !== "string") return [];
  return uniqueToolNames(value.split(/[\s,，;；]+/));
}

export function selectedToolsForMode({ mode, selectedTools, manualTools }) {
  if (mode === TOOL_MODES.MANUAL) return parseManualTools(manualTools);
  if (mode === TOOL_MODES.SELECTED) return uniqueToolNames(selectedTools);
  return [];
}

function normalizedPrompt(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildSessionCreateInput({ mode, selectedTools, manualTools, systemPrompt }) {
  const normalizedSystemPrompt = normalizedPrompt(systemPrompt);
  if (mode === TOOL_MODES.ALL) {
    return {
      submode: "auto",
      quotaCaps: { inherit_host_tools: true },
      ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
    };
  }

  const allowedTools = selectedToolsForMode({ mode, selectedTools, manualTools });

  return {
    submode: "auto",
    quotaCaps: {
      inherit_host_tools: false,
      allowed_tools: allowedTools,
    },
    ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
  };
}

export function buildModelPreferences(modelId) {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  return normalized ? { hints: [{ name: normalized }] } : undefined;
}

export function buildSessionRunInput({ appSessionUuid, userPrompt, systemPrompt, modelId, attachments = [] }) {
  const content = normalizedPrompt(userPrompt);
  if (!content) throw new Error("User prompt 不能为空");
  const normalizedSystemPrompt = normalizedPrompt(systemPrompt);
  const modelPreferences = buildModelPreferences(modelId);
  return {
    app_session_uuid: appSessionUuid,
    content,
    ...(attachments.length ? { attachments: attachments.map((attachment) => ({ ...attachment })) } : {}),
    ...(normalizedSystemPrompt ? { systemPrompt: normalizedSystemPrompt } : {}),
    ...(modelPreferences ? { modelPreferences } : {}),
  };
}

export function unknownToolNames(toolNames, catalog) {
  const catalogNames = new Set((catalog?.platform_tools || [])
    .map((item) => item?.name)
    .filter((name) => typeof name === "string" && name));
  if (catalogNames.size === 0) return [];
  return uniqueToolNames(toolNames).filter((name) => !catalogNames.has(name));
}
