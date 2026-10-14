import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const SHELL = "src/features/manual-page-editor/ManualPageEditorShell.tsx";
const TEXT_OPS = "src/features/manual-page-editor/manualPageEditorText.ts";

async function sourceOf(file: string): Promise<string> {
  return readFile(path.resolve(file), "utf8");
}

describe("manual page editor text editing fixes", () => {
  it("applies font size to the whole subtree, not just the selected box", async () => {
    const shell = await sourceOf(SHELL);
    const textOps = await sourceOf(TEXT_OPS);

    // The select no longer writes a lone inline style that descendant class
    // rules simply override.
    assert.match(shell, /onChange=\{\(event\) => applyFontSize\(Number\(event\.target\.value\)\)\}/);
    assert.doesNotMatch(shell, /applyTextStyle\("fontSize"/);
    assert.match(shell, /applyProportionalFontSize\(selected, iframeDocument\.defaultView, sizePx\)/);
    // Descendants carrying their own font-size scale proportionally, measured
    // before any mutation so inheritance stays intact.
    assert.match(textOps, /export function applyProportionalFontSize/);
    assert.match(textOps, /before\.set\(element, computedFontSize\(view, element\)\)/);
    assert.match(textOps, /element\.style\.fontSize = `\$\{roundTenth/);
    // The toolbar readout and the scaling base both anchor on the box's
    // representative (dominant) text size, so the picked size is what the
    // main text becomes.
    assert.match(textOps, /export function representativeFontSize/);
    assert.match(textOps, /const base = representativeFontSize\(root, view\)/);
    assert.match(shell, /representativeFontSize\(selected, iframeDocument\.defaultView\)/);
    // SVG chart text is left to the SVG editing path.
    assert.match(textOps, /!isSvgElement\(element\)/);
  });

  it("lifts the box out of flow before font and spacing changes", async () => {
    const shell = await sourceOf(SHELL);

    for (const handler of ["applyFontSize", "applyLineHeight", "applyParagraphSpacing"]) {
      const start = shell.indexOf(`const ${handler} = `);
      assert.ok(start >= 0, `${handler} exists`);
      const body = shell.slice(start, shell.indexOf("};", start));
      const mutation = body.indexOf("markMutation()");
      const promotion = body.indexOf("promoteToAbsolute(selected)");
      assert.ok(mutation >= 0 && promotion > mutation, `${handler} promotes after snapshotting`);
    }
  });

  it("makes line height and paragraph spacing reach the text inside the box", async () => {
    const textOps = await sourceOf(TEXT_OPS);
    const shell = await sourceOf(SHELL);

    // Unitless line height is written across the subtree so class-level
    // line-height rules can no longer mask the toolbar control.
    assert.match(textOps, /export function applyInheritedLineHeight/);
    assert.match(textOps, /element\.style\.lineHeight = value/);
    // Space after targets paragraph blocks inside the box, and a
    // single-paragraph box gets perceivable padding instead of a dead margin.
    assert.match(textOps, /export function applySpaceAfter/);
    assert.match(textOps, /paragraph\.style\.marginBottom = `\$\{spacePx\}px`/);
    assert.match(textOps, /root\.style\.paddingBottom = `\$\{spacePx\}px`/);
    // The toolbar readout tracks the paragraph margin that will be rewritten,
    // with the current value merged into the options.
    assert.match(textOps, /export function currentSpaceAfter/);
    // Read-back must come from the same place the write went: the single
    // paragraph path writes paddingBottom on the box, so reading marginBottom
    // there would snap the toolbar back to 0 (the "bounce" bug).
    assert.match(textOps, /getComputedStyle\(root\)\.paddingBottom/);
    assert.match(textOps, /getComputedStyle\(paragraphs\[0\]\)\.marginBottom/);
    assert.match(shell, /currentSpaceAfter\(selected, iframeDocument\.defaultView\)/);
    assert.match(shell, /paragraphSpacingOptions\.map/);
  });
});

describe("manual page editor resize baseline", () => {
  it("captures the resize baseline at gesture start", async () => {
    const shell = await sourceOf(SHELL);

    const start = shell.indexOf("onResizeStart={(event) => {");
    assert.ok(start >= 0, "onResizeStart reads the event target");
    const body = shell.slice(start, shell.indexOf("moved: false,", start));
    assert.ok(body.includes("capturePromotionRollback(target)"), "resize promotes immediately");
    assert.ok(body.includes("startLeft: Number.parseFloat(target.style.left"), "resize captures position");
    assert.ok(body.includes("startWidth: target.offsetWidth"), "resize captures size");
    assert.ok(body.includes("measureLocalScale(target)"), "resize captures scale");
    // The history snapshot is taken before the promotion rewrites the box.
    assert.ok(body.indexOf("serializeDocument") < body.indexOf("capturePromotionRollback"));
  });

  it("no longer captures the resize baseline lazily after the drag threshold", async () => {
    const shell = await sourceOf(SHELL);

    const onResize = shell.indexOf("onResize={(event) => {");
    const onResizeEnd = shell.indexOf("onResizeEnd=()", onResize);
    const body = shell.slice(onResize, onResizeEnd);
    assert.doesNotMatch(body, /promoteToAbsolute/);
  });

  it("rolls back the promotion when a resize gesture never moved", async () => {
    const shell = await sourceOf(SHELL);

    const start = shell.indexOf("onResizeEnd={() => {");
    assert.ok(start >= 0, "onResizeEnd exists");
    const body = shell.slice(start, start + 400);
    assert.ok(body.includes("gesture?.rollback()"), "resize end rolls back unmoved gestures");
    assert.ok(body.indexOf("rollback") > body.indexOf("markMutation"), "rollback only when unmoved");
    assert.match(shell, /function capturePromotionRollback\(element: HTMLElement\)/);
    assert.match(shell, /element\.style\.cssText = cssText/);
    assert.match(shell, /placeholder\.remove\(\)/);
  });
});
