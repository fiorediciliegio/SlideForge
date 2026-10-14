import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SHELL = join(here, "../../src/features/manual-page-editor/ManualPageEditorShell.tsx");
import { messages } from "../../src/i18n/index";

async function sourceOf(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("manual page editor move handle (drag entry)", () => {
  it("renders an explicit move grip pinned to the selection frame", async () => {
    const shell = await sourceOf(SHELL);

    // The grip is an editor artifact: it must carry the editor class so
    // serializeDocument strips it from saves and undo snapshots.
    assert.match(shell, /manual-editor-move-handle/);
    assert.match(shell, /\$\{MOVEABLE_EDITOR_CLASS\} manual-editor-move-handle/);
    // Affordance: grab cursor, accessible label, and a pointer-down gesture.
    assert.match(shell, /cursor: "grab"/);
    assert.match(shell, /aria-label=\{t\.moveElement\}/);
    assert.match(shell, /onPointerDown=\{startHandleMove\}/);
    // The grip is counter-scaled (1/scale) so it stays usable at fit-to-window.
    assert.match(shell, /Math\.round\(22 \/ scale\)/);
  });

  it("moves with the same snapshot/promote/rollback discipline as Moveable drags", async () => {
    const shell = await sourceOf(SHELL);

    const start = shell.indexOf("const startHandleMove = ");
    assert.ok(start >= 0, "startHandleMove exists");
    const body = shell.slice(start, shell.indexOf("view.addEventListener(\"pointerup\"", start));

    // History snapshot precedes the promotion rewrite, a gesture that never
    // crosses the threshold rolls back, and a real move records history.
    assert.ok(body.indexOf("serializeDocument") < body.indexOf("capturePromotionRollback"), "snapshot before promote");
    assert.match(body, /if \(moved\) markMutation\(before\);\s*else rollback\(\);/);
    // Pointer deltas are canvas units already — no stage-scale division here.
    assert.match(body, /startLeft \+ dx \/ localScale\.x/);
    assert.ok(!body.includes("canvasDistance(dx"), "no double scale compensation");
    // The doc-level selection listeners must ignore the grip.
    assert.match(body, /event\.stopPropagation\(\)/);
    // The selection outline must follow the box: the handle path mutates the
    // target behind Moveable's back, so it re-syncs the frame explicitly.
    assert.match(shell, /moveableRef\.current\?\.updateRect\(\)/);
    assert.match(shell, /<Moveable\s+ref=\{moveableRef\}/);
  });

  it("tracks the frame while Moveable gestures mutate the DOM", async () => {
    const shell = await sourceOf(SHELL);
    assert.match(shell, /frameTick/);
    const dragStart = shell.indexOf("onDrag={(event) => {");
    const dragEnd = shell.indexOf("onDragEnd", dragStart);
    assert.ok(shell.slice(dragStart, dragEnd).includes("setFrameTick"), "handle follows body drags");
    const resizeStart = shell.indexOf("onResize={(event) => {");
    const resizeEnd = shell.indexOf("onResizeEnd", resizeStart);
    assert.ok(shell.slice(resizeStart, resizeEnd).includes("setFrameTick"), "handle follows resizes");
  });

  it("has localized affordance text", async () => {
    assert.equal(messages.en.manualEditor.moveElement, "Drag to move");
    assert.equal(messages.zh.manualEditor.moveElement, "拖动移动");
    assert.equal(messages.ja.manualEditor.moveElement, "ドラッグで移動");
    assert.equal(messages.de.manualEditor.moveElement, "Zum Verschieben ziehen");
  });
});
