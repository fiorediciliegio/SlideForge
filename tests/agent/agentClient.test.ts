import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentInfrastructureError,
  AGENT_SESSION_MODEL_PREFERENCE,
  extractLatestHtmlPreview,
  isAgentRunCancelledError,
  createAgentClient,
  type AgentStreamEvent,
} from "../../src/agent/agentClient.ts";
import type {
  AnnaAgentRunFrame,
  AnnaAgentSession,
  AnnaRuntime,
} from "../../src/runtime/annaRuntime.ts";
import { createAiInteractionLogger } from "../../src/ai/interactionLog.ts";

const SESSION_ERROR_MESSAGE = "no cached app_session token; create a new session";

describe("extractLatestHtmlPreview", () => {
  it("returns a paintable partial document once the body starts", () => {
    assert.equal(extractLatestHtmlPreview("<!doctype html><html><head><style>body{color:red}"), null);
    assert.equal(
      extractLatestHtmlPreview("before<html><head></head><body><h1>Live</h1>"),
      "<html><head></head><body><h1>Live</h1>",
    );
  });

  it("uses the newest document when a same-session repair begins", () => {
    const preview = extractLatestHtmlPreview([
      "<html><body>failed attempt</body></html>",
      "<html><body>replacement",
    ].join("\n"));
    assert.equal(preview, "<html><body>replacement");
  });
});

function createRuntime(
  runs: AnnaAgentRunFrame[][],
  options: {
    sessionPatch?: Partial<AnnaAgentSession>;
  } = {},
) {
  let sessionCreations = 0;
  let sessionDeletes = 0;

  const runtime: AnnaRuntime = {
    tools: {
      invoke: async () => ({}),
    },
    llm: {
      complete: async () => ({}),
    },
    agent: {
      session: async () => {
        const frames = runs[sessionCreations] ?? runs.at(-1) ?? [];
        sessionCreations += 1;
        const session: AnnaAgentSession = {
          ...options.sessionPatch,
          run: () =>
            (async function* () {
              for (const frame of frames) {
                yield frame;
              }
            })(),
          delete: async () => {
            sessionDeletes += 1;
          },
        };
        return session;
      },
    },
  };

  return {
    runtime,
    get sessionCreations() {
      return sessionCreations;
    },
    get sessionDeletes() {
      return sessionDeletes;
    },
  };
}

function createRuntimeFromStreams(streams: Array<() => AsyncIterable<AnnaAgentRunFrame>>) {
  let sessionCreations = 0;
  let sessionDeletes = 0;

  const runtime: AnnaRuntime = {
    tools: {
      invoke: async () => ({}),
    },
    llm: {
      complete: async () => ({}),
    },
    agent: {
      session: async () => {
        const run = streams[sessionCreations] ?? streams.at(-1);
        sessionCreations += 1;
        const session: AnnaAgentSession = {
          run: () => run?.() ?? (async function* () {})(),
          delete: async () => {
            sessionDeletes += 1;
          },
        };
        return session;
      },
    },
  };

  return {
    runtime,
    get sessionCreations() {
      return sessionCreations;
    },
    get sessionDeletes() {
      return sessionDeletes;
    },
  };
}

it("creates restricted filesystem sessions and prefers Gemini 3.8 Flash on every run", async () => {
  let createInput: unknown;
  let runInput: unknown;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async (input) => {
        createInput = input;
        return {
          run: (input) => {
            runInput = input;
            return (async function* () {
              yield { event: "message", text: JSON.stringify({
                status: "ready_for_render",
                changed_files: [],
                summary: "ok",
                needs_render: true,
                notes: [],
              }) };
              yield { event: "complete" };
            })();
          },
          delete: async () => undefined,
        };
      },
    },
  };

  const client = await createAgentClient(runtime);
  await client.runAuthoringPrompt("write a page");

  assert.deepEqual(createInput, {
    submode: "auto",
    quotaCaps: {
      inherit_host_tools: false,
      allowed_tools: ["fs_read_file", "fs_write_file"],
    },
  });
  assert.deepEqual((runInput as { modelPreferences?: unknown }).modelPreferences, {
    hints: [{ name: AGENT_SESSION_MODEL_PREFERENCE }],
  });
});

it("only grants specialized tools to the run that explicitly requests them", async () => {
  let createInput: unknown;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async (input) => {
        createInput = input;
        return {
          run: () => (async function* () {
            yield { event: "message", text: JSON.stringify({
              status: "ready_for_render", changed_files: [], summary: "ok", needs_render: false, notes: [],
            }) };
            yield { event: "complete" };
          })(),
          delete: async () => undefined,
        };
      },
    },
  };

  const client = await createAgentClient(runtime);
  await client.runAuthoringPrompt("analyze a source", {
    sessionTools: ["fs_read_file", "fs_write_file", "doc_read", "sheet_read"],
  });

  assert.deepEqual(createInput, {
    submode: "auto",
    quotaCaps: {
      inherit_host_tools: false,
      allowed_tools: ["fs_read_file", "fs_write_file", "doc_read", "sheet_read"],
    },
  });
});

it("creates one Web research Session with a system prompt and reuses it across runs", async () => {
  let createInput: unknown;
  const runInputs: unknown[] = [];
  let deletes = 0;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async (input) => {
        createInput = input;
        return {
          run: (runInput) => {
            runInputs.push(runInput);
            return (async function* () {
              yield { event: "message", text: '{"action":"search","query":"query"}' };
              yield { event: "complete" };
            })();
          },
          delete: async () => { deletes += 1; },
        };
      },
    },
  };
  const client = await createAgentClient(runtime);
  const systemPrompt = "Web research system prompt";
  const session = await client.createWebResearchSession(systemPrompt);
  const options = {
    modelPreference: "moonshotai/kimi-k2.6",
  };

  await session.run("first", options);
  await session.run("second", options);
  await session.close();
  await session.close();

  assert.deepEqual(createInput, {
    submode: "auto",
    systemPrompt,
    quotaCaps: {
      inherit_host_tools: false,
      allowed_tools: [],
    },
  });
  assert.equal(runInputs.length, 2);
  assert.deepEqual(runInputs.map((input) => (input as { content: string }).content), ["first", "second"]);
  for (const input of runInputs as Array<{ systemPrompt?: string; modelPreferences?: unknown }>) {
    assert.equal(input.systemPrompt, undefined);
    assert.deepEqual(input.modelPreferences, { hints: [{ name: options.modelPreference }] });
  }
  assert.equal(deletes, 1);
});

it("creates a tool-free Outline Session with its system prompt and run-scoped model preference", async () => {
  let createInput: unknown;
  const runInputs: unknown[] = [];
  let deletes = 0;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => { throw new Error("outline must not call llm.complete"); } },
    agent: {
      session: async (input) => {
        createInput = input;
        return {
          run: (runInput) => {
            runInputs.push(runInput);
            return (async function* () {
              yield { event: "message", text: '{"presentation_title":"Demo","pages":[]}' };
              yield { event: "complete" };
            })();
          },
          delete: async () => { deletes += 1; },
        };
      },
    },
  };
  const client = await createAgentClient(runtime);
  const systemPrompt = "Outline system prompt";
  const session = await client.createOutlineSession(systemPrompt);

  await session.run("first", {
    modelPreference: "google/gemini-3-flash-preview",
    toolAccessPolicy: "off",
  });
  await session.run("retry", {
    modelPreference: "google/gemini-3-flash-preview",
    toolAccessPolicy: "off",
  });
  await session.close();

  assert.deepEqual(createInput, {
    submode: "auto",
    systemPrompt,
    quotaCaps: {
      inherit_host_tools: false,
      allowed_tools: [],
    },
  });
  assert.deepEqual(
    runInputs.map((input) => (input as { content: string }).content),
    ["first", "retry"],
  );
  assert.ok(runInputs.every((input) => (
    (input as { modelPreferences?: unknown }).modelPreferences
    && JSON.stringify((input as { modelPreferences?: unknown }).modelPreferences)
      === JSON.stringify({ hints: [{ name: "google/gemini-3-flash-preview" }] })
  )));
  assert.equal(deletes, 1);
});

it("allows a held research Session to restart twice within its fresh-session budget", async () => {
  const harness = createRuntime([
    [{ event: "message", text: '{"action":"search","query":"first"}' }, { event: "complete" }],
    [{ event: "message", text: '{"action":"search","query":"second"}' }, { event: "complete" }],
    [{ event: "message", text: '{"action":"search","query":"third"}' }, { event: "complete" }],
  ]);
  let freshSessions = 0;
  const client = await createAgentClient(harness.runtime);
  const session = await client.createWebResearchSession("system", {
    freshPrompt: () => "checkpoint prompt",
    onFreshSession: () => { freshSessions += 1; },
  });

  await session.run("initial", { modelPreference: "model" });
  await session.restartFreshSession();
  await session.run("after first restart", { modelPreference: "model" });
  await session.restartFreshSession();
  await session.run("after second restart", { modelPreference: "model" });

  assert.equal(harness.sessionCreations, 3);
  assert.equal(freshSessions, 2);
  await assert.rejects(() => session.restartFreshSession(), /budget is exhausted/);
  await session.close();
});

it("surfaces a Web research Session deletion failure", async () => {
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async () => ({
        run: () => (async function* () { yield { event: "complete" }; })(),
        delete: async () => { throw new Error("delete failed"); },
      }),
    },
  };
  const client = await createAgentClient(runtime);
  const session = await client.createWebResearchSession("Web research system prompt");

  await assert.rejects(() => session.close(), /delete failed/);
});

it("creates one Image research Session and carries attachments on each held run", async () => {
  const runInputs: Array<{ content: string; attachments?: unknown[] }> = [];
  let createInput: unknown;
  let deletes = 0;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async (input) => {
        createInput = input;
        assert.equal(input.systemPrompt, "Image research system prompt");
        return {
          run: (runInput) => {
            runInputs.push(runInput as { content: string; attachments?: unknown[] });
            return (async function* () {
              yield { event: "message", text: "{\"action\":\"finish\",\"query\":null,\"decisions\":[],\"summary\":\"done\"}" };
              yield { event: "complete" };
            })();
          },
          delete: async () => { deletes += 1; },
        };
      },
    },
  };
  const client = await createAgentClient(runtime);
  const session = await client.createImageResearchSession("Image research system prompt");
  await session.run("first", { attachments: [{ type: "image/jpeg", url: "https://upload.test/a", detail: "auto" }] });
  await session.close();
  assert.deepEqual(createInput, {
    submode: "auto",
    systemPrompt: "Image research system prompt",
    quotaCaps: {
      inherit_host_tools: false,
      allowed_tools: [],
    },
  });
  assert.equal(runInputs.length, 1);
  assert.equal(runInputs[0]?.attachments?.length, 1);
  assert.equal(deletes, 1);
});

it("creates a tool-free HTML Session for visual master and page generation", async () => {
  let createInput: unknown;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async (input) => {
        createInput = input;
        return {
          run: () => (async function* () {
            yield { event: "message", text: "<html><body><main>Page</main></body></html>" };
            yield { event: "complete" };
          })(),
          delete: async () => undefined,
        };
      },
    },
  };

  const client = await createAgentClient(runtime);
  const result = await client.runHtmlGenerationPrompt("generate HTML");

  assert.equal(result.html, "<html><body><main>Page</main></body></html>");
  assert.deepEqual(createInput, {
    submode: "auto",
    quotaCaps: {
      inherit_host_tools: false,
      allowed_tools: [],
    },
  });
});

it("repairs template selection JSON in one session with only doc_read allowed", async () => {
  const creations: unknown[] = [];
  const prompts: string[] = [];
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: { session: async (input) => {
      creations.push(input);
      return {
        run: (runInput) => {
          prompts.push(runInput.content);
          const text = prompts.length === 1 ? '{"page_numbers":' : '{"page_numbers":[2,5]}';
          return (async function* () { yield { event: "message", text }; yield { event: "complete" }; })();
        },
        delete: async () => undefined,
      };
    } },
  };
  const client = await createAgentClient(runtime);
  const result = await client.runStructuredPrompt("Use doc_read to select pages.", (value) => value, { sessionTools: ["doc_read"], toolAccessPolicy: "off" });
  assert.deepEqual(result, { page_numbers: [2, 5] });
  assert.deepEqual(creations, [{ submode: "auto", quotaCaps: { inherit_host_tools: false, allowed_tools: ["doc_read"] } }]);
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1]!, /Use doc_read to select pages/);
});

it("repairs invalid HTML in the same Session without a fresh replay", async () => {
  const prompts: string[] = [];
  let runs = 0;
  let sessionCreations = 0;
  let sessionDeletes = 0;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) },
    llm: { complete: async () => ({}) },
    agent: {
      session: async () => {
        sessionCreations += 1;
        return {
          run: (input) => {
            prompts.push(input.content);
            const response = runs++ === 0
              ? "<html><body>incomplete"
              : "<html><body>repaired</body></html>";
            return (async function* () {
              yield { event: "message", text: response };
              yield { event: "complete" };
            })();
          },
          delete: async () => {
            sessionDeletes += 1;
          },
        };
      },
    },
  };

  const client = await createAgentClient(runtime);
  const result = await client.runHtmlGenerationPrompt("generate HTML");

  assert.equal(result.html, "<html><body>repaired</body></html>");
  assert.equal(result.same_session_retries, 1);
  assert.equal(result.fresh_session_retries, 0);
  assert.equal(sessionCreations, 1);
  assert.equal(sessionDeletes, 1);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], "generate HTML");
  assert.match(prompts[1] ?? "", /唯一的完整 HTML/);
});

function sessionErrorFrames(): AnnaAgentRunFrame[] {
  return [{ event: "error", message: SESSION_ERROR_MESSAGE }];
}

function authoringSuccessFrames(): AnnaAgentRunFrame[] {
  return [
    {
      event: "message",
      text: JSON.stringify({
        status: "ready_for_render",
        changed_files: [],
        summary: "ok",
        needs_render: true,
        notes: [],
      }),
    },
    { event: "complete" },
  ];
}

function emptyCompletionFrames(retryable = true): AnnaAgentRunFrame[] {
  return [{
    event: "sse",
    error: "The Agent completed without producing output.",
    error_type: "empty_completion",
    is_retryable: retryable,
  }];
}

describe("AgentClient unified Session retry", () => {
  it("retries an empty completion with a new Session", async () => {
    const harness = createRuntime([
      emptyCompletionFrames(),
      authoringSuccessFrames(),
    ]);
    const events: AgentStreamEvent[] = [];
    const client = await createAgentClient(harness.runtime);

    const result = await client.runAuthoringPrompt("write a page", {
      onStreamEvent: (event) => events.push(event),
    });

    assert.equal(result.status, "ready_for_render");
    assert.equal(harness.sessionCreations, 2);
    assert.equal(harness.sessionDeletes, 2);
    assert.equal(result.fresh_session_retries, 1);
    assert.equal(events.some((event) => event.type === "activity" && event.message.includes("creating a fresh session")), true);
  });

  it("stops after two fresh Session retries", async () => {
    const harness = createRuntime([
      emptyCompletionFrames(),
      emptyCompletionFrames(),
      emptyCompletionFrames(),
    ]);
    const client = await createAgentClient(harness.runtime);

    await assert.rejects(
      () => client.runAuthoringPrompt("write a page"),
      (error) => {
        assert.equal(error instanceof AgentInfrastructureError, true);
        assert.equal((error as AgentInfrastructureError).code, "empty_completion");
        return true;
      },
    );
    assert.equal(harness.sessionCreations, 3);
    assert.equal(harness.sessionDeletes, 3);
  });

  it("retries a non-retryable empty completion like any other Session error", async () => {
    const harness = createRuntime([
      emptyCompletionFrames(false),
      authoringSuccessFrames(),
    ]);
    const client = await createAgentClient(harness.runtime);

    const result = await client.runAuthoringPrompt("write a page");
    assert.equal(result.status, "ready_for_render");
    assert.equal(result.fresh_session_retries, 1);
    assert.equal(harness.sessionCreations, 2);
    assert.equal(harness.sessionDeletes, 2);
  });

  it("cancels the active Run before deleting its Session after total timeout", async () => {
    const cancelledRunIds: string[] = [];
    const cleanupOrder: string[] = [];
    let sessionDeletes = 0;
    const runtime: AnnaRuntime = {
      tools: { invoke: async () => ({}) },
      llm: { complete: async () => ({}) },
      agent: {
        session: async () => ({
          run: () => (async function* () {
            yield { event: "run_meta", run_id: "run-timeout" };
            await new Promise(() => undefined);
          })(),
          cancel: async (runId) => {
            cancelledRunIds.push(runId);
            cleanupOrder.push("cancel");
          },
          delete: async () => {
            sessionDeletes += 1;
            cleanupOrder.push("delete");
          },
        }),
      },
    };
    const client = await createAgentClient(runtime, {
      runTimeoutMs: 5,
      streamIdleTimeoutMs: 1_000,
    });

    await assert.rejects(
      () => client.runAuthoringPrompt("write a page"),
      /Agent run timed out after 5ms/,
    );
    assert.deepEqual(cancelledRunIds, ["run-timeout", "run-timeout", "run-timeout"]);
    assert.equal(sessionDeletes, 3);
    assert.deepEqual(cleanupOrder, ["cancel", "delete", "cancel", "delete", "cancel", "delete"]);
  });

  it("normalizes an unreadable visual attachment to a failed low-confidence review", async () => {
    const harness = createRuntime([[{
      event: "message",
      text: '{"changed":false,"blocked":true,"summary":"IMAGE_UNAVAILABLE"}',
    }, { event: "complete" }]]);
    const client = await createAgentClient(harness.runtime);

    const result = await client.runPageVisualReviewPrompt("review");

    assert.equal(result.changed, false);
    assert.equal(result.blocked, true);
    assert.equal(result.summary, "IMAGE_UNAVAILABLE");
  });

  it("passes native image attachments only to the initial visual review run", async () => {
    const runInputs: Array<{ content: string; attachments?: unknown[] }> = [];
    const responses = [
      [{ event: "message", text: "not json" }, { event: "complete" }],
      [{ event: "message", text: '{"changed":true,"blocked":false,"summary":"A clear title above three readable cards on a light canvas."}' }, { event: "complete" }],
    ] as AnnaAgentRunFrame[][];
    let runCount = 0;
    const runtime: AnnaRuntime = {
      tools: { invoke: async () => ({}) },
      llm: { complete: async () => ({}) },
      agent: {
        session: async () => ({
            run: (input) => {
              runInputs.push(input);
              const frames = responses[runCount++] ?? [];
              return (async function* () {
                for (const frame of frames) yield frame;
              })();
            },
            delete: async () => undefined,
          }),
      },
    };
    const client = await createAgentClient(runtime);
    await client.runPageVisualReviewPrompt("review", {
      attachments: [{
        type: "image/png",
        url: "https://uploads.example/page.png",
        filename: "page.png",
        detail: "auto",
      }],
    });

    assert.equal(runInputs.length, 2);
    assert.equal(runCount, 2);
    assert.equal(runInputs[0]?.attachments?.length, 1);
    assert.equal(runInputs[1]?.attachments, undefined);
  });
  it("throws AgentInfrastructureError when session create resolves no tools", async () => {
    const harness = createRuntime([authoringSuccessFrames()], {
      sessionPatch: {
        granted_tools: [],
        inherit_host_tools: false,
      },
    });
    const client = await createAgentClient(harness.runtime);

    await assert.rejects(
      () => client.runAuthoringPrompt("write a page"),
      (error) => {
        assert.equal(error instanceof AgentInfrastructureError, true);
        const infrastructureError = error as AgentInfrastructureError;
        assert.equal(infrastructureError.code, "NO_TOOLS_AVAILABLE");
        assert.equal(infrastructureError.noToolsAvailable, true);
        assert.match(infrastructureError.message, /cannot use executable tools/);
        return true;
      },
    );
    assert.equal(harness.sessionCreations, 3);
    assert.equal(harness.sessionDeletes, 3);
  });

  it("keeps older runtimes compatible when session create omits tool surface", async () => {
    const harness = createRuntime([authoringSuccessFrames()]);
    const client = await createAgentClient(harness.runtime);

    await client.checkToolAccess();
    const result = await client.runAuthoringPrompt("write a page");

    assert.equal(result.status, "ready_for_render");
    assert.equal(harness.sessionCreations, 2);
    assert.equal(harness.sessionDeletes, 2);
  });

  it("continues when session create resolves no tools in warn policy", async () => {
    const harness = createRuntime([authoringSuccessFrames()], {
      sessionPatch: {
        granted_tools: [],
        inherit_host_tools: false,
      },
    });
    const client = await createAgentClient(harness.runtime, {
      toolAccessPolicy: "warn",
    });

    await client.checkToolAccess();
    const result = await client.runAuthoringPrompt("write a page");

    assert.equal(result.status, "ready_for_render");
    assert.equal(harness.sessionCreations, 2);
    assert.equal(harness.sessionDeletes, 2);
  });

  it("ignores session create tool access surface in off policy", async () => {
    const harness = createRuntime([authoringSuccessFrames()], {
      sessionPatch: {
        granted_tools: [],
        inherit_host_tools: false,
        warnings: [
          {
            code: "NO_TOOLS_AVAILABLE",
            message: "This agent session resolved ZERO executable tools.",
          },
        ],
      },
    });
    const client = await createAgentClient(harness.runtime, {
      toolAccessPolicy: "off",
    });

    await client.checkToolAccess();
    const result = await client.runAuthoringPrompt("write a page");

    assert.equal(result.status, "ready_for_render");
    assert.equal(harness.sessionCreations, 2);
    assert.equal(harness.sessionDeletes, 2);
  });

  it("throws AgentInfrastructureError when run_meta reports no tools", async () => {
    const harness = createRuntime([
      [
        {
          event: "run_meta",
          granted_tools: [],
          inherit_host_tools: false,
          warnings: [
            {
              code: "NO_TOOLS_AVAILABLE",
              message: "This agent session resolved ZERO executable tools.",
            },
          ],
        },
        ...authoringSuccessFrames(),
      ],
    ]);
    const client = await createAgentClient(harness.runtime);

    await assert.rejects(
      () => client.runAuthoringPrompt("write a page"),
      (error) => {
        assert.equal(error instanceof AgentInfrastructureError, true);
        const infrastructureError = error as AgentInfrastructureError;
        assert.equal(infrastructureError.code, "NO_TOOLS_AVAILABLE");
        assert.equal(infrastructureError.noToolsAvailable, true);
        return true;
      },
    );
    assert.equal(harness.sessionCreations, 3);
    assert.equal(harness.sessionDeletes, 3);
  });

  it("logs tool warnings without sending them to UI progress in warn policy", async () => {
    const harness = createRuntime([
      [
        {
          event: "run_meta",
          granted_tools: [],
          inherit_host_tools: false,
          warnings: [
            {
              code: "NO_TOOLS_AVAILABLE",
              message: "This agent session resolved ZERO executable tools.",
            },
          ],
        },
        ...authoringSuccessFrames(),
      ],
    ]);
    const events: AgentStreamEvent[] = [];
    const client = await createAgentClient(harness.runtime, {
      toolAccessPolicy: "warn",
    });

    const logs: unknown[] = [];
    const logger = createAiInteractionLogger({ appendWorkspaceLog: async (entry) => { logs.push(entry); } });
    const result = await client.runAuthoringPrompt("write a page", {
      onStreamEvent: (event) => events.push(event),
      logContext: { logger, workspace_dir: "/tmp/workspace", domain: "page_agent", operation: "authoring" },
    });

    assert.equal(result.status, "ready_for_render");
    assert.equal(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.message.includes("Agent tool access warning"),
      ),
      false,
    );
    assert.match(JSON.stringify(logs), /Agent tool access warning/);
    assert.ok(events.some((event) => event.type === "content"));
    assert.equal(harness.sessionCreations, 1);
    assert.equal(harness.sessionDeletes, 1);
  });

  it("ignores run_meta tool access surface in off policy", async () => {
    const harness = createRuntime([
      [
        {
          event: "run_meta",
          granted_tools: [],
          inherit_host_tools: false,
          warnings: [
            {
              code: "NO_TOOLS_AVAILABLE",
              message: "This agent session resolved ZERO executable tools.",
            },
          ],
        },
        ...authoringSuccessFrames(),
      ],
    ]);
    const events: AgentStreamEvent[] = [];
    const client = await createAgentClient(harness.runtime, {
      toolAccessPolicy: "off",
    });

    const result = await client.runAuthoringPrompt("write a page", {
      onStreamEvent: (event) => events.push(event),
    });

    assert.equal(result.status, "ready_for_render");
    assert.equal(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.message.includes("Agent tool access warning"),
      ),
      false,
    );
    assert.equal(harness.sessionCreations, 1);
    assert.equal(harness.sessionDeletes, 1);
  });

  it("recovers a logical Agent run after generic Session errors", async () => {
    const harness = createRuntime([
      sessionErrorFrames(),
      sessionErrorFrames(),
      authoringSuccessFrames(),
    ]);
    const events: AgentStreamEvent[] = [];
    const client = await createAgentClient(harness.runtime);

    const result = await client.runAuthoringPrompt("write a page", {
      onStreamEvent: (event) => events.push(event),
    });

    assert.equal(result.status, "ready_for_render");
    assert.equal(result.fresh_session_retries, 2);
    assert.equal(harness.sessionCreations, 3);
    assert.equal(harness.sessionDeletes, 3);
    assert.equal(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.message.includes("creating a fresh session (1/2)"),
      ),
      true,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.message.includes("creating a fresh session (2/2)"),
      ),
      true,
    );
  });

  it("surfaces the generic infrastructure error after Session retry exhaustion", async () => {
    const harness = createRuntime([
      sessionErrorFrames(),
      sessionErrorFrames(),
      sessionErrorFrames(),
    ]);
    const client = await createAgentClient(harness.runtime);

    await assert.rejects(
      () => client.runAuthoringPrompt("write a page"),
      (error) => {
        assert.equal(error instanceof AgentInfrastructureError, true);
        const infrastructureError = error as AgentInfrastructureError;
        assert.match(infrastructureError.message, /no cached app_session token/);
        return true;
      },
    );
    assert.equal(harness.sessionCreations, 3);
    assert.equal(harness.sessionDeletes, 3);
  });

  it("rebuilds one session after stream idle timeout and then succeeds", async () => {
    const harness = createRuntimeFromStreams([
      async function* () {
        await new Promise(() => undefined);
      },
      async function* () {
        for (const frame of authoringSuccessFrames()) yield frame;
      },
    ]);
    const events: AgentStreamEvent[] = [];
    const client = await createAgentClient(harness.runtime, {
      streamIdleTimeoutMs: 5,
    });

    const result = await client.runAuthoringPrompt("write a page", {
      onStreamEvent: (event) => events.push(event),
    });

    assert.equal(result.status, "ready_for_render");
    assert.equal(harness.sessionCreations, 2);
    assert.equal(harness.sessionDeletes, 2);
    assert.equal(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.message.includes("creating a fresh session"),
      ),
      true,
    );
  });

  it("throws AgentInfrastructureError when stream idle retry is exhausted", async () => {
    const harness = createRuntimeFromStreams([
      async function* () {
        await new Promise(() => undefined);
      },
      async function* () {
        await new Promise(() => undefined);
      },
    ]);
    const client = await createAgentClient(harness.runtime, {
      streamIdleTimeoutMs: 5,
    });

    await assert.rejects(
      () => client.runAuthoringPrompt("write a page"),
      (error) => {
        assert.equal(error instanceof AgentInfrastructureError, true);
        assert.equal((error as AgentInfrastructureError).code, "idle_timeout");
        return true;
      },
    );
    assert.equal(harness.sessionCreations, 3);
    assert.equal(harness.sessionDeletes, 3);
  });

  it("maps cancellation to AgentRunCancelledError and deletes the session", async () => {
    const harness = createRuntimeFromStreams([
      async function* () {
        await new Promise(() => undefined);
      },
    ]);
    const controller = new AbortController();
    const client = await createAgentClient(harness.runtime, {
      streamIdleTimeoutMs: 100,
    });
    const result = client.runAuthoringPrompt("write a page", {
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(
      () => result,
      (error) => {
        assert.equal(isAgentRunCancelledError(error), true);
        return true;
      },
    );
    assert.equal(harness.sessionDeletes, 1);
  });

});

describe("Agent run completion semantics", () => {
  it("finishes from the real task_complete payload without waiting for transport closure", async () => {
    let returned = 0;
    let nextCalls = 0;
    const fixture = createRuntimeFromStreams([() => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          nextCalls += 1;
          if (nextCalls === 1) return { done: false, value: { event: "sse", choices: [{ delta: {
            content: '{"title":"done"}',
            task_complete: { status: "completed", task_id: "task-1", token_usage: { total_tokens: 42 } },
          } }] } };
          return new Promise(() => {});
        },
        return: () => { returned += 1; return new Promise(() => {}); },
      }),
    })]);
    const events: AgentStreamEvent[] = [];
    const client = await createAgentClient(fixture.runtime, { streamIdleTimeoutMs: 5 });
    const result = await client.runStructuredPrompt("test", (value) => value, { onStreamEvent: (event) => events.push(event) });
    assert.deepEqual(result, { title: "done" });
    assert.equal(nextCalls, 1);
    assert.equal(returned, 1);
    assert.equal(fixture.sessionCreations, 1);
    assert.deepEqual(events.at(-1), { type: "complete", usage: { total_tokens: 42 } });
  });

  for (const complete of [{}, { status: "running" }, { status: "failed" }, { status: "cancelled" }]) {
    it(`does not treat task_complete ${JSON.stringify(complete)} or choice.finish_reason as run success`, async () => {
      const fixture = createRuntime([[{
        event: "sse", choices: [{ delta: { content: '{"title":', task_complete: complete }, finish_reason: "stop" }],
      }, {
        event: "sse", choices: [{ delta: { tool_start: { name: "test", input: {} } } }],
      }, {
        event: "sse", choices: [{ delta: { content: '"done"}', task_complete: { status: "completed" } } }],
      }]]);
      const client = await createAgentClient(fixture.runtime);
      assert.deepEqual(await client.runStructuredPrompt("test", (value) => value), { title: "done" });
      assert.equal(fixture.sessionCreations, 1);
    });
  }

  for (const frame of [
    { event: "complete", text: '{"title":"done"}', error: "same-frame error", code: "failure" },
    { event: "sse", choices: [{ delta: { content: '{"title":"done"}', task_complete: { status: "completed" }, error: { message: "same-frame error" } } }] },
  ]) it("does not allow completion to hide a same-frame error", async () => {
    const fixture = createRuntime([[frame]]);
    const client = await createAgentClient(fixture.runtime);
    await assert.rejects(client.runStructuredPrompt("test", (value) => value), /same-frame error/);
    assert.equal(fixture.sessionCreations, 3);
  });

  for (const event of ["complete", "message"]) it(`keeps same-frame text for ${event} and natural exhaustion`, async () => {
    const fixture = createRuntime([[{ event, text: '{"title":"done"}' }]]);
    const client = await createAgentClient(fixture.runtime);
    assert.deepEqual(await client.runStructuredPrompt("test", (value) => value), { title: "done" });
  });
});


it("still repairs invalid business output in the same session after task completion", async () => {
  let runs = 0;
  let sessions = 0;
  const runtime: AnnaRuntime = {
    tools: { invoke: async () => ({}) }, llm: { complete: async () => ({}) },
    agent: { session: async () => {
      sessions += 1;
      return {
        run: () => (async function* () {
          runs += 1;
          yield { event: "sse", choices: [{ delta: {
            content: runs === 1 ? "not json" : '{"title":"valid"}',
            task_complete: { status: "completed" },
          } }] };
          await new Promise(() => {});
        })(),
        delete: async () => undefined,
      };
    } },
  };
  const client = await createAgentClient(runtime, { streamIdleTimeoutMs: 5 });
  assert.deepEqual(await client.runStructuredPrompt("test", (value) => value), { title: "valid" });
  assert.equal(sessions, 1);
  assert.equal(runs, 2);
});
