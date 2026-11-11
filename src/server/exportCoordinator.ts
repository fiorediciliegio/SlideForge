/** 单实例导出幂等协调：内容指纹 + 可选客户端幂等键 + 持久回执。 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { ExportDeckResult } from "../capabilities/deck.js";
import { chargeFixed } from "../billing/index.js";
import { publishRemoteFile, remoteFilesEnabled } from "./fileClient.js";
import { HttpRequestError } from "./httpSecurity.js";

interface PublishedExportResult extends ExportDeckResult {
  file_id?: string;
  download_url?: string;
}

interface ExportReceipt {
  operationId: string;
  fingerprint: string;
  result: PublishedExportResult;
  charge: { points: number; balance?: number };
  createdAt: string;
}

type ReceiptStore = Record<string, ExportReceipt>;

export interface IdempotentExportInput {
  apiKey?: string;
  ownerKeyHash?: string;
  deckId: string;
  runDir: string;
  format: "pptx" | "pdf";
  outPath: string;
  idempotencyKey?: string;
  revisionId?: string;
  execute: () => Promise<ExportDeckResult>;
}

export interface IdempotentExportResult extends PublishedExportResult {
  billing: { points: number; balance?: number };
  export_id: string;
  idempotent: boolean;
}

const inFlight = new Map<string, Promise<IdempotentExportResult>>();
let writeChain: Promise<void> = Promise.resolve();
const MAX_RECEIPTS = 50_000;

function receiptsFile(): string {
  const dataDir = process.env.SLIDEFORGE_DATA_DIR
    ? path.resolve(process.env.SLIDEFORGE_DATA_DIR)
    : path.resolve(import.meta.dirname, "..", "..", "data");
  return path.join(dataDir, "export-receipts.json");
}

async function readReceipts(): Promise<ReceiptStore> {
  try { return JSON.parse(await readFile(receiptsFile(), "utf8")) as ReceiptStore; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveReceipt(receipt: ExportReceipt): Promise<void> {
  writeChain = writeChain.catch(() => undefined).then(async () => {
    const receipts = await readReceipts();
    receipts[receipt.operationId] = receipt;
    const identities = Object.keys(receipts);
    if (identities.length > MAX_RECEIPTS) {
      for (const stale of identities.slice(0, identities.length - MAX_RECEIPTS)) delete receipts[stale];
    }
    const file = receiptsFile();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(receipts, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  });
  return writeChain;
}

async function deckFingerprint(runDir: string, format: string): Promise<string> {
  const deckHtml = await readFile(path.join(runDir, "deck.html"));
  return createHash("sha256").update(format).update("\0").update(deckHtml).digest("hex");
}

export async function runIdempotentExport(input: IdempotentExportInput): Promise<IdempotentExportResult> {
  const fingerprint = await deckFingerprint(input.runDir, input.format);
  const clientKey = input.idempotencyKey?.trim();
  if (clientKey && (clientKey.length > 128 || !/^[\w:.-]+$/.test(clientKey))) {
    throw new HttpRequestError(400, "Idempotency-Key 只能包含字母、数字、下划线、点、冒号和连字符，且最长 128 字符");
  }
  const operationId = createHash("sha256").update([
    input.ownerKeyHash ?? "local", input.deckId, input.format,...(input.revisionId?[`revision:${input.revisionId}`]:[]),
    clientKey ? `key:${clientKey}` : `content:${fingerprint}`,
  ].join("\0")).digest("hex");
  const existing = inFlight.get(operationId);
  if (existing) return existing;

  const promise = (async (): Promise<IdempotentExportResult> => {
    const receipt = (await readReceipts())[operationId];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new HttpRequestError(409, "同一 Idempotency-Key 不能用于不同内容");
      }
      if (receipt.result.download_url || existsSync(receipt.result.outPath)) {
        return {
          ...receipt.result, billing: receipt.charge,
          export_id: operationId, idempotent: true,
        };
      }
    }
    let result: PublishedExportResult = await input.execute();
    if (remoteFilesEnabled()) {
      const published = await publishRemoteFile({
        filePath: result.outPath, deckId: input.deckId,
        ownerKeyHash: input.ownerKeyHash, format: input.format,
      });
      result = { ...result, ...published };
    }
    const charge = await chargeFixed(input.apiKey, input.deckId, "export", undefined, operationId,input.ownerKeyHash);
    await saveReceipt({ operationId, fingerprint, result, charge, createdAt: new Date().toISOString() });
    return { ...result, billing: charge, export_id: operationId, idempotent: false };
  })();
  inFlight.set(operationId, promise);
  try { return await promise; } finally { inFlight.delete(operationId); }
}
