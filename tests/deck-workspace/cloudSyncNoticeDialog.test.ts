import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CloudSyncNoticeDialog } from "../../src/features/deck-workspace/components/CloudSyncNoticeDialog.tsx";
import type { CloudConflictDialogState } from "../../src/features/deck-workspace/types.ts";
import { messages } from "../../src/i18n/messages.ts";

function render(notice: CloudConflictDialogState | null, locale: "en" | "zh" = "en") {
  return renderToStaticMarkup(createElement(CloudSyncNoticeDialog, {
    t: messages[locale],
    notice,
    onDismiss: () => undefined,
  }));
}

describe("CloudSyncNoticeDialog", () => {
  it("renders nothing without a pending notice", () => {
    assert.equal(render(null), "");
  });

  it("explains that the cloud version won after a conflict resolution", () => {
    const html = render({
      status: "conflict_resolved",
      workspaceId: "done",
      backupTitle: "季度复盘(本地副本-20260723-1000)",
    });

    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /Conflicting changes detected/);
    assert.match(html, /季度复盘\(本地副本-20260723-1000\)/);
    assert.match(html, />Got it</);
    assert.match(html, /cloud-sync\.notice\.confirm/);
  });

  it("explains that the conflict is unresolved when the backup copy failed", () => {
    const html = render({
      status: "conflict_blocked",
      workspaceId: "done",
      backupTitle: null,
    }, "zh");

    assert.match(html, /检测到冲突修改/);
    assert.match(html, /冲突未解决，本地内容保持原样/);
    assert.match(html, />知道了</);
  });

  it("keeps the close control dismissible via its dedicated button", () => {
    const html = render({
      status: "conflict_resolved",
      workspaceId: "done",
      backupTitle: null,
    });

    assert.match(html, /cloud-sync\.notice\.close/);
    assert.match(html, /app-confirmation-close/);
  });
});
