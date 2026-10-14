import type { PptBackend } from "../../api/pptBackend";
import type { ResearchWebClient } from "../../api/researchWebClient";
import { getResearchImageDownloadUrl } from "../../api/researchImageUrl";
import type { ImageCandidateReference } from "../../api/types";
import type { Locale } from "../../i18n";
import { availableImageLibrary, availableOutlineImages, resolveOutlineImage, type OutlineImageAsset } from "./images";

export interface OutlineImageLibraryService {
  load(): Promise<OutlineImageAsset[]>;
  preview(id: string, size?: "thumbnail" | "large"): Promise<string>;
  adopt(image: OutlineImageAsset): Promise<OutlineImageAsset>;
  adoptMany(candidates: ImageCandidateReference[]): Promise<OutlineImageAsset[]>;
}

export function selectedImageReason(locale: Locale): string {
  return ({ zh: "用户为当前页面选择了这张图片。", en: "User selected this image for the current page.",
    ja: "ユーザーが現在のページ用にこの画像を選択しました。", de: "Der Benutzer hat dieses Bild für die aktuelle Seite ausgewählt." })[locale];
}

export function createOutlineImageLibraryService(input: {
  backend: PptBackend; web: ResearchWebClient; workspaceDir: string; locale: Locale;
}): OutlineImageLibraryService {
  const workspace_dir = input.workspaceDir;
  let images: OutlineImageAsset[] = [];
  const pending = new Map<string, Promise<OutlineImageAsset | undefined>>();
  const load = async () => images = availableImageLibrary(await input.backend.getSharedResearchContext({ workspace_dir }));
  async function freshUrl(candidate: ImageCandidateReference) {
    let failure: unknown;
    for (const path of [...new Set([candidate.aps_path, ...(candidate.aps_paths ?? [])])]) {
      try { return await getResearchImageDownloadUrl(input.web, path); } catch (error) { failure = error; }
    }
    throw failure;
  }
  async function importCandidate(candidate: ImageCandidateReference): Promise<OutlineImageAsset | undefined> {
    // Recheck the catalog before I/O; uploads and different search tasks share content identities.
    const existing = availableOutlineImages(await input.backend.getSharedResearchContext({ workspace_dir })).find((image) => image.sha256 === candidate.sha256);
    if (existing) return existing;
    const operation_id = `adopt-image-${crypto.randomUUID()}`;
    try {
      const url = await freshUrl(candidate);
      const prepared = await input.backend.prepareSharedResearchImageCandidate({ workspace_dir, operation_id,
        candidate_id: candidate.candidate_id, source_url: url, expected_sha256: candidate.sha256 });
      if (prepared.sha256 !== candidate.sha256 || prepared.mime_type !== candidate.mime_type || prepared.bytes_size !== candidate.bytes_size) {
        throw new Error("IMAGE_CANDIDATE_CHANGED");
      }
      const imported = await input.backend.importSharedResearchImageLocal({ workspace_dir, candidate_id: candidate.candidate_id,
        local_file_path: prepared.local_file_path, mime_type: prepared.mime_type, size_bytes: prepared.bytes_size, sha256: candidate.sha256 });
      await input.backend.appendSharedImageResearchBatch({ workspace_dir, batch: {
        title: "User-selected page image", status: "completed", queries: [], gaps: [], candidates: [{
          ...candidate, query: candidate.matched_queries[0] ?? "", selected_by_user: true,
          reason: selectedImageReason(input.locale), import_status: "imported", aps_fetch_status: "completed",
          file_path: imported.file_path, width: imported.width, height: imported.height,
        }],
      } });
      return availableOutlineImages(await input.backend.getSharedResearchContext({ workspace_dir })).find((image) => image.sha256 === candidate.sha256);
    } finally {
      await input.backend.cleanupSharedResearchImageStaging({ workspace_dir, operation_id }).catch(() => undefined);
    }
  }
  return {
    load,
    async preview(id, size) {
      let image = resolveOutlineImage(images, id);
      if (!image) image = resolveOutlineImage(await load(), id);
      if (!image?.remote_candidate) return (await input.backend.getOutlineImagePreview({ workspace_dir, asset_id: id, size })).preview_url;
      return freshUrl(image.remote_candidate);
    },
    async adopt(image) {
      if (!image.remote_candidate) return image;
      const result = (await this.adoptMany([image.remote_candidate]))[0];
      if (!result) throw new Error("IMAGE_CANDIDATE_ADD_FAILED");
      return result;
    },
    async adoptMany(candidates) {
      const results: Array<OutlineImageAsset | undefined> = [];
      // Bound file transfers while retaining independent successes and their input order.
      for (let offset = 0; offset < candidates.length; offset += 10) {
        const chunk = await Promise.all(candidates.slice(offset, offset + 10).map(async (candidate) => {
          let request = pending.get(candidate.sha256);
          if (!request) {
            request = importCandidate(candidate).finally(() => pending.delete(candidate.sha256));
            pending.set(candidate.sha256, request);
          }
          try { return await request; }
          catch (error) {
            try { await input.backend.appendWorkspaceLog({ workspace_dir, channel: "ai-research", entry: {
              event: "research.warning", operation: "image-candidate-adoption", candidate_id: candidate.candidate_id,
              aps_path: candidate.aps_path, sha256: candidate.sha256, mime_type: candidate.mime_type, bytes_size: candidate.bytes_size,
              error: (error instanceof Error ? error.message : String(error)).replace(/(?:https?:\/\/|data:)[^\s"'<>]+/gi, "[redacted]"),
            } }); } catch { /* Optional diagnostics. */ }
            return undefined;
          }
        }));
        results.push(...chunk);
      }
      return results.filter((image): image is OutlineImageAsset => Boolean(image));
    },
  };
}
