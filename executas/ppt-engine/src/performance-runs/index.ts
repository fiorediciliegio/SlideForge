import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { getPptWorkspaceRoot } from "../workspace-root.js";
import {
  emptyPerformanceTokenUsage,
  summarizePerformanceTokenUsage,
  type PerformanceTokenUsageSummary,
} from "./token-usage.js";

export type { PerformanceTokenUsageBucket, PerformanceTokenUsageSource, PerformanceTokenUsageSummary } from "./token-usage.js";

export type PerformanceRunStatus =
  | "recording"
  | "finalizing"
  | "completed"
  | "finalization_failed"
  | "abandoned";

export type PerformanceDataIntegrity = "complete" | "degraded";

export interface PerformanceContext {
  run_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  operation_name?: string;
  workspace_id?: string;
}

export interface PerformanceEvent {
  schema_version: 1;
  event_id: string;
  event_type: "span.started" | "span.finished" | "button.interaction" | "token.usage" | "data.loss";
  recorded_at: string;
  producer_id: string;
  sequence_number: number;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  operation_name?: string;
  workspace_id?: string;
  duration_ms?: number;
  interaction_delay_ms?: number;
  feedback_delay_ms?: number;
  status?: "ok" | "error" | "interrupted";
  attributes?: Record<string, string | number | boolean | null>;
}

export interface PerformanceOperationMetric {
  operation_name: string;
  count: number;
  wall_clock_ms: number;
  total_duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  calls: number;
}

export interface PerformanceRunRecord {
  schema_version: 1;
  run_id: string;
  status: PerformanceRunStatus;
  data_integrity: PerformanceDataIntegrity;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  report_locale: ReportLocale | null;
  report_status: "not_generated" | "generated" | "failed";
  report_error: string | null;
  app_version: string;
  environment: Record<string, string | number | boolean | null>;
  initial_settings: Record<string, unknown>;
  event_count: number;
  dropped_event_count: number;
  token_usage?: PerformanceTokenUsageSummary;
  operation_metrics?: PerformanceOperationMetric[];
}

export interface PerformanceRunSummary extends PerformanceRunRecord {
  run_dir: string;
  report_available: boolean;
}

/**
 * List calls run during app startup. Do not return the full on-disk record
 * for every historical run: reports retain that data locally and the UI only
 * needs these fields to display, open, regenerate, or delete a run.
 */
export interface PerformanceRunListItem extends Pick<PerformanceRunSummary,
  "run_id"
  | "status"
  | "started_at"
  | "event_count"
> {
  report_available: boolean;
}

export interface PerformanceRunPaths {
  root_dir: string;
  active_run_path: string;
  run_dir: string;
  run_path: string;
  events_path: string;
  report_path: string;
}

export interface PerformanceFinalizeResult {
  run: PerformanceRunSummary;
  requires_force: boolean;
  active_span_count: number;
}

const DEFAULT_ROOT = path.join(getPptWorkspaceRoot(), "performance-runs");
const RUN_ID_PATTERN = /^perf-\d{8}-\d{6}-[0-9a-f]{8}$/;
const MAX_EVENTS_PER_APPEND = 200;
const MAX_APPEND_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_DETAIL_ROWS = 1_000;
// The performance history is requested during app startup. Keep its RPC
// payload comfortably below the local bridge's response limit; full records
// remain available on disk for report generation.
const MAX_LISTED_HISTORY_RUNS = 50;
const START_LOCK_DIRNAME = ".active-run.lock";
const START_LOCK_STALE_MS = 2 * 60 * 1000;
const START_LOCK_RETRY_MS = 10;
const START_LOCK_MAX_ATTEMPTS = 500;
const appendQueues = new Map<string, Promise<void>>();

interface StartLockOwner {
  owner_id: string;
  pid: number;
  acquired_at: string;
}

function isoNow() {
  return new Date().toISOString();
}

function formatRunId(date = new Date()) {
  const digits = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `perf-${digits}-${randomUUID().slice(0, 8)}`;
}

function assertRunId(runId: string) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('"run_id" is invalid');
  return runId;
}

export function getPerformanceRunPaths(runId: string, rootDir = DEFAULT_ROOT): PerformanceRunPaths {
  assertRunId(runId);
  const runDir = path.join(rootDir, runId);
  return {
    root_dir: rootDir,
    active_run_path: path.join(rootDir, "active-run.json"),
    run_dir: runDir,
    run_path: path.join(runDir, "run.json"),
    events_path: path.join(runDir, "events.jsonl"),
    report_path: path.join(runDir, "report.html"),
  };
}

export async function materializePerformanceRun(input: {
  run_id: string;
  destination_dir: string;
}): Promise<{ run_id: string; destination_dir: string; files: string[] }> {
  const paths = getPerformanceRunPaths(input.run_id);
  const workspaceRoot = getPptWorkspaceRoot();
  const destination = path.normalize(input.destination_dir);
  const testRoot = path.join(workspaceRoot, "test");
  const relative = path.relative(testRoot, destination);
  if (!path.isAbsolute(destination) || destination === testRoot || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error('"destination_dir" must be inside the default PPT test directory');
  }
  const files = [paths.run_path, paths.events_path, paths.report_path];
  await mkdir(destination, { recursive: true });
  const copied: string[] = [];
  for (const source of files) {
    try {
      await stat(source);
    } catch {
      continue;
    }
    const target = path.join(destination, path.basename(source));
    await copyFile(source, target);
    copied.push(target);
  }
  if (copied.length === 0) throw new Error(`Performance Run has no materializable files: ${input.run_id}`);
  return { run_id: input.run_id, destination_dir: destination, files: copied };
}

async function atomicWriteJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function atomicWriteText(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, value, "utf8");
  await rename(temporaryPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function fileExists(filePath: string) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function acquireStartLock(rootDir: string): Promise<() => Promise<void>> {
  await mkdir(rootDir, { recursive: true });
  const lockPath = path.join(rootDir, START_LOCK_DIRNAME);
  const owner: StartLockOwner = {
    owner_id: randomUUID(),
    pid: process.pid,
    acquired_at: isoNow(),
  };
  for (let attempt = 0; attempt < START_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        try {
          const currentOwner = await readJson<StartLockOwner>(path.join(lockPath, "owner.json"));
          if (currentOwner.owner_id === owner.owner_id) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        let stale = false;
        try {
          const currentOwner = await readJson<StartLockOwner>(path.join(lockPath, "owner.json"));
          stale = !processIsAlive(currentOwner.pid);
        } catch {
          stale = Date.now() - lockStat.mtimeMs > START_LOCK_STALE_MS;
        }
        if (stale) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (staleError) {
        if (!isNodeError(staleError) || !["ENOENT", "EEXIST"].includes(staleError.code ?? "")) {
          throw staleError;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, START_LOCK_RETRY_MS));
    }
  }
  throw new Error("Timed out waiting to create a Performance Run");
}

async function readRun(runId: string, rootDir = DEFAULT_ROOT) {
  return readJson<PerformanceRunRecord>(getPerformanceRunPaths(runId, rootDir).run_path);
}

async function toSummary(run: PerformanceRunRecord, rootDir = DEFAULT_ROOT): Promise<PerformanceRunSummary> {
  const paths = getPerformanceRunPaths(run.run_id, rootDir);
  return {
    ...run,
    run_dir: paths.run_dir,
    report_available: await fileExists(paths.report_path),
  };
}

function summarizeOperationMetrics(events: PerformanceEvent[]): PerformanceOperationMetric[] {
  const finished = events.filter((event) => event.event_type === "span.finished" && typeof event.duration_ms === "number");
  const tokenByOperation = new Map<string, { input: number; output: number; total: number; calls: number }>();
  for (const event of events) {
    if (event.event_type !== "token.usage" || !event.operation_name) continue;
    const a = event.attributes ?? {};
    const current = tokenByOperation.get(event.operation_name) ?? { input: 0, output: 0, total: 0, calls: 0 };
    current.input += typeof a.input_tokens === "number" ? a.input_tokens : 0;
    current.output += typeof a.output_tokens === "number" ? a.output_tokens : 0;
    current.total += typeof a.total_tokens === "number" ? a.total_tokens : 0;
    current.calls += typeof a.token_calls === "number" ? a.token_calls : 0;
    tokenByOperation.set(event.operation_name, current);
  }
  const groups = new Map<string, PerformanceEvent[]>();
  for (const event of finished) {
    if (!event.operation_name) continue;
    groups.set(event.operation_name, [...(groups.get(event.operation_name) ?? []), event]);
  }
  const names = new Set([...groups.keys(), ...tokenByOperation.keys()]);
  return [...names].map((name) => {
    const items = groups.get(name) ?? [];
    const durations = items.map((item) => item.duration_ms ?? 0);
    return {
      operation_name: name,
      count: items.length,
      wall_clock_ms: mergedWallClockDuration(items),
      total_duration_ms: durations.reduce((sum, value) => sum + value, 0),
      input_tokens: tokenByOperation.get(name)?.input ?? 0,
      output_tokens: tokenByOperation.get(name)?.output ?? 0,
      total_tokens: tokenByOperation.get(name)?.total ?? 0,
      calls: tokenByOperation.get(name)?.calls ?? 0,
    };
  }).sort((a, b) => b.total_duration_ms - a.total_duration_ms);
}

function toListItem(run: PerformanceRunSummary): PerformanceRunListItem {
  return {
    run_id: run.run_id,
    status: run.status,
    started_at: run.started_at,
    event_count: run.event_count,
    report_available: run.report_available,
  };
}

async function readActivePointer(rootDir = DEFAULT_ROOT): Promise<string | null> {
  try {
    const pointer = await readJson<{ run_id?: unknown }>(path.join(rootDir, "active-run.json"));
    return typeof pointer.run_id === "string" && RUN_ID_PATTERN.test(pointer.run_id)
      ? pointer.run_id
      : null;
  } catch {
    return null;
  }
}

async function recoverActiveRunId(rootDir: string) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map(async (entry) => {
      try {
        const run = await readRun(entry.name, rootDir);
        return ["recording", "finalizing", "finalization_failed"].includes(run.status) ? run : null;
      } catch {
        return null;
      }
    })))
    .filter((run): run is PerformanceRunRecord => run !== null)
    .sort((left, right) => right.started_at.localeCompare(left.started_at));
  if (candidates.length !== 1) return null;
  await atomicWriteJson(path.join(rootDir, "active-run.json"), { schema_version: 1, run_id: candidates[0].run_id });
  return candidates[0].run_id;
}

export async function getActivePerformanceRun(rootDir = DEFAULT_ROOT): Promise<PerformanceRunSummary | null> {
  const runId = await readActivePointer(rootDir) ?? await recoverActiveRunId(rootDir);
  if (!runId) return null;
  try {
    const run = await readRun(runId, rootDir);
    if (run.status !== "recording" && run.status !== "finalizing" && run.status !== "finalization_failed") {
      await rm(path.join(rootDir, "active-run.json"), { force: true });
      return null;
    }
    return toSummary(run, rootDir);
  } catch {
    await rm(path.join(rootDir, "active-run.json"), { force: true });
    const recoveredRunId = await recoverActiveRunId(rootDir);
    if (!recoveredRunId || recoveredRunId === runId) return null;
    return toSummary(await readRun(recoveredRunId, rootDir), rootDir);
  }
}

export async function listPerformanceRuns(rootDir = DEFAULT_ROOT): Promise<{
  root_dir: string;
  active_run: PerformanceRunListItem | null;
  runs: PerformanceRunListItem[];
}> {
  await mkdir(rootDir, { recursive: true });
  const entries = await readdir(rootDir, { withFileTypes: true });
  const runs = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map(async (entry) => {
      try {
        return toListItem(await toSummary(await readRun(entry.name, rootDir), rootDir));
      } catch {
        return null;
      }
    }));
  const summaries = runs.filter((run): run is PerformanceRunListItem => run !== null)
    .sort((left, right) => right.started_at.localeCompare(left.started_at));
  // Preserve the pointer/recovery semantics used by startup guards. The
  // compact list item is only a transport projection of the authoritative
  // active run summary.
  const activeRun = await getActivePerformanceRun(rootDir);
  return {
    root_dir: rootDir,
    active_run: activeRun ? toListItem(activeRun) : null,
    runs: summaries.slice(0, MAX_LISTED_HISTORY_RUNS),
  };
}

export async function startPerformanceRun(input: {
  app_version?: string;
  environment?: Record<string, string | number | boolean | null>;
  initial_settings?: Record<string, unknown>;
  root_dir?: string;
} = {}): Promise<PerformanceRunSummary> {
  const rootDir = input.root_dir ?? DEFAULT_ROOT;
  const environment = input.environment ?? {};
  const initialSettings = input.initial_settings ?? {};
  if (Buffer.byteLength(JSON.stringify(environment)) > 32 * 1024) throw new Error("Performance environment snapshot exceeds 32768 bytes");
  if (Buffer.byteLength(JSON.stringify(initialSettings)) > 64 * 1024) throw new Error("Performance initial settings snapshot exceeds 65536 bytes");
  if (Object.values(environment).some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))) {
    throw new Error("Performance environment values must be scalar");
  }
  const releaseLock = await acquireStartLock(rootDir);
  try {
    const active = await getActivePerformanceRun(rootDir);
    if (active) throw new Error(`Performance Run ${active.run_id} is already active`);
    const now = isoNow();
    const run: PerformanceRunRecord = {
      schema_version: 1,
      run_id: formatRunId(),
      status: "recording",
      data_integrity: "complete",
      started_at: now,
      updated_at: now,
      ended_at: null,
      report_locale: null,
      report_status: "not_generated",
      report_error: null,
      app_version: input.app_version?.trim() || "unknown",
      environment,
      initial_settings: initialSettings,
      event_count: 0,
      dropped_event_count: 0,
      token_usage: emptyPerformanceTokenUsage(),
    };
    const paths = getPerformanceRunPaths(run.run_id, rootDir);
    await mkdir(paths.run_dir, { recursive: false });
    await writeFile(paths.events_path, "", "utf8");
    await atomicWriteJson(paths.run_path, run);
    await atomicWriteJson(paths.active_run_path, { schema_version: 1, run_id: run.run_id });
    return toSummary(run, rootDir);
  } finally {
    await releaseLock();
  }
}

function validateEvent(value: unknown): PerformanceEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Performance event must be an object");
  const event = value as Partial<PerformanceEvent>;
  if (event.schema_version !== 1) throw new Error("Performance event schema_version must be 1");
  if (typeof event.event_id !== "string" || event.event_id.length < 8 || event.event_id.length > 128) throw new Error("Performance event_id is invalid");
  if (!["span.started", "span.finished", "button.interaction", "token.usage", "data.loss"].includes(event.event_type ?? "")) throw new Error("Performance event_type is invalid");
  if (typeof event.recorded_at !== "string" || !Number.isFinite(Date.parse(event.recorded_at))) throw new Error("Performance event recorded_at is invalid");
  if (typeof event.producer_id !== "string" || event.producer_id.length === 0 || event.producer_id.length > 128) throw new Error("Performance event producer_id is invalid");
  if (!Number.isSafeInteger(event.sequence_number) || Number(event.sequence_number) < 0) throw new Error("Performance event sequence_number is invalid");
  for (const key of ["duration_ms", "interaction_delay_ms", "feedback_delay_ms"] as const) {
    const measurement = event[key];
    if (measurement !== undefined && (!Number.isFinite(measurement) || measurement < 0)) throw new Error(`Performance event ${key} is invalid`);
  }
  for (const key of ["trace_id", "span_id", "parent_span_id", "operation_name", "workspace_id"] as const) {
    const field = event[key];
    if (field !== undefined && (typeof field !== "string" || field.length === 0 || field.length > 160)) throw new Error(`Performance event ${key} is invalid`);
  }
  if (event.attributes !== undefined) {
    const entries = Object.entries(event.attributes);
    if (entries.length > 32 || entries.some(([key, attribute]) => key.length > 80 || (attribute !== null && !["string", "number", "boolean"].includes(typeof attribute)))) {
      throw new Error("Performance event attributes must contain at most 32 bounded scalar values");
    }
  }
  if (Buffer.byteLength(JSON.stringify(event)) > 16 * 1024) throw new Error("Performance event exceeds 16384 bytes");
  return event as PerformanceEvent;
}

async function serializeAppend(runId: string, task: () => Promise<void>) {
  const previous = appendQueues.get(runId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  appendQueues.set(runId, next);
  try {
    await next;
  } finally {
    if (appendQueues.get(runId) === next) appendQueues.delete(runId);
  }
}

export async function appendPerformanceEvents(input: {
  run_id: string;
  events: unknown[];
  root_dir?: string;
}): Promise<{ appended: number; run: PerformanceRunSummary }> {
  const rootDir = input.root_dir ?? DEFAULT_ROOT;
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > MAX_EVENTS_PER_APPEND) {
    throw new Error(`"events" must contain between 1 and ${MAX_EVENTS_PER_APPEND} items`);
  }
  const events = input.events.map(validateEvent);
  const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  if (Buffer.byteLength(payload) > MAX_APPEND_BYTES) throw new Error(`Performance event batch exceeds ${MAX_APPEND_BYTES} bytes`);
  let result!: PerformanceRunSummary;
  await serializeAppend(assertRunId(input.run_id), async () => {
    const run = await readRun(input.run_id, rootDir);
    if (run.status !== "recording") throw new Error(`Performance Run ${run.run_id} is not recording`);
    const paths = getPerformanceRunPaths(run.run_id, rootDir);
    await appendFile(paths.events_path, payload, "utf8");
    const next = { ...run, event_count: run.event_count + events.length, updated_at: isoNow() };
    if (events.some((event) => event.event_type === "data.loss")) {
      next.data_integrity = "degraded";
      next.dropped_event_count += events.reduce((sum, event) => sum + Number(event.attributes?.dropped_count ?? 0), 0);
    }
    await atomicWriteJson(paths.run_path, next);
    result = await toSummary(next, rootDir);
  });
  return { appended: events.length, run: result };
}

interface ParsedEvents {
  events: PerformanceEvent[];
  corruptLineCount: number;
}

async function parseEvents(filePath: string): Promise<ParsedEvents> {
  const content = await readFile(filePath, "utf8");
  const events: PerformanceEvent[] = [];
  let corruptLineCount = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(validateEvent(JSON.parse(line)));
    } catch {
      corruptLineCount += 1;
    }
  }
  return { events, corruptLineCount };
}

function activeSpans(events: PerformanceEvent[]) {
  const active = new Map<string, PerformanceEvent>();
  for (const event of events) {
    if (!event.span_id) continue;
    if (event.event_type === "span.started") active.set(event.span_id, event);
    if (event.event_type === "span.finished") active.delete(event.span_id);
  }
  return active;
}

function hasEventIntegrityIssue(events: PerformanceEvent[]) {
  const eventIds = new Set<string>();
  const lastSequenceByProducer = new Map<string, number>();
  for (const event of events) {
    if (eventIds.has(event.event_id)) return true;
    eventIds.add(event.event_id);
    const previous = lastSequenceByProducer.get(event.producer_id);
    if (previous !== undefined && event.sequence_number !== previous + 1) return true;
    lastSequenceByProducer.set(event.producer_id, event.sequence_number);
  }
  return false;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function formatDuration(value: number) {
  if (value >= 60_000) return `${Math.floor(value / 60_000)}m ${((value % 60_000) / 1_000).toFixed(1)}s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s`;
  return `${value.toFixed(value >= 100 ? 0 : 1)}ms`;
}

function formatBytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.max(0, Math.round(value))} B`;
}

interface PerformanceMetric {
  name: string;
  events: PerformanceEvent[];
  durations: number[];
  total: number;
  wall_clock: number;
  average: number;
  p95: number;
  max: number;
  errors: number;
  interrupted: number;
}

function mergedWallClockDuration(events: PerformanceEvent[]) {
  const intervals = events.map((event) => {
    const end = Date.parse(event.recorded_at);
    const duration = event.duration_ms ?? 0;
    return { start: end - duration, end };
  }).filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end))
    .sort((left, right) => left.start - right.start);
  if (intervals.length === 0) return 0;
  let total = 0;
  let start = intervals[0].start;
  let end = intervals[0].end;
  for (const interval of intervals.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
      continue;
    }
    total += end - start;
    start = interval.start;
    end = interval.end;
  }
  return total + end - start;
}

function metric(name: string, events: PerformanceEvent[]): PerformanceMetric | null {
  const measured = events.filter((event) => typeof event.duration_ms === "number");
  if (measured.length === 0) return null;
  const durations = measured.map((event) => event.duration_ms ?? 0);
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  return {
    name,
    events: measured,
    durations,
    total,
    wall_clock: mergedWallClockDuration(measured),
    average: total / durations.length,
    p95: percentile(durations, 0.95),
    max: Math.max(...durations),
    errors: measured.filter((event) => event.status === "error").length,
    interrupted: measured.filter((event) => event.status === "interrupted").length,
  };
}

function preferredOperationMetric(finished: PerformanceEvent[], name: string) {
  for (const candidate of [name, `${name}.roundtrip`, `${name}.backend`]) {
    const result = metric(name, finished.filter((event) => event.operation_name === candidate));
    if (result) return result;
  }
  return null;
}

export type ReportLocale = "en" | "zh" | "ja" | "de";

// 标签元组顺序固定为 [zh, en, ja, de]
const LOCALE_INDEX: Record<ReportLocale, number> = { zh: 0, en: 1, ja: 2, de: 3 };

function operationLabel(name: string, locale: ReportLocale) {
  const labels: Record<string, [string, string, string, string]> = {
    "requirements.create": ["演示需求创建", "Requirements creation", "プレゼン要件作成", "Anforderungserstellung"],
    "outline.create": ["大纲创建", "Outline creation", "アウトライン作成", "Gliederungserstellung"],
    "outline.rewrite": ["大纲重写", "Outline rewrite", "アウトライン書き換え", "Gliederungsüberarbeitung"],
    "generation.run": ["整套生成", "Deck generation", "デッキ全体生成", "Deck-Generierung"],
    "authoring_kit.install": ["安装 Authoring Kit", "Install Authoring Kit", "Authoring Kit インストール", "Authoring Kit installieren"],
    "style_guide.create": ["创建艺术指导", "Create style guide", "スタイルガイド作成", "Style Guide erstellen"],
    "page_sources.prepare": ["准备页面源码", "Prepare page sources", "ページソース準備", "Seitenquellen vorbereiten"],
    "research.run": ["研究", "Research", "リサーチ", "Recherche"],
    "research.web.decision": ["判断是否需要 Web 资料", "Decide whether web research is needed", "Web 資料の要否判断", "Entscheidung über Web-Recherche"],
    "research.web.search": ["Web 搜索阶段", "Web search stage", "Web 検索ステージ", "Web-Suchphase"],
    "web.search": ["Web 搜索调用", "Web search calls", "Web 検索呼び出し", "Web-Suchaufrufe"],
    "research.web.fetch_selection": ["判断需要读取的网页", "Select pages to fetch", "取得ページの選定", "Abrufseiten auswählen"],
    "research.web.fetch": ["Web 正文抓取阶段", "Web fetch stage", "Web 本文取得ステージ", "Web-Abrufphase"],
    "web.fetch": ["Web 抓取调用", "Web fetch calls", "Web 取得呼び出し", "Web-Abrufaufrufe"],
    "research.web.synthesis": ["Web 信息整理", "Web information synthesis", "Web 情報整理", "Web-Informationssynthese"],
    "research.web.publish": ["发布 Web 研究结果", "Publish web research", "Web リサーチ結果の公開", "Web-Recherche veröffentlichen"],
    "research.image.decision": ["判断是否需要图片", "Decide whether images are needed", "画像の要否判断", "Entscheidung über Bildrecherche"],
    "research.image.search": ["图片搜索阶段", "Image search stage", "画像検索ステージ", "Bildsuchphase"],
    "image.search": ["图片搜索调用", "Image search calls", "画像検索呼び出し", "Bildsuchaufrufe"],
    "research.image.analysis": ["图片 Session 判断", "Image session assessment", "画像 Session 判定", "Bild-Session-Bewertung"],
    "image.fetch": ["获取图片下载地址", "Resolve image downloads", "画像ダウンロード先の解決", "Bild-Downloads auflösen"],
    "research.image.download": ["下载图片", "Download images", "画像ダウンロード", "Bilder herunterladen"],
    "research.image.import": ["上传并导入图片", "Upload and import images", "画像のアップロードとインポート", "Bilder hochladen und importieren"],
    "research.image.publish": ["发布图片研究结果", "Publish image research", "画像リサーチ結果の公開", "Bildrecherche veröffentlichen"],
    "page.generation": ["页面生成", "Page generation", "ページ生成", "Seitengenerierung"],
    "page.research": ["页面研究", "Page research", "ページリサーチ", "Seitenrecherche"],
    "page.authoring": ["页面创作", "Page authoring", "ページ作成", "Seitenerstellung"],
    "page.render": ["页面渲染", "Page render", "ページレンダリング", "Seiten-Rendering"],
    "page.render_fix": ["渲染修复", "Render fix", "レンダリング修正", "Rendering-Korrektur"],
    "page.visual_review": ["视觉检查", "Visual review", "ビジュアルチェック", "Visuelle Prüfung"],
    "page.visual_review_fix": ["视觉修复", "Visual review fix", "ビジュアル修正", "Visuelle Korrektur"],
    "final_deck_render": ["最终 Deck 渲染", "Final deck render", "最終デッキレンダリング", "Finales Deck-Rendering"],
    "generation.commit": ["提交生成结果", "Commit generation", "生成結果のコミット", "Generierung committen"],
    "ai.interaction": ["AI 调用", "AI interaction", "AI 呼び出し", "KI-Interaktion"],
    "agent.session": ["Agent 会话", "Agent session", "Agent セッション", "Agent-Sitzung"],
    "host_upload": ["Host Upload", "Host Upload", "Host Upload", "Host Upload"],
    "page_refinement.end_to_end": ["单页 AI 修改（端到端）", "Page refinement (end-to-end)", "ページAI修正（エンドツーエンド）", "Seiten-KI-Überarbeitung (End-to-End)"],
    "page_refinement.run": ["单页 AI 修改", "Page refinement", "ページAI修正", "Seiten-KI-Überarbeitung"],
    "deck_refinement.run": ["整套 AI 修改", "Deck refinement", "デッキ一括AI修正", "Deck-KI-Überarbeitung"],
  };
  return labels[name]?.[LOCALE_INDEX[locale]] ?? name;
}

function buttonLabel(buttonId: string, locale: ReportLocale) {
  const labels: Record<string, [string, string, string, string]> = {
    "brief.create-deck": ["创建 PPT", "Create deck", "PPT を作成", "Deck erstellen"],
    "requirements.create.retry": ["重试创建演示需求", "Retry requirements creation", "要件作成を再試行", "Anforderungserstellung wiederholen"],
    "requirements.save": ["保存演示需求", "Save requirements", "要件を保存", "Anforderungen speichern"],
    "requirements.confirm": ["确认演示需求", "Confirm requirements", "要件を確定", "Anforderungen bestätigen"],
    "outline.create.retry": ["重试创建大纲", "Retry outline creation", "アウトライン作成を再試行", "Gliederungserstellung wiederholen"],
    "outline.rewrite": ["重写大纲", "Rewrite outline", "アウトラインを書き換え", "Gliederung überarbeiten"],
    "outline.save": ["保存大纲", "Save outline", "アウトラインを保存", "Gliederung speichern"],
    "outline.confirm": ["确认大纲", "Confirm outline", "アウトラインを確定", "Gliederung bestätigen"],
    "generation.resume": ["继续生成", "Resume generation", "生成を再開", "Generierung fortsetzen"],
    "deck.refine-page": ["修改当前页", "Refine page", "現在のページを修正", "Seite verfeinern"],
    "deck.refine-deck": ["修改整套 PPT", "Refine deck", "PPT 全体を修正", "Deck verfeinern"],
    "deck.preview": ["预览 PPT", "Preview deck", "PPT をプレビュー", "Deck-Vorschau"],
    "deck.export": ["打开导出", "Open export", "エクスポートを開く", "Export öffnen"],
    "export.pptx.start": ["导出 PPTX", "Export PPTX", "PPTX をエクスポート", "PPTX exportieren"],
    "export.pdf.start": ["导出 PDF", "Export PDF", "PDF をエクスポート", "PDF exportieren"],
    "workspace.create": ["新建工作区", "Create workspace", "ワークスペースを作成", "Workspace erstellen"],
    "workspace.open-latest": ["打开最近工作区", "Open latest workspace", "最近のワークスペースを開く", "Letzten Workspace öffnen"],
    "my-work.workspace.open": ["打开 PPT", "Open presentation", "PPT を開く", "Präsentation öffnen"],
    "my-work.new-presentation": ["新建 PPT", "New presentation", "新規 PPT", "Neue Präsentation"],
    "settings.preferences.save": ["保存设置", "Save settings", "設定を保存", "Einstellungen speichern"],
  };
  if (labels[buttonId]) return labels[buttonId][LOCALE_INDEX[locale]];
  return buttonId.split(".").map((part) => part.replaceAll("-", " ")).join(" / ");
}

const REPORT_LABELS_ZH = {
    title: "PPT 性能测试报告", subtitle: "面向测试人员的业务流程耗时与交互反馈摘要", overview: "运行摘要", total: "测试总时长", generation: "整套生成耗时", clicks: "按钮点击", slowestButton: "最慢按钮反馈", issues: "异常操作", integrity: "数据完整性", tokenUsage: "Token 消耗", tokenUsageNote: "Session 和 LLM 分开统计；总计为两类调用的合计，不代表额外的第三类调用。", tokenSource: "来源", session: "Session 会话", llm: "LLM 调用", inputTokens: "输入 Token", outputTokens: "输出 Token", totalTokens: "总 Token", calls: "调用次数", cacheRead: "缓存读取 Token", estimatedCost: "估算成本", slowButtons: "耗时前 10 按钮", buttonNote: "按钮耗时表示浏览器收到点击后到下一帧反馈的 UI 延迟，不代表后台任务完成时间。", rank: "排名", button: "按钮名称", count: "次数", interaction: "平均交互", feedbackAverage: "平均反馈", feedbackP95: "反馈 P95", maximum: "最大", workflow: "PPT 创建流程", workflowNote: "业务阶段显示系统处理时间，不包含测试人员阅读、编辑和确认时的停留时间。", generationBreakdown: "生成过程分解", generationNote: "墙钟耗时合并了并行区间，表示实际等待；累计耗时表示全部调用工作量。父子阶段可能相互包含，不能直接相加。", preparation: "生成准备", research: "研究过程", pages: "逐页生成", completion: "生成收尾", pageBreakdown: "页面生成明细", page: "页面", authoring: "创作", render: "渲染", renderFix: "渲染修复", visualReview: "视觉检查", visualReviewFix: "视觉修复", uploads: "上传性能", uploadNote: "当前统计来自前端 Host Upload 完成事件，单次耗时覆盖协商、文件传输和确认；不包含后端上传、自动重试分解或各阶段独立耗时。", uploadCount: "上传次数", uploadData: "总上传数据量", uploadAverage: "平均上传耗时", uploadP95: "上传耗时 P95", uploadMaximum: "最大上传耗时", uploadIssues: "上传异常", successful: "成功", averageSize: "平均文件大小", stage: "阶段", wallClock: "墙钟耗时", totalWork: "累计耗时", average: "平均", errors: "异常", slowOperations: "最慢业务操作", diagnostics: "技术诊断数据", diagnosticsNote: "用于开发排查的底层 Tool、backend 和 roundtrip 指标。", issueDetails: "错误、中断与数据丢失", noData: "本次运行没有相应数据。", events: "个事件", started: "开始", ended: "结束", time: "时间", type: "类型", duration: "耗时", status: "状态", runsUnit: " 次", issuesUnit: "异常", notRecorded: "未记录", totalRow: "合计", eventFileIntegrity: "事件文件完整性", pageLabel: "第 {n} 页", };
const REPORT_LABELS_EN: typeof REPORT_LABELS_ZH = {
    title: "PPT Performance Report", subtitle: "Business workflow timing and interaction feedback for testers", overview: "Run summary", total: "Run duration", generation: "Deck generation", clicks: "Button clicks", slowestButton: "Slowest button feedback", issues: "Operation issues", integrity: "Data integrity", tokenUsage: "Token usage", tokenUsageNote: "Session and LLM calls are reported separately; total is their combined usage, not an additional call type.", tokenSource: "Source", session: "Session", llm: "LLM", inputTokens: "Input tokens", outputTokens: "Output tokens", totalTokens: "Total tokens", calls: "Calls", cacheRead: "Cache read tokens", estimatedCost: "Estimated cost", slowButtons: "Top 10 slowest buttons", buttonNote: "Button timing measures browser UI feedback from click receipt to the next frame. It is not backend task completion time.", rank: "Rank", button: "Button", count: "Count", interaction: "Avg interaction", feedbackAverage: "Avg feedback", feedbackP95: "Feedback P95", maximum: "Max", workflow: "PPT creation workflow", workflowNote: "Business stages show system processing time and exclude time spent by the tester reading, editing, or confirming.", generationBreakdown: "Generation breakdown", generationNote: "Wall-clock time merges overlapping intervals and represents actual waiting time. Cumulative time represents total work. Parent and child stages may overlap and must not be added together.", preparation: "Generation preparation", research: "Research", pages: "Page generation", completion: "Generation completion", pageBreakdown: "Page generation details", page: "Page", authoring: "Authoring", render: "Render", renderFix: "Render fixes", visualReview: "Visual review", visualReviewFix: "Visual fixes", uploads: "Upload performance", uploadNote: "Current metrics come from completed frontend Host Upload events. Each duration covers negotiation, file transfer, and confirmation; backend uploads, retry breakdowns, and per-phase timings are not included.", uploadCount: "Upload count", uploadData: "Total uploaded data", uploadAverage: "Average upload duration", uploadP95: "Upload duration P95", uploadMaximum: "Maximum upload duration", uploadIssues: "Upload issues", successful: "Successful", averageSize: "Average file size", stage: "Stage", wallClock: "Wall clock", totalWork: "Cumulative", average: "Average", errors: "Issues", slowOperations: "Slowest business operations", diagnostics: "Technical diagnostics", diagnosticsNote: "Low-level Tool, backend, and roundtrip metrics for engineering diagnosis.", issueDetails: "Errors, interruptions, and data loss", noData: "No corresponding data was recorded in this run.", events: "events", started: "Started", ended: "Ended", time: "Time", type: "Type", duration: "Duration", status: "Status", runsUnit: " runs", issuesUnit: "issues", notRecorded: "Not recorded", totalRow: "Total", eventFileIntegrity: "Event file integrity", pageLabel: "Page {n}", };
const REPORT_LABELS_JA: typeof REPORT_LABELS_ZH = { title: "PPT パフォーマンステストレポート", subtitle: "テスター向けの業務フロー所要時間とインタラクションフィードバックの要約", overview: "実行サマリー", total: "テスト総時間", generation: "デッキ全体の生成時間", clicks: "ボタンクリック", slowestButton: "最も遅いボタンフィードバック", issues: "異常な操作", integrity: "データ整合性", tokenUsage: "Token 消費", tokenUsageNote: "Session と LLM は別々に集計されます。合計は 2 種類の呼び出しの合算であり、追加の呼び出し種別ではありません。", tokenSource: "ソース", session: "Session セッション", llm: "LLM 呼び出し", inputTokens: "入力 Token", outputTokens: "出力 Token", totalTokens: "総 Token", calls: "呼び出し回数", cacheRead: "キャッシュ読み取り Token", estimatedCost: "推定コスト", slowButtons: "所要時間上位 10 ボタン", buttonNote: "ボタン所要時間は、ブラウザがクリックを受け取ってから次のフレームのフィードバックまでの UI 遅延であり、バックグラウンドタスクの完了時間ではありません。", rank: "順位", button: "ボタン名", count: "回数", interaction: "平均インタラクション", feedbackAverage: "平均フィードバック", feedbackP95: "フィードバック P95", maximum: "最大", workflow: "PPT 作成フロー", workflowNote: "業務ステージはシステムの処理時間を示し、テスターが閲覧・編集・確認に費やした時間は含みません。", generationBreakdown: "生成プロセスの分解", generationNote: "壁時計時間は並列区間をマージし、実際の待機時間を表します。累計時間は全呼び出しの作業量を表します。親子ステージは相互に含まれる場合があり、直接加算できません。", preparation: "生成準備", research: "リサーチプロセス", pages: "ページごとの生成", completion: "生成の仕上げ", pageBreakdown: "ページ生成の明細", page: "ページ", authoring: "作成", render: "レンダリング", renderFix: "レンダリング修正", visualReview: "ビジュアルチェック", visualReviewFix: "ビジュアル修正", uploads: "アップロード性能", uploadNote: "現在の統計はフロントエンドの Host Upload 完了イベントに基づきます。各所要時間はネゴシエーション、ファイル転送、確認を含み、バックエンドのアップロード、自動リトライの分解、各フェーズの個別時間は含みません。", uploadCount: "アップロード回数", uploadData: "総アップロードデータ量", uploadAverage: "平均アップロード時間", uploadP95: "アップロード時間 P95", uploadMaximum: "最大アップロード時間", uploadIssues: "アップロード異常", successful: "成功", averageSize: "平均ファイルサイズ", stage: "ステージ", wallClock: "壁時計時間", totalWork: "累計時間", average: "平均", errors: "異常", slowOperations: "最も遅い業務操作", diagnostics: "技術診断データ", diagnosticsNote: "開発調査用の低レベル Tool、backend、roundtrip 指標。", issueDetails: "エラー・中断・データ損失", noData: "この実行には該当データがありません。", events: "件のイベント", started: "開始", ended: "終了", time: "時刻", type: "タイプ", duration: "所要時間", status: "ステータス", runsUnit: " 回", issuesUnit: "異常", notRecorded: "未記録", totalRow: "合計", eventFileIntegrity: "イベントファイル整合性", pageLabel: "{n} ページ", };
const REPORT_LABELS_DE: typeof REPORT_LABELS_ZH = { title: "PPT-Performance-Bericht", subtitle: "Zusammenfassung von Workflow-Laufzeiten und Interaktionsfeedback für Tester", overview: "Laufübersicht", total: "Gesamtdauer des Tests", generation: "Deck-Generierungsdauer", clicks: "Button-Klicks", slowestButton: "Langsamstes Button-Feedback", issues: "Auffällige Vorgänge", integrity: "Datenintegrität", tokenUsage: "Token-Verbrauch", tokenUsageNote: "Session- und LLM-Aufrufe werden getrennt ausgewiesen; die Summe ist ihr kombinierter Verbrauch, kein zusätzlicher Aufruftyp.", tokenSource: "Quelle", session: "Session", llm: "LLM-Aufrufe", inputTokens: "Eingabe-Tokens", outputTokens: "Ausgabe-Tokens", totalTokens: "Tokens gesamt", calls: "Aufrufe", cacheRead: "Cache-Lese-Tokens", estimatedCost: "Geschätzte Kosten", slowButtons: "Top 10 der langsamsten Buttons", buttonNote: "Die Button-Zeit misst die UI-Verzögerung vom Klick bis zum nächsten Frame-Feedback im Browser, nicht die Abschlusszeit der Hintergrundaufgabe.", rank: "Rang", button: "Button-Name", count: "Anzahl", interaction: "Ø Interaktion", feedbackAverage: "Ø Feedback", feedbackP95: "Feedback P95", maximum: "Maximum", workflow: "PPT-Erstellungsablauf", workflowNote: "Geschäftsphasen zeigen die Systemverarbeitungszeit und schließen die Zeit aus, die der Tester mit Lesen, Bearbeiten und Bestätigen verbringt.", generationBreakdown: "Aufschlüsselung der Generierung", generationNote: "Die Wall-Clock-Zeit fasst parallele Intervalle zusammen und entspricht der tatsächlichen Wartezeit. Die kumulative Zeit entspricht dem gesamten Arbeitsaufwand. Eltern- und Kindphasen können sich überschneiden und dürfen nicht addiert werden.", preparation: "Generierungsvorbereitung", research: "Rechercheprozess", pages: "Seitenweise Generierung", completion: "Generierungsabschluss", pageBreakdown: "Details zur Seitengenerierung", page: "Seite", authoring: "Erstellung", render: "Rendering", renderFix: "Rendering-Korrektur", visualReview: "Visuelle Prüfung", visualReviewFix: "Visuelle Korrektur", uploads: "Upload-Performance", uploadNote: "Die aktuellen Metriken stammen aus abgeschlossenen Frontend-Host-Upload-Ereignissen. Jede Dauer umfasst Aushandlung, Dateiübertragung und Bestätigung; Backend-Uploads, Retry-Aufschlüsselungen und Phasenzeiten sind nicht enthalten.", uploadCount: "Upload-Anzahl", uploadData: "Hochgeladene Datenmenge gesamt", uploadAverage: "Ø Upload-Dauer", uploadP95: "Upload-Dauer P95", uploadMaximum: "Maximale Upload-Dauer", uploadIssues: "Upload-Probleme", successful: "Erfolgreich", averageSize: "Ø Dateigröße", stage: "Phase", wallClock: "Wall-Clock-Zeit", totalWork: "Kumulativ", average: "Durchschnitt", errors: "Probleme", slowOperations: "Langsamste Geschäftsvorgänge", diagnostics: "Technische Diagnosedaten", diagnosticsNote: "Low-level-Metriken für Tool, Backend und Roundtrips zur Entwicklungsdiagnose.", issueDetails: "Fehler, Unterbrechungen und Datenverlust", noData: "Für diesen Lauf wurden keine entsprechenden Daten aufgezeichnet.", events: "Ereignisse", started: "Gestartet", ended: "Beendet", time: "Zeit", type: "Typ", duration: "Dauer", status: "Status", runsUnit: " Läufe", issuesUnit: "Probleme", notRecorded: "Nicht aufgezeichnet", totalRow: "Gesamt", eventFileIntegrity: "Ereignisdatei-Integrität", pageLabel: "Seite {n}", };
const REPORT_LABELS: Record<ReportLocale, typeof REPORT_LABELS_ZH> = { zh: REPORT_LABELS_ZH, en: REPORT_LABELS_EN, ja: REPORT_LABELS_JA, de: REPORT_LABELS_DE };
function createReportHtml(run: PerformanceRunRecord, parsed: ParsedEvents, locale: ReportLocale) {
  const labels = REPORT_LABELS[locale];
  const finished = parsed.events.filter((event) => event.event_type === "span.finished" && typeof event.duration_ms === "number");
  const integrity = run.data_integrity === "complete" && parsed.corruptLineCount === 0 && !hasEventIntegrityIssue(parsed.events) ? "complete" : "degraded";
  const runDuration = run.ended_at ? Math.max(0, Date.parse(run.ended_at) - Date.parse(run.started_at)) : 0;
  const failures = finished.filter((event) => event.status === "error" || event.status === "interrupted");
  const tokenUsage = summarizePerformanceTokenUsage(parsed.events);

  const buttonGroups = new Map<string, PerformanceEvent[]>();
  for (const event of parsed.events.filter((item) => item.event_type === "button.interaction")) {
    const buttonId = String(event.attributes?.button_id ?? "unknown");
    buttonGroups.set(buttonId, [...(buttonGroups.get(buttonId) ?? []), event]);
  }
  const buttonMetrics = Array.from(buttonGroups.entries()).map(([buttonId, events]) => {
    const interaction = events.map((event) => event.interaction_delay_ms ?? 0);
    const feedback = events.map((event) => event.feedback_delay_ms ?? 0);
    return {
      buttonId,
      count: events.length,
      interactionAverage: interaction.reduce((sum, value) => sum + value, 0) / interaction.length,
      feedbackAverage: feedback.reduce((sum, value) => sum + value, 0) / feedback.length,
      feedbackP95: percentile(feedback, 0.95),
      feedbackMax: Math.max(...feedback),
    };
  }).sort((left, right) => right.feedbackP95 - left.feedbackP95);
  const topButtons = buttonMetrics.slice(0, 10);
  const topButtonRows = topButtons.map((item, index) => `<tr><td class="rank">${index + 1}</td><td><strong>${escapeHtml(buttonLabel(item.buttonId, locale))}</strong><code>${escapeHtml(item.buttonId)}</code></td><td>${item.count}</td><td>${formatDuration(item.interactionAverage)}</td><td>${formatDuration(item.feedbackAverage)}</td><td>${formatDuration(item.feedbackP95)}</td><td>${formatDuration(item.feedbackMax)}</td></tr>`).join("");

  const primaryStages = [
    "requirements.create",
    "outline.create",
    "outline.rewrite",
    "generation.run",
    "page_refinement.end_to_end",
    "page_refinement.run",
    "deck_refinement.run",
  ];
  const primaryMetrics = primaryStages.map((name) => ({ name, value: preferredOperationMetric(finished, name) }));
  const maxPrimaryDuration = Math.max(1, ...primaryMetrics.map((item) => item.value?.wall_clock ?? 0));
  const stageRows = primaryMetrics.map(({ name, value }) => `<div class="stage-row"><div class="stage-name"><strong>${escapeHtml(operationLabel(name, locale))}</strong><code>${name}</code></div><div class="stage-track"><i style="width:${value ? Math.max(2, value.wall_clock / maxPrimaryDuration * 100) : 0}%"></i></div><div class="stage-value">${value ? `<strong>${formatDuration(value.wall_clock)}</strong><span>${value.events.length}${labels.runsUnit}${value.errors + value.interrupted ? ` · ${value.errors + value.interrupted} ${labels.issuesUnit}` : ""}</span>` : `<span>${labels.notRecorded}</span>`}</div></div>`).join("");

  const pageGroups = new Map<string, PerformanceEvent[]>();
  for (const event of finished) {
    const pageId = event.attributes?.page_id;
    if (typeof pageId !== "string" || !pageId) continue;
    pageGroups.set(pageId, [...(pageGroups.get(pageId) ?? []), event]);
  }
  const pageRows = Array.from(pageGroups.entries()).map(([pageId, events]) => {
    const pageIndex = Math.min(...events.map((event) => Number(event.attributes?.page_index ?? Number.MAX_SAFE_INTEGER)));
    const stageFor = (...names: string[]) => {
      const matching = events.filter((event) => names.includes(event.operation_name ?? ""));
      return { duration: matching.reduce((sum, event) => sum + (event.duration_ms ?? 0), 0), count: matching.length };
    };
    const total = stageFor("page.generation");
    const issues = events.filter((event) => event.status === "error" || event.status === "interrupted").length;
    return { pageId, pageIndex, total, authoring: stageFor("page.authoring"), render: stageFor("page.render"), renderFix: stageFor("page.render_fix"), review: stageFor("page.visual_review"), reviewFix: stageFor("page.visual_review_fix"), issues };
  }).sort((left, right) => left.pageIndex - right.pageIndex);
  const stageCell = (stage: { duration: number; count: number }) => stage.count > 0
    ? `${formatDuration(stage.duration)}<small>${stage.count}${labels.runsUnit}</small>`
    : "—";
  const pageDetailRows = pageRows.map((item) => `<tr><td><strong>${labels.pageLabel.replace("{n}", String(item.pageIndex + 1))}</strong><code>${escapeHtml(item.pageId)}</code></td><td>${stageCell(item.total)}</td><td>${stageCell(item.authoring)}</td><td>${stageCell(item.render)}</td><td>${stageCell(item.renderFix)}</td><td>${stageCell(item.review)}</td><td>${stageCell(item.reviewFix)}</td><td>${item.issues}</td></tr>`).join("");

  const operationGroups = new Map<string, PerformanceEvent[]>();
  for (const event of finished) {
    const name = event.operation_name || "unknown";
    operationGroups.set(name, [...(operationGroups.get(name) ?? []), event]);
  }
  const operationMetrics = Array.from(operationGroups.entries()).map(([name, events]) => metric(name, events)).filter((item): item is PerformanceMetric => item !== null);
  const slowOperations = operationMetrics.filter((item) => !item.name.endsWith(".backend") && !item.name.endsWith(".roundtrip") && !item.name.startsWith("tool.")).sort((left, right) => right.max - left.max).slice(0, 10);
  const slowRows = slowOperations.map((item, index) => `<tr><td class="rank">${index + 1}</td><td><strong>${escapeHtml(operationLabel(item.name, locale))}</strong><code>${escapeHtml(item.name)}</code></td><td>${item.events.length}</td><td>${formatDuration(item.average)}</td><td>${formatDuration(item.p95)}</td><td>${formatDuration(item.max)}</td><td>${item.errors + item.interrupted}</td></tr>`).join("");

  const diagnosticRows = operationMetrics.sort((left, right) => right.max - left.max).map((item) => `<tr><td><code>${escapeHtml(item.name)}</code></td><td>${item.events.length}</td><td>${formatDuration(item.average)}</td><td>${formatDuration(item.p95)}</td><td>${formatDuration(item.max)}</td><td>${item.errors + item.interrupted}</td></tr>`).join("");
  const issueEvents = parsed.events.filter((event) => event.event_type === "data.loss" || event.status === "error" || event.status === "interrupted").slice(0, MAX_REPORT_DETAIL_ROWS);
  const issueRows = issueEvents.map((event) => `<tr><td>${escapeHtml(event.recorded_at)}</td><td>${escapeHtml(event.event_type)}</td><td><code>${escapeHtml(event.operation_name ?? event.attributes?.button_id ?? "")}</code></td><td>${event.duration_ms === undefined ? "—" : formatDuration(event.duration_ms)}</td><td>${escapeHtml(event.status ?? event.attributes?.reason ?? "")}</td></tr>`).join("");

  const uploadMetric = metric("host_upload", finished.filter((event) => event.operation_name === "host_upload"));
  const uploadSizes = uploadMetric?.events
    .map((event) => event.attributes?.size_bytes)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0) ?? [];
  const uploadTotalBytes = uploadSizes.reduce((sum, value) => sum + value, 0);
  const uploadAverageBytes = uploadSizes.length > 0 ? uploadTotalBytes / uploadSizes.length : null;

  const formatTokenCount = (value: number) => Math.round(value).toLocaleString(({ zh: "zh-CN", en: "en-US", ja: "ja-JP", de: "de-DE" } as Record<ReportLocale, string>)[locale]);
  const formatEstimatedCost = (value: number | null) => value === null ? "—" : value.toFixed(6);
  // 报告里少数硬编码文案按「是否中文」二选一；其余文案一律走 locale 标签表。
  const zh = locale === "zh";
  const tokenRows = [
    [labels.session, tokenUsage.session],
    [labels.llm, tokenUsage.llm],
    [labels.totalRow, tokenUsage.total],
  ].map(([name, bucket]) => {
    const value = bucket as typeof tokenUsage.total;
    return `<tr><td><strong>${escapeHtml(name)}</strong></td><td>${value.available ? formatTokenCount(value.input_tokens) : "—"}</td><td>${value.available ? formatTokenCount(value.output_tokens) : "—"}</td><td>${value.available ? formatTokenCount(value.total_tokens) : "—"}</td><td>${value.available ? formatTokenCount(value.calls) : "—"}</td><td>${value.available ? formatTokenCount(value.cache_read_tokens) : "—"}</td><td>${value.available ? formatEstimatedCost(value.estimated_cost) : "—"}</td></tr>`;
  }).join("");
  const tokenUsageSummaryDetails = tokenUsage.total.available
    ? `<div class="table-wrap"><table><thead><tr><th>${labels.tokenSource}</th><th>${labels.inputTokens}</th><th>${labels.outputTokens}</th><th>${labels.totalTokens}</th><th>${labels.calls}</th><th>${labels.cacheRead}</th><th>${labels.estimatedCost}</th></tr></thead><tbody>${tokenRows}</tbody></table></div>`
    : `<div class="empty">${labels.noData}</div>`;
  const tokenOperations = new Map<string, PerformanceEvent[]>();
  for (const event of parsed.events) {
    if (event.event_type !== "token.usage") continue;
    const name = event.operation_name || "unknown";
    tokenOperations.set(name, [...(tokenOperations.get(name) ?? []), event]);
  }
  const tokenOperationRows = Array.from(tokenOperations.entries())
    .map(([name, events]) => ({ name, usage: summarizePerformanceTokenUsage(events) }))
    .filter((item) => item.usage.total.available)
    .sort((left, right) => right.usage.total.total_tokens - left.usage.total.total_tokens)
    .map(({ name, usage }) => `<tr><td><strong>${escapeHtml(operationLabel(name, locale))}</strong><code>${escapeHtml(name)}</code></td><td>${formatTokenCount(usage.total.input_tokens)}</td><td>${formatTokenCount(usage.total.output_tokens)}</td><td>${formatTokenCount(usage.total.total_tokens)}</td><td>${formatTokenCount(usage.total.calls)}</td><td>${formatTokenCount(usage.total.cache_read_tokens)}</td><td>${formatEstimatedCost(usage.total.estimated_cost)}</td></tr>`)
    .join("");
  const tokenUsageByOperationDetails = tokenOperationRows
    ? `<div class="table-wrap"><table><thead><tr><th>${labels.stage}</th><th>${labels.inputTokens}</th><th>${labels.outputTokens}</th><th>${labels.totalTokens}</th><th>${labels.calls}</th><th>${labels.cacheRead}</th><th>${labels.estimatedCost}</th></tr></thead><tbody>${tokenOperationRows}</tbody></table></div>`
    : `<div class="empty">${labels.noData}</div>`;
  const tokenUsageByOperationTitle = zh ? "按操作拆分 Token" : "Token usage by operation";
  const tokenUsageByOperationNote = zh
    ? "用于定位单次页面修改中的 Agent HTML 生成等具体调用。"
    : "Use this to isolate calls such as Agent HTML generation within one page refinement.";
  const uploadSummaryItems = uploadMetric ? [
    [labels.uploadCount, String(uploadMetric.events.length)],
    [labels.uploadData, uploadSizes.length > 0 ? formatBytes(uploadTotalBytes) : "—"],
    [labels.uploadAverage, formatDuration(uploadMetric.average)],
    [labels.uploadP95, formatDuration(uploadMetric.p95)],
    [labels.uploadMaximum, formatDuration(uploadMetric.max)],
    [labels.uploadIssues, String(uploadMetric.errors + uploadMetric.interrupted)],
  ].map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("") : "";
  const uploadDetails = uploadMetric
    ? `<div class="table-wrap"><table><thead><tr><th>${labels.stage}</th><th>${labels.count}</th><th>${labels.successful}</th><th>${labels.errors}</th><th>${labels.wallClock}</th><th>${labels.totalWork}</th><th>${labels.averageSize}</th></tr></thead><tbody><tr><td><strong>${escapeHtml(operationLabel("host_upload", locale))}</strong><code>host_upload</code></td><td>${uploadMetric.events.length}</td><td>${uploadMetric.events.length - uploadMetric.errors - uploadMetric.interrupted}</td><td>${uploadMetric.errors + uploadMetric.interrupted}</td><td>${formatDuration(uploadMetric.wall_clock)}</td><td>${formatDuration(uploadMetric.total)}</td><td>${uploadAverageBytes === null ? "—" : formatBytes(uploadAverageBytes)}</td></tr></tbody></table></div>`
    : `<div class="empty">${labels.noData}</div>`;
  const generationGroups = [
    { title: labels.preparation, stages: ["authoring_kit.install", "style_guide.create", "page_sources.prepare"] },
    { title: labels.research, stages: ["research.run", "research.web.decision", "research.web.search", "web.search", "research.web.fetch_selection", "research.web.fetch", "web.fetch", "research.web.synthesis", "research.web.publish", "research.image.decision", "research.image.search", "image.search", "research.image.analysis", "image.fetch", "research.image.download", "research.image.import", "research.image.publish"] },
    { title: labels.pages, stages: ["page.generation", "page.authoring", "page.render", "page.render_fix", "page.visual_review", "page.visual_review_fix"] },
    { title: labels.completion, stages: ["final_deck_render", "generation.commit"] },
  ];
  const generationGroupHtml = generationGroups.map((group) => {
    const rows = group.stages
      .map((name) => preferredOperationMetric(finished, name))
      .filter((item): item is PerformanceMetric => item !== null)
      .map((item) => `<tr><td><strong>${escapeHtml(operationLabel(item.name, locale))}</strong><code>${item.name}</code></td><td>${item.events.length}</td><td>${formatDuration(item.wall_clock)}</td><td>${formatDuration(item.total)}</td><td>${formatDuration(item.average)}</td><td>${formatDuration(item.p95)}</td><td>${formatDuration(item.max)}</td><td>${item.errors + item.interrupted}</td></tr>`)
      .join("");
    return `<div class="generation-group"><h3>${escapeHtml(group.title)}</h3>${rows ? `<div class="table-wrap"><table><thead><tr><th>${labels.stage}</th><th>${labels.count}</th><th>${labels.wallClock}</th><th>${labels.totalWork}</th><th>${labels.average}</th><th>P95</th><th>${labels.maximum}</th><th>${labels.errors}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${labels.noData}</div>`}</div>`;
  }).join("");
  const generationMetric = preferredOperationMetric(finished, "generation.run");
  const slowestButton = topButtons[0];
  const summaryItems = [
    [labels.total, formatDuration(runDuration)],
    [labels.generation, generationMetric ? formatDuration(generationMetric.wall_clock) : "—"],
    [labels.clicks, String(parsed.events.filter((event) => event.event_type === "button.interaction").length)],
    [labels.slowestButton, slowestButton ? formatDuration(slowestButton.feedbackP95) : "—"],
    [labels.issues, String(failures.length)],
    [labels.eventFileIntegrity, integrity],
  ].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong class="${value === "degraded" ? "danger" : ""}">${escapeHtml(value)}</strong></div>`).join("");

  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${labels.title}</title><style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#202737;font:14px/1.5 system-ui,-apple-system,sans-serif}main{max-width:1180px;margin:auto;padding:32px 24px 56px}header.report-header{padding:0 0 24px;border-bottom:1px solid #dce1e8}h1{font-size:28px;line-height:1.2;margin:0}header p{margin:7px 0 0;color:#657084}header small{display:block;margin-top:15px;color:#7b8495}h2{font-size:19px;margin:32px 0 6px}h3{font-size:14px;margin:20px 0 8px}.generation-group:first-of-type h3{margin-top:14px}section>p.note{margin:0 0 14px;color:#687386;font-size:13px}.summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid #dce1e8;background:#dce1e8;gap:1px}.summary-item{background:#fff;padding:16px 18px;min-height:82px}.summary-item span{display:block;color:#687386;font-size:12px}.summary-item strong{display:block;margin-top:7px;font-size:21px}.danger{color:#b42318}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dce1e8;font-size:13px}th,td{text-align:left;padding:11px 12px;border-bottom:1px solid #e3e7ed;vertical-align:middle}th{background:#edf0f4;color:#4f5b6d;font-size:12px}tbody tr:last-child td{border-bottom:0}td.rank{width:52px;color:#7b8495}td strong{display:block;font-weight:600}td small{display:block;margin-top:2px;color:#778195;font-size:11px}code{display:block;margin-top:2px;color:#778195;font:11px/1.35 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}.stage-list{background:#fff;border:1px solid #dce1e8}.stage-row{display:grid;grid-template-columns:minmax(180px,1.2fr) minmax(180px,2fr) minmax(115px,.7fr);gap:18px;align-items:center;padding:15px 18px;border-bottom:1px solid #e3e7ed}.stage-row:last-child{border-bottom:0}.stage-name strong,.stage-value strong,.stage-value span{display:block}.stage-track{height:8px;background:#e8ebf0;overflow:hidden}.stage-track i{display:block;height:100%;background:#267a5b}.stage-value{text-align:right}.stage-value span{color:#778195;font-size:11px}.empty{padding:18px;background:#fff;border:1px solid #dce1e8;color:#778195}details{margin-top:16px;border:1px solid #dce1e8;background:#fff}summary{cursor:pointer;padding:14px 16px;font-weight:600}details .details-body{padding:0 16px 16px;overflow:auto}.table-wrap{overflow:auto;border:1px solid #dce1e8}.table-wrap table{border:0;min-width:860px}@media(max-width:720px){main{padding:22px 14px 40px}.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.stage-row{grid-template-columns:1fr}.stage-value{text-align:left}h1{font-size:24px}}@media(max-width:430px){.summary-grid{grid-template-columns:1fr}}</style></head><body><main><header class="report-header"><h1>${labels.title}</h1><p>${labels.subtitle}</p><small>Run ID: ${escapeHtml(run.run_id)} · ${labels.started}: ${escapeHtml(run.started_at)} · ${labels.ended}: ${escapeHtml(run.ended_at)} · ${parsed.events.length} ${labels.events}</small></header><section><h2>${labels.overview}</h2><div class="summary-grid">${summaryItems}</div></section><section><h2>${labels.tokenUsage}</h2><p class="note">${labels.tokenUsageNote}</p>${tokenUsageSummaryDetails}</section><section><h2>${tokenUsageByOperationTitle}</h2><p class="note">${tokenUsageByOperationNote}</p>${tokenUsageByOperationDetails}</section><section><h2>${labels.slowButtons}</h2><p class="note">${labels.buttonNote}</p>${topButtonRows ? `<div class="table-wrap"><table><thead><tr><th>${labels.rank}</th><th>${labels.button}</th><th>${labels.count}</th><th>${labels.interaction}</th><th>${labels.feedbackAverage}</th><th>${labels.feedbackP95}</th><th>${labels.maximum}</th></tr></thead><tbody>${topButtonRows}</tbody></table></div>` : `<div class="empty">${labels.noData}</div>`}</section><section><h2>${labels.workflow}</h2><p class="note">${labels.workflowNote}</p><div class="stage-list">${stageRows}</div></section><section><h2>${labels.generationBreakdown}</h2><p class="note">${labels.generationNote}</p>${generationGroupHtml}</section><section><h2>${labels.pageBreakdown}</h2>${pageDetailRows ? `<div class="table-wrap"><table><thead><tr><th>${labels.page}</th><th>${labels.total}</th><th>${labels.authoring}</th><th>${labels.render}</th><th>${labels.renderFix}</th><th>${labels.visualReview}</th><th>${labels.visualReviewFix}</th><th>${labels.errors}</th></tr></thead><tbody>${pageDetailRows}</tbody></table></div>` : `<div class="empty">${labels.noData}</div>`}</section><section><h2>${labels.uploads}</h2><p class="note">${labels.uploadNote}</p>${uploadMetric ? `<div class="summary-grid">${uploadSummaryItems}</div>${uploadDetails}` : uploadDetails}</section><section><h2>${labels.slowOperations}</h2>${slowRows ? `<div class="table-wrap"><table><thead><tr><th>${labels.rank}</th><th>${labels.stage}</th><th>${labels.count}</th><th>${labels.average}</th><th>P95</th><th>${labels.maximum}</th><th>${labels.errors}</th></tr></thead><tbody>${slowRows}</tbody></table></div>` : `<div class="empty">${labels.noData}</div>`}</section><section><h2>${labels.diagnostics}</h2><p class="note">${labels.diagnosticsNote}</p><details><summary>${labels.diagnostics}</summary><div class="details-body"><div class="table-wrap"><table><thead><tr><th>${labels.stage}</th><th>${labels.count}</th><th>${labels.average}</th><th>P95</th><th>${labels.maximum}</th><th>${labels.errors}</th></tr></thead><tbody>${diagnosticRows}</tbody></table></div></div></details><details><summary>${labels.issueDetails} (${issueEvents.length})</summary><div class="details-body">${issueRows ? `<div class="table-wrap"><table><thead><tr><th>${zh ? "时间" : "Time"}</th><th>${zh ? "类型" : "Type"}</th><th>${labels.stage}</th><th>${zh ? "耗时" : "Duration"}</th><th>${zh ? "状态" : "Status"}</th></tr></thead><tbody>${issueRows}</tbody></table></div>` : `<div class="empty">${labels.noData}</div>`}</div></details></section></main></body></html>`;
}

export async function finalizePerformanceRun(input: {
  run_id: string;
  locale: ReportLocale;
  force?: boolean;
  root_dir?: string;
}): Promise<PerformanceFinalizeResult> {
  const rootDir = input.root_dir ?? DEFAULT_ROOT;
  const paths = getPerformanceRunPaths(input.run_id, rootDir);
  await appendQueues.get(input.run_id)?.catch(() => undefined);
  let run = await readRun(input.run_id, rootDir);
  if (run.status !== "recording" && run.status !== "finalization_failed") throw new Error(`Performance Run ${run.run_id} cannot be finalized from ${run.status}`);
  let parsed = await parseEvents(paths.events_path);
  const active = activeSpans(parsed.events);
  if (active.size > 0 && !input.force) {
    return { run: await toSummary(run, rootDir), requires_force: true, active_span_count: active.size };
  }
  run = { ...run, status: "finalizing", report_locale: input.locale, updated_at: isoNow(), report_error: null };
  await atomicWriteJson(paths.run_path, run);
  try {
    if (active.size > 0) {
      const interruptedAt = isoNow();
      const interruptions = Array.from(active.values()).map((started, index): PerformanceEvent => ({
        schema_version: 1,
        event_id: randomUUID(),
        event_type: "span.finished",
        recorded_at: interruptedAt,
        producer_id: "ppt-engine-finalizer",
        sequence_number: index,
        trace_id: started.trace_id,
        span_id: started.span_id,
        parent_span_id: started.parent_span_id,
        operation_name: started.operation_name,
        workspace_id: started.workspace_id,
        duration_ms: Math.max(0, Date.parse(interruptedAt) - Date.parse(started.recorded_at)),
        status: "interrupted",
        attributes: { duration_source: "estimated_wall_clock" },
      }));
      await appendFile(paths.events_path, interruptions.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
      run.event_count += interruptions.length;
      parsed = await parseEvents(paths.events_path);
    }
    if (parsed.corruptLineCount > 0 || hasEventIntegrityIssue(parsed.events)) run.data_integrity = "degraded";
    run = {
      ...run,
      token_usage: summarizePerformanceTokenUsage(parsed.events),
      operation_metrics: summarizeOperationMetrics(parsed.events),
      status: "completed",
      report_status: "generated",
      ended_at: isoNow(),
      updated_at: isoNow(),
    };
    const html = createReportHtml(run, parsed, input.locale);
    if (Buffer.byteLength(html) > MAX_REPORT_BYTES) throw new Error(`Performance report exceeds ${MAX_REPORT_BYTES} bytes`);
    await atomicWriteText(paths.report_path, html);
    await atomicWriteJson(paths.run_path, run);
    await rm(paths.active_run_path, { force: true });
    return { run: await toSummary(run, rootDir), requires_force: false, active_span_count: active.size };
  } catch (error) {
    run = {
      ...run,
      status: "finalization_failed",
      report_status: "failed",
      report_error: error instanceof Error ? error.message : String(error),
      updated_at: isoNow(),
    };
    await atomicWriteJson(paths.run_path, run);
    throw error;
  }
}

export async function regeneratePerformanceReport(input: {
  run_id: string;
  locale: ReportLocale;
  root_dir?: string;
}): Promise<PerformanceRunSummary> {
  const rootDir = input.root_dir ?? DEFAULT_ROOT;
  const paths = getPerformanceRunPaths(input.run_id, rootDir);
  let run = await readRun(input.run_id, rootDir);
  if (run.status !== "completed") {
    throw new Error(`Performance Run ${run.run_id} cannot regenerate a report from ${run.status}`);
  }
  try {
    const parsed = await parseEvents(paths.events_path);
    const dataIntegrity = parsed.corruptLineCount > 0 || hasEventIntegrityIssue(parsed.events)
      ? "degraded"
      : "complete";
    run = {
      ...run,
      data_integrity: dataIntegrity,
      token_usage: summarizePerformanceTokenUsage(parsed.events),
      report_locale: input.locale,
      report_status: "generated",
      report_error: null,
      updated_at: isoNow(),
    };
    const html = createReportHtml(run, parsed, input.locale);
    if (Buffer.byteLength(html) > MAX_REPORT_BYTES) {
      throw new Error(`Performance report exceeds ${MAX_REPORT_BYTES} bytes`);
    }
    await atomicWriteText(paths.report_path, html);
    await atomicWriteJson(paths.run_path, run);
    return toSummary(run, rootDir);
  } catch (error) {
    run = {
      ...run,
      report_locale: input.locale,
      report_status: "failed",
      report_error: error instanceof Error ? error.message : String(error),
      updated_at: isoNow(),
    };
    await atomicWriteJson(paths.run_path, run);
    throw error;
  }
}

export async function abandonPerformanceRun(input: { run_id: string; root_dir?: string }) {
  const rootDir = input.root_dir ?? DEFAULT_ROOT;
  const paths = getPerformanceRunPaths(input.run_id, rootDir);
  await appendQueues.get(input.run_id)?.catch(() => undefined);
  const run = await readRun(input.run_id, rootDir);
  if (run.status === "completed" || run.status === "abandoned") throw new Error(`Performance Run ${run.run_id} is already terminal`);
  const next: PerformanceRunRecord = { ...run, status: "abandoned", ended_at: isoNow(), updated_at: isoNow() };
  await atomicWriteJson(paths.run_path, next);
  await rm(paths.active_run_path, { force: true });
  return toSummary(next, rootDir);
}

export async function deletePerformanceRun(input: { run_id: string; root_dir?: string }) {
  const rootDir = input.root_dir ?? DEFAULT_ROOT;
  const run = await readRun(input.run_id, rootDir);
  if (run.status !== "completed" && run.status !== "abandoned") throw new Error("Only terminal Performance Runs can be deleted");
  await rm(getPerformanceRunPaths(run.run_id, rootDir).run_dir, { recursive: true, force: true });
  return { deleted: true as const, run_id: run.run_id };
}

export async function getPerformanceReportPath(input: { run_id: string; root_dir?: string }) {
  const rootDir = input.root_dir ?? DEFAULT_ROOT;
  const run = await readRun(input.run_id, rootDir);
  const reportPath = getPerformanceRunPaths(run.run_id, rootDir).report_path;
  if (run.report_status !== "generated" || !(await fileExists(reportPath))) throw new Error(`Performance Run ${run.run_id} does not have a report`);
  return { run: await toSummary(run, rootDir), report_path: reportPath };
}
