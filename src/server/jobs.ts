/** 任务仓库：默认本地单实例；配置 SLIDEFORGE_JOB_API_URL 后由 Go 独占任务记录。 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { DeckEvent, DeckJobRecord } from "../contracts/deck.js";

export type DeckJob = DeckJobRecord;

export const deckJobs = new Map<string, DeckJob>();
const MAX_EVENTS = 200;
let writeChain: Promise<void> = Promise.resolve();

export function remoteJobsEnabled(): boolean {
  return Boolean(process.env.SLIDEFORGE_JOB_API_URL?.trim());
}

async function callRemoteJobs<T>(action: "create" | "get" | "list" | "save" | "delete", input: { job?: DeckJob; deckId?: string }): Promise<T> {
  const base = process.env.SLIDEFORGE_JOB_API_URL!.trim().replace(/\/$/, "");
  const response = await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.GATEWAY_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify({ action, job: input.job, deck_id: input.deckId }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Go job API ${response.status}`);
  return payload as T;
}

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
    if (remoteJobsEnabled()) {
      await callRemoteJobs("save", { job });
      return;
    }
    const file = jobsFile();
    await mkdir(path.dirname(file), { recursive: true });
    const snapshot = JSON.stringify([...deckJobs.values()], null, 2);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  });
  return writeChain;
}

export async function createDeckJob(job: DeckJob): Promise<void> {
  if (remoteJobsEnabled()) {
    await callRemoteJobs("create", { job });
    return;
  }
  deckJobs.set(job.id, job);
  await persistDeckJob(job);
}

export async function getDeckJob(id: string): Promise<DeckJob | undefined> {
  if (remoteJobsEnabled()) {
    const result = await callRemoteJobs<{ job?: DeckJob | null }>("get", { deckId: id });
    return result.job ?? undefined;
  }
  return deckJobs.get(id);
}

export async function listDeckJobs(): Promise<DeckJob[]> {
  if (remoteJobsEnabled()) {
    const result = await callRemoteJobs<{ jobs?: DeckJob[] }>("list", {});
    return result.jobs ?? [];
  }
  return [...deckJobs.values()];
}

export async function deleteDeckJob(id: string): Promise<void> {
  if (remoteJobsEnabled()) {
    await callRemoteJobs("delete", { deckId: id });
    return;
  }
  deckJobs.delete(id);
  const file = jobsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify([...deckJobs.values()], null, 2), "utf8");
}

export async function loadDeckJobs(): Promise<void> {
  if (remoteJobsEnabled()) return;
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
