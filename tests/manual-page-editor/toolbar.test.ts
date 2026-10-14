import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { messages } from "../../src/i18n/messages";
import { localeIds } from "../../src/i18n/locales";
import { manualToolbarOverflow } from "../../src/features/manual-page-editor/manualToolbarLayout";

const SHELL = "src/features/manual-page-editor/ManualPageEditorShell.tsx";
const STYLES = "src/features/manual-page-editor/manual-page-editor.css";

async function shellSource(): Promise<string> {
  return readFile(path.resolve(SHELL), "utf8");
}

describe("manual page editor toolbar", () => {
  it("reads the page canvas from persisted HTML metadata", async () => {
    const source = await shellSource();

    assert.match(source, /width: SLIDE_WIDTH, height: SLIDE_HEIGHT.*slideFormatFromHtml\(html\)/);
    assert.doesNotMatch(source, /width: 1280/);
    assert.doesNotMatch(source, /height: 720/);
  });

  it("no longer offers an opacity control", async () => {
    const source = await shellSource();
    const styles = await readFile(path.resolve(STYLES), "utf8");

    assert.doesNotMatch(source, /style\.opacity/);
    assert.doesNotMatch(source, /"opacity"/);
    assert.doesNotMatch(styles, /manual-toolbar-popover\.opacity/);
    for (const locale of localeIds) {
      assert.ok(!("opacity" in messages[locale].manualEditor));
    }
  });

  it("keeps line height and space after together in the spacing panel", async () => {
    const source = await shellSource();

    assert.doesNotMatch(source, /togglePopover\("paragraph"\)/);
    assert.match(
      source,
      /id: "spacing"[\s\S]*?aria-label=\{t\.spacing\}[\s\S]*?<AlignVerticalSpaceAround/,
    );
    assert.match(
      source,
      /<ManualEditorNumericControl label=\{t\.lineHeight\}[\s\S]*?<ManualEditorNumericControl label=\{t\.spaceAfter\}/,
    );
    // Spacing changes route through helpers that reach into the text subtree
    // and lift the box out of flow first, instead of writing a dead container
    // margin that also pushed siblings around.
    assert.match(source, /onChange=\{\(value\) => patchSelectedText\(\(element\) => applyInheritedLineHeight\(element, String\(value\)\)\)\}/);
    assert.match(source, /onChange=\{\(value\) => patchSelectedText\(\(element\) => applySpaceAfter\(element, element\.ownerDocument\.defaultView!, value\)\)\}/);
    assert.doesNotMatch(source, /element\.style\.lineHeight = event\.target\.value/);
    assert.doesNotMatch(source, /element\.style\.marginBottom = `\$\{event\.target\.value\}px`/);
  });

  it("keeps only the popovers that still exist", async () => {
    const source = await shellSource();

    assert.match(source, /type ToolbarPopover = "insert" \| "spacing" \| "text-color" \| "fill" \| "border" \| null;/);
    for (const locale of localeIds) {
      const editor = messages[locale].manualEditor;
      assert.ok(!("paragraph" in editor));
      assert.ok(editor.lineHeight.length > 0);
      assert.ok(editor.spaceAfter.length > 0);
    }
  });

  it("uses one crop action instead of image-fit modes", async () => {
    const source = await shellSource();
    const styles = await readFile(path.resolve(STYLES), "utf8");

    assert.match(source, /manual-editor\.image\.crop/);
    assert.match(source, /manual-editor\.image\.reset-crop/);
    assert.doesNotMatch(source, /manual-toolbar-select image-fit/);
    assert.doesNotMatch(source, /style\.objectFit = event\.target\.value/);
    assert.doesNotMatch(styles, /manual-toolbar-select\.image-fit/);
    for (const locale of localeIds) {
      const editor = messages[locale].manualEditor;
      assert.ok(editor.cropImage.length > 0);
      assert.ok(editor.resetCrop.length > 0);
      assert.ok(!("imageFit" in editor));
      assert.ok(!("imageFitCover" in editor));
      assert.ok(!("imageFitContain" in editor));
      assert.ok(!("imageFitFill" in editor));
    }
  });

  it("keeps insert actions at the far left and commits an active crop first", async () => {
    const source = await shellSource();
    const toolbarStart = source.indexOf('const toolbarItems: ManualEditorToolbarItem[]');
    const addText = source.indexOf('manual-editor.element.add-text', toolbarStart);
    const addShape = source.indexOf('manual-editor.element.add-shape', toolbarStart);
    const addImage = source.indexOf('manual-editor.element.add-image', toolbarStart);
    const undo = source.indexOf('manual-editor.undo', toolbarStart);

    assert.ok(toolbarStart >= 0);
    assert.ok(toolbarStart < addText && addText < addShape && addShape < addImage && addImage < undo);
    assert.doesNotMatch(
      source.slice(toolbarStart, addText),
      /!selected/,
    );
    assert.match(source, /const addElement = \(kind: "text" \| "shape"\) => \{\s*\n\s*finishCropRef\.current\(\);/);
    assert.match(
      source,
      /manual-editor\.element\.add-image[\s\S]*?onClick=\{\(\) => \{ finishCropRef\.current\(\); setToolbarPopover\(null\); setImageMode\("add"\);/,
    );
  });

  it("removes layer controls and shows one ungrouped font list", async () => {
    const source = await shellSource();

    assert.doesNotMatch(source, /manual-editor\.layer\./);
    assert.doesNotMatch(source, /manualPageEditorStacking/);
    assert.doesNotMatch(source, /<optgroup/);
    assert.match(source, /selectableManagedFonts\.filter/);
    assert.match(source, /const fontFamilyOptions: ManualToolbarSelectOption\[\]/);
    for (const locale of localeIds) {
      const editor = messages[locale].manualEditor;
      assert.ok(!("managedFonts" in editor));
      assert.ok(!("localFonts" in editor));
      assert.ok(!("layers" in editor));
      assert.ok(!("bringToFront" in editor));
      assert.ok(!("bringForward" in editor));
      assert.ok(!("sendBackward" in editor));
      assert.ok(!("sendToBack" in editor));
    }
  });

  it("hides the ordinary selection transform origin", async () => {
    const source = await shellSource();

    assert.match(source, /<Moveable[\s\S]*?target=\{selected\}[\s\S]*?origin=\{false\}/);
  });
});

describe("工具栏空间不足时的功能保留", () => {
  const items = [
    { id: "insert", width: 64, priority: 0 },
    { id: "history", width: 70, priority: 1 },
    { id: "font", width: 128, priority: 6 },
    { id: "text-style", width: 128, priority: 0, pinned: true },
    { id: "spacing", width: 30, priority: 3 },
    { id: "alignment", width: 30, priority: 2 },
  ];

  it("窄窗口保留常用文字样式，宽度恢复后显示全部工具", () => {
    const overflow = manualToolbarOverflow(items, 390, 6);
    assert.ok(overflow.includes("font"));
    assert.ok(!overflow.includes("text-style"));
    assert.deepEqual(manualToolbarOverflow(items, 1000, 6), []);
  });

  it("每种宽度都能容纳主栏工具，其余功能完整进入菜单且保持顺序", () => {
    for (let availableWidth = 0; availableWidth <= 650; availableWidth += 13) {
      const overflow = manualToolbarOverflow(items, availableWidth, 6);
      const visible = items.filter((item) => !overflow.includes(item.id));
      const width = visible.reduce((total, item) => total + item.width, 0) + Math.max(0, visible.length - 1) * 6;
      assert.ok(width <= availableWidth || visible.every((item) => item.pinned));
      assert.deepEqual(overflow, items.filter((item) => overflow.includes(item.id)).map((item) => item.id));
      assert.equal(new Set([...visible.map((item) => item.id), ...overflow]).size, items.length);
      for (const item of items.filter((item) => overflow.includes(item.id))) {
        assert.ok(visible.every((shown) => shown.pinned || shown.priority <= item.priority));
      }
    }
  });

  it("固定工具即使比可用空间更宽也不会被移到更多菜单", () => {
    assert.deepEqual(manualToolbarOverflow([
      { id: "font", width: 120, priority: 0 },
      { id: "text-style", width: 128, priority: 10, pinned: true },
    ], 40, 6), ["font"]);
  });
});
