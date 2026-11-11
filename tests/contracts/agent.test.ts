import assert from "node:assert/strict";
import test from "node:test";
import { agentOptionsSchema, outlineDraftSchema, effectiveGenerationMode,explicitPageConflict,explicitExportFormats } from "../../src/contracts/agent.ts";

test("agent options default to direct, 600 seconds and two CNY with bounded page policies", () => {
  const options = agentOptionsSchema.parse({ version: 1, page_policy: { mode: "fixed", count: 8 } });
  assert.equal(options.generation_mode, "direct");
  assert.deepEqual(options.budget, { active_seconds: 600, estimated_cost_cny: 2 });
  assert.equal(options.research_allowed, false);
  assert.equal(agentOptionsSchema.safeParse({ version: 1, page_policy: { mode: "range", min: 10, max: 6 } }).success, false);
  assert.equal(agentOptionsSchema.safeParse({ version: 1, page_policy: { mode: "fixed", count: 21 } }).success, false);
  assert.equal(effectiveGenerationMode("先规划一下，等我确认", "direct"), "outline_first");
});
test("explicit page requirements conflict instead of silently overriding selected controls",()=>{
 assert.equal(explicitPageConflict("生成十二页的介绍",{mode:"fixed",count:8})?.requested,12);
 assert.equal(explicitPageConflict("生成8页，介绍第12页的内容",{mode:"fixed",count:8}),undefined);
 assert.equal(explicitPageConflict("做两页旅行规划",{mode:"range",min:2,max:6}),undefined);
 assert.equal(explicitPageConflict("生成30页",{mode:"auto"})?.requested,30);
});
test("export authorization requires an affirmative user instruction",()=>{
 assert.deepEqual(explicitExportFormats("介绍软件的导出PPTX功能，不要导出文件"),[]);
 assert.deepEqual(explicitExportFormats("请制作2页并导出PDF"),["pdf"]);
 assert.deepEqual(explicitExportFormats("不要导出PPTX；请导出PDF"),["pdf"]);
 assert.deepEqual(explicitExportFormats("制作并导出PPTX和PDF"),["pdf","pptx"]);
});

test("outline preserves stable page identities and rejects duplicate pages", () => {
  const page = { page_id: "page-a", title: "标题", bullets: ["事实"] };
  assert.equal(outlineDraftSchema.safeParse({ draft_revision: 1, title: "测试", pages: [page, page] }).success, false);
  assert.equal(outlineDraftSchema.parse({ draft_revision: 1, title: "测试", pages: [page, { ...page, page_id: "page-b" }] }).pages[1].page_id, "page-b");
});
