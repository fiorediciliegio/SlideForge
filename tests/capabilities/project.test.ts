import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importLegacyProject, prepareRevision, readProjectRevision, prepareRollback } from "../../src/capabilities/project.ts";

const html = (text: string) => `<!doctype html><html><head><style>.slide{width:1920px;height:1080px;overflow:hidden}</style></head><body><main class="slide"><h1>${text}</h1></main></body></html>`;
test("legacy migration captures current pages and truthfully identifies missing original sources", async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), "sf-project-"));
 await writeFile(path.join(root, "brief.txt"), "原需求");
 await writeFile(path.join(root, "outline.json"), JSON.stringify({ title: "作品", pages: [{title:"初始一",bullets:[]},{title:"初始二",bullets:[]}] }));
 await writeFile(path.join(root, "page-1.html"), html("用户修改后的内容"));await writeFile(path.join(root,"page-2.html"),html("二"));
 const baseline = await importLegacyProject(root,"deck-test");
 assert.ok(baseline.project.missing.includes("original_attachments"));assert.equal(baseline.project.constraints.length,0);
 assert.match(await readFile(path.join(root,baseline.ref.artifact_ref,"slides",`${baseline.project.outline.pages[0].page_id}.html`),"utf8"),/用户修改后/);
 const edited = await prepareRevision(root,baseline.project,{instruction:"更新",page_html:{[baseline.project.outline.pages[0].page_id]:html("新版本")}});
 const reverted = await prepareRollback(root,edited.project,baseline.ref.revision_id,baseline.project.outline.pages[0].page_id);
 assert.notEqual(reverted.ref.revision_id,baseline.ref.revision_id);
 assert.deepEqual(reverted.project.sources,edited.project.sources);
 assert.deepEqual(reverted.project.constraints,edited.project.constraints);
 assert.equal(reverted.project.history.instruction,"回退页面版本");
 assert.equal((await readProjectRevision(root,reverted.ref)).pages.length,2);
 assert.match(await readFile(path.join(root,"page-1.html"),"utf8"),/用户修改后/);
});
