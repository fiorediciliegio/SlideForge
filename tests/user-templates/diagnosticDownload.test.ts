import assert from "node:assert/strict";
import test from "node:test";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useTemplateDiagnosticBundle } from "../../src/features/user-templates/useTemplateDiagnosticBundle.ts";
import type { PptBackend } from "../../src/api/pptBackend.ts";
import type { PrepareWorkspaceDiagnosticBundleResult } from "../../src/api/types.ts";
import { messages } from "../../src/i18n/messages.ts";

test("switching templates ignores stale preparation and always downloads the selected owner", async () => {
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const calls: string[] = [], downloads: string[] = [];
  const resolvers = new Map<string, (result: PrepareWorkspaceDiagnosticBundleResult) => void>();
  const backend = { prepareUserTemplateDiagnosticBundle: ({ id }: { id: string }) => {
    calls.push(id);
    return new Promise<PrepareWorkspaceDiagnosticBundleResult>((resolve) => resolvers.set(id, resolve));
  } } as PptBackend;
  let model: ReturnType<typeof useTemplateDiagnosticBundle>;
  function Harness({ id, enabled = true }: { id: string; enabled?: boolean }) {
    model = useTemplateDiagnosticBundle({ backend, templateId: id, enabled, t: messages.zh,
      hostDownload: { download: async ({ path }) => { downloads.push(path); return "downloaded"; } },
    });
    return null;
  }
  const result = (id: string): PrepareWorkspaceDiagnosticBundleResult => ({ status: "ready", workspace_id: id, filename: `${id}.zip`, size_bytes: 1, download_url: `https://example.test/${id}`, expires_at: null, mirror: { path: `user-templates/${id}/diagnostics/current-template.zip` } });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness, { id: "A" })));
    let first!: Promise<void>;
    await act(async () => { first = model.download(); });
    await act(async () => root.render(createElement(Harness, { id: "B" })));
    await act(async () => { resolvers.get("A")!(result("A")); await first; });
    assert.deepEqual(downloads, []);
    assert.equal(model!.state.status, "idle");
    let second!: Promise<void>;
    await act(async () => { second = model.download(); });
    await act(async () => { resolvers.get("B")!(result("B")); await second; });
    assert.deepEqual(calls, ["A", "B"]);
    assert.deepEqual(downloads, ["user-templates/B/diagnostics/current-template.zip"]);
    assert.equal(model!.state.workspaceId, "B");
    assert.equal(model!.state.href, undefined);
    // Host success must rebuild on the next click, not silently reuse an old URL.
    let third!: Promise<void>;
    await act(async () => { third = model.download(); });
    assert.deepEqual(calls, ["A", "B", "B"]);
    await act(async () => root.render(createElement(Harness, { id: "B", enabled: false })));
    await act(async () => { resolvers.get("B")!(result("B")); await third; });
    assert.equal(downloads.length, 1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
