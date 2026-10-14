import assert from "node:assert/strict";
import test from "node:test";

import { createAttachmentBriefCompletionClient } from "../../src/ai/attachmentBriefCompletion";
import type { HostRuntime } from "../../src/runtime/hostRuntime";

test("Attachment Brief reports only the accepted completed response", async () => {
  const received: string[] = [];
  const runtime: HostRuntime = {
    tools: { invoke: async () => ({}) },
    llm: {
      complete: async () => ({ text: '{"progress_summary":"Validated batch finding"}' }),
    },
  };

  const result = await createAttachmentBriefCompletionClient(runtime).complete({
    prompt: "Summarize this batch.",
    accept: (raw) => JSON.parse(raw) as { progress_summary: string },
    onCompletedText: (raw) => received.push(raw),
  });

  assert.equal(result.value.progress_summary, "Validated batch finding");
  assert.deepEqual(received, ['{"progress_summary":"Validated batch finding"}']);
});
