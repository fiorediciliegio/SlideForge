import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { createAppHostUploadClient } from "../../src/runtime/appHostUploadClient.ts";
import type { HostRuntime } from "../../src/runtime/hostRuntime.ts";

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as Record<string, unknown>).window;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = originalWindow;
  }
  mock.restoreAll();
});

function runtimeWithUpload(): HostRuntime {
  return {
    tools: {
      invoke: async () => ({}),
    },
    llm: {
      complete: async () => ({}),
    },
    agent: {
      session: async () => {
        throw new Error("not used");
      },
    },
    upload: {
      negotiate: async (input) => ({
        put_url: "https://uploads.example.test/put",
        headers: {
          "Content-Type": input.mime_type,
          "x-upload-token": "token-1",
        },
        r2_key: "r2/key",
        expires_at: "2026-07-09T12:00:00Z",
      }),
      confirm: async ({ r2_key }) => ({
        download_url: "https://uploads.example.test/get",
        r2_key,
        size_bytes: 5,
        expires_at: "2026-07-09T12:30:00Z",
      }),
    },
  };
}

describe("AppHostUploadClient", () => {
  it("routes template upload phases to the template even without a Deck workspace", async () => {
    globalThis.fetch = mock.fn(async () => new Response("", { status: 200 })) as typeof fetch;
    const events: Array<{ user_template_id?: string; workspace_dir: string; entry: Record<string, unknown> }> = [];
    const upload = createAppHostUploadClient(runtimeWithUpload(), { appendWorkspaceLog: async (event) => { events.push(event); } });
    await upload.uploadFile(new File(["hello"], "source.pptx"), { purpose: "user_artifact", metadata: { user_template_id: "user-test", creation_run_id: "run-1", operation_id: "upload-1" } });
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => event.user_template_id === "user-test" && event.workspace_dir === "" && event.entry.creation_run_id === "run-1"));
  });
  it("preserves deterministic errors without starting a relay", async () => {
    const runtime = runtimeWithUpload();
    const error = Object.assign(new Error("permission denied"), { code: -32204, data: { reason: "not granted" } });
    runtime.upload!.negotiate = async () => { throw error; };
    runtime.tools.invoke = async () => { assert.fail("must not relay deterministic failures"); };
    await assert.rejects(createAppHostUploadClient(runtime).uploadFile(new File(["test"], "test.txt"), {
      purpose: "user_artifact", mimeType: "text/plain",
    }), (actual) => actual === error);
  });

  it("fails clearly when runtime upload APIs are missing", async () => {
    const client = createAppHostUploadClient({
      tools: { invoke: async () => ({}) },
      llm: { complete: async () => ({}) },
      agent: {
        session: async () => {
          throw new Error("not used");
        },
      },
    });

    await assert.rejects(
      () => client.uploadFile(new File(["hello"], "source.txt", { type: "text/plain" }), {
        purpose: "user_artifact",
      }),
      /upload\.negotiate\/upload\.confirm is not available/,
    );
  });

  it("uses negotiate headers unchanged for PUT and returns HostUploadRef", async () => {
    const fetchMock = mock.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(url), "https://uploads.example.test/put");
      assert.deepEqual(init?.headers, {
        "Content-Type": "text/plain",
        "x-upload-token": "token-1",
      });
      assert.equal(init?.method, "PUT");
      return new Response("", { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = createAppHostUploadClient(runtimeWithUpload());
    const ref = await client.uploadFile(new File(["hello"], "source.txt", { type: "text/plain" }), {
      purpose: "user_artifact",
    });

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.deepEqual(ref, {
      transport: "host_upload",
      r2_key: "r2/key",
      url: "https://uploads.example.test/get",
      mime_type: "text/plain",
      size_bytes: 5,
      filename: "source.txt",
      expires_at: "2026-07-09T12:30:00Z",
      expires_in: undefined,
      mode: "negotiate+confirm",
    });
  });

  it("records storage phases without leaking signed URLs", async () => {
    globalThis.fetch = mock.fn(async () => new Response("", { status: 200 })) as typeof fetch;
    const events: Array<{ workspace_dir: string; entry: Record<string, unknown> }> = [];
    const client = createAppHostUploadClient(runtimeWithUpload(), {
      appendWorkspaceLog: async (event) => {
        events.push(event);
      },
    });

    await client.uploadFile(new File(["hello"], "source.txt", { type: "text/plain" }), {
      purpose: "user_artifact",
      metadata: {
        workspace_dir: "/tmp/workspace",
        operation_id: "operation-1",
        interaction_id: "interaction-1",
        parent_interaction_id: "parent-interaction-1",
      },
    });

    assert.deepEqual(events.map((event) => event.entry.event), [
      "storage.transfer.started",
      "storage.transfer.negotiate",
      "storage.transfer.put",
      "storage.transfer.confirm",
      "storage.transfer.finished",
    ]);
    assert.equal(events[0].workspace_dir, "/tmp/workspace");
    assert.equal(events[1].entry.r2_key, "r2/key");
    assert.equal((events[1].entry.response as Record<string, unknown>).put_url, "[REDACTED]");
    assert.equal(events[1].entry.operation_id, "operation-1");
    assert.equal(events[1].entry.interaction_id, "interaction-1");
    assert.equal(events[1].entry.parent_interaction_id, "parent-interaction-1");
  });

  it("re-negotiates and re-uploads after a transient PUT failure", async () => {
    let negotiateCalls = 0;
    let confirmCalls = 0;
    const runtime = runtimeWithUpload();
    runtime.upload = {
      ...runtime.upload!,
      negotiate: async (input) => ({
        put_url: "https://uploads.example.test/put",
        headers: { "Content-Type": input.mime_type },
        r2_key: `r2/key-${++negotiateCalls}`,
      }),
      confirm: async ({ r2_key }) => {
        confirmCalls += 1;
        return {
          download_url: "https://uploads.example.test/get",
          r2_key,
          size_bytes: 5,
        };
      },
    };
    let putCalls = 0;
    globalThis.fetch = mock.fn(async () => {
      putCalls += 1;
      return putCalls < 3
        ? new Response("<Code>InternalError</Code>", { status: 500 })
        : new Response("", { status: 200 });
    }) as typeof fetch;
    const events: Array<{ entry: Record<string, unknown> }> = [];
    const client = createAppHostUploadClient(runtime, {
      appendWorkspaceLog: async (event) => {
        events.push(event);
      },
    });

    const ref = await client.uploadFile(new File(["hello"], "source.txt", { type: "text/plain" }), {
      purpose: "user_artifact",
      metadata: { workspace_dir: "/tmp/workspace" },
    });

    assert.equal(ref.r2_key, "r2/key-3");
    assert.equal(negotiateCalls, 3);
    assert.equal(putCalls, 3);
    assert.equal(confirmCalls, 1);
    assert.equal(events.filter((event) => event.entry.event === "storage.transfer.retry").length, 2);
    assert.notEqual(events[0]?.entry.transfer_id, events[6]?.entry.transfer_id);
  });

  it("names the engine relay skip reason when the browser PUT dies (e.g. CORS preflight)", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const client = createAppHostUploadClient(runtimeWithUpload());
    // Node test env has no window.__BUNDLED_TOOL_IDS__, so resolvePptBundledToolIds
    // throws and the relay is skipped with that reason spelled out.
    await assert.rejects(
      () => client.uploadFile(new File(["hello"], "source.txt", { type: "text/plain" }), {
        purpose: "user_artifact",
      }),
      /Host upload failed: Failed to fetch\. ppt-engine relay failed: Missing SlideForge bundled tool id for "ppt-engine"\./,
    );
  });

  it("reports a relay failure when the engine fallback itself throws", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    // Provide the bundled tool id so resolvePptBundledToolIds succeeds and the
    // relay actually reaches runtime.tools.invoke.
    (globalThis as Record<string, unknown>).window = {
      __BUNDLED_TOOL_IDS__: { "ppt-engine": "tool-test-engine" },
    };

    const runtime = runtimeWithUpload();
    runtime.tools = {
      invoke: async () => {
        throw new Error("engine offline");
      },
    };
    const client = createAppHostUploadClient(runtime);
    await assert.rejects(
      () => client.uploadFile(new File(["hello"], "source.txt", { type: "text/plain" }), {
        purpose: "user_artifact",
      }),
      /Host upload failed: Failed to fetch\. ppt-engine relay failed: engine offline\./,
    );
  });
});

