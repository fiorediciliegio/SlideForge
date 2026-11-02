/**
 * M4 · 附件文本提取：DOCX（mammoth）/ PDF（pdfjs-dist）/ TXT·MD。
 * 确定性提取，提取文本作为生成的唯一事实来源。
 */
import { createRequire } from "node:module";
import { extractDocumentViaBrain, remoteBrainEnabled } from "../server/brainClient.js";

const engineRequire = createRequire(
  new URL("../../executas/ppt-engine/package.json", import.meta.url),
) as (id: string) => any;

export interface ExtractedDocument {
  text: string;
  chars: number;
  pages?: number;
  kind: "docx" | "pdf" | "text";
}

export async function extractDocumentText(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
  if (remoteBrainEnabled()) {
    const result = await extractDocumentViaBrain(buffer, filename);
    return {
      text: result.text,
      chars: result.chars,
      kind: result.kind === "txt" ? "text" : result.kind as "docx" | "pdf",
    };
  }
  const lower = filename.toLowerCase();

  if (lower.endsWith(".docx")) {
    const mammoth = engineRequire("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value.trim(), chars: result.value.trim().length, kind: "docx" };
  }

  if (lower.endsWith(".pdf")) {
    const pdfjs = engineRequire("pdfjs-dist");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map((item: { str?: string }) => ("str" in item ? item.str : "")).join(" ").trim();
      if (line) parts.push(`[第 ${i} 页] ${line}`);
    }
    const text = parts.join("\n");
    return { text, chars: text.length, pages: doc.numPages, kind: "pdf" };
  }

  if (lower.endsWith(".txt") || lower.endsWith(".md")) {
    const text = buffer.toString("utf8").trim();
    return { text, chars: text.length, kind: "text" };
  }

  throw new Error(`不支持的附件类型：${filename}（支持 .docx/.pdf/.txt/.md）`);
}
