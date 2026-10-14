#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { auditHtmlFile } from "./audit.js";
import { buildAgentAuditReport } from "./agent-report.js";
import { renderAuditMarkdown } from "./report.js";

type ReportFormat = "json" | "markdown" | "agent" | "both";

interface CliOptions {
  input: string;
  slideSelector?: string;
  width: number;
  height: number;
  format: ReportFormat;
  output?: string;
  reportOnly: boolean;
}

const HELP = `PPT DOM 几何审计器

用法：
  npm run audit:layout -- --input <绝对 HTML 路径> [选项]

选项：
  --slide-selector <selector>  指定 slide 根元素选择器
  --width <number>             viewport/画布宽度，默认 1280
  --height <number>            viewport/画布高度，默认 720
  --format <format>            agent | json | markdown | both，默认 both；agent 是给 AI Agent 的精简 JSON
  --output <path>              输出路径；both 会生成 <path>.json 和 <path>.md
  --report-only                即使发现严重问题也返回退出码 0
  --help                       显示帮助
`;

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数值`);
  return value;
}

function positiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} 必须是正数`);
  return parsed;
}

function parseArgs(args: string[]): CliOptions | null {
  if (args.includes("--help") || args.includes("-h")) return null;
  const result: CliOptions = {
    input: "",
    width: 1280,
    height: 720,
    format: "both",
    reportOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--report-only") {
      result.reportOnly = true;
      continue;
    }
    if (argument === "--input") {
      result.input = nextValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--slide-selector") {
      result.slideSelector = nextValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--width") {
      result.width = positiveNumber(nextValue(args, index, argument), argument);
      index += 1;
      continue;
    }
    if (argument === "--height") {
      result.height = positiveNumber(nextValue(args, index, argument), argument);
      index += 1;
      continue;
    }
    if (argument === "--format") {
      const format = nextValue(args, index, argument);
      if (format !== "json" && format !== "markdown" && format !== "agent" && format !== "both") {
        throw new Error("--format 只支持 agent、json、markdown 或 both");
      }
      result.format = format;
      index += 1;
      continue;
    }
    if (argument === "--output") {
      result.output = nextValue(args, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  if (!result.input) throw new Error("缺少 --input <绝对 HTML 路径>");
  return result;
}

function outputPaths(output: string, format: ReportFormat): { agent?: string; json?: string; markdown?: string } {
  const resolved = path.resolve(output);
  if (format === "agent") return { agent: resolved };
  if (format === "json") return { json: resolved };
  if (format === "markdown") return { markdown: resolved };
  const extension = path.extname(resolved);
  const base = extension ? resolved.slice(0, -extension.length) : resolved;
  return { json: `${base}.json`, markdown: `${base}.md` };
}

async function writeReport(
  output: string,
  format: ReportFormat,
  agentJson: string,
  json: string,
  markdown: string,
): Promise<void> {
  const paths = outputPaths(output, format);
  for (const [kind, reportPath] of Object.entries(paths)) {
    if (!reportPath) continue;
    await mkdir(path.dirname(reportPath), { recursive: true });
    const content = kind === "agent" ? agentJson : kind === "json" ? json : markdown;
    await writeFile(reportPath, content, "utf8");
    const label = kind === "agent" ? "Agent JSON" : kind === "json" ? "JSON" : "Markdown";
    process.stdout.write(`已写入 ${label} 报告：${reportPath}\n`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(HELP);
    return;
  }
  const report = await auditHtmlFile(options);
  const agentJson = options.format === "agent"
    ? `${JSON.stringify(await buildAgentAuditReport(report), null, 2)}\n`
    : "";
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderAuditMarkdown(report);
  if (options.output) {
    await writeReport(options.output, options.format, agentJson, json, markdown);
  } else if (options.format === "agent") {
    process.stdout.write(agentJson);
  } else if (options.format === "json") {
    process.stdout.write(json);
  } else if (options.format === "markdown") {
    process.stdout.write(markdown);
  } else {
    process.stdout.write(`${markdown}\n--- JSON ---\n\n${json}`);
  }
  process.stdout.write(
    `审计完成：${report.summary.slideCount} 个 slide，${report.summary.issueCount} 个问题，其中 ${report.summary.errorCount} 个严重问题。\n`,
  );
  if (!options.reportOnly && report.summary.errorCount > 0) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`PPT DOM 几何审计失败：${message}\n`);
  process.exitCode = 1;
});
