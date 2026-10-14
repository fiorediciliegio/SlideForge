import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractUploadedSource } from "../../src/uploaded-source-preflight/extract.ts";
import {
  canContinuePartialSource,
  canUseFullContextForPartialSpreadsheet,
  selectOriginalReadingMethod,
} from "../../src/uploaded-source-preflight/routing.ts";

test("spreadsheet preflight keeps sheet and cell locations while warning about hidden sheets, visuals, and uncached formulas", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "presenton-spreadsheet-preflight-"));
  try {
    const workbook = XLSX.utils.book_new();
    const visible = XLSX.utils.aoa_to_sheet([
      ["区域", "销售额（万元）", "同比"],
      ["华东", 1280, 0.153],
      ["华南", 1195, -0.021],
    ]);
    visible.C2.z = "0.0%";
    visible.C3.z = "0.0%";
    visible["!ref"] = "A1:D3";
    XLSX.utils.book_append_sheet(workbook, visible, "区域汇总");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["不应进入上下文"], ["保密"]]), "隐藏资料");
    workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };

    const base = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const archive = await JSZip.loadAsync(base);
    const sheetXml = await archive.file("xl/worksheets/sheet1.xml")!.async("string");
    archive.file(
      "xl/worksheets/sheet1.xml",
      sheetXml.replace(/(<row r="2"[^>]*>[\s\S]*?)(<\/row>)/, "$1<c r=\"D2\"><f>B2*2</f></c>$2"),
    );
    archive.file("xl/media/image1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    archive.file("xl/charts/chart1.xml", "<c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"/>");
    archive.file("xl/pivotTables/pivotTable1.xml", "<pivotTableDefinition/>");
    archive.file("xl/model/item.data", Buffer.from([0x00]));
    const filePath = path.join(tempDir, "sales.xlsx");
    await writeFile(filePath, await archive.generateAsync({ type: "nodebuffer" }));

    const result = await extractUploadedSource(filePath, ".xlsx");

    assert.equal(result.is_spreadsheet, true);
    assert.equal(result.parse_status, "partial");
    assert.match(result.text, /# Sheet: 区域汇总/);
    assert.match(result.text, /Range: A1:D3/);
    assert.match(result.text, /\[Row 2 \| A2:D2\].*华东.*1280.*15\.3%/);
    assert.doesNotMatch(result.text, /隐藏资料|保密/);
    assert.ok(result.warnings.some((warning) => warning.code === "hidden_sheet_excluded"), JSON.stringify(result.warnings));
    assert.ok(result.warnings.some((warning) => warning.code === "visual_content_needs_ocr"));
    assert.ok(result.warnings.some((warning) => warning.code === "pivot_content_not_extracted"));
    assert.ok(result.warnings.some((warning) => warning.code === "formula_value_unavailable"));
    assert.equal(result.format_metrics.hidden_sheets, 1);
    assert.equal(result.format_metrics.embedded_images, 1);
    assert.equal(result.format_metrics.charts, 1);
    assert.equal(result.format_metrics.pivot_tables, 1);
    assert.equal(result.format_metrics.power_pivot_models, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("spreadsheet preflight supports CSV and legacy XLS with spreadsheet_read routing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "presenton-spreadsheet-formats-"));
  try {
    const csvPath = path.join(tempDir, "metrics.csv");
    await writeFile(csvPath, "月份,销售额\n2026-01,1280\n", "utf8");
    const csv = await extractUploadedSource(csvPath, ".csv");
    assert.equal(csv.parse_status, "ready");
    assert.match(csv.text, /# Sheet: Sheet1/);
    assert.match(csv.text, /\[Row 2 \| A2:B2\].*2026-01.*1280/);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "金额"], ["预算", 500]]), "预算");
    const xlsPath = path.join(tempDir, "budget.xls");
    await writeFile(xlsPath, XLSX.write(workbook, { type: "buffer", bookType: "xls" }) as Buffer);
    const xls = await extractUploadedSource(xlsPath, ".xls");
    assert.equal(xls.parse_status, "ready");
    assert.match(xls.text, /# Sheet: 预算/);

    assert.equal(selectOriginalReadingMethod({ contentStrategy: "full_context", isSpreadsheet: true }), "spreadsheet_read");
    assert.equal(selectOriginalReadingMethod({ contentStrategy: "summarized_context", isSpreadsheet: true }), "spreadsheet_read");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("an otherwise readable workbook can continue when it also contains an empty visible sheet", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "presenton-spreadsheet-empty-sheet-"));
  try {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Metric"], ["Ready"]]), "Data");
    XLSX.utils.book_append_sheet(workbook, { "!ref": "A1", A1: { t: "s", v: "" } }, "Empty");
    const filePath = path.join(tempDir, "with-empty-sheet.xlsx");
    await writeFile(filePath, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer);

    const result = await extractUploadedSource(filePath, ".xlsx");

    assert.equal(result.parse_status, "partial");
    assert.equal(result.format_metrics.parsed_sheets, 1);
    assert.equal(result.format_metrics.total_sheets, 2);
    assert.ok(result.warnings.some((warning) => warning.code === "sheet_empty_excluded"));
    assert.equal(canContinuePartialSource({
      text: result.text,
      formatMetrics: result.format_metrics,
      warnings: result.warnings,
    }), true);
    assert.equal(canUseFullContextForPartialSpreadsheet({
      text: result.text,
      formatMetrics: result.format_metrics,
      warnings: result.warnings,
    }), true);
    assert.equal(canUseFullContextForPartialSpreadsheet({
      text: result.text,
      formatMetrics: result.format_metrics,
      warnings: [{ code: "sheet_parse_failed", locations: ["sheet:Data"] }],
    }), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
