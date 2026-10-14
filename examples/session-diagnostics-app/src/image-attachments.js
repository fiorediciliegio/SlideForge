export const MAX_SESSION_IMAGES = 6;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MIME_BY_EXTENSION = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function imageFileMetadata(file) {
  const type = file.type || MIME_BY_EXTENSION[file.name.split(".").pop().toLowerCase()];
  if (!IMAGE_TYPES.has(type)) throw new Error(`${file.name}：仅支持 PNG、JPEG、WebP 和 GIF 图片。`);
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error(`${file.name}：图片文件为空或大小无效。`);
  return { filename: file.name, mime_type: type, size_bytes: file.size };
}

export function validateImageSelection(files) {
  if (files.length > MAX_SESSION_IMAGES) throw new Error(`每次最多添加 ${MAX_SESSION_IMAGES} 张图片，请先移除部分图片。`);
  files.forEach(imageFileMetadata);
}

function httpsUrl(value, label) {
  try {
    if (new URL(value).protocol === "https:") return value;
  } catch { /* Report the invalid Host response below. */ }
  throw new Error(`${label}没有返回有效的 HTTPS 地址。`);
}

function expiryTime(confirmed, negotiated, receivedAt) {
  const expiresAt = confirmed.expires_at ?? negotiated.expires_at;
  if (expiresAt != null) {
    const parsed = typeof expiresAt === "number"
      ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt)
      : Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) throw new Error("上传接口返回的图片过期时间无效，请重新上传。");
    return parsed;
  }
  if (typeof confirmed.expires_in === "number" && Number.isFinite(confirmed.expires_in)) {
    return receivedAt + confirmed.expires_in * 1000;
  }
  return null;
}

export async function uploadSessionImage(runtime, file, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  onPhase = () => {},
} = {}) {
  const metadata = imageFileMetadata(file);
  if (typeof runtime?.upload?.negotiate !== "function" || typeof runtime?.upload?.confirm !== "function") {
    throw new Error("当前 Anna Runtime 不支持图片上传，请更新运行环境后重新连接。");
  }
  onPhase("negotiate", "started");
  const negotiated = await runtime.upload.negotiate({ ...metadata, purpose: "image_input" });
  const putUrl = httpsUrl(negotiated?.put_url, "上传协商");
  if (typeof negotiated.r2_key !== "string" || !negotiated.r2_key) throw new Error("上传协商没有返回对象标识。");
  onPhase("negotiate", "succeeded");
  onPhase("put", "started");
  const response = await fetchImpl(putUrl, {
    method: "PUT", headers: negotiated.headers ?? {}, body: file, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`图片上传失败：HTTP ${response.status}。`);
  onPhase("put", "succeeded");
  onPhase("confirm", "started");
  const confirmed = await runtime.upload.confirm({ r2_key: negotiated.r2_key });
  const url = httpsUrl(confirmed?.download_url, "上传确认");
  const upload = {
    ...metadata,
    url,
    r2_key: confirmed.r2_key || negotiated.r2_key,
    expires_at_ms: expiryTime(confirmed, negotiated, now()),
  };
  onPhase("confirm", "succeeded");
  return upload;
}

export function buildSessionImageAttachments(images, detail = "high", now = Date.now()) {
  if (images.length > MAX_SESSION_IMAGES) throw new Error(`每轮最多 ${MAX_SESSION_IMAGES} 张图片。`);
  if (!["auto", "low", "high"].includes(detail)) throw new Error("图片识别精度无效。");
  return images.map((image) => {
    const { upload } = image;
    if (image.status !== "uploaded" || !upload) throw new Error("请先成功上传列表中的全部图片，或移除失败的图片。");
    if (upload.expires_at_ms != null && upload.expires_at_ms <= now + 120_000) {
      throw new Error(`${upload.filename}：图片地址已过期或将在两分钟内过期，请重新上传。`);
    }
    return { type: upload.mime_type, url: httpsUrl(upload.url, "图片附件"), filename: upload.filename, detail };
  });
}
