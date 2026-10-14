import assert from "node:assert/strict";
import test from "node:test";
import { parseRegionFromRule, ruleTextWithoutRegion, setRegionInRule, isAssetRegionKey } from "../../src/features/user-templates/assetRegions";

test("region prefix round-trips through position_rule", () => {
  assert.equal(parseRegionFromRule("[top-right] 与标题同行"), "top-right");
  assert.equal(ruleTextWithoutRegion("[top-right] 与标题同行"), "与标题同行");
  const written = setRegionInRule(undefined, "top-left");
  assert.equal(written, "[top-left]");
  assert.equal(parseRegionFromRule(written), "top-left");
  assert.equal(setRegionInRule("[top-left] 旧备注", "bottom-center"), "[bottom-center] 旧备注");
  assert.equal(setRegionInRule("[top-left]", undefined), undefined);
});

test("invalid or missing prefixes are ignored safely", () => {
  assert.equal(parseRegionFromRule(undefined), undefined);
  assert.equal(parseRegionFromRule("左上角（无前缀）"), undefined);
  assert.equal(parseRegionFromRule("[nowhere] 无效区域"), undefined);
  assert.equal(isAssetRegionKey("center"), true);
  assert.equal(isAssetRegionKey("middle"), false);
});
