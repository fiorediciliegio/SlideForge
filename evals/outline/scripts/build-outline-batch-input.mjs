import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseXlsx } from "../../research-routing/src/xlsx.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultWorkbook = resolve(scriptDir, "../../../../eval/Outline测试数据.xlsx");
const defaultOutput = resolve(scriptDir, "../config/outline-provided-requirements-batch-input.json");
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? resolve(process.cwd(), args[index + 1]) : fallback;
}

function columnsFromHeader(row) {
  const columns = new Map(row.map((value, index) => [String(value ?? "").trim(), index]));
  for (const header of ["序号", "用户原始Brief", "Requirements"]) {
    if (!columns.has(header)) throw new Error(`Outline workbook is missing column: ${header}`);
  }
  return columns;
}

const workbookPath = option("--workbook", defaultWorkbook);
const outputPath = option("--output", defaultOutput);
const sheets = parseXlsx(await readFile(workbookPath));
if (sheets.size !== 1) throw new Error(`Expected one worksheet; found ${sheets.size}.`);
const [sheetName, rows] = sheets.entries().next().value;
const columns = columnsFromHeader(rows[0] ?? []);
const entries = rows.slice(1)
  .filter((row) => String(row[columns.get("序号")] ?? "").trim())
  .map((row) => {
    const number = Number(String(row[columns.get("序号")] ?? "").trim());
    const sourceBrief = String(row[columns.get("用户原始Brief")] ?? "").trim();
    const rawRequirements = String(row[columns.get("Requirements")] ?? "").trim();
    if (!Number.isInteger(number) || number < 1 || !sourceBrief || !rawRequirements) {
      throw new Error("Outline workbook contains an incomplete fixture row.");
    }
    let requirements;
    try {
      requirements = JSON.parse(rawRequirements);
    } catch {
      throw new Error(`Requirements JSON is invalid for row ${number}.`);
    }
    if (requirements?.status !== "confirmed" || typeof requirements?.source?.brief !== "string" || !requirements.source.brief.trim()) {
      throw new Error(`Requirements must be confirmed and contain source.brief for row ${number}.`);
    }
    if (requirements?.research?.web?.enabled !== false || requirements?.research?.images?.enabled !== false) {
      throw new Error(`Requirements must disable Web and image research for row ${number}.`);
    }
    return { number, requirements };
  })
  .sort((left, right) => left.number - right.number);

if (entries.length !== 20 || entries.some((entry, index) => entry.number !== index + 1)) {
  throw new Error(`Expected rows 1-20 exactly; found: ${entries.map((entry) => entry.number).join(", ")}`);
}

const document = {
  test_id: "outline-provided-requirements-20260826-rerun-3",
  repeat: 1,
  target_stage: "outline-confirmed",
  briefs: entries.map(({ number, requirements }) => ({
    id: `outline-${String(number).padStart(3, "0")}`,
    // Outline receives requirements.source.brief, not the workbook's separate Brief column.
    brief: requirements.source.brief,
    provided_requirements: requirements,
  })),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`Built ${entries.length} outline-only cases from ${sheetName}: ${outputPath}`);
