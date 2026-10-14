import { createAnnaAiClient } from "./hostAiClient";
import { createMockAiClient } from "./mockAiClient";
import type { AiClient } from "./types";
import { connectHostRuntime, type HostRuntime } from "../runtime/hostRuntime";
import type { AgentClient } from "../agent/agentClient";
import { detectRuntimeMode } from "../runtime/runtimeMode";

export type { AiAttemptLog, AiClient, LlmContextRow } from "./types";

export async function createAiClient(
  runtime?: HostRuntime,
  agentClient?: AgentClient,
): Promise<AiClient> {
  if (detectRuntimeMode() === "host") {
    return createAnnaAiClient(runtime ?? await connectHostRuntime(), { agentClient });
  }

  return createMockAiClient();
}
