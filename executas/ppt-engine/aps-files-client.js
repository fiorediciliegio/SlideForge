import { randomUUID } from "node:crypto";

import { attachInvokeContext } from "./invoke-context.js";

export const APS_FILES_ERROR_NOT_GRANTED = -32021;
export const APS_FILES_ERROR_TIMEOUT = -32030;
export const APS_FILES_DOWNLOAD_SCOPE = "user";

// APS may serialize UTC datetimes without a timezone suffix. Never let the
// machine's local timezone reinterpret those expiry values.
function normalizeDownloadExpiry(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return value;
  const timestamp = Date.parse(`${value}Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

export class ApsFilesError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "ApsFilesError";
    this.code = code;
    this.data = data ?? {};
  }
}

export class ApsFilesClient {
  constructor({ writeFrame }) {
    this.writeFrame = writeFrame;
    this.pending = new Map();
    this.disabledReason = null;
  }

  enable() {
    this.disabledReason = null;
  }

  disable(reason) {
    this.disabledReason = reason || "APS Files is not available.";
  }

  dispatchResponse(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || "method" in message) {
      return false;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return false;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new ApsFilesError(
        Number.isInteger(message.error.code) ? message.error.code : -32603,
        typeof message.error.message === "string" ? message.error.message : "APS Files reverse RPC failed",
        message.error.data,
      ));
    } else {
      pending.resolve(message.result ?? {});
    }
    return true;
  }

  uploadBegin({ path, sizeBytes, contentType, metadata, scope = APS_FILES_DOWNLOAD_SCOPE }) {
    return this.call("files/upload_begin", {
      path,
      scope,
      size_bytes: sizeBytes,
      content_type: contentType,
      metadata,
    }, 60_000);
  }

  uploadComplete({ path, etag, sizeBytes, contentType, scope = APS_FILES_DOWNLOAD_SCOPE }) {
    return this.call("files/upload_complete", {
      path,
      scope,
      etag,
      size_bytes: sizeBytes,
      content_type: contentType,
    }, 60_000);
  }

  async downloadUrl({ path, expiresIn, scope = APS_FILES_DOWNLOAD_SCOPE }) {
    const result = await this.call("files/download_url", {
      path,
      scope,
      expires_in: expiresIn,
      ttl_seconds: expiresIn,
    }, 30_000);
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return {
        ...result,
        ...(result.url == null && typeof result.get_url === "string" ? { url: result.get_url } : {}),
        ...(Object.hasOwn(result, "expires_at") ? { expires_at: normalizeDownloadExpiry(result.expires_at) } : {}),
      };
    }
    return result;
  }

  list({ prefix, scope = APS_FILES_DOWNLOAD_SCOPE, limit, cursor } = {}) {
    return this.call("files/list", { prefix, scope, limit, cursor }, 30_000);
  }

  delete({ path, scope = APS_FILES_DOWNLOAD_SCOPE }) {
    return this.call("files/delete", { path, scope }, 30_000);
  }

  call(method, params, timeoutMs) {
    if (this.disabledReason) {
      return Promise.reject(new ApsFilesError(APS_FILES_ERROR_NOT_GRANTED, this.disabledReason));
    }
    const id = `aps-files-${randomUUID()}`;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params: attachInvokeContext(Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      )),
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new ApsFilesError(
            APS_FILES_ERROR_TIMEOUT,
            `${method} timed out after ${timeoutMs}ms`,
          ));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      Promise.resolve(this.writeFrame(message)).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}
