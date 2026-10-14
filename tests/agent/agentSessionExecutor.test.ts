import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentSessionExecutionError,
  AgentSessionResponseValidationError,
  executeAgentSession,
  type AgentSessionHandle,
} from "../../src/agent/agentSessionExecutor.ts";

function handle(
  run: AgentSessionHandle["run"],
  close: AgentSessionHandle["close"] = async () => undefined,
): AgentSessionHandle {
  return { run, close };
}

describe("executeAgentSession", () => {
  it("keeps response repair in the same Session", async () => {
    const prompts: string[] = [];
    let created = 0;
    let closed = 0;
    const result = await executeAgentSession({
      initialPrompt: "原始请求",
      createSession: async () => {
        created += 1;
        return handle(async (prompt) => {
          prompts.push(prompt);
          return prompts.length === 1 ? "invalid" : '{"ok":true}';
        }, async () => {
          closed += 1;
        });
      },
      accept: (rawText) => {
        if (rawText !== '{"ok":true}') throw new Error("JSON 无效");
        return rawText;
      },
      buildSameSessionRepairPrompt: () => "请只返回 JSON",
    });

    assert.equal(result.value, '{"ok":true}');
    assert.equal(created, 1);
    assert.equal(closed, 1);
    assert.deepEqual(prompts, ["原始请求", "请只返回 JSON"]);
    assert.equal(result.sameSessionRetries, 1);
    assert.equal(result.freshSessionRetries, 0);
    assert.deepEqual(result.attempts.map((attempt) => attempt.retry_mode), ["initial", "same_session"]);
  });

  it("does not add a fresh retry after same-Session validation retries are exhausted", async () => {
    let created = 0;
    await assert.rejects(
      () => executeAgentSession({
        initialPrompt: "原始请求",
        createSession: async () => {
          created += 1;
          return handle(async () => "invalid");
        },
        accept: () => {
          throw new Error("JSON 无效");
        },
        buildSameSessionRepairPrompt: () => "请修复",
      }),
      (error) => {
        assert.equal(error instanceof AgentSessionResponseValidationError, true);
        assert.deepEqual(
          (error as AgentSessionResponseValidationError).attempts.map((attempt) => attempt.status),
          ["retry", "retry", "error"],
        );
        return true;
      },
    );

    assert.equal(created, 1);
  });

  it("replays only the initial prompt in a fresh Session after execution errors", async () => {
    const prompts: string[] = [];
    const sessionIds: number[] = [];
    let created = 0;
    let closed = 0;
    const result = await executeAgentSession({
      initialPrompt: "原始请求",
      createSession: async () => {
        const id = created;
        created += 1;
        sessionIds.push(id);
        return handle(async (prompt) => {
          prompts.push(prompt);
          if (id < 2) throw new Error(`Session ${id} 失败`);
          return "ok";
        }, async () => {
          closed += 1;
        });
      },
      accept: (rawText) => rawText,
    });

    assert.equal(result.value, "ok");
    assert.deepEqual(sessionIds, [0, 1, 2]);
    assert.deepEqual(prompts, ["原始请求", "原始请求", "原始请求"]);
    assert.equal(created, 3);
    assert.equal(closed, 3);
    assert.equal(result.sameSessionRetries, 0);
    assert.equal(result.freshSessionRetries, 2);
    assert.deepEqual(result.attempts.map((attempt) => attempt.retry_mode), ["initial", "fresh_session", "fresh_session"]);
  });

  it("does not retry cancellation", async () => {
    let created = 0;
    await assert.rejects(
      () => executeAgentSession({
        initialPrompt: "原始请求",
        createSession: async () => {
          created += 1;
          return handle(async () => { throw new Error("cancelled"); });
        },
        accept: (rawText) => rawText,
        isCancellationError: (error) => error instanceof Error && error.message === "cancelled",
      }),
      /cancelled/,
    );
    assert.equal(created, 1);
  });

  it("counts Session creation failures in the shared fresh retry budget", async () => {
    let createAttempts = 0;
    const result = await executeAgentSession({
      initialPrompt: "原始请求",
      createSession: async () => {
        createAttempts += 1;
        if (createAttempts < 3) throw new Error("create failed");
        return handle(async () => "ok");
      },
      accept: (rawText) => rawText,
    });

    assert.equal(result.value, "ok");
    assert.equal(createAttempts, 3);
    assert.equal(result.freshSessionRetries, 2);
    assert.equal(result.attempts.length, 3);
    assert.equal(result.logicalAttempts, 1);
  });

  it("surfaces the last Session error after the fresh retry budget is exhausted", async () => {
    let created = 0;
    await assert.rejects(
      () => executeAgentSession({
        initialPrompt: "原始请求",
        createSession: async () => {
          created += 1;
          return handle(async () => { throw new Error(`失败 ${created}`); });
        },
        accept: (rawText) => rawText,
      }),
      (error) => {
        assert.equal(error instanceof AgentSessionExecutionError, true);
        const executionError = error as AgentSessionExecutionError;
        assert.match(executionError.message, /失败 3/);
        assert.equal(executionError.attempts.length, 3);
        return true;
      },
    );
    assert.equal(created, 3);
  });
});
