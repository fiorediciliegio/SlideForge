import assert from "node:assert/strict";
import test from "node:test";
import { extractRootBlock, replaceRootBlock } from "../../src/features/user-templates/masterVarSync";

const MASTER = `<html><head><style>:root { --primary: #1B4F9C; --bg: #FFFFFF; font-family: 'Microsoft YaHei'; }</style></head><body><div class="slide">{{PAGE_CONTENT}}</div></body></html>`;
const PAGE = `<html><head><style>:root { --primary: #000000; --bg: #EEEEEE; }</style><style>.slide { color: var(--primary); }</style></head><body><div class="slide">目录</div></body></html>`;

test("extractRootBlock pulls the first :root block", () => {
  assert.equal(extractRootBlock(MASTER), ":root { --primary: #1B4F9C; --bg: #FFFFFF; font-family: 'Microsoft YaHei'; }");
  assert.equal(extractRootBlock("<html><body>no styles</body></html>"), null);
});

test("replaceRootBlock swaps variables and keeps everything else intact", () => {
  const root = extractRootBlock(MASTER)!;
  const out = replaceRootBlock(PAGE, root);
  assert.match(out, /--primary: #1B4F9C/);
  assert.match(out, /font-family: 'Microsoft YaHei'/);
  assert.match(out, /\.slide \{ color: var\(--primary\); \}/, "other style blocks untouched");
  assert.match(out, /目录/);
  assert.equal((out.match(/:root/g) ?? []).length, 1, "exactly one :root block remains");
});

test("replaceRootBlock is a safe no-op when the target has no :root block", () => {
  const bare = "<html><body>x</body></html>";
  assert.equal(replaceRootBlock(bare, ":root { --a: 1; }"), bare);
});
