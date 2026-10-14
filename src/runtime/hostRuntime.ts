export interface ToolInvokeInput {
  tool_id: string;
  method: string;
  args: object;
  timeoutMs?: number;
}

export interface ToolInvokeAsyncInput extends ToolInvokeInput {
  clientTag?: string;
}

export type ToolJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface ToolJobProgress {
  seq: number;
  phase?: string;
  percent?: number;
  message?: string;
  data?: unknown;
}

export interface ToolJobSnapshot<T = unknown> {
  jobId: string;
  clientTag?: string;
  state: ToolJobState;
  result?: T;
  error?: {
    code?: string;
    message: string;
    details?: unknown;
  };
  progress?: ToolJobProgress[];
  lastSeq?: number;
}

export interface LlmTextContent {
  type: "text";
  text: string;
}

/** MCP-shaped image block accepted by the Host LLM message assembler. */
export interface LlmImageContent {
  type: "image";
  /** Base64-encoded image bytes, without a data-URL prefix. */
  data: string;
  mimeType: string;
}

export type LlmMessageContent =
  | string
  | LlmTextContent
  | LlmImageContent;

export interface LlmCompleteInput {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: LlmMessageContent;
  }>;
  maxTokens?: number;
  temperature?: number;
  modelPreferences?: {
    hints?: Array<{ name: string }> | Record<string, unknown>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface AgentRunFrame {
  event?: string;
  event_type?: string;
  text?: string;
  granted_tools?: string[];
  inherit_host_tools?: boolean;
  warnings?: Array<{
    code?: string;
    message?: string;
  }>;
  [key: string]: unknown;
}

export interface AgentImageAttachment {
  type: string;
  url: string;
  filename?: string;
  detail: "auto";
}

export interface HostAgentSession {
  appSessionUuid?: string;
  expires_in?: number;
  expiresIn?: number;
  granted_tools?: string[];
  inherit_host_tools?: boolean;
  run(input: HostAgentSessionRunInput): AsyncIterable<AgentRunFrame>;
  history?(): Promise<unknown>;
  cancel?(runId: string): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface HostAgentSessionRunInput {
  content: string;
  attachments?: AgentImageAttachment[];
  modelPreferences?: {
    hints: Array<{ name: string }>;
  };
}

export interface UploadNegotiateInput {
  filename: string;
  mime_type: string;
  size_bytes: number;
  purpose?: "user_artifact" | "image_reference" | "image_input";
  metadata?: Record<string, unknown>;
}

export interface UploadNegotiateResult {
  put_url: string;
  headers?: Record<string, string>;
  r2_key: string;
  expires_at?: string;
}

export interface UploadConfirmResult {
  download_url: string;
  r2_key: string;
  size_bytes?: number;
  expires_at?: string;
  expires_in?: number;
}

export interface FilesDownloadInput {
  path: string;
  scope?: string | null;
  /** Save-as name; the Host bakes it into the attachment disposition. */
  filename?: string | null;
  ttl_seconds?: number;
}

export interface FilesDownloadUrlInput {
  path: string;
  scope?: string | null;
  owner?: string | null;
  ttl_seconds?: number;
}

export interface FilesDownloadUrlResult {
  get_url: string;
  expires_at?: string;
  etag?: string;
  size_bytes?: number;
  content_type?: string;
}

export interface HostRuntime {
  call?<T = unknown>(
    ns: string,
    method: string,
    args?: object,
    options?: { timeoutMs?: number }
  ): Promise<T>;
  tools: {
    invoke(
      input: ToolInvokeInput,
      options?: { timeoutMs?: number }
    ): Promise<unknown>;
    invokeAsyncAwait?<T = unknown>(
      input: ToolInvokeAsyncInput,
      options?: {
        timeoutMs?: number;
        onProgress?: (progress: ToolJobProgress) => void;
        signal?: AbortSignal;
      },
    ): Promise<T>;
    listJobs?(input?: {
      tool_id?: string;
      state?: ToolJobState | ToolJobState[];
      clientTag?: string;
      limit?: number;
    }): Promise<{ jobs: Array<ToolJobSnapshot>; truncated?: boolean }>;
    getJob?<T = unknown>(input: {
      jobId: string;
      sinceSeq?: number;
      limit?: number;
    }): Promise<ToolJobSnapshot<T>>;
    cancelJob?(input: { jobId: string; reason?: string }): Promise<{
      jobId: string;
      state: ToolJobState;
      cancelled: boolean;
    }>;
  };
  llm: {
    complete(input: LlmCompleteInput): Promise<unknown>;
  };
  web?: {
    search(input: {
      query: string;
      max_results?: number;
      search_depth?: "basic" | "advanced";
      topic?: "general" | "news";
      time_range?: "day" | "week" | "month" | "year";
      region?: string;
      include_domains?: string[];
      exclude_domains?: string[];
    }): Promise<unknown>;
    fetch(
      input: {
        urls: string[];
        format?: "markdown" | "text";
        max_chars?: number;
        timeout_ms?: number;
      },
      options?: { timeoutMs?: number },
    ): Promise<unknown>;
    image_search(input: {
      query: string;
      max_results?: number;
      min_width?: number;
      min_height?: number;
      aspect?: "any" | "wide" | "tall" | "square";
    }): Promise<unknown>;
    image_fetch(
      input: {
        url: string;
        max_bytes?: number;
        purpose?: string;
      },
      options?: { timeoutMs?: number },
    ): Promise<unknown>;
  };
  agent: {
    session(input: {
      submode: "auto";
      systemPrompt?: string;
      quotaCaps?: {
        inherit_host_tools?: boolean;
        allowed_tools?: string[];
      };
      label?: string;
    }): Promise<HostAgentSession>;
  };
  upload?: {
    negotiate(input: UploadNegotiateInput): Promise<UploadNegotiateResult>;
    confirm(input: { r2_key: string }): Promise<UploadConfirmResult>;
  };
  // The SDK builds `files` as a proxy, so every method is present as a function
  // whether or not the Host implements it. Availability has to come from the
  // call itself, not from a typeof check.
  files?: {
    download(input: FilesDownloadInput): Promise<unknown>;
    download_url?(input: FilesDownloadUrlInput): Promise<FilesDownloadUrlResult>;
  };
}

declare global {
  interface Window {
    HostAppRuntime?: {
      connect(): Promise<HostRuntime>;
    };
    __BUNDLED_TOOL_IDS__?: Record<string, string>;
  }
}

interface HostRuntimeModule {
  HostAppRuntime?: {
    connect(): Promise<HostRuntime>;
  };
  default?: {
    connect(): Promise<HostRuntime>;
  };
}

const SLIDEFORGE_RUNTIME_SDK_URLS = [
  "/static/slideforge/_sdk/latest/index.js",
  "/static/slideforge/_sdk/0.2.0/index.js"
];

async function loadAnnaRuntimeSdk(): Promise<HostRuntimeModule | null> {
  for (const sdkUrl of SLIDEFORGE_RUNTIME_SDK_URLS) {
    try {
      return await import(/* @vite-ignore */ sdkUrl);
    } catch {
      // Try the next SDK path; production staging currently serves `latest`.
    }
  }
  return null;
}

export async function connectHostRuntime(): Promise<HostRuntime> {
  if (!window.HostAppRuntime) {
    const runtimeModule = await loadAnnaRuntimeSdk();
    window.HostAppRuntime =
      runtimeModule?.HostAppRuntime ?? runtimeModule?.default ?? window.HostAppRuntime;
  }

  if (!window.HostAppRuntime) {
    throw new Error("HostAppRuntime is not available in this environment.");
  }

  return window.HostAppRuntime.connect();
}
