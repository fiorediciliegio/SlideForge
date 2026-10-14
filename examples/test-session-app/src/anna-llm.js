import { imageFileMetadata, validateImageSelection } from "./image-attachments.js";

export function readLlmImage(file, createReader = () => new FileReader()) {
  const metadata = imageFileMetadata(file);
  return new Promise((resolve, reject) => {
    const reader = createReader();
    reader.onload = () => {
      const data = String(reader.result || "").split(",")[1];
      if (!data) return reject(new Error(`${file.name}：读取图片内容失败。`));
      resolve({ type: "image", data, mimeType: metadata.mime_type });
    };
    reader.onerror = () => reject(new Error(`${file.name}：读取图片失败，请重新选择。`));
    reader.onabort = () => reject(new Error(`${file.name}：图片读取已取消。`));
    reader.readAsDataURL(file);
  });
}

export function buildLlmInput(systemPrompt, userPrompt, images = []) {
  validateImageSelection(images.map((image) => image.file));
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: { type: "text", text: systemPrompt } });
  }
  messages.push({ role: "user", content: { type: "text", text: userPrompt } });
  for (const image of images) {
    if (image.status !== "ready" || !image.content?.data) {
      throw new Error("请等待图片读取完成，或移除读取失败的图片。");
    }
    // The documented MCP shape accepts one content block per message.
    messages.push({ role: "user", content: { ...image.content } });
  }
  return { messages };
}

export function summarizeLlmInput(input) {
  return {
    ...input,
    messages: input.messages.map((message) => message.content?.type === "image"
      ? { ...message, content: { type: "image", mimeType: message.content.mimeType, data: "[图片 base64 已省略]" } }
      : message),
  };
}

export function selectLlmInvocationPath(runtime) {
  if (typeof runtime?.call === "function") return "runtime.call";
  if (typeof runtime?.llm?.complete === "function") return "runtime.llm.complete";
  return "unavailable";
}

export async function invokeAnnaLlm(runtime, input, timeoutMs) {
  const invocationPath = selectLlmInvocationPath(runtime);
  if (invocationPath === "runtime.call") {
    return {
      invocationPath,
      timeoutAppliedByRuntime: true,
      result: await runtime.call("llm", "complete", input, { timeoutMs }),
    };
  }
  if (invocationPath === "runtime.llm.complete") {
    return {
      invocationPath,
      timeoutAppliedByRuntime: false,
      result: await runtime.llm.complete(input),
    };
  }
  throw new Error("Anna runtime 未提供 llm.complete 能力");
}
