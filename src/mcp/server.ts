/**
 * SlideForge MCP Server（stdio 入口）。
 * 工具定义与 HTTP transport 共用 src/mcp/tools.ts。
 *
 * 启动：OPENAI_API_KEY=sk-... npm run mcp
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSlideForgeMcpServer } from "./tools.js";
import { loadDotEnv } from "../server/env.js";

loadDotEnv();

const transport = new StdioServerTransport();
await createSlideForgeMcpServer().connect(transport);
console.error("[slideforge-mcp] stdio server ready");
