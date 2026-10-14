import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readWorkspaceSlideFormat } from "../workspace-slide-format.js";

import type { DeckManifestInput } from "../render/types.js";
import { validateDeckManifest } from "../render/manifest-render-plan.js";

const PAGE_ID_PATTERN = /^page-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface WorkspaceAuthoringPaths {
  workspace_dir: string;
  authoring_kit_dir: string;
  manifest_path: string;
  slides_dir: string;
  persistent_elements_path: string;
}

export interface WorkspaceAuthoringKitResult extends WorkspaceAuthoringPaths {
  installed: boolean;
}

export interface WorkspaceOutlinePage {
  page_id: string;
  page_type: "cover" | "standard";
  title: string;
  [key: string]: unknown;
}

export interface ConfirmedWorkspaceOutline {
  title: string;
  status: "confirmed";
  items: WorkspaceOutlinePage[];
  [key: string]: unknown;
}

function assertAbsolutePath(value: string, fieldName: string) {
  if (!path.isAbsolute(value)) throw new Error(`Field "${fieldName}" must be an absolute path`);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getWorkspaceAuthoringPaths(workspaceDir: string): WorkspaceAuthoringPaths {
  assertAbsolutePath(workspaceDir, "workspace_dir");
  const normalized = path.normalize(workspaceDir);
  return {
    workspace_dir: normalized,
    // Kept only so existing app-facing result shapes remain easy to migrate.
    // HTML authoring never creates or reads this directory.
    authoring_kit_dir: path.join(normalized, "authoring-kit"),
    manifest_path: path.join(normalized, "manifest.json"),
    slides_dir: path.join(normalized, "slides"),
    persistent_elements_path: path.join(normalized, "visual-master.html"),
  };
}

export async function ensureWorkspacePersistentElementsReference(input: {
  workspace_dir: string;
  reset_existing?: boolean;
}): Promise<{ path: string; created: boolean; sha256: string; size_bytes: number }> {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  await mkdir(paths.workspace_dir, { recursive: true });
  if (input.reset_existing === true) await rm(paths.persistent_elements_path, { force: true });
  const bytes = await readFile(paths.persistent_elements_path).catch(() => Buffer.alloc(0));
  return {
    path: paths.persistent_elements_path,
    created: false,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.length,
  };
}

export async function fingerprintWorkspacePersistentElements(input: { workspace_dir: string }) {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  const bytes = await readFile(paths.persistent_elements_path);
  const fileStat = await stat(paths.persistent_elements_path);
  return {
    path: paths.persistent_elements_path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: fileStat.size,
  };
}

/**
 * Compatibility-shaped app-facing operation. HTML authoring has no Authoring
 * Kit installation; it only ensures the Workspace and slides directory exist.
 */
export async function installWorkspaceAuthoringKit(input: {
  workspace_dir: string;
}): Promise<WorkspaceAuthoringKitResult> {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  await mkdir(paths.workspace_dir, { recursive: true });
  await mkdir(paths.slides_dir, { recursive: true });
  return { ...paths, installed: false };
}

function normalizeConfirmedOutline(value: unknown): ConfirmedWorkspaceOutline {
  if (!isPlainRecord(value) || value.status !== "confirmed" || !Array.isArray(value.items)) {
    throw new Error("Workspace outline must be confirmed before preparing Page Sources");
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    throw new Error("Confirmed Outline title must be a non-empty string");
  }
  const seenIds = new Set<string>();
  const items = value.items.map((itemValue, index) => {
    if (!isPlainRecord(itemValue)) {
      throw new Error(`Confirmed Outline item at index ${index} must be an object`);
    }
    const existingId = typeof itemValue.page_id === "string" ? itemValue.page_id : "";
    const pageId = existingId || `page-${randomUUID()}`;
    if (!PAGE_ID_PATTERN.test(pageId)) {
      throw new Error(`Confirmed Outline item at index ${index} has invalid page_id`);
    }
    if (seenIds.has(pageId)) throw new Error(`Duplicate Confirmed Outline page_id "${pageId}"`);
    seenIds.add(pageId);
    return {
      ...itemValue,
      page_id: pageId,
      page_type: itemValue.page_type === "cover" ? "cover" : "standard",
      title: typeof itemValue.title === "string" ? itemValue.title : "",
    };
  });
  return { ...value, title: value.title, status: "confirmed", items } as ConfirmedWorkspaceOutline;
}

export async function ensureConfirmedOutlinePageIds(input: {
  workspace_dir: string;
}): Promise<ConfirmedWorkspaceOutline> {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  const outlinePath = path.join(paths.workspace_dir, "outline.json");
  const outline = normalizeConfirmedOutline(JSON.parse(await readFile(outlinePath, "utf8")));
  await writeFile(outlinePath, `${JSON.stringify(outline, null, 2)}\n`, "utf8");
  return outline;
}

export async function rebuildWorkspaceDeckManifest(input: {
  workspace_dir: string;
  outline?: ConfirmedWorkspaceOutline;
}): Promise<DeckManifestInput> {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  const outline = input.outline ?? await ensureConfirmedOutlinePageIds(input);
  const { aspectRatio } = await readWorkspaceSlideFormat(paths.workspace_dir);
  const manifest: DeckManifestInput = {
    ...(aspectRatio === "16:9" ? {} : { aspect_ratio: aspectRatio }),
    title: outline.title,
    slides: outline.items.map((item) => ({
      id: item.page_id,
      source: `./slides/${item.page_id}.html`,
    })),
  };
  validateDeckManifest(manifest);
  await mkdir(paths.slides_dir, { recursive: true });
  await writeFile(paths.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // Prune orphaned slide sources in the same step that rewrites the manifest.
  // When the confirmed outline's page set is replaced (deck refinement
  // delete/add, replan), the old slides/<id>.html files used to stay on disk:
  // the snapshot semantic validation then sees archived slide ids that the
  // manifest does not declare (manifest_archive_slide_ids_mismatch), fails
  // every snapshot build, and permanently blocks cloud publish. The declared
  // set above is authoritative, so anything else under slides/ is stale.
  const declaredPageIds = new Set(outline.items.map((item) => item.page_id));
  try {
    const slideEntries = await readdir(paths.slides_dir);
    await Promise.all(
      slideEntries
        .filter((name) => name.endsWith(".html"))
        .filter((name) => !declaredPageIds.has(name.slice(0, -".html".length)))
        .map((name) => rm(path.join(paths.slides_dir, name), { force: true })),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return manifest;
}

export async function prepareWorkspacePageSources(input: {
  workspace_dir: string;
  reset_existing?: boolean;
}): Promise<{
  paths: WorkspaceAuthoringPaths;
  outline: ConfirmedWorkspaceOutline;
  manifest: DeckManifestInput;
  created_page_ids: string[];
}> {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  await mkdir(paths.slides_dir, { recursive: true });
  const outline = await ensureConfirmedOutlinePageIds(input);
  if (input.reset_existing) {
    await Promise.all(outline.items.map((item) =>
      rm(path.join(paths.slides_dir, `${item.page_id}.html`), { force: true })
    ));
  }
  const manifest = await rebuildWorkspaceDeckManifest({ workspace_dir: input.workspace_dir, outline });
  return { paths, outline, manifest, created_page_ids: [] };
}

export async function reconcileWorkspacePageSources(input: {
  workspace_dir: string;
}): Promise<{
  paths: WorkspaceAuthoringPaths;
  repaired_page_ids: string[];
  manifest: DeckManifestInput;
}> {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  await mkdir(paths.slides_dir, { recursive: true });
  const outline = await ensureConfirmedOutlinePageIds(input);
  const progressPath = path.join(paths.workspace_dir, "page-progress.json");
  const progressValue = JSON.parse(await readFile(progressPath, "utf8")) as unknown;
  const progress = isPlainRecord(progressValue) && Array.isArray(progressValue.pages)
    ? progressValue.pages
    : [];
  const statusByPageId = new Map(progress.map((value) => {
    const page = isPlainRecord(value) ? value : {};
    return [typeof page.page_id === "string" ? page.page_id : "", typeof page.status === "string" ? page.status : ""];
  }));
  for (const item of outline.items) {
    const targetPath = path.join(paths.slides_dir, `${item.page_id}.html`);
    if (await pathExists(targetPath)) continue;
    // Only accepted pages are preserved as-is on resume; every other status
    // (pending, interrupted, render_failed, ...) is re-generated, so a missing
    // source is expected after an interrupted run and must not block resume.
    if (statusByPageId.get(item.page_id) === "accepted") {
      throw new Error(`Page Source is missing for accepted page_id "${item.page_id}"; this generation cannot be resumed`);
    }
  }
  const manifest = await rebuildWorkspaceDeckManifest({ workspace_dir: input.workspace_dir, outline });
  return { paths, repaired_page_ids: [], manifest };
}

export async function fingerprintWorkspacePageSource(input: {
  workspace_dir: string;
  page_id: string;
}): Promise<{ path: string; sha256: string; size_bytes: number }> {
  const paths = getWorkspaceAuthoringPaths(input.workspace_dir);
  if (!PAGE_ID_PATTERN.test(input.page_id)) {
    throw new Error('Field "page_id" must be an opaque page UUID');
  }
  const sourcePath = path.join(paths.slides_dir, `${input.page_id}.html`);
  const bytes = await readFile(sourcePath);
  const fileStat = await stat(sourcePath);
  return {
    path: sourcePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: fileStat.size,
  };
}
