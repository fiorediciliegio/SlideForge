import type { ImageCandidateReference } from "../../api/types";
import type { PageImageSearchResult } from "../../api/pageImageSearchTypes";
import type { OutlineImageAsset } from "../outline/images";

/** 搜索结果先作为可选择的候选，确认配图时才保存原图。 */
export function pageImageCandidate({ get_url: _url, ...result }: PageImageSearchResult): ImageCandidateReference {
  return {
    ...result,
    candidate_id: result.result_id,
    title: result.title ?? undefined,
    width: result.width ?? undefined,
    height: result.height ?? undefined,
    source_urls: result.source_urls ?? [result.source_url],
    matched_queries: result.matched_queries ?? [result.query],
    description: "",
    use_in_ppt: false,
    recommendation: "not_analysed",
  };
}

export function pageImageSearchAsset(result: PageImageSearchResult): OutlineImageAsset {
  const candidate = pageImageCandidate(result);
  return {
    ...candidate,
    asset_id: candidate.candidate_id,
    file_path: "",
    aspect_ratio: candidate.width && candidate.height ? candidate.width / candidate.height : null,
    reason: "",
    source: "search",
    remote_candidate: candidate,
  };
}
