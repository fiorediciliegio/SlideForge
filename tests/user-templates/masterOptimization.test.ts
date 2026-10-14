import assert from "node:assert/strict";
import test from "node:test";
import { parseMasterOptimization, templateMasterOptimizePrompt, templateMasterPrompt } from "../../src/features/user-templates/prompts";

const GOOD_HTML = "<!doctype html><html><head><style></style></head><body><h1>{{PAGE_TITLE}}</h1><div>{{PAGE_CONTENT}}</div></body></html>";

test("parseMasterOptimization accepts a well-formed payload", () => {
  const parsed = parseMasterOptimization({ master_html: GOOD_HTML, summary: "深色模式", changed: ["背景改为深色", "标题加粗"] });
  assert.equal(parsed.summary, "深色模式");
  assert.deepEqual(parsed.changed, ["背景改为深色", "标题加粗"]);
  assert.match(parsed.master_html, /{{PAGE_TITLE}}/);
});

test("parseMasterOptimization rejects structural breaks", () => {
  assert.throws(() => parseMasterOptimization(null), /object/);
  assert.throws(() => parseMasterOptimization({ master_html: "no html here", summary: "x", changed: ["a"] }), /full master_html/);
  assert.throws(() => parseMasterOptimization({ master_html: "<html><body>{{PAGE_TITLE}}</body></html>", summary: "x", changed: ["a"] }), /page marker/);
  assert.throws(() => parseMasterOptimization({ master_html: GOOD_HTML, summary: "x", changed: [] }), /1-12/);
  assert.throws(() => parseMasterOptimization({ master_html: GOOD_HTML, summary: "  ", changed: ["a"] }), /summary/);
});

test("templateMasterOptimizePrompt embeds master, instruction and constraints; omits profile when absent", () => {
  const withoutProfile = templateMasterOptimizePrompt(GOOD_HTML, null, "整体换深色", "zh" as never);
  assert.match(withoutProfile, /整体换深色/);
  assert.match(withoutProfile, /\{\{PAGE_TITLE\}\}/);
  assert.match(withoutProfile, /硬性结构约束/);
  assert.doesNotMatch(withoutProfile, /已确认的设计档案/);
  const withProfile = templateMasterOptimizePrompt(GOOD_HTML, { colors: [{ token: "primary", hex: "#1B4F9C", role: "主色" }] }, "更商务", "zh" as never);
  assert.match(withProfile, /已确认的设计档案/);
  assert.match(withProfile, /#1B4F9C/);
});

test("templateMasterOptimizePrompt puts master_html first and guards asset refs", () => {
  const prompt = templateMasterOptimizePrompt(GOOD_HTML, null, "增加装饰", "zh" as never);
  const formatIndex = prompt.indexOf("## 输出格式");
  const orderSection = prompt.slice(formatIndex);
  assert.ok(orderSection.indexOf('"master_html"') < orderSection.indexOf('"summary"'), "master_html must be the first JSON field");
  assert.match(prompt, /x-asset-ref/);
  assert.match(prompt, /资产引用原样保留/);
  assert.match(prompt, /换行写作/);
});

test("templateMasterPrompt asks for asset slots only when the profile declares image assets", () => {
  const profile = {
    colors: [], layout_rules: [], do: [], dont: [],
    fixed_assets: [{ kind: "logo", label: "品牌标识", position_rule: "左上角", image: { filename: "logo-1.png", mime_type: "image/png", size_bytes: 1 } }],
  };
  const prompt = templateMasterPrompt(profile as never);
  assert.match(prompt, /固定资产槽位/);
  assert.match(prompt, /class="asset-slot" data-asset="logo-1\.png"/);
  assert.match(prompt, /top-left/);
  const withoutAssets = templateMasterPrompt({ colors: [], layout_rules: [], do: [], dont: [] } as never);
  assert.doesNotMatch(withoutAssets, /固定资产槽位/);
});

test("templateMasterOptimizePrompt also injects the slot section for legacy self-healing", () => {
  const profile = {
    colors: [], layout_rules: [], do: [], dont: [],
    fixed_assets: [{ kind: "logo", label: "品牌标识", position_rule: "左上角", image: { filename: "logo-1.png", mime_type: "image/png", size_bytes: 1 } }],
  };
  const prompt = templateMasterOptimizePrompt(GOOD_HTML, profile as never, "标题居中", "zh" as never);
  assert.match(prompt, /固定资产槽位/);
  assert.match(prompt, /data-asset="logo-1\.png"/);
  const bare = templateMasterOptimizePrompt(GOOD_HTML, { colors: [], layout_rules: [], do: [], dont: [] } as never, "标题居中", "zh" as never);
  assert.doesNotMatch(bare, /固定资产槽位/);
});

test("masterAssetSlotSection pins an explicit data-region when the rule has a [region] prefix", () => {
  const profile = {
    colors: [], layout_rules: [], do: [], dont: [],
    fixed_assets: [
      { kind: "logo", label: "品牌标识", position_rule: "[top-right] 与标题同行", image: { filename: "logo-1.png", mime_type: "image/png", size_bytes: 1 } },
      { kind: "logo", label: "次标识", position_rule: "无前缀", image: { filename: "logo-2.png", mime_type: "image/png", size_bytes: 1 } },
    ],
  };
  const prompt = templateMasterPrompt(profile as never);
  assert.match(prompt, /data-asset="logo-1\.png" data-region="top-right"/);
  assert.match(prompt, /必须使用该 data-region 值，不得更改/);
  // Unprefixed asset still gets the free-choice guidance.
  assert.match(prompt, /data-asset="logo-2\.png" data-region="区域名"/);
});

test("templateMasterOptimizePrompt intensity tiers tighten or loosen the change scope", () => {
  const conservative = templateMasterOptimizePrompt(GOOD_HTML, null, "换深色", "zh" as never, "conservative");
  assert.match(conservative, /微调强度/);
  assert.match(conservative, /字节级保持不变/);
  const bold = templateMasterOptimizePrompt(GOOD_HTML, null, "换深色", "zh" as never, "bold");
  assert.match(bold, /重构强度/);
  const balanced = templateMasterOptimizePrompt(GOOD_HTML, null, "换深色", "zh" as never);
  assert.doesNotMatch(balanced, /微调强度|重构强度/);
});

test("templateMasterOptimizePrompt section lock freezes everything outside the named scope", () => {
  const locked = templateMasterOptimizePrompt(GOOD_HTML, null, "页眉改窄", "zh" as never, "balanced", "header");
  assert.match(locked, /板块锁定/);
  assert.match(locked, /只允许调整页眉区/);
  assert.match(locked, /一律保持原样，不得改动/);
  const colors = templateMasterOptimizePrompt(GOOD_HTML, null, "换色", "zh" as never, "balanced", "colors");
  assert.match(colors, /只允许调整配色整体/);
  const free = templateMasterOptimizePrompt(GOOD_HTML, null, "换深色", "zh" as never);
  assert.doesNotMatch(free, /板块锁定/);
});
