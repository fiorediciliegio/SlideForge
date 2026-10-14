import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyUserFacingError,
  invokeTimeoutSummary,
  isInvokeTimeout,
  isOpaqueErrorDetail,
  summarizeUserFacingError,
} from "../../src/features/deck-workspace/userFacingError.ts";
import { messages } from "../../src/i18n/messages.ts";

describe("classifyUserFacingError", () => {
  it("recognises the artifact transport failure behind the open-work bug", () => {
    assert.equal(
      classifyUserFacingError("Error: r2_key does not belong to this invoke"),
      "transport",
    );
  });

  it("recognises timeouts, missing files and connectivity problems", () => {
    assert.equal(classifyUserFacingError("Request timed out after 60s"), "timeout");
    assert.equal(classifyUserFacingError("ENOENT: no such file or directory"), "notFound");
    assert.equal(classifyUserFacingError("fetch failed"), "network");
    assert.equal(classifyUserFacingError("something odd"), "unknown");
  });
});

describe("isOpaqueErrorDetail", () => {
  it("treats RPC envelopes and stack traces as unfit for display", () => {
    assert.equal(isOpaqueErrorDetail('{"jsonrpc":"2.0","error":{"code":-32000}}'), true);
    assert.equal(isOpaqueErrorDetail("Boom\n    at run (file.ts:1:1)"), true);
    assert.equal(isOpaqueErrorDetail(""), true);
    assert.equal(isOpaqueErrorDetail("Workspace is locked by another run."), false);
  });
});

describe("summarizeUserFacingError", () => {
  it("replaces the RPC envelope with a readable summary but keeps the detail", () => {
    const raw = '{"jsonrpc":"2.0","error":{"code":-32000,"message":"r2_key does not belong to this invoke"}}';

    const { summary, detail } = summarizeUserFacingError(messages.en, new Error(raw));

    assert.equal(summary, messages.en.errors.summaryTransport);
    assert.equal(detail, raw);
  });

  it("falls back to the caller's message when nothing can be classified", () => {
    const { summary } = summarizeUserFacingError(
      messages.zh,
      new Error('{"jsonrpc":"2.0","error":{"code":-1}}'),
      messages.zh.myWork.openFailed,
    );

    assert.equal(summary, messages.zh.myWork.openFailed);
  });

  it("keeps a short human-written backend message as the summary", () => {
    const { summary } = summarizeUserFacingError(messages.en, new Error("Workspace is locked by another run."));

    assert.equal(summary, "Workspace is locked by another run.");
  });
});


describe("工具调用超时提示", () => {
  const raw = "RPC tools.invoke timed out after 70000ms (pass { timeoutMs } as the 2nd arg to override)";

  it("四种语言均显示统一摘要，保留原始技术详情", () => {
    for (const locale of ["zh", "en", "ja", "de"] as const) {
      const t = messages[locale];
      const result = summarizeUserFacingError(t, new Error(raw));
      assert.equal(result.summary, t.errors.summaryInvokeTimeout);
      assert.equal(result.detail, raw);
      assert.equal(invokeTimeoutSummary(t, `上传失败：${raw}`, "上传失败"), t.errors.summaryInvokeTimeout);
    }
  });

  it("不将本地或模型超时、普通工具错误描述为服务器繁忙", () => {
    for (const error of ["Preview timed out", "RPC session.run timed out", "RPC tools.invoke: invalid arguments"]) {
      assert.equal(isInvokeTimeout(error), false);
      assert.equal(invokeTimeoutSummary(messages.zh, error, "原有提示"), "原有提示");
    }
    assert.equal(summarizeUserFacingError(messages.zh, "Preview timed out").summary, messages.zh.errors.summaryTimeout);
  });
});

describe("模型最终失败提示", () => {
  it("四种语言将模型超时和限流显示为服务繁忙，并保留诊断原文", () => {
    for (const raw of [
      "Agent stream idle timeout after 180000ms",
      "Agent run timed out after 600000ms",
      "Agent Session failed after 6 attempts: RPC session.run timed out",
      "Agent request failed: HTTP 429 Too Many Requests",
      "Model rate_limit_exceeded",
    ]) {
      for (const locale of ["zh", "en", "ja", "de"] as const) {
        const t = messages[locale];
        const result = summarizeUserFacingError(t, new Error(raw));
        assert.equal(result.summary, t.errors.summaryModelBusy);
        assert.equal(result.detail, raw);
      }
    }
    assert.equal(messages.zh.errors.summaryModelBusy, "服务暂时繁忙，请稍后重试。");
  });

  it("不改变本地超时、普通会话错误或工具请求超时的分类", () => {
    assert.equal(classifyUserFacingError("Preview timed out"), "timeout");
    assert.equal(classifyUserFacingError("Agent session: no cached app_session token"), "unknown");
    assert.equal(classifyUserFacingError("RPC tools.invoke timed out"), "timeout");
  });
});

describe("额度耗尽提示", () => {
  it("识别 LLM 和 Session 的额度错误，并在四种语言显示专用摘要", () => {
    for (const raw of [
      'transport HTTP 429: {"errorCode":"APP_QUOTA_EXCEEDED","data":{"remainingCu":0.0}}',
      'Agent stream error: Quota exhausted, unable to continue using Anna service.',
      'rpc.stream payload {"error_type":"quota_exhausted"}',
    ]) {
      assert.equal(classifyUserFacingError(raw), "quotaExceeded");
      for (const locale of ["zh", "en", "ja", "de"] as const) {
        const t = messages[locale];
        const result = summarizeUserFacingError(t, new Error(raw));
        assert.equal(result.summary, t.errors.summaryQuotaExceeded);
        assert.equal(result.detail, raw);
        assert.equal(invokeTimeoutSummary(t, raw, "原有提示"), t.errors.summaryQuotaExceeded);
      }
    }
  });

  it("读取结构化 Session 错误码，即使 message 没有额度文字也能识别", () => {
    const error = Object.assign(new Error("Agent session failed."), { code: "quota_exhausted" });
    const result = summarizeUserFacingError(messages.zh, error);
    assert.equal(result.summary, messages.zh.errors.summaryQuotaExceeded);
    assert.equal(result.detail, "Agent session failed.");
  });
});
