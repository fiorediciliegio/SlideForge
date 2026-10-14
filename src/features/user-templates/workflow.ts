import type { AgentClient } from "../../agent/agentClient";
import type { AppHostUploadClient } from "../../runtime/appHostUploadClient";
import type { AgentImageAttachment } from "../../runtime/annaRuntime";
import type { HostUploadRef } from "../../api/types";
import type { TemplatePageProgress, TemplateProgress, TemplateStepDetailDrift, UserTemplate, UserTemplateBackend, UserTemplateMetadata, DesignProfile } from "./types";
import type { Locale } from "../../i18n/messages";
import { templateAnalysisPrompt, templateDescriptionPrompt, templateMasterPrompt, templatePagePrompt, templateProfilePrompt } from "./prompts";
import { checkPageDrift, type PageDrift } from "./profile-drift";
import { createRunLog, createFrameCollector, captureRunEnvironment, describeError, finishRunLog, runLogged, summarizeRawFrame, type RunFrame, type RunLog } from "./runLog";
import { resolveAgentModelPreference, type AgentStreamEvent } from "../../agent/agentClient";
import { PPT_ENGINE_TOOL } from "../../api/toolManifests.generated";

export const TEMPLATE_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const TEMPLATE_IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};
export function validateTemplateFile(file: Pick<File, "name" | "size">) {
  return /\.pptx$/i.test(file.name) && file.size > 0 && file.size <= TEMPLATE_FILE_MAX_BYTES;
}
export function validateTemplateImage(file: Pick<File, "type" | "size">) {
  return file.type in TEMPLATE_IMAGE_TYPES && file.size > 0 && file.size <= TEMPLATE_FILE_MAX_BYTES;
}
/** One PPTX, or 1-6 images. Returns the detected source kind. */
export function validateTemplateFiles(files: Pick<File, "name" | "type" | "size">[]): "pptx" | "images" {
  if (!files.length) throw new Error("Select one PPTX or 1-6 images.");
  if (files.length === 1 && /\.pptx$/i.test(files[0].name)) return "pptx";
  if (files.length > 6 || files.some((file) => !validateTemplateImage(file))) throw new Error("Select one PPTX or 1-6 PNG/JPEG/WebP images, each at most 20 MB.");
  return "images";
}
export function parseSelectedTemplatePages(value: unknown): number[] {
  const record = value as { page_numbers?: unknown; error?: unknown } | null;
  if (record?.error) throw new Error(String(record.error));
  const pages = record?.page_numbers;
  if (!Array.isArray(pages) || !pages.length || pages.length > 6 || pages.some((n) => !Number.isInteger(n) || n < 1) || new Set(pages).size !== pages.length) throw new Error("page_numbers 必须包含 1 至 6 个不同的正整数页码");
  return pages as number[];
}
export function parseTemplateMetadata(value: unknown, selected: number[]): UserTemplateMetadata {
  const record = value as UserTemplateMetadata | null;
  if (!record || typeof record.name !== "string" || !record.name.trim() || record.name.length > 160 || typeof record.description !== "string" || !record.description.trim() || record.description.length > 2000 || !Array.isArray(record.pages)) throw new Error("需要模板名称、整体描述和 pages 数组");
  const numbers = parseSelectedTemplatePages({ page_numbers: record.pages.map((p) => p?.page_number) });
  if (numbers.length !== selected.length || numbers.some((n) => !selected.includes(n)) || record.pages.some((p) => typeof p.description !== "string" || !p.description.trim() || p.description.length > 1000)) throw new Error("每个选中页面都需要且只能有一句描述");
  return record;
}
export const attachment = (upload: HostUploadRef): AgentImageAttachment => ({ type: upload.mime_type, url: upload.url, filename: upload.filename, detail: "auto" });

export async function createPersonalTemplate(input: {
  backend: UserTemplateBackend;
  agent: AgentClient;
  upload: AppHostUploadClient;
  files?: File[];
  templateId?: string;
  locale: Locale;
  signal: AbortSignal;
  /** Pause point (Step 4): called with the extracted profile before any
   *  generation happens. Resolve with (possibly edited) profile to continue;
   *  the callee is responsible for persisting edits via saveUserTemplateProfile. */
  confirmProfile?: (record: UserTemplate, profile: DesignProfile) => Promise<DesignProfile>;
  /** Drift check (Step 5): dominant preview colors vs the confirmed palette. Injectable for tests. */
  driftCheck?: (page_number: number, previewUrl: string, profile: DesignProfile) => Promise<PageDrift>;
  /** Diagnostics: receives the finished run log (success or failure) exactly once. */
  onRunLog?: (log: RunLog) => void;
  onCreated: (record: UserTemplate) => void;
  onProgress: (progress: TemplateProgress) => void;
}): Promise<UserTemplate> {
  const { backend, agent, upload, signal } = input;
  const runLog = createRunLog();
  runLog.model_preference = resolveAgentModelPreference();
  const runStartMs = Date.now();
  runLog.environment = captureRunEnvironment({ engine_version: PPT_ENGINE_TOOL.version });
  /** Frames for one agent call; pass the array to runLogged AND both stream callbacks. */
  const frameRunIds = new WeakMap<RunFrame[], { run_id?: string }>();
  const collect = (frames: RunFrame[]) => createFrameCollector(runStartMs, frames, undefined, frameRunIds.get(frames));
  /** Wire the platform run id into the frames of one agent call (for server-side log lookup). */
  const trackRunId = (frames: RunFrame[]) => {
    let holder = frameRunIds.get(frames);
    if (!holder) { holder = {}; frameRunIds.set(frames, holder); }
    const target = holder;
    return (runId: string) => { target.run_id = runId; };
  };
  /** Raw event-stream frames, recorded untransformed before any parsing. */
  const collectRaw = (frames: RunFrame[]) => (frame: unknown) => {
    if (frames.length >= 500) return;
    const holder = frameRunIds.get(frames);
    if (frame && typeof frame === "object") {
      const rid = (frame as { run_id?: unknown; runId?: unknown }).run_id ?? (frame as { runId?: unknown }).runId;
      if (typeof rid === "string" && holder) holder.run_id = rid;
    }
    frames.push({ offset_ms: Date.now() - runStartMs, type: "raw", summary: summarizeRawFrame(frame), run_id: holder?.run_id });
  };
  /** Wrap a backend (engine bridge) call so non-LLM steps are visible in the log too. */
  const backendCall = <T>(label: string, fn: () => Promise<T>, meta?: Record<string, string | number | boolean | undefined>): Promise<T> =>
    runLogged(runLog, { stage: "backend", label, meta }, fn);
  const check = () => signal.throwIfAborted();
  const stage = (progress: TemplateProgress) => { check(); input.onProgress(progress); };
  // Timeline previews are best-effort: a missing thumbnail must never fail the run.
  const previewUrl = async (id: string, page_number?: number) => {
    try { return (await backend.getUserTemplateAsset({ id, asset: "preview", page_number })).url; }
    catch { return undefined; }
  };
  const saveHtml = async (id: string, html: string, page_number?: number) => {
    check();
    await backendCall("saveUserTemplateHtml", () => backend.saveUserTemplateHtml({ id, page_number, content: html }), { ...(page_number !== undefined ? { page_number } : { asset: "master" }) });
  };
  let record: UserTemplate;
  let sourceKind: "pptx" | "images" | undefined;
  try {
  stage({ stage: "upload" });
  if (input.templateId) record = await backendCall("getUserTemplate (resume)", () => backend.getUserTemplate({ id: input.templateId! }));
  else {
    const files = input.files ?? [];
    sourceKind = validateTemplateFiles(files);
    if (sourceKind === "pptx") {
      // Draft-first: create the record, then stream the source into it, so a
      // failed upload leaves a reselectable draft instead of losing the run.
      const file = files[0];
      record = await backendCall("createUserTemplate (draft)", () => backend.createUserTemplate({ filename: file.name }), { source: "pptx", filename: file.name });
      runLog.template_id = record.id;
      input.onCreated(record);
      const sourceUpload = await upload.uploadFile(file, {
        purpose: "user_artifact",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        metadata: { user_template_id: record.id, source: "personal-template-source" },
      });
      check();
      record = await backendCall("saveUserTemplateSource", () => backend.saveUserTemplateSource({ id: record.id, filename: file.name, host_upload: sourceUpload }), { source: "pptx", filename: file.name });
    } else {
      const uploaded = await Promise.all(files.map(async (file) => ({ filename: file.name, host_upload: await upload.uploadFile(file, { purpose: "user_artifact", mimeType: file.type }) })));
      check();
      record = await backendCall("createImageUserTemplate", () => backend.createImageUserTemplate({ files: uploaded }), { source: "images", count: uploaded.length });
      runLog.template_id = record.id;
      input.onCreated(record);
      // For image templates the uploaded images are the references themselves.
      record = await backendCall("selectUserTemplatePages", () => backend.selectUserTemplatePages({ id: record.id, page_numbers: record.source_files!.map((_, index) => index + 1) }));
    }
  }
  input.onCreated(record);
  if (record.status === "ready") return record;
  runLog.template_id = record.id;
  return await runTemplateBody();
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    finishRunLog(runLog, aborted ? "aborted" : "error", describeError(cause));
    throw cause;
  } finally {
    if (!runLog.outcome) finishRunLog(runLog, "success");
    input.onRunLog?.(runLog);
  }
  /** The remainder of the workflow, wrapped so the run log always finishes. */
  async function runTemplateBody(): Promise<UserTemplate> {
  const id = record.id;
  // Draft-first resumes: a draft whose source file never arrived asks for it again.
  if (record.source_kind !== "images" && record.source_ready === false) {
    const file = input.files?.[0];
    if (!file || !validateTemplateFile(file)) throw new TemplateSourceRequiredError();
    if (file.name !== record.filename) throw new TemplateSourceRequiredError("filename");
    const sourceUpload = await upload.uploadFile(file, {
      purpose: "user_artifact",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      metadata: { user_template_id: id, source: "personal-template-source" },
    });
    check();
    record = await backendCall("saveUserTemplateSource", () => backend.saveUserTemplateSource({ id, filename: file.name, host_upload: sourceUpload }));
    input.onCreated(record);
  }
  let numbers = record.pages.map((p) => p.page_number);
  stage({ stage: "analyze" });
  // Images need no doc_read analysis: their pages were already selected at creation.
  const pagesSelected = numbers.length > 0 || record.source_kind === "images";
  if (!pagesSelected) {
    const source = await backend.getUserTemplateAsset({ id, asset: "source" });
    const analysisPrompt = templateAnalysisPrompt(source.url);
    const frames: RunFrame[] = [];
    numbers = await runLogged(runLog, { stage: "analyze", label: "page selection via doc_read", meta: { prompt_chars: analysisPrompt.length, tool: "doc_read" }, frames }, () =>
      agent.runStructuredPrompt(analysisPrompt, parseSelectedTemplatePages, { sessionTools: ["doc_read"], toolAccessPolicy: "off", signal, onStreamEvent: collect(frames), onDiagnosticStreamEvent: collect(frames), onRunId: trackRunId(frames), onRawFrame: collectRaw(frames) }));
  }
  stage({ stage: "analyze", detail: { page_numbers: numbers } });
  stage({ stage: "images" });
  if (!pagesSelected) record = await backend.selectUserTemplatePages({ id, page_numbers: numbers });
  const references = await Promise.all(numbers.map(async (page_number) => ({ page_number, upload: await backend.getUserTemplateAsset({ id, asset: "reference", page_number }) })));
  const images = references.map((reference) => attachment(reference.upload));
  stage({ stage: "images", detail: { images: references.map(({ page_number, upload }) => ({ page_number, url: upload.url })) } });
  // Profile extraction happens BEFORE any generation so the confirmed profile can
  // constrain the master and reference pages (Step 5 injects it into the prompts).
  // Resumed drafts hydrate their saved profile and skip straight to confirmation.
  stage({ stage: "profile" });
  let profile = record.profile ?? null;
  if (!profile) {
    profile = await extractDesignProfile(backend, agent, id, images, input.locale, signal, check, runLog, collect, trackRunId, collectRaw, backendCall);
  }
  if (input.confirmProfile) profile = await runLogged(runLog, { stage: "profile", label: "user review of design profile" }, () => input.confirmProfile!(record, profile as DesignProfile));
  check();
  stage({ stage: "profile", detail: { profile_colors: profile.colors.map((color) => `${color.token} ${color.hex}`) } });
  stage({ stage: "master" });
  let master: string;
  if (record.master_ready) master = (await backend.getUserTemplateHtml({ id })).html;
  else {
    const masterPrompt = templateMasterPrompt(profile);
    const frames: RunFrame[] = [];
    master = (await runLogged(runLog, { stage: "master", label: "visual master generation", meta: { prompt_chars: masterPrompt.length, attachments: images.length }, frames }, () =>
      agent.runHtmlGenerationPrompt(masterPrompt, { attachments: images, signal, onStreamEvent: collect(frames), onDiagnosticStreamEvent: collect(frames), onRunId: trackRunId(frames), onRawFrame: collectRaw(frames) }))).html;
    await saveHtml(id, master);
  }
  stage({ stage: "master", detail: { master_preview_url: await previewUrl(id) } });
  const pageStates: TemplatePageProgress[] = numbers.map((page_number) => ({ page_number, status: record.completed_pages.includes(page_number) ? "done" : "pending" }));
  let completed = record.completed_pages.length;
  const reportPages = (drifts?: TemplateStepDetailDrift[]) => stage({ stage: "pages", completed, total: numbers.length, detail: { pages: pageStates.map((page) => ({ ...page })), ...(drifts ? { drifts } : {}) } });
  await Promise.all(pageStates.filter((page) => page.status === "done").map(async (page) => { page.preview_url = await previewUrl(id, page.page_number); }));
  reportPages();
  const generatePage = async (n: number) => {
    const pagePrompt = templatePagePrompt(master, profile);
    const frames: RunFrame[] = [];
    const html = (await runLogged(runLog, { stage: "pages", label: "reference page generation", meta: { page_number: n, prompt_chars: pagePrompt.length, attachments: 1 }, frames }, () =>
      agent.runHtmlGenerationPrompt(pagePrompt, { attachments: [images[numbers.indexOf(n)]], signal, onStreamEvent: collect(frames), onDiagnosticStreamEvent: collect(frames), onRunId: trackRunId(frames), onRawFrame: collectRaw(frames) }))).html;
    await saveHtml(id, html, n);
  };
  // At most three concurrent sessions. Successful pages survive a failed sibling.
  const pending = numbers.filter((n) => !record.completed_pages.includes(n));
  const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (pending.length) {
      check();
      const n = pending.shift()!;
      const state = pageStates.find((page) => page.page_number === n)!;
      state.status = "running";
      reportPages();
      await generatePage(n);
      completed += 1;
      state.status = "done";
      state.preview_url = await previewUrl(id, n);
      reportPages();
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failure = outcomes.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  // Step 5: compare each finished page's dominant colors with the confirmed palette;
  // pages that drifted get exactly one regeneration, then the final report is emitted.
  const driftCheck = input.driftCheck ?? checkPageDrift;
  const checkAllDrift = async (): Promise<PageDrift[]> => Promise.all(numbers.map(async (page_number) => {
    const url = await previewUrl(id, page_number);
    if (!url) return { page_number, drifted: false, dominant: [], unmatched: [] } as PageDrift;
    return driftCheck(page_number, url, profile);
  }));
  let driftReport = await runLogged(runLog, { stage: "pages", label: "color drift check", meta: { pages: numbers.length } }, () => checkAllDrift());
  const driftOnce = driftReport.filter((entry) => entry.drifted);
  if (driftOnce.length) {
    for (const entry of driftOnce) {
      check();
      const state = pageStates.find((page) => page.page_number === entry.page_number)!;
      state.status = "running";
      reportPages(driftOnce.map((item) => ({ page_number: item.page_number, unmatched: item.unmatched.map((sample) => sample.hex) })));
      await generatePage(entry.page_number);
      state.status = "done";
      state.preview_url = await previewUrl(id, entry.page_number);
    }
    driftReport = await checkAllDrift();
  }
  const finalDrifts = driftReport.filter((entry) => entry.drifted).map((entry) => ({ page_number: entry.page_number, unmatched: entry.unmatched.map((sample) => sample.hex) }));
  completed = numbers.length;
  reportPages(finalDrifts);
  stage({ stage: "describe" });
  const previews = await Promise.all(numbers.map(async (page_number) => attachment(await backend.getUserTemplateAsset({ id, asset: "preview", page_number }))));
  const frames: RunFrame[] = [];
  const metadata = await runLogged(runLog, { stage: "describe", label: "template name/description", meta: { attachments: previews.length }, frames }, () =>
    agent.runStructuredPrompt(templateDescriptionPrompt(numbers, input.locale), (value) => parseTemplateMetadata(value, numbers), { attachments: previews, signal, sessionTools: [], toolAccessPolicy: "off", onStreamEvent: collect(frames), onDiagnosticStreamEvent: collect(frames), onRunId: trackRunId(frames), onRawFrame: collectRaw(frames) }));
  stage({ stage: "describe", detail: { name: metadata.name, description: metadata.description } });
  check();
  return backendCall("publishUserTemplate", () => backend.publishUserTemplate({ id, metadata }));
  }
}

/** Minimal shape check; the engine re-validates the full schema on save. */
function parseDesignProfileLoose(value: unknown): DesignProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Design profile must be an object");
  if (!Array.isArray((value as { colors?: unknown }).colors) || !(value as { colors: unknown[] }).colors.length) throw new Error("Design profile needs a non-empty colors array");
  return value as DesignProfile;
}

async function extractDesignProfile(
  backend: UserTemplateBackend,
  agent: AgentClient,
  id: string,
  referenceImages: AgentImageAttachment[],
  locale: Locale,
  signal: AbortSignal,
  check: () => void,
  runLog: RunLog,
  collect: (frames: RunFrame[]) => (event: import("./runLog").StreamEventLike) => void,
  trackRunId: (frames: RunFrame[]) => (runId: string) => void,
  collectRaw: (frames: RunFrame[]) => (frame: unknown) => void,
  backendCall: <T>(label: string, fn: () => Promise<T>, meta?: Record<string, string | number | boolean | undefined>) => Promise<T>,
): Promise<DesignProfile> {
  check();
  const prompt = templateProfilePrompt(locale);
  const frames: RunFrame[] = [];
  const profile = await runLogged(runLog, { stage: "profile", label: "design profile extraction", meta: { prompt_chars: prompt.length, attachments: referenceImages.length }, frames }, () =>
    agent.runStructuredPrompt(prompt, parseDesignProfileLoose, { attachments: referenceImages, signal, sessionTools: [], toolAccessPolicy: "off", onStreamEvent: collect(frames), onDiagnosticStreamEvent: collect(frames), onRunId: trackRunId(frames), onRawFrame: collectRaw(frames) }));
  check();
  await backendCall("saveUserTemplateProfile", () => backend.saveUserTemplateProfile({ id, profile }));
  return profile;
}

export class TemplateSourceRequiredError extends Error {
  constructor(public readonly reason: "missing" | "filename" = "missing") { super("Template source must be selected again"); }
}
