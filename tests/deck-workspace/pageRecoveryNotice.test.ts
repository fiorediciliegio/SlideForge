import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { PageRecoveryNotice } from "../../src/features/deck-workspace/components/PageRecoveryNotice.tsx";
import { messages } from "../../src/i18n/messages.ts";
import { withOrdinaryInvokeTransport } from "../helpers/invokeRuntime.ts";

test("恢复确认的失败保护、去重及晚到结果", async (t) => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.HTMLElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute("open"); };
  window.__BUNDLED_TOOL_IDS__ = { "ppt-engine": "test-engine" };
  let invoke: (input: any) => Promise<any>;
  window.HostAppRuntime = { connect: async () => ({ tools: { invoke: withOrdinaryInvokeTransport(async (input) => {
    if (input.method === "app_run_workspace_snapshot_publish_dedicated_invoke") return { success: true, data: { status: "completed" } };
    if (input.method === "app_append_workspace_log") return { success: true, data: { appended: true } };
    return { success: true, data: await invoke(input) };
  }) } }) as any };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const restored: string[] = [];
  let parentClicks = 0;
  const option = (id: string, token = "a") => ({ workspace_dir: "/notice", page_id: id,
    available: true, source: "saved_snapshot", recovery_token: token.repeat(64) });
  const render = (id: string) => act(async () => root.render(createElement("div", { onClick: () => { parentClicks++; } },
    createElement(PageRecoveryNotice, { key: id, workspaceDir: "/notice", pageId: id, versionKey: `notice/${id}`,
      title: id, t: messages.zh, retry: () => undefined, retrying: false,
      onRestored: (value) => { restored.push(value.page_id); },
    }))));
  const click = (id: string) => act(async () => {
    host.querySelector(`[data-performance-id="preview.recovery.${id}"]`)!.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  try {
    await t.test("冲突不重放写请求，重新打开时获取新令牌，连点只提交一次", async () => {
      let reads = 0;
      let writes = 0;
      let resolve!: (value: unknown) => void;
      invoke = async (input) => {
        if (input.method === "app_prepare_page_recovery") return option("conflict", ++reads === 1 ? "a" : "b");
        assert.equal(input.method, "app_restore_page_source_version");
        writes++;
        if (writes === 1) throw new Error("PAGE_RECOVERY_CONFLICT");
        assert.equal(input.args.recovery_token, "b".repeat(64));
        return new Promise((done) => { resolve = done; });
      };
      await render("conflict");
      await click("confirm");
      assert.equal(writes, 1);
      assert.equal(host.querySelector("dialog"), null);
      assert.ok(host.textContent?.includes(messages.zh.review.previewRecoveryConflict));
      await click("open");
      assert.equal(reads, 2);
      await click("confirm");
      await click("confirm");
      assert.equal(writes, 2);
      assert.equal(host.querySelector<HTMLButtonElement>('[data-performance-id="preview.recovery.cancel"]')!.disabled, true);
      await act(async () => { resolve({ workspace_dir: "/notice", page_id: "conflict", restored: true }); });
      assert.deepEqual(restored, ["conflict"]);
      assert.equal(parentClicks, 0, "dialog actions must not turn presentation pages");
    });
    await t.test("传输失败不会重复提交，保留重试与恢复入口", async () => {
      let writes = 0;
      invoke = async (input) => {
        if (input.method === "app_prepare_page_recovery") return option("failure");
        writes++; throw new Error("Network unavailable");
      };
      await render("failure");
      await click("confirm");
      assert.equal(writes, 1);
      assert.ok(host.textContent?.includes(messages.zh.review.previewRecoveryFailed));
      assert.ok(host.querySelector('[data-performance-id="preview.recovery.open"]'));
      assert.equal(restored.length, 1);
    });
    await t.test("没有可编辑内容时只保留重试，不提供确认覆盖", async () => {
      invoke = async (input) => ({ ...option(input.args.page_id), available: false,
        source: undefined, recovery_token: undefined });
      await render("unavailable");
      assert.equal(host.querySelector("dialog"), null);
      assert.ok(host.textContent?.includes(messages.zh.review.previewRecoveryUnavailable));
      assert.equal(host.querySelector<HTMLButtonElement>('[data-performance-id="preview.recovery.open"]')!.disabled, true);
    });
    await t.test("切页后旧查询结果不弹窗，旧确认成功仍通知正确页面", async () => {
      let resolveOld!: (value: unknown) => void;
      invoke = async (input) => input.args.page_id === "late-query"
        ? new Promise((resolve) => { resolveOld = resolve; })
        : { ...option(input.args.page_id), available: false };
      await render("late-query");
      await render("new-page");
      await act(async () => { resolveOld(option("late-query")); });
      assert.equal(host.querySelector("dialog"), null);
      assert.ok(host.textContent?.includes("new-page"));
      let resolveWrite!: (value: unknown) => void;
      invoke = async (input) => input.method === "app_prepare_page_recovery" ? option(input.args.page_id)
        : new Promise((resolve) => { resolveWrite = resolve; });
      await render("late-write");
      await click("confirm");
      await render("destination");
      await act(async () => { resolveWrite({ workspace_dir: "/notice", page_id: "late-write", restored: true }); });
      assert.deepEqual(restored, ["conflict", "late-write"]);
      assert.ok(host.textContent?.includes("destination"));
    });
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
