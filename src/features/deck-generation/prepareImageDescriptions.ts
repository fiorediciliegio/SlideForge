import { AgentRunCancelledError, isAgentRunCancelledError, type AgentClient } from "../../agent/agentClient";
import type { AiInteractionLogger } from "../../ai/interactionLog";
import type { PptBackend } from "../../api/pptBackend";
import type { SharedResearchContextResult } from "../../api/types";
import type { Locale } from "../../i18n";
import { availableOutlineImages } from "../outline/images";
import { PAGE_IMAGE_ATTACHMENT_LIMIT } from "../outline/imageAttachmentLimit";
import { describeImageAttachments, type PageImageDescriptionAttachment } from "../page-image-upload/service";

export interface ImageDescriptionProgress { completed: number; total: number; failed: number }

// Auxiliary persistence may fail. Keep the current run's results for page retries in this app session.
const preparedRuns = new Map<string, { attempted: Set<string>; descriptions: Map<string, string> }>();
function currentRun(workspaceDir: string, runKey?: string) {
  if (!runKey) return { attempted: new Set<string>(), descriptions: new Map<string, string>() };
  const key = `${workspaceDir}\0${runKey}`;
  let run = preparedRuns.get(key);
  if (!run) {
    run = { attempted: new Set(), descriptions: new Map() };
    preparedRuns.set(key, run);
    if (preparedRuns.size > 32) preparedRuns.delete(preparedRuns.keys().next().value!);
  }
  return run;
}

/** Once per generation preparation, before any HTML Session. Descriptions are optional assistance. */
export async function prepareSelectedImageDescriptions(input: {
  backend: PptBackend; agent: AgentClient; workspaceDir: string; locale: Locale;
  context: SharedResearchContextResult; selectedImageIds: string[]; logger?: AiInteractionLogger | null;
  runKey?: string; signal?: AbortSignal; isCancelled?: () => boolean; onProgress?: (progress: ImageDescriptionProgress) => void;
}): Promise<SharedResearchContextResult> {
  const check = () => { if (input.signal?.aborted || input.isCancelled?.()) throw new AgentRunCancelledError(); };
  const warning = async (stage: string, error: unknown, ids: string[]) => {
    check();
    if (isAgentRunCancelledError(error)) throw error;
    try { await input.backend.appendWorkspaceLog({ workspace_dir: input.workspaceDir, channel: "ai-research", entry: {
      event: "research.warning", operation: `image-description-${stage}`, asset_ids: ids,
      error: (error instanceof Error ? error.message : String(error)).replace(/(?:https?:\/\/|data:)[^\s"'<>]+/gi, "[redacted]"),
    } }); } catch (failure) { check(); if (isAgentRunCancelledError(failure)) throw failure; }
  };
  check();
  const selected = new Set(input.selectedImageIds);
  const unique = new Map(availableOutlineImages(input.context).filter((image) => (selected.has(image.asset_id) || image.asset_aliases?.some((id) => selected.has(id))) && !image.description.trim())
    .map((image) => [image.sha256, image]));
  if (!unique.size) return input.context;
  const run = currentRun(input.workspaceDir, input.runKey);
  const attempted = run.attempted;
  if (input.runKey) {
    try {
      const saved = await input.backend.outlineImageDescriptions({ workspace_dir: input.workspaceDir, action: "get_run", run_key: input.runKey });
      (saved.attempted_sha256 ?? []).forEach((hash) => attempted.add(hash));
    } catch (error) { await warning("read-run", error, []); }
  }
  check();
  const pending = [...unique.values()].filter((image) => !attempted.has(image.sha256));
  const descriptions = run.descriptions;
  const total = unique.size;
  let completed = total - pending.length;
  let failed = [...unique.values()].filter((image) => attempted.has(image.sha256) && !descriptions.has(image.sha256)).length;
  input.onProgress?.({ completed, total, failed });
  for (let offset = 0; offset < pending.length; offset += PAGE_IMAGE_ATTACHMENT_LIMIT) {
    check();
    const batch = pending.slice(offset, offset + PAGE_IMAGE_ATTACHMENT_LIMIT);
    const prepared = await Promise.all(batch.map(async (image) => {
      try {
        const { host_upload } = await input.backend.uploadOutlineImageForAgent({ workspace_dir: input.workspaceDir,
          asset_id: image.asset_id, operation_id: `describe-image-${crypto.randomUUID()}` });
        check();
        if (!host_upload.url || !host_upload.mime_type.startsWith("image/")) throw new Error("IMAGE_NOT_AVAILABLE");
        return { image, attachment: { url: host_upload.url, mime_type: host_upload.mime_type, filename: host_upload.filename } satisfies PageImageDescriptionAttachment };
      } catch (error) { await warning("attachment", error, [image.asset_id]); return null; }
    }));
    check();
    const attachments = prepared.filter((item) => item !== null);
    if (attachments.length) {
      try {
        await describeImageAttachments({ agent: input.agent, attachments: attachments.map((item) => item.attachment),
          locale: input.locale, workspaceDir: input.workspaceDir, logger: input.logger, retryUnavailable: true,
          signal: input.signal, isCancelled: input.isCancelled,
          onDescriptions: (items) => {
            check();
            for (const item of items) if (item.description) descriptions.set(attachments[item.attachment_index - 1]!.image.sha256, item.description);
          },
        });
      } catch (error) { await warning("session", error, attachments.map((item) => item.image.asset_id)); }
    }
    check();
    for (const image of batch) {
      const description = descriptions.get(image.sha256);
      if (!description) { failed++; continue; }
      try {
        check();
        const saved = await input.backend.outlineImageDescriptions({ workspace_dir: input.workspaceDir, action: "describe", asset_id: image.asset_id, description });
        if (saved.image?.description) descriptions.set(image.sha256, saved.image.description);
      } catch (error) { await warning("save", error, [image.asset_id]); }
    }
    check();
    batch.forEach((image) => attempted.add(image.sha256));
    if (input.runKey) {
      try {
        await input.backend.outlineImageDescriptions({ workspace_dir: input.workspaceDir, action: "mark_attempted", run_key: input.runKey, sha256s: batch.map((image) => image.sha256) });
      } catch (error) { await warning("save-run", error, batch.map((image) => image.asset_id)); }
    }
    check();
    completed += batch.length;
    input.onProgress?.({ completed, total, failed });
  }
  // Preserve current successes even if auxiliary persistence failed. All selected images remain.
  const update = (catalog: SharedResearchContextResult["image_catalog"] | undefined) => catalog ? { ...catalog,
    assets: catalog.assets.map((image) => descriptions.has(image.sha256) ? { ...image, description: descriptions.get(image.sha256)! } : image),
  } : undefined;
  return { ...input.context, image_catalog: update(input.context.image_catalog)!, uploaded_asset_catalog: update(input.context.uploaded_asset_catalog) };
}
