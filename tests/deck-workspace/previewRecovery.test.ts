import assert from "node:assert/strict";
import { test } from "node:test";
import type { GetWorkspacePageHtmlInput, WorkspacePageHtml } from "../../src/api/pageHtmlPreview";
import { beginPageRecovery, dismissRecoveryPrompt, recoveryPromptDismissed, loadPagePreviewWithRecovery, waitForPagePreviewPreparation } from "../../src/features/deck-workspace/previewRecovery";
import { loadCachedPageHtml } from "../../src/features/deck-workspace/pageHtmlPreviewCache";

const value = (patch: Partial<WorkspacePageHtml> = {}): WorkspacePageHtml => ({ page_id: "page-a",
  html: "<html><body>saved page</body></html>", html_fingerprint: "html", preview_source_fingerprint: "v2",
  resources_expires_at: null, ...patch });
function backend(read: (input: GetWorkspacePageHtmlInput) => Promise<WorkspacePageHtml>) {
  const logs: Array<Record<string, unknown>> = [];
  const calls: GetWorkspacePageHtmlInput[] = [];
  return { logs, calls, getWorkspacePageHtml: (input: GetWorkspacePageHtmlInput) => { calls.push(input); return read(input); },
    prepareWorkspacePagePreview: async (input: { workspace_dir: string; page_id: string }) => ({
      task_id: "task", workspace_dir: input.workspace_dir, page_id: input.page_id,
      status: "ready" as const, input_version: "v1",
    }),
    getWorkspacePagePreviewPreparation: async (input: { workspace_dir: string }) => ({
      task_id: "task", workspace_dir: input.workspace_dir, page_id: "page-a",
      status: "ready" as const, input_version: "v1",
    }),
    appendWorkspaceLog: async (input: { entry: Record<string, unknown> }) => {
      logs.push(input.entry); return { workspace_dir: "", log_file: "", appended: true };
    } };
}

test("版本变化只刷新一次当前页，不把新版本标成备用", async () => {
  const api = backend(async (input) => {
    if (input.expected_preview_fingerprint) throw new Error("Page preview version changed");
    return value();
  });
  const actual = await loadPagePreviewWithRecovery(api, { workspace_dir: "/recovery-version", page_id: "page-a", expected_preview_fingerprint: "v1" });
  assert.equal(actual.preview_source_fingerprint, "v2");
  assert.equal(actual.fallback, undefined);
  assert.equal(api.calls.length, 2);
  assert.equal(api.logs[0].event, "preview.recovered");
});

test("资源过期只重试两次，失败后不自动读取旧版，告警不包含内容", async () => {
  const api = backend(async () => value({ resources_expires_at: "2020-01-01T00:00:00Z" }));
  await assert.rejects(loadPagePreviewWithRecovery(api, { workspace_dir: "/recovery-expired", page_id: "page-a" }), /expired/);
  assert.equal(api.calls.length, 2);
  assert.ok(api.calls.every((input) => !input.fallback_only));
  assert.equal(api.logs[0].event, "preview.failed");
  assert.equal(api.logs[0].error_kind, "resource_unavailable");
  assert.ok(!JSON.stringify(api.logs).includes("<html>"));
});

test("同页缓存不能在用户确认之前成为当前页", async () => {
  await loadCachedPageHtml("same-page", async () => value(), true);
  const api = backend(async () => { throw new Error("Network unavailable"); });
  await assert.rejects(loadPagePreviewWithRecovery(api, { workspace_dir: "/recovery-cache", page_id: "page-a" }), /Network/);
  assert.equal(api.calls.length, 2);
});

test("不响应的请求有等待上限，晚到结果不能替换失败状态", async () => {
  let deliver!: (value: WorkspacePageHtml) => void;
  const api = backend(async () => new Promise((resolve) => { deliver = resolve; }));
  await assert.rejects(loadPagePreviewWithRecovery(api, { workspace_dir: "/recovery-timeout", page_id: "page-a" }, { deadlineMs: 5 }), /timed out/);
  deliver(value({ html: "late" }));
  assert.equal(api.calls.length, 1);
  assert.equal(api.logs[0].event, "preview.failed");
});

test("预览准备排队时轮询状态，完成后才读取页面", async () => {
  const api = backend(async () => value());
  let polls = 0;
  api.prepareWorkspacePagePreview = async (input) => ({ task_id: "task", workspace_dir: input.workspace_dir,
    page_id: input.page_id, status: "queued", input_version: "v1" });
  api.getWorkspacePagePreviewPreparation = async (input) => ({ task_id: "task", workspace_dir: input.workspace_dir,
    page_id: "page-a", status: ++polls === 1 ? "running" : "ready", input_version: "v1" });
  const states: string[] = [];
  await waitForPagePreviewPreparation(api, { workspace_dir: "/queued", page_id: "page-a", priority: "foreground" },
    { onStatus: (status) => states.push(status) });
  assert.deepEqual(states, ["queued", "running", "ready"]);
  assert.equal(api.calls.length, 0);
});

test("页面身份错误不能绕过检查，候选预览也不允许借用正式页", async () => {
  const wrong = backend(async () => value({ page_id: "page-b" }));
  await assert.rejects(loadPagePreviewWithRecovery(wrong, { workspace_dir: "/wrong-id", page_id: "page-a" }), /identity mismatch/);
  assert.equal(wrong.calls.length, 1);
  const candidate = backend(async () => { throw new Error("Page preview version changed"); });
  await assert.rejects(loadPagePreviewWithRecovery(candidate, { workspace_dir: "/candidate", page_id: "page-a", batch_id: "b", candidate_id: "c", expected_preview_fingerprint: "v1" }));
  assert.equal(candidate.calls.length, 2);
  assert.ok(candidate.calls.every((input) => input.expected_preview_fingerprint === "v1" && !input.fallback_only));
});

test("旧版响应不可充当当前页，日志失败不影响正确内容", async () => {
  const wrong = backend(async () => value({ fallback: { source: "saved_snapshot" } }));
  await assert.rejects(loadPagePreviewWithRecovery(wrong, { workspace_dir: "/unmarked", page_id: "page-a" }), /fallback metadata/);
  const api = backend(async () => value());
  api.appendWorkspaceLog = async () => { throw new Error("logging failed"); };
  assert.equal((await loadPagePreviewWithRecovery(api, { workspace_dir: "/logging-error", page_id: "page-a" })).fallback, undefined);
});

test("取消按版本保留，同页恢复不能并发重复提交", () => {
  dismissRecoveryPrompt("workspace/page/v1");
  assert.equal(recoveryPromptDismissed("workspace/page/v1"), true);
  assert.equal(recoveryPromptDismissed("workspace/page/v2"), false);
  const release = beginPageRecovery("workspace", "page");
  assert.ok(release);
  assert.equal(beginPageRecovery("workspace", "page"), null);
  const other = beginPageRecovery("workspace", "other");
  assert.ok(other);
  release(); other();
  beginPageRecovery("workspace", "page")!();
});
