import assert from "node:assert/strict";
import test from "node:test";
import { compareMasters } from "../../src/features/user-templates/masterDrift";

const MASTER = `<!doctype html><html><head><style>
:root { --primary: #1B4F9C; --accent: #E67E22; }
.title { font-size: 44px; color: #1B4F9C; }
.body { font-size: 24px; }
</style></head><body><div class="slide">
<div class="header" data-fixed="true">{{PAGE_TITLE}}</div>
<img data-composed-asset data-asset="logo-1.png" src="data:image/webp;base64,AAAA" style="position:absolute;left:96px;top:72px;height:72px">
<div>{{PAGE_CONTENT}}</div>
<div class="footer" data-fixed="true">08</div>
</div></body></html>`;

test("compareMasters reports unchanged dimensions as unchanged", () => {
  const drift = compareMasters(MASTER, MASTER);
  assert.equal(drift.colors.added + drift.colors.removed + drift.colors.changed, 0);
  assert.equal(drift.fontSizes.added + drift.fontSizes.removed, 0);
  assert.deepEqual(drift.logos, { kept: 1, moved: 0, lost: 0, added: 0 });
  assert.deepEqual(drift.markers, { title: true, content: true });
  assert.equal(drift.skeletonChanged, false);
});

test("compareMasters counts color/font changes and detects a moved logo", () => {
  const proposed = MASTER
    .replace("#E67E22", "#27AE60")           // one color swapped
    .replace("font-size: 24px", "font-size: 28px")  // one font size swapped
    .replace("left:96px;top:72px", "left:200px;top:72px"); // logo moved 104px
  const drift = compareMasters(MASTER, proposed);
  assert.equal(drift.colors.added, 1);
  assert.equal(drift.colors.removed, 1);
  assert.equal(drift.colors.changed, 0);
  assert.equal(drift.fontSizes.added, 1);
  assert.equal(drift.fontSizes.removed, 1);
  assert.equal(drift.logos.moved, 1);
  assert.equal(drift.logos.kept, 0);
  assert.deepEqual(drift.markers, { title: true, content: true });
});

test("compareMasters flags lost markers, lost logos and skeleton changes", () => {
  const proposed = MASTER
    .replace("{{PAGE_TITLE}}", "标题")
    .replace(/<img[^>]*logo-1\.png[^>]*>/, "")
    .replace('data-fixed="true"', "");
  const drift = compareMasters(MASTER, proposed);
  assert.equal(drift.markers.title, false);
  assert.equal(drift.logos.lost, 1);
  assert.equal(drift.skeletonChanged, true);
});

test("compareMasters tolerates small logo repositioning (<=8px) as in place", () => {
  const proposed = MASTER.replace("left:96px;top:72px", "left:100px;top:70px");
  const drift = compareMasters(MASTER, proposed);
  assert.equal(drift.logos.kept, 1);
  assert.equal(drift.logos.moved, 0);
});
