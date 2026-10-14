import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseXlsx } from "./xlsx.mjs";

function requiredHeader(row, expected, label) {
  const actual = row.map((value) => String(value).trim());
  for (const header of expected) {
    if (!actual.includes(header)) throw new Error(`${label} is missing required column: ${header}`);
  }
  return new Map(actual.map((value, index) => [value, index]));
}

function workbookSheets(buffer) {
  const sheets = parseXlsx(buffer);
  const rows = [...sheets.values()];
  const casesSheet = rows.find((sheet) => {
    const header = sheet[0]?.map((value) => String(value).trim()) ?? [];
    return ["#", "Prompt", "Web Search", "Image Search"].every((name) => header.includes(name));
  });
  const promptsSheet = rows.find((sheet) => {
    const header = sheet[0]?.map((value) => String(value).trim()) ?? [];
    return header.includes("Prompt") && !header.includes("#");
  });
  if (!casesSheet || !promptsSheet) throw new Error("Workbook must contain the labelled cases sheet and candidate Prompt sheet.");
  return { casesSheet, promptsSheet };
}

function expectedBoolean(value, label) {
  if (value === "Yes") return true;
  if (value === "No") return false;
  throw new Error(`${label} must be Yes or No.`);
}

function promptVersion(rawValue) {
  const match = /^(?:v)?([1-9]|10)([a-z]?)$/iu.exec(String(rawValue).trim());
  return match ? `v${match[1]}${match[2].toLowerCase()}` : null;
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// v11 只从 v7 移除末尾 JSON 输出约束；系统消息、日期和附件由评估入口组装。
export function v11PromptFromV7(v7) {
  const jsonConstraint = /\n\s*Return exactly one JSON object:\s*\{"web":\{"recommended":false,"reason":"\.\.\."\},"images":\{"recommended":false,"reason":"\.\.\."\}\}\s*$/u;
  if (!v7 || !jsonConstraint.test(v7.prompt)) {
    throw new Error("Cannot derive v11: v7 must end with the expected JSON output constraint.");
  }
  const prompt = v7.prompt.replace(jsonConstraint, "").trimEnd();
  return {
    prompt_version: "v11",
    label: "V11：评估层系统提示词版",
    prompt,
    prompt_hash: sha256(prompt),
  };
}

export function fixturesFromWorkbook(buffer, { promptStageIndex = 0 } = {}) {
  const { casesSheet, promptsSheet } = workbookSheets(buffer);
  const caseColumns = requiredHeader(casesSheet[0] ?? [], ["#", "Prompt", "Web Search", "Image Search"], "cases sheet");
  const cases = casesSheet.slice(1).filter((row) => String(row[caseColumns.get("#")] ?? "").trim()).map((row) => {
    const number = Number(row[caseColumns.get("#")]);
    const prompt = String(row[caseColumns.get("Prompt")] ?? "").trim();
    if (!Number.isInteger(number) || number < 1 || !prompt) throw new Error("Cases sheet contains an invalid case.");
    return {
      case_id: `case-${String(number).padStart(3, "0")}`,
      source_row: number,
      brief: prompt,
      expected: {
        web: expectedBoolean(String(row[caseColumns.get("Web Search")] ?? "").trim(), `case ${number} Web Search`),
        images: expectedBoolean(String(row[caseColumns.get("Image Search")] ?? "").trim(), `case ${number} Image Search`),
      },
    };
  });

  const promptColumns = requiredHeader(promptsSheet[0] ?? [], ["Prompt"], "candidate Prompt sheet");
  const promptColumn = promptColumns.get("Prompt");
  if (promptColumn === undefined || promptColumn < 2) throw new Error("Candidate Prompt sheet has an unsupported column layout.");
  const idColumn = promptColumn - 2;
  const labelColumn = promptColumn - 1;
  const stageColumn = promptColumn >= 3 ? promptColumn - 3 : null;
  const promptRows = promptsSheet.slice(1).filter((row) => String(row[idColumn] ?? "").trim());
  const stages = stageColumn === null ? [""] : [...new Set(promptRows.map((row) => String(row[stageColumn] ?? "").trim()))];
  const stage = stages[promptStageIndex];
  if (stage === undefined) throw new Error(`Prompt stage ${promptStageIndex + 1} does not exist.`);
  const prompts = promptRows.filter((row) => stageColumn === null || String(row[stageColumn] ?? "").trim() === stage).map((row) => {
    const version = promptVersion(row[idColumn]);
    const prompt = String(row[promptColumns.get("Prompt")] ?? "").trim().replace(/\r\n/gu, "\n");
    if (!version || !prompt) throw new Error("Candidate Prompt sheet contains an invalid Prompt.");
    return {
      prompt_version: version,
      label: String(row[labelColumn] ?? "").trim(),
      prompt,
      prompt_hash: sha256(prompt),
    };
  });
  if (cases.length !== 50) throw new Error(`Expected 50 cases; found ${cases.length}.`);
  if (prompts.length === 0 || prompts.length > 10) throw new Error(`Expected 1-10 prompts; found ${prompts.length}.`);
  const caseIds = new Set(cases.map((item) => item.case_id));
  const versions = new Set(prompts.map((item) => item.prompt_version));
  if (caseIds.size !== cases.length || versions.size !== prompts.length) throw new Error("Workbook contains duplicate case or Prompt IDs.");
  return { schema_version: 1, cases, prompts };
}

export async function readFixturesFromWorkbook(path, options) {
  return fixturesFromWorkbook(await readFile(path), options);
}
