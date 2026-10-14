import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeToolRequest, decodeToolResponse } from "../helpers/invoke.ts";
import { createUserTemplate, publishUserTemplate, saveUserTemplateHtml, selectUserTemplatePages } from "../../src/user-templates/index.ts";
import { rasterizePptxToImages } from "../../src/pptx-rasterization/index.ts";

type JsonRpcResponse = {
  id: string | number | null;
  __file_transport?: string;
  __trans_file__?: string;
  result?: { success?: boolean; data?: { templates?: Array<Record<string, unknown>> } & Record<string, unknown> };
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
      const transportPath = response.__file_transport ?? response.__trans_file__;
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

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<JsonRpcResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.child.stdin.write(`${JSON.stringify(await encodeToolRequest({ jsonrpc: "2.0", id, method, params }))}\n`);
    return promise.then(decodeToolResponse);
  }

  async close() {
    this.lines.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    await exited;
  }
}

async function startPluginProcess(workspaceRoot: string): Promise<PluginProcess> {
  const child = spawn(process.execPath, ["example_plugin.js"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ANNA_WORKSPACE_DIR: workspaceRoot },
  });
  child.stderr.resume();
  return new PluginProcess(child);
}

test("app_list_user_templates returns metadata only and never touches the network", { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "user-template-list-metadata-"));
  const previousRoot = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = temporary;
  const plugin = await startPluginProcess(temporary);
  try {
    // Seed one ready template directly through the storage layer.
    const source = path.join(temporary, "source.pptx");
    await writeFile(source, "PKsource");
    const record = await createUserTemplate({ filename: "source.pptx", staging_file_path: source, size_bytes: 8 });
    await selectUserTemplatePages(record.id, [1], (input) => rasterizePptxToImages(input, {
      loadPptxSvgSlides: async (_file, pageNumbers) => pageNumbers.map((page_number) => ({ page_number, svg: "<svg/>" })),
      convertSvgToPng: async ({ outputPath }) => { await writeFile(outputPath, "image"); return { width: 1920, height: 1080 }; },
    }));
    const html = "<!doctype html><html><body><div class='slide'>{{PAGE_TITLE}}{{PAGE_CONTENT}}</div></body></html>";
    const staging = path.join(temporary, "template.html");
    await writeFile(staging, html);
    const render = async (_html: string, file: string, image: string) => {
      await writeFile(file, "<html data-presenton-runtime=\"html-page-shell\"><body><div class=\"presentation-slides-wrapper\"></div></body></html>");
      await writeFile(image, "image");
    };
    await saveUserTemplateHtml({ id: record.id, staging_file_path: staging }, render);
    await saveUserTemplateHtml({ id: record.id, page_number: 1, staging_file_path: staging }, render);
    await publishUserTemplate(record.id, { name: "Ready", description: "A ready template.", pages: [{ page_number: 1, description: "Cover." }] });

    // The list call must be a pure disk read. If it ever regresses to bulk
    // host uploads, the call blocks on the host/uploadFile RPC until its
    // 120s timeout — the race below fails long before that.
    const started = Date.now();
    const response = await Promise.race([
      plugin.request("invoke", { tool: "app_list_user_templates", arguments: {} }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("list took >20s — likely reverted to bulk host uploads")), 20000)),
    ]);
    const elapsed = Date.now() - started;

    assert.equal(response.error, undefined, response.error?.message);
    const templates = response.result?.data?.templates ?? [];
    assert.equal(templates.length, 1);
    assert.equal(templates[0].status, "ready");
    assert.deepEqual(templates[0].preview_images, []);
    assert.ok(elapsed < 15000, `list took ${elapsed}ms`);
  } finally {
    await plugin.close();
    if (previousRoot === undefined) delete process.env.ANNA_WORKSPACE_DIR;
    else process.env.ANNA_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
