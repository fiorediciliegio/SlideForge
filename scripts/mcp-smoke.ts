/**
 * MCP smoke：真实 stdio 客户端调用 SlideForge MCP Server 全链路。
 * 用法：OPENAI_API_KEY=sk-... node --import tsx/esm scripts/mcp-smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx/esm", path.join(repoRoot, "src", "mcp", "server.ts")],
  cwd: repoRoot,
  env: { ...process.env },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk: Buffer) => {
  const line = chunk.toString().trim();
  if (line) console.log(`  [server] ${line.slice(0, 140)}`);
});

const client = new Client({ name: "slideforge-smoke", version: "0.1.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("工具清单：", tools.tools.map((t) => t.name).join(", "));

function parse(result: { content?: unknown }) {
  const text = (result.content as Array<{ text: string }>)[0].text;
  return JSON.parse(text);
}

console.log("\n[1] create_deck…");
const created = parse(await client.callTool({
  name: "create_deck",
  arguments: {
    brief: "读书笔记分享《纳瓦尔宝典》：财富与幸福的指南，涵盖杠杆思维、复利、判断力、活在当下；面向书友会 10 分钟分享",
    page_count: 4,
  },
}));
console.log("  →", created.deck_id, created.status);

console.log("[2] 轮询任务…");
let status = "creating";
let rounds = 0;
while (status === "creating" && rounds < 40) {
  await new Promise((r) => setTimeout(r, 5000));
  const job = parse(await client.callTool({ name: "get_deck_job", arguments: { deck_id: created.deck_id } }));
  status = job.status;
  rounds++;
  console.log(`  → ${status}（${job.recent_events?.at(-1) ?? ""}）`);
  if (status === "error") throw new Error(job.error);
}

console.log("[3] regenerate_page（指哪改哪）…");
const regen = parse(await client.callTool({
  name: "regenerate_page",
  arguments: { deck_id: created.deck_id, page: 2, instruction: "改成三栏卡片式布局，每栏一个核心观点" },
}));
console.log("  →", regen.status);

console.log("[4] export_deck…");
const exported = parse(await client.callTool({ name: "export_deck", arguments: { deck_id: created.deck_id } }));
console.log("  →", JSON.stringify(exported, null, 2));

console.log("[5] get_deck_preview（图片消息）…");
const preview = await client.callTool({ name: "get_deck_preview", arguments: { deck_id: created.deck_id, pages: [1, 2] } });
const { writeFile, mkdir } = await import("node:fs/promises");
const previewDir = path.join(repoRoot, "artifacts", "mcp-preview");
await mkdir(previewDir, { recursive: true });
let imageCount = 0;
for (const block of preview.content as Array<{ type: string; data?: string }>) {
  if (block.type === "image" && block.data) {
    imageCount++;
    const file = path.join(previewDir, `preview-${imageCount}.jpg`);
    await writeFile(file, Buffer.from(block.data, "base64"));
    console.log(`  → 图片 ${imageCount} 已保存 ${file}`);
  }
}
if (imageCount === 0) throw new Error("未收到任何图片消息");

await client.close();
console.log("\n✅ MCP 全链路 smoke 通过（含图片预览）");
process.exit(0);
