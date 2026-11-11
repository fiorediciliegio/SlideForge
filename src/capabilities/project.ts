import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { buildDeckHtml, splitSlideDocument } from "../../scripts/m0/deck.js";
import { validateHtmlDialect } from "../../scripts/m0/dialect.js";
import { type OutlineDraft, type ProjectRef } from "../contracts/agent.js";
import { HttpRequestError } from "../server/httpSecurity.js";

export interface ProjectSource { source_id: string; name: string; kind: "user" | "web" | "legacy"; text_ref: string; chars: number; original_ref?: string; url?: string; retrieved_at?: string }
export interface ProjectPage { page_id: string; page_revision: string; html_ref: string }
export interface ProjectSnapshot {
  page_constraints?: Record<string,Array<{text:string;confirmed_at:string}>>;
  version: 1; deck_id: string; revision_id: string; brief: string; title: string;
  outline: OutlineDraft; constraints_revision: number;
  constraints: Array<{ text: string; source: "user" | "outline"; confirmed_at: string }>;
  scenario: { category: string; subtype: string; reason: string; user_confirmed?: boolean };
  sources: ProjectSource[]; pages: ProjectPage[]; missing: string[];
  visual?: { template_id?: string; reference_html?: string; visual_spec?: string; brand?: unknown; logo?: { src: string; position?: "top-right" | "top-left" | "bottom-right" | "bottom-left" } };
  history: { parent_revision?: string; instruction: string; at: string; changed_page_ids: string[]; operation_id?: string };
  confirmed_outline_revision?: number; checks?: string[];
}
export const projectId = () => randomUUID();
export function projectPath(root: string, ref: string) {
  const resolved = path.resolve(root, ref);
  if (!resolved.startsWith(path.resolve(root) + path.sep) || !ref.startsWith("project/")) throw new HttpRequestError(400, "项目文件引用越界");
  return resolved;
}
export async function readJSON<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")); }
export async function writeArtifact(root: string, kind: string, value: unknown, id: string = projectId()) {
  if (!/^[\w-]+$/.test(kind) || !/^[\w-]+$/.test(id)) throw new Error("无效 artifact 标识");
  const ref = `project/${kind}/${id}.json`;
  await mkdir(path.dirname(projectPath(root, ref)), { recursive: true });
  const temporary = `${projectPath(root, ref)}.${projectId()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
  await rename(temporary, projectPath(root, ref));
  return ref;
}
export function toProjectRef(project: ProjectSnapshot): ProjectRef {
  return { revision_id: project.revision_id, artifact_ref: `project/revisions/${project.revision_id}`, outline_revision: project.outline.draft_revision, constraints_revision: project.constraints_revision };
}
export async function readProjectRevision(root: string, ref: ProjectRef): Promise<ProjectSnapshot> {
  if (ref.artifact_ref !== `project/revisions/${ref.revision_id}` || !/^[\w-]+$/.test(ref.revision_id)) throw new HttpRequestError(400, "无效项目修订引用");
  return readJSON(path.join(projectPath(root, ref.artifact_ref), "project.json"));
}
export async function pageHTML(root: string, project: ProjectSnapshot, pageId: string) {
  const page = project.pages.find(value => value.page_id === pageId);
  if (!page) throw new HttpRequestError(404, "页面尚未生成");
  return readFile(path.join(projectPath(root, toProjectRef(project).artifact_ref), page.html_ref), "utf8");
}
export async function prepareRevision(root: string, base: ProjectSnapshot, change: {
  instruction: string; page_html?: Record<string, string>; outline?: OutlineDraft; operation_id?: string;
  context?: Partial<Pick<ProjectSnapshot, "scenario" | "constraints" | "constraints_revision" | "sources" | "visual" | "confirmed_outline_revision" | "page_constraints">>;
}) {
  const revision = projectId();
  const project: ProjectSnapshot = { ...base, ...change.context, revision_id: revision,
    outline: change.outline ?? base.outline, title: (change.outline ?? base.outline).title,
    pages: [], checks: [], history: { parent_revision: base.revision_id || undefined, instruction: change.instruction, at: new Date().toISOString(), changed_page_ids: Object.keys(change.page_html ?? {}), operation_id: change.operation_id },
  };
  const ref = toProjectRef(project);
  const finalDir = projectPath(root, ref.artifact_ref), staging = `${finalDir}.staging`;
  await mkdir(path.join(staging, "slides"), { recursive: true });
  const slides = [];
  for (const page of project.outline.pages) {
    const previous = base.pages.find(item => item.page_id === page.page_id);
    const html = change.page_html?.[page.page_id] ?? (previous ? await pageHTML(root, base, page.page_id) : undefined);
    if (html === undefined) continue;
    const validation = validateHtmlDialect(html);
    if (!validation.ok) throw new HttpRequestError(422, validation.errors.map(item => `${item.rule}: ${item.detail}`).join("；"));
    const htmlRef = `slides/${page.page_id}.html`;
    await writeFile(path.join(staging, htmlRef), html, "utf8");
    const pageRevision = createHash("sha256").update(html).digest("hex");
    project.pages.push({ page_id: page.page_id, page_revision: pageRevision, html_ref: htmlRef });
    slides.push(splitSlideDocument(html));
  }
  await writeFile(path.join(staging, "project.json"), JSON.stringify(project, null, 2));
  await writeFile(path.join(staging, "outline.json"), JSON.stringify(project.outline));
  await writeFile(path.join(staging, "brief.txt"), project.brief);
  await writeFile(path.join(staging, "manifest.json"), JSON.stringify({ pages: project.pages, order: project.outline.pages.map(page => page.page_id) }));
  await writeFile(path.join(staging, "deck.html"), buildDeckHtml({ title: project.title, slides, logo: project.visual?.logo }));
  await rename(staging, finalDir);
  return { ref, project, runDir: finalDir };
}
export function emptyProject(deckId: string, brief: string, outline: OutlineDraft): ProjectSnapshot {
  return { version: 1, deck_id: deckId, revision_id: "", brief, title: outline.title, outline, constraints_revision: 0,
    constraints: [], scenario: { category: "待明确", subtype: "", reason: "尚未识别" }, sources: [], pages: [], missing: [],
    history: { instruction: "创建项目", at: new Date().toISOString(), changed_page_ids: [] } };
}
export async function importLegacyProject(root: string, deckId: string) {
  const outline = await readJSON<{ title: string; pages: Array<{ title: string; bullets: string[] }> }>(path.join(root, "outline.json"));
  const draft: OutlineDraft = { title: outline.title, draft_revision: 0, pages: outline.pages.map((page, index) => ({ ...page, page_id: `page-${index + 1}` })) };
  const base = emptyProject(deckId, await readFile(path.join(root, "brief.txt"), "utf8"), draft);
  base.missing = ["original_attachments", "confirmed_constraints", "historical_versions", "complete_brand_rules"];
  const legacySource = await saveSource(root, "旧作品保留的需求和资料文本", base.brief, undefined, "legacy");base.sources=[legacySource];
  const page_html: Record<string, string> = {};
  for (let index = 0; index < draft.pages.length; index++) page_html[draft.pages[index].page_id] = await readFile(path.join(root, `page-${index + 1}.html`), "utf8");
  return prepareRevision(root, base, { instruction: "由旧作品当前页面重建基线（原始资料与历史可能缺失）", page_html });
}
export async function prepareRollback(root: string, current: ProjectSnapshot, revision: string, pageId: string) {
  const historical = await readProjectRevision(root, { ...toProjectRef(current), revision_id: revision, artifact_ref: `project/revisions/${revision}` });
  if (!current.outline.pages.some(page => page.page_id === pageId)) throw new HttpRequestError(409, "当前大纲中已不存在该页面");
  return prepareRevision(root, current, { instruction: "回退页面版本", page_html: { [pageId]: await pageHTML(root, historical, pageId) } });
}
export async function saveSource(root: string, name: string, text: string, original?: Buffer, kind: ProjectSource["kind"] = "user") {
  const source_id = projectId(), directory = `project/sources/${source_id}`;
  await mkdir(projectPath(root, directory), { recursive: true });
  await writeFile(projectPath(root, `${directory}/extracted.txt`), text);
  if (original) await writeFile(projectPath(root, `${directory}/original`), original);
  return { source_id, name, kind, text_ref: `${directory}/extracted.txt`, chars: text.length, ...(original ? { original_ref: `${directory}/original` } : {}) } satisfies ProjectSource;
}
export async function projectHistory(root: string, current: ProjectSnapshot, pageId: string) {
  const results: Array<{ revision_id: string; page_revision?: string; instruction: string; at: string }> = [];
  let project: ProjectSnapshot | undefined = current;
  while (project) {
    const page = project.pages.find(item => item.page_id === pageId);
    if (page && (project.history.changed_page_ids.includes(pageId) || !project.history.parent_revision)) results.push({ revision_id: project.revision_id, page_revision: page.page_revision, instruction: project.history.instruction, at: project.history.at });
    const parent: string | undefined = project.history.parent_revision;
    project = parent ? await readProjectRevision(root, { ...toProjectRef(current), revision_id: parent, artifact_ref: `project/revisions/${parent}` }) : undefined;
  }
  return results;
}
export async function findPreparedOperation(root: string, operationId: string) {
  let entries: string[];
  try { entries = await readdir(projectPath(root, "project/revisions")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const revision of entries.filter(value => !value.endsWith(".staging"))) {
    const ref = { revision_id: revision, artifact_ref: `project/revisions/${revision}`, outline_revision: 0, constraints_revision: 0 };
    const project = await readProjectRevision(root, ref);
    if (project.history.operation_id === operationId) return { ref: toProjectRef(project), project, runDir: projectPath(root, ref.artifact_ref) };
  }
}
