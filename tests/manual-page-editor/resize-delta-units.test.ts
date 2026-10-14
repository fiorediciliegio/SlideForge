import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SHELL = join(here, "../../src/features/manual-page-editor/ManualPageEditorShell.tsx");

describe("manual editor moveable delta units", () => {
  it("writes Moveable deltas without re-scaling by the fit zoom", async () => {
    const shell = await readFile(SHELL, "utf8");

    // Moveable renders inside the editor iframe; the fit-zoom transform lives
    // on the iframe wrapper in the parent document, so its deltas are already
    // iframe-document pixels. Dividing them by the fit scale amplified every
    // style write by 1/scale and, through Moveable's fixed-edge drag
    // compensation, diverged once the min-size clamp engaged: the element's
    // top ran away by ~1.8x per pointermove and flew out of the slide.
    const onDrag = shell.slice(shell.indexOf("onDrag={"), shell.indexOf("onDragEnd="));
    assert.doesNotMatch(onDrag, /canvasDistance\(event\.dist, scale\)/);
    assert.match(onDrag, /const dx = event\.dist\[0\];/);

    const onResize = shell.slice(shell.indexOf("onResize={"), shell.indexOf("onResizeEnd="));
    assert.doesNotMatch(onResize, /canvasDistance\(resizeDistance, scale\)/);
    assert.doesNotMatch(onResize, /canvasDistance\(dragDistance, scale\)/);
    assert.match(onResize, /const dw = resizeDistance\[0\];/);
    assert.match(onResize, /const dx = dragDistance\[0\];/);

    // The element's own ancestor scale (rotated/scaled groups) still has to be
    // divided out of the offsets written to style.left/top.
    assert.match(onResize, /gesture\.startWidth \+ dw \/ gesture\.localScale\.x/);
    assert.match(onResize, /gesture\.startTop \+ dy \/ gesture\.localScale\.y/);
  });
});
