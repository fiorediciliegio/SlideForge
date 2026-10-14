import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SHELL = join(here, "../../src/features/manual-page-editor/ManualPageEditorShell.tsx");

describe("manual editor resize minimum size", () => {
  it("aligns Moveable's internal size floor with the shell's style clamp", async () => {
    const shell = await readFile(SHELL, "utf8");

    // One shared floor constant drives both sides of the resize gesture.
    assert.match(shell, /const RESIZE_MIN_SIZE_PX = 16;/);

    // Moveable clamps its own bounding size at 0 by default; the gesture start
    // must install the same floor so its control box never collapses to zero
    // while the shell keeps writing 16px styles (the "box disappears" bug).
    const resizeStart = shell.slice(
      shell.indexOf("onResizeStart="),
      shell.indexOf("onResize={", shell.indexOf("onResizeStart=")),
    );
    assert.match(resizeStart, /event\.setMin\(\[RESIZE_MIN_SIZE_PX, RESIZE_MIN_SIZE_PX\]\)/);

    // The style-writing side clamps width/height with the same constant, so
    // both halves of the gesture stop at the identical edge.
    const resize = shell.slice(shell.indexOf("onResize={"), shell.indexOf("onResizeEnd="));
    assert.match(resize, /Math\.max\(RESIZE_MIN_SIZE_PX, gesture\.startWidth/);
    assert.match(resize, /Math\.max\(RESIZE_MIN_SIZE_PX, gesture\.startHeight/);
  });
});
