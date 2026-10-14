#!/usr/bin/env node
/**
 * plugin.js — minimal Node stdio Executa that persists batch-test output to the
 * local filesystem.
 *
 * Why this Executa exists
 * -----------------------
 * The Session Lifecycle Test app ships as a `static-spa` bundle running inside
 * the Anna Host iframe. An iframe cannot write to an arbitrary local directory:
 * `a[download]` only reaches the browser download dir, and the File System
 * Access API is not guaranteed to be reachable from the host frame. An Executa
 * is an ordinary local process, so it has a normal filesystem — which is why
 * the batch tab hands it `{ dir, filename, content }` and lets it do the write.
 *
 * Two tools, both deliberately dumb:
 *
 * - `ensure_output_dir` — validate + create the target directory once, before a
 *   batch starts. Fails fast so a bad path costs zero session runs instead of N.
 * - `write_text_file`   — create the directory if needed and write one UTF-8
 *   text file. No templating, no path guessing, no cleanup.
 *
 * Both tools require `dir` to be ABSOLUTE. A relative path would resolve against
 * this process's cwd, which the UI cannot see and the user would not guess.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdio (`initialize` / `describe`
 * / `invoke` / `health`), matching docs/protocol-spec.md. Tool arguments arrive
 * as `params.arguments`; `parameters` (NOT MCP-style `input_schema`) is the
 * manifest shape the host's ToolDefinition reads.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const PROTOCOL_VERSION = "2.0";

// The host's stdio channel is line-based, so a tool call crosses it as a single
// JSON line. A model's final text is normally a few KB; this cap exists only to
// turn a pathological payload into a clear error instead of a parser crash.
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

const MANIFEST = {
  display_name: "Batch Output Writer",
  version: "0.1.0",
  description:
    "Writes batch session-test results to an absolute local directory. Exists because a static-spa iframe cannot write arbitrary local paths.",
  author: "Anna Developer",
  host_capabilities: [],
  tools: [
    {
      name: "ensure_output_dir",
      description:
        "Validate that `dir` is an absolute path and create it recursively. Call once before a batch run to fail fast on a bad path.",
      parameters: [
        {
          name: "dir",
          type: "string",
          required: true,
          description: "Absolute directory path, e.g. /Users/me/tmp/batch-out.",
        },
      ],
    },
    {
      name: "write_text_file",
      description:
        "Write one UTF-8 text file into an absolute directory, creating the directory if needed. Overwrites an existing file with the same name.",
      parameters: [
        {
          name: "dir",
          type: "string",
          required: true,
          description: "Absolute directory path the file is written into.",
        },
        {
          name: "filename",
          type: "string",
          required: true,
          description: "Bare filename with no path separators and no '..'.",
        },
        {
          name: "content",
          type: "string",
          required: false,
          description: "UTF-8 text body. Defaults to an empty file.",
        },
      ],
    },
  ],
};

const MANIFEST_TOOL_NAMES = MANIFEST.tools.map((tool) => tool.name);

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function invalidParams(message) {
  return new ToolError(-32602, message);
}

function makeResponse(id, result, error) {
  const response = { jsonrpc: "2.0", id: id ?? null };
  if (error !== undefined) response.error = error;
  else response.result = result;
  return response;
}

function readAbsoluteDir(args) {
  const dir = typeof args.dir === "string" ? args.dir.trim() : "";
  if (!dir) throw invalidParams("missing required 'dir'");
  if (!path.isAbsolute(dir)) {
    throw invalidParams(
      `'dir' must be an absolute path so the UI and this process agree on the location; got ${JSON.stringify(dir)}`,
    );
  }
  return path.resolve(dir);
}

// A bare filename only. Rejecting separators and '..' keeps a prefix/suffix
// typo from writing outside the directory the user picked.
function readBareFilename(args) {
  const filename = typeof args.filename === "string" ? args.filename.trim() : "";
  if (!filename) throw invalidParams("missing required 'filename'");
  if (filename.includes("\0")) throw invalidParams("'filename' must not contain a NUL byte");
  if (filename !== path.basename(filename) || filename === "." || filename === "..") {
    throw invalidParams(
      `'filename' must be a bare filename without path separators; got ${JSON.stringify(filename)}`,
    );
  }
  return filename;
}

async function ensureOutputDir(args) {
  const dir = readAbsoluteDir(args);
  let existed = false;
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw invalidParams(`'dir' exists but is not a directory: ${dir}`);
    existed = true;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dir, { recursive: true });
  return { ok: true, dir, existed };
}

async function writeTextFile(args) {
  const dir = readAbsoluteDir(args);
  const filename = readBareFilename(args);
  const content = typeof args.content === "string" ? args.content : "";
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw invalidParams(
      `'content' is ${bytes} bytes, above the ${MAX_CONTENT_BYTES}-byte stdio limit for a single tool call`,
    );
  }
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, filename);
  await writeFile(target, content, "utf8");
  return { ok: true, path: target, dir, filename, bytes, written_at: new Date().toISOString() };
}

const TOOL_DISPATCH = {
  ensure_output_dir: ensureOutputDir,
  write_text_file: writeTextFile,
};

async function handleInvoke(id, params = {}) {
  const tool = params.tool;
  const args = params.arguments ?? {};
  if (!tool || typeof tool !== "string") {
    return makeResponse(id, undefined, { code: -32602, message: "Missing 'tool' in params" });
  }
  const fn = TOOL_DISPATCH[tool];
  if (!fn) {
    return makeResponse(id, undefined, {
      code: -32601,
      message: `Unknown tool: ${tool}`,
      data: { available_tools: MANIFEST_TOOL_NAMES },
    });
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return makeResponse(id, undefined, { code: -32602, message: "'arguments' must be an object" });
  }
  try {
    const data = await fn(args);
    // Host InvokeResult reads `success`; the payload's `ok` is not a protocol
    // success flag. Keep both tools inside the standard Executa envelope.
    return makeResponse(id, { success: true, data, tool });
  } catch (error) {
    const code = error instanceof ToolError ? error.code : -32603;
    return makeResponse(id, undefined, {
      code,
      message: error instanceof Error ? error.message : "Tool execution failed",
      ...(error?.code && typeof error.code === "string" ? { data: { errno: error.code } } : {}),
    });
  }
}

async function handleRequest(request) {
  const { id, method, params = {} } = request;
  switch (method) {
    case "initialize":
      return makeResponse(id, {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        serverInfo: { name: MANIFEST.display_name, version: MANIFEST.version },
        capabilities: {},
      });
    case "describe":
      return makeResponse(id, MANIFEST);
    case "invoke":
      return handleInvoke(id, params);
    case "health":
      return makeResponse(id, {
        status: "healthy",
        timestamp: new Date().toISOString(),
        version: MANIFEST.version,
        tools_count: MANIFEST.tools.length,
      });
    default:
      return makeResponse(id, undefined, { code: -32601, message: `Method not found: ${method}` });
  }
}

const rl = readline.createInterface({ input: process.stdin });
let shuttingDown = false;
let pending = 0;

function exitWhenDrained() {
  if (shuttingDown && pending === 0) process.exit(0);
}

process.stderr.write("🗂  batch-writer Executa started\n");
process.stderr.write(`   Tools: ${MANIFEST_TOOL_NAMES.join(", ")}\n`);

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed || shuttingDown) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(makeResponse(null, undefined, { code: -32700, message: `Parse error: ${error.message}` }))}\n`,
    );
    return;
  }
  // Responses to reverse-RPC we never send; nothing to correlate.
  if (!request || typeof request !== "object" || !("method" in request)) return;

  pending += 1;
  try {
    const response = await handleRequest(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(makeResponse(request.id, undefined, {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      }))}\n`,
    );
  } finally {
    pending -= 1;
    exitWhenDrained();
  }
});

rl.on("close", () => {
  shuttingDown = true;
  exitWhenDrained();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`Received ${signal}; shutting down\n`);
    rl.close();
  });
}
