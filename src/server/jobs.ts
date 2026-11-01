/**
 * 三端共享的 deck 任务存储。内存 Map 负责热路径，JSON 快照负责单实例重启恢复。
 * 多实例部署必须替换为 PostgreSQL / Redis，不能共享此本地文件。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { DeckEvent } from "../capabilities/deck.js";

export interface DeckJob {
  id: string;
  runDir?: string;
  title?: string;
  status: "creating" | "ready" | "error";
  events: string[];
  error?: string;
  overflowPages: number[];
  billing?: { points: number; balance?: number };
  ownerKeyHash?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const deckJobs = new Map<string, DeckJob>();
const MAX_EVENTS = 200;
let writeChain: Promise<void> = Promise.resolve();

function jobsFile(): string {
  const dataDir = process.env.SLIDEFORGE_DATA_DIR
    ? path.resolve(process.env.SLIDEFORGE_DATA_DIR)
    : path.resolve(import.meta.dirname, "..", "..", "data");
  return path.join(dataDir, "deck-jobs.json");
}

export function appendDeckJobEvent(job: DeckJob, event: DeckEvent): void {
  job.events.push(`[${event.stage}]${event.page ? ` p${event.page}` : ""} ${event.message}`);
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
}

export function persistDeckJob(job: DeckJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  writeChain = writeChain.catch(() => undefined).then(async () => {
    const file = jobsFile();
    await mkdir(path.dirname(file), { recursive: true });
    const snapshot = JSON.stringify([...deckJobs.values()], null, 2);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  });
  return writeChain;
}

export async function loadDeckJobs(): Promise<void> {
  try {
    const jobs = JSON.parse(await readFile(jobsFile(), "utf8")) as DeckJob[];
    for (const job of jobs) {
      if (!job || typeof job.id !== "string" || !Array.isArray(job.events)) continue;
      if (job.status === "creating") {
        job.status = "error";
        job.error = "服务重启中断了生成，请重新创建任务";
      }
      deckJobs.set(job.id, job);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
