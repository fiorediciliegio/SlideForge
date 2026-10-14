import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAgentClient, AGENT_SESSION_MODEL_PREFERENCE } from "../../src/agent/agentClient.ts";
import type { AgentStreamEvent } from "../../src/agent/agentClient.ts";
import type { HostRuntime } from "../../src/runtime/hostRuntime.ts";

describe("AgentClient RPC lifecycle diagnostics", () => {
  it("emits session.create and session.run frames before any stream output", async () => {
    const diagnostics: AgentStreamEvent[] = [];
    const runtime: HostRuntime = {
      tools: { invoke: async () => ({}) },
      llm: { complete: async () => ({}) },
      agent: {
        session: async () => ({
          appSessionUuid: "sess-diagnostic-1",
          granted_tools: ["fs_read_file", "fs_write_file", "doc_read"],
          run: () =>
            (async function* () {
              yield {
                event: "message",
                text: JSON.stringify({
                  status: "ready_for_render",
                  changed_files: [],
                  summary: "ok",
                  needs_render: true,
                  notes: [],
                }),
              };
              yield { event: "complete", task_complete: { token_usage: { total: 1 } } };
            })(),
          delete: async () => undefined,
        }),
      },
    };
    const client = await createAgentClient(runtime);
    await client.runAuthoringPrompt("write the slide", {
      onDiagnosticStreamEvent: (event) => diagnostics.push(event),
    });

    const messages = diagnostics
      .map((event) => (event.type === "activity" ? event.message : ""))
      .filter(Boolean);
    const createFrame = messages.find((message) => message.startsWith("session.create:"));
    const runFrame = messages.find((message) => message.startsWith("session.run:"));
    assert.ok(createFrame, "session.create diagnostic frame recorded");
    assert.ok(runFrame, "session.run diagnostic frame recorded");
    assert.match(createFrame, /tools=/);
    assert.match(createFrame, /granted=fs_read_file,fs_write_file,doc_read/);
    assert.match(createFrame, /expires_in=\d+s/);
    assert.match(createFrame, /session_id=sess-diagnostic-1/);
    assert.match(runFrame, /content_chars=\d+/);
    const modelEsc = AGENT_SESSION_MODEL_PREFERENCE.replace(/[/.]/g, "\\$&");
    assert.match(runFrame, new RegExp(`model_hint=${modelEsc}`));
    // Lifecycle order: create happens before the run frame.
    assert.ok(
      messages.indexOf(createFrame) < messages.indexOf(runFrame),
      "session.create precedes session.run in the diagnostic timeline",
    );
  });
});
