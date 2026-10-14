import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

describe("attachment upload limits", () => {
  it("rejects an over-limit selection before starting any host upload", async () => {
    const source = await readFile(
      path.resolve("src/features/deck-workspace/components/BriefPage.tsx"),
      "utf8",
    );
    const selectionStart = source.indexOf("async function handleAttachmentSelection");
    const selectionEnd = source.indexOf("async function submitBrief", selectionStart);
    assert.notEqual(selectionStart, -1);
    assert.notEqual(selectionEnd, -1);
    const selectionSource = source.slice(selectionStart, selectionEnd);

    assert.match(source, /ATTACHMENT_SINGLE_FILE_MAX_BYTES = 25 \* 1024 \* 1024/);
    assert.match(source, /ATTACHMENT_TOTAL_MAX_BYTES = 100 \* 1024 \* 1024/);
    assert.match(selectionSource, /activeAttachmentBytes/);
    assert.match(selectionSource, /ATTACHMENT_TOTAL_MAX_BYTES/);
    assert.ok(
      selectionSource.indexOf("ATTACHMENT_TOTAL_MAX_BYTES") < selectionSource.indexOf("setPendingAttachments"),
      "the total-size guard must run before pending uploads are shown",
    );
  });

  it("uses localised messages instead of surfacing the backend error", async () => {
    const hook = await readFile(
      path.resolve("src/features/deck-workspace/hooks/useDeckWorkspace.ts"),
      "utf8",
    );

    assert.match(hook, /showToast\(t\.toasts\.attachmentUploadFailed\);/);
  });
});
