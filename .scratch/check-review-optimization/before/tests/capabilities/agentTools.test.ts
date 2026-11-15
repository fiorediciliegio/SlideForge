import assert from "node:assert/strict";
import test from "node:test";
import { validateToolAccess, canReuseCheck, validateCompletion } from "../../src/capabilities/agent.ts";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {emptyProject} from "../../src/capabilities/project.ts";
import {inputHash} from "../../src/server/agentClient.ts";
test("tool permissions reject research and export without user authorization", () => {
 assert.throws(()=>validateToolAccess("research_sources", {research_allowed:false},[]),/联网/);
 assert.throws(()=>validateToolAccess("export_deck", {research_allowed:true},[],"pptx"),/导出/);
 assert.doesNotThrow(()=>validateToolAccess("export_deck", {research_allowed:false},["pdf"],"pdf"));
});
test("a batch review issue on page A does not block unchanged page B after A is cleared",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"sf-check-scope-"));await mkdir(path.join(root,"project/checks"),{recursive:true});
 const project=emptyProject("deck-scope","test",{draft_revision:1,title:"test",pages:[{page_id:"a",title:"A",bullets:[]},{page_id:"b",title:"B",bullets:[]}]});project.revision_id="current";project.pages=[{page_id:"a",page_revision:"a-v1",html_ref:"slides/a.html"},{page_id:"b",page_revision:"b-v1",html_ref:"slides/b.html"}];
 const fingerprint={page_revisions:{a:inputHash(["a-v1",[]]),b:inputHash(["b-v1",[]])},constraints_hash:inputHash([project.constraints,project.outline.pages,project.sources]),template_hash:inputHash({})};
 const put=(name:string,value:unknown)=>writeFile(path.join(root,"project/checks",name+".json"),JSON.stringify(value));
 for(const kind of ["layout","content"])await put(kind,{...fingerprint,kind,page_ids:["a","b"],revision_id:"current",global_summary:kind==="content",issues:[],created_at:"2026-11-10T00:00:00Z"});
 await put("visual-batch",{...fingerprint,kind:"visual",page_ids:["a","b"],revision_id:"current",issues:[{severity:"blocker",code:"placeholder",detail:"page A placeholder",page_ids:["a"]}],created_at:"2026-11-10T00:00:00Z"});
 await put("visual-fixed-a",{...fingerprint,kind:"visual",page_ids:["a"],page_revisions:{a:fingerprint.page_revisions.a},revision_id:"current",issues:[],created_at:"2026-11-10T00:01:00Z"});
 const result=await validateCompletion(root,project);assert.equal(result.ok,true,JSON.stringify(result.issues));
});
test("unchanged pages reuse checks while modified pages or constraints invalidate them", () => {
 const check={page_revisions:{"a":"rev-a"},constraints_hash:"c",template_hash:"t"};
 assert.equal(canReuseCheck(check,{page_revisions:{"a":"rev-a"},constraints_hash:"c",template_hash:"t"}),true);
 assert.equal(canReuseCheck(check,{page_revisions:{"a":"changed"},constraints_hash:"c",template_hash:"t"}),false);
 assert.equal(canReuseCheck(check,{page_revisions:{"a":"rev-a"},constraints_hash:"new",template_hash:"t"}),false);
 const batch={...check,page_revisions:{a:"rev-a",b:"rev-b"}},changed={...check,page_revisions:{a:"rev-a",b:"changed"}};
 assert.equal(canReuseCheck(batch,changed,"a"),true);
 assert.equal(canReuseCheck(batch,changed,"b"),false);
});
