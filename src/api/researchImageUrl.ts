import type { ResearchWebClient } from "./researchWebClient";

/** Resolve a fresh APS URL; never fall back to image_fetch URLs or persist signed URLs. */
export async function getResearchImageDownloadUrl(client: Pick<ResearchWebClient, "getImageDownloadUrl">, path: string): Promise<string> {
  if (!path) throw new Error("APS image URL preparation failed: missing APS path");
  const url = await client.getImageDownloadUrl(path);
  try {
    const parsed = new URL(url);
    if (!/^https?:\/\//i.test(url) || !["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    // Do not include signed URLs or image bytes from malformed Host responses.
    throw new Error("APS image URL preparation failed: expected an absolute HTTP(S) download URL");
  }
  return url;
}
