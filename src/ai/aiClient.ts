import { createAnnaAiClient } from "./annaAiClient";
import { createMockAiClient } from "./mockAiClient";
import type { AiClient } from "./types";
import { connectAnnaRuntime, type AnnaRuntime } from "../runtime/annaRuntime";
import type { AgentClient } from "../agent/agentClient";
import { detectRuntimeMode } from "../runtime/runtimeMode";

export type { AiAttemptLog, AiClient, LlmContextRow } from "./types";

export async function createAiClient(
  runtime?: AnnaRuntime,
  agentClient?: AgentClient,
): Promise<AiClient> {
  if (detectRuntimeMode() === "anna") {
    return createAnnaAiClient(runtime ?? await connectAnnaRuntime(), { agentClient });
  }

  return createMockAiClient();
}
