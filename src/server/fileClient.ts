import path from "node:path";
import { readFile } from "node:fs/promises";

export interface PublishedFile {
  file_id: string;
  download_url: string;
}

export function remoteFilesEnabled(): boolean {
  return Boolean(process.env.SLIDEFORGE_FILE_API_URL?.trim());
}

export async function publishRemoteFile(input: {
  filePath: string;
  deckId: string;
  ownerKeyHash?: string;
  format: "pptx" | "pdf";
}): Promise<PublishedFile> {
  if (!input.ownerKeyHash) throw new Error("远程文件发布需要明确的文件归属");
  const content = await readFile(input.filePath);
  const response = await fetch(process.env.SLIDEFORGE_FILE_API_URL!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": process.env.GATEWAY_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify({
      deck_id: input.deckId,
      name: path.basename(input.filePath),
      media_type: input.format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      content_base64: content.toString("base64"),
      ownerKeyHash: input.ownerKeyHash,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json() as PublishedFile & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Go file API ${response.status}`);
  return { file_id: payload.file_id, download_url: payload.download_url };
}
