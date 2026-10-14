import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface ImageCandidateReference {
  candidate_id: string;
  aps_path: string;
  aps_paths?: string[];
  sha256: string;
  mime_type: string;
  bytes_size: number;
  image_url: string;
  source_url: string;
  source_urls: string[];
  matched_queries: string[];
  title?: string;
  width?: number;
  height?: number;
  description: string;
  use_in_ppt: boolean;
  recommendation: "recommended" | "not_recommended" | "not_analysed";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

/** Only fetched originals are selectable. Analysis and URL availability are separate states. */
export function normalizeImageCandidates(values: unknown[]): ImageCandidateReference[] {
  const byHash = new Map<string, ImageCandidateReference>();
  for (const value of values) {
    const item = record(value);
    const pageResult = typeof item.result_id === "string";
    if ((!pageResult && item.aps_fetch_status !== "completed") || typeof item.aps_path !== "string" || !item.aps_path
      || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)
      || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(String(item.mime_type))
      || typeof item.bytes_size !== "number" || !Number.isSafeInteger(item.bytes_size) || item.bytes_size <= 0) continue;
    const id = pageResult ? item.result_id : item.candidate_id;
    if (typeof id !== "string" || !id) continue;
    const recommended = item.use_in_ppt === true;
    const candidate: ImageCandidateReference = {
      candidate_id: id, aps_path: item.aps_path, aps_paths: [...new Set([item.aps_path, ...strings(item.aps_paths)])], sha256: item.sha256.toLowerCase(), mime_type: String(item.mime_type), bytes_size: item.bytes_size,
      image_url: typeof item.image_url === "string" ? item.image_url : "",
      source_url: typeof item.source_url === "string" ? item.source_url : "",
      source_urls: [...new Set([...strings(item.source_urls), ...(typeof item.source_url === "string" && item.source_url ? [item.source_url] : [])])],
      matched_queries: [...new Set([...strings(item.matched_queries), ...(typeof item.query === "string" && item.query ? [item.query] : [])])],
      ...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
      ...(typeof item.width === "number" && item.width > 0 ? { width: item.width } : {}),
      ...(typeof item.height === "number" && item.height > 0 ? { height: item.height } : {}),
      // Rejected/skipped candidates can contain diagnostic sentences, not visual descriptions.
      description: recommended && item.analysis_status === "completed" && typeof item.description === "string" ? item.description : "",
      use_in_ppt: recommended,
      recommendation: recommended ? "recommended" : item.analysis_status === "completed" ? "not_recommended" : "not_analysed",
    };
    const previous = byHash.get(candidate.sha256);
    const ranks = { recommended: 2, not_recommended: 1, not_analysed: 0 };
    const preferred = previous && ranks[previous.recommendation] >= ranks[candidate.recommendation] ? previous : candidate;
    byHash.set(candidate.sha256, previous ? { ...preferred,
      aps_paths: [...new Set([...(previous.aps_paths ?? [previous.aps_path]), ...(candidate.aps_paths ?? [candidate.aps_path])])],
      matched_queries: [...new Set([...previous.matched_queries, ...candidate.matched_queries])],
      source_urls: [...new Set([...previous.source_urls, ...candidate.source_urls])],
    } : candidate);
  }
  return [...byHash.values()];
}

/** These workspace-owned records already participate in snapshots and requirement reset. */
export async function readImageCandidateReferences(workspaceDir: string, progress: Record<string, unknown>): Promise<ImageCandidateReference[]> {
  const image = record(progress.image);
  const values: unknown[] = [...(Array.isArray(image.candidates) ? image.candidates : [])];
  const directory = path.join(workspaceDir, "research", "page-image-search");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return normalizeImageCandidates(values); throw error; }
  for (const name of names.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).sort()) {
    let task: Record<string, unknown>;
    try { task = record(JSON.parse(await readFile(path.join(directory, name), "utf8"))); }
    catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (Array.isArray(task.results)) values.push(...task.results);
    const legacy = record(record(task.checkpoint).image);
    if (Array.isArray(legacy.candidates)) values.push(...legacy.candidates);
  }
  return normalizeImageCandidates(values);
}
