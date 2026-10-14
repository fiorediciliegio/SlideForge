import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentClient } from "../../agent/agentClient";
import type { PptBackend } from "../../api/pptBackend";
import type { AppHostUploadClient } from "../../runtime/appHostUploadClient";
import type { AgentImageAttachment } from "../../runtime/annaRuntime";
import type { Messages, Locale } from "../../i18n/messages";
import type { DesignProfile, TemplateProgress, TemplateStep, UserTemplateListEntry } from "./types";
import type { ProfileAssetMeta } from "./types";
import { attachment, createPersonalTemplate, validateTemplateFiles, TemplateSourceRequiredError } from "./workflow";
import { toReadyUserVisualStylePresets, type UserTemplateCoverMap } from "./userTemplateVisualStylePresets";
import { applyProfileOps, parseProfileOps, type ProfileOpsResult } from "./profile-ops";
import { persistRunLog, createRunLog, finishRunLog, runLogged, createFrameCollector, describeError, type RunFrame, type RunLog } from "./runLog";
import { templateProfileSectionPrompt, templateProfileChatPrompt, templateMasterOptimizePrompt, parseMasterOptimization, type MasterOptimization, type MasterOptimizeIntensity, type MasterOptimizeScope } from "./prompts";
import { stripInlineAssetData, restoreInlineAssetData, reinsertMissingAssets } from "./masterAssetRefs";
import { extractRootBlock, replaceRootBlock } from "./masterVarSync";

export type ProfileSection = "colors" | "typography" | "layout_rules" | "fixed_assets" | "voice";

/** Client-side guard mirroring the engine's PROFILE_ASSET_MAX_BYTES (5 MB). */
export const PROFILE_ASSET_MAX_BYTES_FRONTEND = 5 * 1024 * 1024;
const PROFILE_ASSET_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/** A paused workflow waiting for the user to review/edit the extracted design profile. */
export interface ProfileReview {
  templateId: string;
  profile: DesignProfile;
  resolve: (profile: DesignProfile) => void;
  reject: (cause: unknown) => void;
}

/**
 * Accumulate the workflow's stage reports into a timeline. A report for the
 * current stage merges into it, a report for a new stage closes the previous one.
 */
export function appendTemplateStep(steps: TemplateStep[], progress: TemplateProgress): TemplateStep[] {
  const last = steps.at(-1);
  if (last?.stage === progress.stage) return [...steps.slice(0, -1), { ...last, ...progress, detail: { ...last.detail, ...progress.detail }, status: "running" }];
  return [...steps.map((step) => ({ ...step, status: "done" as const })), { ...progress, status: "running" }];
}

export function useUserTemplates(input: { backend: PptBackend | null; agent: AgentClient | null; upload: AppHostUploadClient | null; locale: Locale; t: Messages; onDeleted?: (id: string) => void }) {
  const { backend, agent, upload, locale, t } = input;
  const [templates, setTemplates] = useState<UserTemplateListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<TemplateStep[]>([]);
  const [deletingId, setDeletingId] = useState("");
  const [activeId, setActiveId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState("");
  const [runLog, setRunLog] = useState<RunLog | null>(null);
  const [profileReview, setProfileReview] = useState<ProfileReview | null>(null);
  const [reextracting, setReextracting] = useState<ProfileSection | "">("");
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const refreshRetryRef = useRef(0);
  const mounted = useRef(true);
  const onDeletedRef = useRef(input.onDeleted);
  onDeletedRef.current = input.onDeleted;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; abortRef.current?.abort(); }; }, []);
  const profileReviewRef = useRef<ProfileReview | null>(null);
  profileReviewRef.current = profileReview;
  useEffect(() => () => { profileReviewRef.current?.reject(new DOMException("Aborted", "AbortError")); }, []);
  const refresh = useCallback(async () => {
    if (!backend) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const result = await backend.listUserTemplates();
      refreshRetryRef.current = 0;
      if (mounted.current && request === requestRef.current) {
        setTemplates(result.templates);
        setError((current) => current === t.userTemplates.loadFailed ? "" : current);
      }
    } catch (cause) {
      if (mounted.current && request === requestRef.current) { setError(t.userTemplates.loadFailed); setDetail(String(cause)); }
      // Bounded automatic retry for transient network blips (VPN etc.): at most
      // two silent re-attempts, 2.5s apart. Existing entries stay rendered; the
      // error banner offers a manual retry as well.
      if (refreshRetryRef.current < 2) {
        refreshRetryRef.current += 1;
        const retryNumber = refreshRetryRef.current;
        setTimeout(() => {
          if (mounted.current && requestRef.current === request && refreshRetryRef.current === retryNumber) void refresh();
        }, 2500);
      }
    } finally { if (mounted.current && request === requestRef.current) setLoading(false); }
  }, [backend, t]);
  useEffect(() => { void refresh(); }, [refresh]);
  const [presetCovers, setPresetCovers] = useState<UserTemplateCoverMap>({});
  const coversRequestRef = useRef(0);
  /** Session cache of resolved cover URLs so a list refresh does not re-fetch
   *  signatures for every page of every template. */
  const coversCacheRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (!backend) return;
    const request = ++coversRequestRef.current;
    const readyTemplates = templates.filter((template) => template.status === "ready" && template.master_ready);
    if (!readyTemplates.length) { setPresetCovers({}); return; }
    // Concurrency gate: dozens of simultaneous host uploads (every page of every
    // ready template) have killed the engine process under load - run at most
    // COVER_FETCH_CONCURRENCY uploads at a time.
    const COVER_FETCH_CONCURRENCY = 3;
    setPresetCovers({});
    const queue = readyTemplates.flatMap((template) => template.pages.map((page) => ({ template, page })));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue[cursor++];
        if (!item || request !== coversRequestRef.current) return;
        const { template, page } = item;
        const key = `${template.id}:${page.page_number}`;
        try {
          const cached = coversCacheRef.current.get(key);
          const url = cached ?? (await backend.getUserTemplateAsset({ id: template.id, asset: "preview", page_number: page.page_number })).url;
          coversCacheRef.current.set(key, url);
          if (request === coversRequestRef.current) {
            setPresetCovers((current) => {
              const items = [
                ...(current[template.id] ?? []).map((preview) => ({ ...preview, page: Number(preview.alt.split(" · ").pop()) })),
                { url, alt: `${template.name} · ${page.page_number}`, page: page.page_number },
              ];
              items.sort((a, b) => a.page - b.page);
              return { ...current, [template.id]: items.map(({ url: previewUrl, alt }) => ({ url: previewUrl, alt })) };
            });
          }
        } catch { /* single cover failure leaves the rest of the list unaffected */ }
      }
    };
    void Promise.all(Array.from({ length: COVER_FETCH_CONCURRENCY }, () => worker()));
  }, [templates, backend]);
  const presets = useMemo(() => toReadyUserVisualStylePresets(templates, presetCovers), [templates, presetCovers]);
  async function run(files?: File[], templateId?: string) {
    if (!backend || !agent || !upload || abortRef.current) return;
    if (files) {
      try { validateTemplateFiles(files); }
      catch { setError(t.userTemplates.invalidFile); return; }
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true); setError(""); setDetail(""); setNotice(""); setSteps([]); setActiveId(templateId ?? ""); setSelectedId(templateId ?? ""); setRunLog(null);
    try {
      await createPersonalTemplate({ backend, agent, upload, files, templateId, locale, signal: controller.signal,
        confirmProfile: (record, profile) => new Promise<DesignProfile>((resolve, reject) => {
          if (!mounted.current) { reject(new DOMException("Aborted", "AbortError")); return; }
          setProfileReview({ templateId: record.id, profile, resolve, reject });
        }),
        onCreated: (record) => { if (mounted.current) {
          setActiveId(record.id); setSelectedId(record.id);
          setTemplates((current) => [{ ...record, preview_images: current.find((item) => item.id === record.id)?.preview_images ?? [] }, ...current.filter((item) => item.id !== record.id)]);
        } },
        onProgress: (next) => { if (mounted.current) setSteps((current) => appendTemplateStep(current, next)); },
        onRunLog: (log) => {
          if (!mounted.current) return;
          setRunLog(log);
          // Diagnostics survive a page refresh on the online deployment, where
          // only frontend logs are visible.
          persistRunLog(typeof localStorage === "undefined" ? null : localStorage, log);
        },
      });
      if (mounted.current) { setSteps((current) => current.map((step) => ({ ...step, status: "done" }))); setNotice(t.userTemplates.complete); }
    } catch (cause) {
      if (mounted.current) {
        setSteps((current) => current.map((step) => step.status === "running" ? { ...step, status: controller.signal.aborted ? "stopped" : "failed" } : step));
        if (controller.signal.aborted) setNotice(t.userTemplates.interrupted);
        else if (cause instanceof TemplateSourceRequiredError) setError(cause.reason === "filename" ? t.userTemplates.sourceMismatch : t.userTemplates.sourceRequired);
        else { setError(t.userTemplates.failed); setDetail(cause instanceof Error ? cause.message : String(cause)); }
      }
    } finally {
      abortRef.current = null;
      if (mounted.current) { setBusy(false); await refresh(); }
    }
  }
  /** Persist the reviewed/edited profile, then let the paused workflow continue. */
  async function confirmProfileEdits(profile: DesignProfile) {
    const review = profileReview;
    if (!review || !backend) return;
    try {
      await backend.saveUserTemplateProfile({ id: review.templateId, profile });
    } catch (cause) {
      if (mounted.current) { setError(t.userTemplates.profileSaveFailed); setDetail(cause instanceof Error ? cause.message : String(cause)); }
      return;
    }
    if (!mounted.current) return;
    setProfileReview(null);
    review.resolve(profile);
  }
  /** Cancel the review and abort the paused run; the saved profile draft is kept. */
  function cancelProfileReview() {
    const review = profileReview;
    if (!review) return;
    setProfileReview(null);
    abortRef.current?.abort();
    review.reject(new DOMException("Aborted", "AbortError"));
  }
  /** Ask the LLM assistant to turn a natural-language instruction into structured profile edits. */
  async function suggestProfileEdits(profile: DesignProfile, instruction: string): Promise<ProfileOpsResult> {
    if (!agent) throw new Error("Agent client unavailable");
    const parsed = await agent.runStructuredPrompt(
      templateProfileChatPrompt(profile, instruction, locale),
      (value) => parseProfileOps(value),
      { sessionTools: [], toolAccessPolicy: "off" },
    );
    return applyProfileOps(profile, parsed);
  }
  /** Re-run extraction for a single section against the source reference images. */
  async function reextractProfileSection(section: ProfileSection): Promise<Partial<DesignProfile> | null> {
    const review = profileReview;
    if (!review || !backend || !agent || reextracting) return null;
    setReextracting(section);
    setError(""); setDetail("");
    try {
      const record = await backend.getUserTemplate({ id: review.templateId });
      const refs = await Promise.all(record.pages.map(async (page) => attachment(await backend.getUserTemplateAsset({ id: record.id, asset: "reference", page_number: page.page_number }))));
      const partial = await agent.runStructuredPrompt(
        templateProfileSectionPrompt(section, locale),
        (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Section extraction must return an object");
          if ((value as Record<string, unknown>)[section] === undefined) throw new Error(`Section extraction must include "${section}"`);
          return value as Partial<DesignProfile>;
        },
        { attachments: refs, sessionTools: [], toolAccessPolicy: "off" },
      );
      return partial;
    } catch (cause) {
      if (mounted.current) { setError(t.userTemplates.profileReextractFailed); setDetail(cause instanceof Error ? cause.message : String(cause)); }
      return null;
    } finally { if (mounted.current) setReextracting(""); }
  }
  const preview = useCallback(async (id: string, pageNumber?: number): Promise<string> => {
    if (!backend) throw new Error(t.userTemplates.previewFailed);
    setSelectedId(id);
    return (await backend.getUserTemplateAsset({ id, asset: "preview", page_number: pageNumber })).url;
  }, [backend, t]);
  const assetUrlCacheRef = useRef(new Map<string, string>());
  /** Resolve a profile asset (imported logo) to a display URL via the single-asset channel. */
  const profileAssetUrl = useCallback(async (id: string, filename: string): Promise<string> => {
    if (!backend) throw new Error(t.userTemplates.previewFailed);
    const key = `${id}:${filename}`;
    const cached = assetUrlCacheRef.current.get(key);
    if (cached) return cached;
    const url = (await backend.getUserTemplateAsset({ id, asset: "profile_asset", filename })).url;
    assetUrlCacheRef.current.set(key, url);
    return url;
  }, [backend, t]);
  const importingAssetRef = useRef(false);
  /** Upload an imported logo through the mature host-upload stack; the engine pins the
   *  single source of truth under the template's assets/ directory (plan B′). */
  async function importProfileAsset(file: File): Promise<ProfileAssetMeta> {
    if (!backend || !upload || !profileReview) throw new Error(t.userTemplates.previewFailed);
    if (importingAssetRef.current) throw new Error(t.userTemplates.editorAssetImportFailed);
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mime = PROFILE_ASSET_MIME[ext];
    if (!mime || file.size < 1 || file.size > PROFILE_ASSET_MAX_BYTES_FRONTEND) throw new Error(t.userTemplates.editorAssetInvalid);
    importingAssetRef.current = true;
    try {
      const uploaded = await upload.uploadFile(file, { purpose: "user_artifact", mimeType: file.type || mime });
      return await backend.saveUserTemplateProfileAsset({ id: profileReview.templateId, filename: file.name, host_upload: uploaded });
    } finally { importingAssetRef.current = false; }
  }
  /** Current HTML for the master or one page, plus the two-slot previous version. */
  async function getTemplateHtmls(id: string, pageNumber?: number): Promise<{ html: string; previous_html: string | null }> {
    if (!backend) throw new Error(t.userTemplates.previewFailed);
    return backend.getUserTemplateHtml({ id, page_number: pageNumber });
  }
  /** One-shot regeneration for the master or one page (leader requirement: no
   *  conversational context). The model sees current HTML + confirmed profile +
   *  the one instruction; nothing persists until the user adopts the result.
   *  Inline asset bytes are swapped for x-asset-ref placeholders before the
   *  call (the model copies a short token instead of a base64 blob) and
   *  restored verbatim afterwards — same "leave a slot" philosophy as the
   *  reference-page image protocol. */
  async function regenerateMaster(id: string, instruction: string, pageNumber?: number, onStream?: (text: string) => void, intensity: MasterOptimizeIntensity = "balanced", scope?: MasterOptimizeScope): Promise<MasterOptimization> {
    if (!backend) throw new Error(t.userTemplates.previewFailed);
    if (!agent) throw new Error(t.userTemplates.masterAgentUnavailable);
    const [{ html }, record] = await Promise.all([backend.getUserTemplateHtml({ id, page_number: pageNumber }), backend.getUserTemplate({ id })]);
    const stripped = stripInlineAssetData(html);
    // T8 reference anchoring: send the original reference-page screenshot
    // along so "keep it like the original" is grounded in something the model
    // can see instead of the user's memory. Best-effort: a missing reference
    // never blocks the tuning flow. (Same-session repair rounds strip
    // attachments by design — documented limitation.)
    let attachments: AgentImageAttachment[] = [];
    if (pageNumber === undefined) {
      try {
        const firstPage = record.pages[0]?.page_number;
        if (firstPage !== undefined) {
          const reference = await backend.getUserTemplateAsset({ id, asset: "reference", page_number: firstPage });
          attachments = [{ type: reference.mime_type, url: reference.url, filename: reference.filename, detail: "auto" }];
        }
      } catch { attachments = []; }
    }
    const anchorSection = attachments.length
      ? `\n\n## 品牌一致性参考（附件截图）\n附件是该模板原稿的参考页截图。调整时保持其配色、字体气质与标识使用方式的一致；当调整要求与该参考冲突时，以"贴近原稿"为优先。`
      : "";
    const prompt = templateMasterOptimizePrompt(stripped.html, record.profile ?? null, instruction, locale, intensity, scope) + anchorSection;
    // Diagnostics: this flow used to be a black box (only console.info). Run it
    // through the same run-log machinery as template creation so failures are
    // copyable/persisted for production debugging (T1).
    const runStartMs = Date.now();
    const frames: RunFrame[] = [];
    const runIdHolder: { run_id?: string } = {};
    const collect = createFrameCollector(runStartMs, frames, undefined, runIdHolder);
    const runLog = createRunLog();
    runLog.template_id = id;
    let streamed = "";
    let result: MasterOptimization;
    try {
      result = await runLogged(runLog, {
        stage: "master-tune",
        label: pageNumber === undefined ? "master optimization" : `page ${pageNumber} optimization`,
        meta: {
          prompt_chars: prompt.length,
          instruction_chars: instruction.length,
          stripped_assets: stripped.assets.length,
          master_html_chars: html.length,
          size_warning: html.length > 300 * 1024 ? `master HTML ${Math.round(html.length / 1024)}KB exceeds 300KB watch threshold (invoke transfer risk)` : undefined,
        },
        frames,
      }, () => agent.runStructuredPrompt(
        prompt,
        (value) => parseMasterOptimization(value),
        { sessionTools: [], toolAccessPolicy: "off", attachments, onStreamEvent: (event) => {
          collect(event);
          if (event.type === "content") { streamed += event.text; onStream?.(streamed); }
        }, onDiagnosticStreamEvent: (event) => {
          collect(event);
          if (event.type === "activity") console.info(`[master-tune] ${event.message}`);
        }, onRunId: (runId) => { runIdHolder.run_id = runId; } },
      ));
      finishRunLog(runLog, "success");
    } catch (cause) {
      finishRunLog(runLog, "error", describeError(cause));
      persistRunLog(typeof localStorage === "undefined" ? null : localStorage, runLog);
      throw cause;
    }
    // Guard against the silent logo-drop: if the model lost an asset, put the
    // original element back deterministically and record it in the audit list.
    const repaired = reinsertMissingAssets(result.master_html, stripped.assets);
    const restored = restoreInlineAssetData(repaired.html, stripped.assets);
    const changed = repaired.reinserted.length
      ? [...result.changed, `固定资产回补：${repaired.reinserted.join("、")}（生成中丢失，已从原版原样恢复）`]
      : result.changed;
    persistRunLog(typeof localStorage === "undefined" ? null : localStorage, runLog);
    return { ...result, master_html: restored, changed };
  }
  /** Persist master or page HTML. Ready templates re-publish: the snapshot
   *  rebuilds and the version bumps; already-confirmed Workspaces keep their
   *  own copy and are unaffected. */
  async function applyMasterHtml(record: UserTemplateListEntry, html: string, pageNumber?: number): Promise<void> {
    if (!backend) throw new Error(t.userTemplates.previewFailed);
    await backend.saveUserTemplateHtml({ id: record.id, page_number: pageNumber, content: html });
    if (record.status === "ready") {
      await backend.publishUserTemplate({ id: record.id, metadata: { name: record.name, description: record.description, pages: record.pages } });
    }
  }
  /** Variable cascade: push the master's :root variable block into every
   *  reference page (colors/fonts only — layout is never cascaded, pages
   *  keep their identity as snapshots). Returns how many pages changed. */
  async function syncPageVariables(id: string): Promise<number> {
    if (!backend) throw new Error(t.userTemplates.previewFailed);
    const { html: masterHtml } = await backend.getUserTemplateHtml({ id });
    const rootBlock = extractRootBlock(masterHtml);
    if (!rootBlock) return 0;
    const record = await backend.getUserTemplate({ id });
    let synced = 0;
    for (const page of record.pages) {
      const { html } = await backend.getUserTemplateHtml({ id, page_number: page.page_number });
      const next = replaceRootBlock(html, rootBlock);
      if (next !== html) {
        await backend.saveUserTemplateHtml({ id, page_number: page.page_number, content: next });
        synced += 1;
      }
    }
    if (synced > 0 && record.status === "ready") {
      await backend.publishUserTemplate({ id, metadata: { name: record.name, description: record.description, pages: record.pages } });
    }
    return synced;
  }
  async function remove(id: string) {
    if (!backend || busy || deletingId) return;
    setDeletingId(id); setError(""); setDetail(""); setNotice("");
    try {
      await backend.deleteUserTemplate({ id });
      if (!mounted.current) return;
      // A confirmed Workspace owns an immutable preset snapshot, so only an
      // unconfirmed draft selection can still point at the deleted template.
      onDeletedRef.current?.(id);
      setTemplates((current) => current.filter((record) => record.id !== id));
      setNotice(t.userTemplates.deleted);
      if (activeId === id) { setActiveId(""); setSteps([]); }
      if (selectedId === id) setSelectedId("");
    } catch (cause) {
      if (mounted.current) { setError(t.userTemplates.deleteFailed); setDetail(cause instanceof Error ? cause.message : String(cause)); }
    } finally { if (mounted.current) setDeletingId(""); }
  }
  return { templates, presets, loading, busy, ready: Boolean(backend && agent && upload), steps, activeId, selectedId, select: setSelectedId, deletingId, notice, error, detail, runLog, refresh,
    profileReview, reextracting, confirmProfileEdits, cancelProfileReview, reextractProfileSection, suggestProfileEdits,
    importProfileAsset, profileAssetUrl, getTemplateHtmls, regenerateMaster, applyMasterHtml, syncPageVariables,
    getTemplate: (id: string) => backend ? backend.getUserTemplate({ id }) : Promise.reject(new Error("")),
    create: (files: File[]) => run(files), resume: (id: string, file?: File) => run(file ? [file] : undefined, id), stop: () => abortRef.current?.abort(), preview, remove };
}
