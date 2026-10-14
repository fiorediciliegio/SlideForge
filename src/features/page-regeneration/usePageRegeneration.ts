import { availableImageLibrary } from "../outline/images";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentClient } from "../../agent/agentClient";
import type { AiClient } from "../../ai/aiClient";
import type { AiInteractionLogger } from "../../ai/interactionLog";
import type { PptBackend } from "../../api/pptBackend";
import type { PageRegenerationBatch } from "../../api/pageRegenerationTypes";
import type { WorkspaceOutline, WorkspaceOutlineItem, WorkspaceResult } from "../../api/types";
import type { Locale, Messages } from "../../i18n/messages";
import { generatePageAlternatives } from "./workflow";

export function usePageRegeneration(input: {
  imageLibrary?: import("../outline/imageLibrary").OutlineImageLibraryService | null;
  pageImageUpload?: import("../page-image-upload/service").PageImageUploadService | null;
  pageImageSearch: import("../page-image-search/service").PageImageSearchService | null;
  backend: PptBackend | null; agent: AgentClient | null; ai: AiClient | null;
  logger: AiInteractionLogger | null; workspace: WorkspaceResult | null; t: Messages; locale: Locale;
  onAdopted: (workspaceDir: string, pageId: string) => Promise<void>;
}) {
  const [view, setView] = useState<"closed" | "configure" | "candidates">("closed");
  const [mode, setMode] = useState<"regenerate" | "beautify">("regenerate");
  const [batch, setBatch] = useState<PageRegenerationBatch | null>(null);
  const [outline, setOutline] = useState<WorkspaceOutlineItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [imagePreparation, setImagePreparation] = useState<import("../deck-generation/prepareImageDescriptions").ImageDescriptionProgress | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState("");
  const inFlight = useRef(false);
  const workspaceRef = useRef<WorkspaceResult | null>(null);
  const text = mode === "beautify" ? input.t.pageBeautification : input.t.pageRegeneration;
  function showError(value: unknown) {
    const message = value instanceof Error ? value.message : String(value);
    setDetail(message);
    setError(message.includes("PAGE_REGENERATION_CONFLICT") ? text.conflict
      : message.includes("PAGE_REGENERATION_WORKSPACE_BUSY") ? text.busy
      : message.includes("PAGE_REGENERATION_DECK_NOT_READY") ? text.notReady
      : message.includes("PAGE_REGENERATION_INVALID_COUNT") ? text.invalid : text.operationFailed);
  }
  async function open(pageIndex: number, nextMode: "regenerate" | "beautify" = "regenerate") {
    if (inFlight.current || !input.backend || !input.workspace) return;
    const item = (input.workspace.outline as WorkspaceOutline).items?.[pageIndex];
    if (!item?.page_id) return;
    workspaceRef.current = input.workspace;
    setMode(nextMode);
    setOutline(item);
    setBatch(null);
    setError("");
    setDetail("");
    setView("configure");
  }
  async function start(count: number, editedOutline: WorkspaceOutlineItem) {
    const workspace = workspaceRef.current;
    if (inFlight.current || !workspace || !input.backend || !input.agent || !input.ai) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setDetail("");
    setOutline(editedOutline);
    setBatch(null);
    setImagePreparation(null);
    setView("candidates");
    try {
      await generatePageAlternatives({ backend: input.backend, agent: input.agent, ai: input.ai,
        workspace, outline: editedOutline, count, logger: input.logger, mode, locale: input.locale,
        onImagePreparation: setImagePreparation, onBatch: (batch) => { setImagePreparation(null); setBatch(batch); } });
    } catch (error) { showError(error); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function refresh() {
    const workspace = workspaceRef.current;
    if (inFlight.current || !input.backend || !workspace) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await input.backend.pageRegeneration({ action: "get", workspace_dir: workspace.workspace_dir,
        ...(batch ? { batch_id: batch.id } : { page_id: outline?.page_id, mode }) });
      if (result) { setBatch(result); setMode(result.mode ?? "regenerate"); setOutline(result.outline); setView("candidates"); }
      else setError(text.noBatch);
    } catch (error) { showError(error); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function adopt(candidateId: string) {
    const workspace = workspaceRef.current;
    if (inFlight.current || !input.backend || !workspace || !batch) return;
    inFlight.current = true;
    setBusy(true);
    setApplying(true);
    setError("");
    try {
      const result = await input.backend.pageRegeneration({ action: "adopt", workspace_dir: workspace.workspace_dir,
        batch_id: batch.id, candidate_id: candidateId });
      if (!result || result.status !== "adopted") throw new Error("Page alternative was not adopted");
      setBatch(result);
      await input.onAdopted(workspace.workspace_dir, result.page_id);
      setView("closed");
    } catch (error) { showError(error); }
    finally { inFlight.current = false; setBusy(false); setApplying(false); }
  }
  const loadImages = useCallback(async () => {
    const workspace = workspaceRef.current;
    if (!input.backend || !workspace) throw new Error("Page regeneration workspace unavailable");
    return availableImageLibrary(await input.backend.getSharedResearchContext({ workspace_dir: workspace.workspace_dir }));
  }, [input.backend]);
  const loadImagePreview = useCallback(async (id: string, size?: "thumbnail" | "large") => {
    const workspace = workspaceRef.current;
    if (!input.backend || !workspace) throw new Error("Page regeneration workspace unavailable");
    if (input.imageLibrary) return input.imageLibrary.preview(id, size);
    return (await input.backend.getOutlineImagePreview({ workspace_dir: workspace.workspace_dir, asset_id: id, size })).preview_url;
  }, [input.backend, input.imageLibrary]);
  // A reopened result screen follows backend renders and detects expired
  // generation ownership without taking over another tab's active Sessions.
  useEffect(() => {
    if (view !== "candidates" || busy || batch?.status !== "running" || !input.backend) return;
    const timer = setTimeout(() => { void refresh(); }, 2000);
    return () => clearTimeout(timer);
  }, [view, busy, batch, input.backend]);
  return {
    workspaceDir: workspaceRef.current?.workspace_dir ?? "",
    view, mode, text, batch, outline, busy, applying, imagePreparation, error, detail, open, start, refresh, adopt,
    loadImages, loadImagePreview, imageLibrary: input.imageLibrary, pageImageSearch: input.pageImageSearch, pageImageUpload: input.pageImageUpload,
    deckTitle: (workspaceRef.current?.outline as WorkspaceOutline | undefined)?.title ?? "",
    globalRequirements: (workspaceRef.current?.outline as WorkspaceOutline | undefined)?.global_creation_requirements ?? "",
    outlineItems: (workspaceRef.current?.outline as WorkspaceOutline | undefined)?.items ?? [],
    close: () => { if (!inFlight.current) setView("closed"); },
    configure: () => { if (!inFlight.current) setView("configure"); },
    available: Boolean(input.backend && input.agent && input.ai && input.workspace),
  };
}

export type PageRegenerationModel = ReturnType<typeof usePageRegeneration>;
