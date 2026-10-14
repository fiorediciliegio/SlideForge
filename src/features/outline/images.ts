import type { ImageCandidateReference, SharedResearchContextResult, SharedResearchImageAsset } from "../../api/types";

export interface OutlineImageAsset extends SharedResearchImageAsset {
  source: "uploaded" | "search";
  remote_candidate?: ImageCandidateReference;
  /** Existing references remain usable when catalogs contain the same content under multiple IDs. */
  asset_aliases?: string[];
}

/** 同内容图片合并，用户上传的版本优先。 */
export function availableOutlineImages(context: Pick<SharedResearchContextResult, "image_catalog" | "uploaded_asset_catalog">): OutlineImageAsset[] {
  const byHash = new Map<string, OutlineImageAsset>();
  for (const asset of [
    ...(context.uploaded_asset_catalog?.assets ?? []).map((asset) => ({ ...asset, source: "uploaded" as const })),
    ...context.image_catalog.assets.map((asset) => ({ ...asset, source: "search" as const })),
  ]) {
    if (!asset.file_path) continue;
    const previous = byHash.get(asset.sha256);
    byHash.set(asset.sha256, previous ? { ...previous,
      description: previous.description || asset.description,
      asset_aliases: [...new Set([...(previous.asset_aliases ?? []), asset.asset_id])],
    } : asset);
  }
  return [...byHash.values()];
}

export function matchesOutlineImage(asset: OutlineImageAsset, id: string): boolean {
  return asset.asset_id === id || Boolean(asset.asset_aliases?.includes(id));
}

export function resolveOutlineImage(assets: OutlineImageAsset[], id: string): OutlineImageAsset | undefined {
  const image = assets.find((asset) => matchesOutlineImage(asset, id));
  return image && image.asset_id !== id ? { ...image, asset_id: id } : image;
}

/** Updates after adoption/upload retain existing formal IDs while replacing remote metadata. */
export function mergeOutlineImageAssets(assets: OutlineImageAsset[], updates: OutlineImageAsset[]): OutlineImageAsset[] {
  const byHash = new Map(assets.map((image) => [image.sha256, image]));
  for (const image of updates) {
    const previous = byHash.get(image.sha256);
    // 新一轮搜索可能再次命中已有素材，不能将正式素材退回远程候选。
    const preferred = previous?.file_path && !image.file_path ? previous : image;
    const aliases = [...new Set([
      ...(image.asset_aliases ?? []),
      image.asset_id,
      ...(previous ? [previous.asset_id, ...(previous.asset_aliases ?? [])] : []),
    ])].filter((id) => id !== preferred.asset_id);
    byHash.set(image.sha256, {
      ...preferred,
      description: preferred.description || previous?.description || image.description,
      matched_queries: [...new Set([...(previous?.matched_queries ?? []), ...image.matched_queries])],
      ...(preferred.remote_candidate ? { remote_candidate: {
        ...preferred.remote_candidate,
        description: preferred.description || previous?.description || image.description,
        recommendation: previous?.remote_candidate?.recommendation ?? preferred.remote_candidate.recommendation,
        use_in_ppt: previous?.remote_candidate?.use_in_ppt ?? preferred.remote_candidate.use_in_ppt,
        aps_paths: [...new Set([preferred.remote_candidate.aps_path, ...(preferred.remote_candidate.aps_paths ?? []),
          ...(previous?.remote_candidate ? [previous.remote_candidate.aps_path, ...(previous.remote_candidate.aps_paths ?? [])] : [])])],
        source_urls: [...new Set([...(previous?.remote_candidate?.source_urls ?? []), ...preferred.remote_candidate.source_urls])],
        matched_queries: [...new Set([...(previous?.remote_candidate?.matched_queries ?? []), ...preferred.remote_candidate.matched_queries])],
      } } : {}),
      ...(aliases.length ? { asset_aliases: aliases } : {}),
    });
  }
  return [...byHash.values()];
}

/** Manual selection includes remote candidates; automatic assignment still uses formal assets. */
export function availableImageLibrary(context: SharedResearchContextResult): OutlineImageAsset[] {
  const assets = availableOutlineImages(context);
  const seen = new Set(assets.map((asset) => asset.sha256));
  return [...assets, ...(context.image_candidates ?? []).filter((candidate) => !seen.has(candidate.sha256)).map((candidate): OutlineImageAsset => ({
    ...candidate, asset_id: candidate.candidate_id, file_path: "", aspect_ratio: candidate.width && candidate.height ? candidate.width / candidate.height : null,
    reason: "", source: "search", remote_candidate: candidate,
  }))];
}

export function validateImageAssignments(items: Array<{ selected_image_ids?: string[] }>, assets: OutlineImageAsset[], previousItems: Array<{ selected_image_ids?: string[] }> = []) {
  const byId = new Map(assets.flatMap((asset) => [asset.asset_id, ...(asset.asset_aliases ?? [])].map((id) => [id, asset] as const)));
  const allowances = new Map<string, number>();
  for (const item of previousItems) for (const hash of new Set((item.selected_image_ids ?? []).map((id) => byId.get(id)?.sha256).filter((hash): hash is string => Boolean(hash)))) {
    allowances.set(hash, (allowances.get(hash) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  for (const item of items) {
    if (item.selected_image_ids !== undefined && !Array.isArray(item.selected_image_ids)) throw new Error("Invalid image assignment list");
    const pageImages = new Set<string>();
    for (const id of item.selected_image_ids ?? []) {
      const asset = byId.get(id);
      if (!asset) throw new Error(`Unknown or unavailable image: ${id}`);
      const count = (used.get(asset.sha256) ?? 0) + 1;
      if (pageImages.has(asset.sha256) || count > Math.max(1, allowances.get(asset.sha256) ?? 0)) throw new Error(`Image may only be assigned once unless already shared by the user: ${id}`);
      pageImages.add(asset.sha256);
      used.set(asset.sha256, count);
    }
  }
}
