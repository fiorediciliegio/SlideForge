import test from "node:test";
import assert from "node:assert/strict";
import * as agent from "../../src/capabilities/agent.ts";
import {emptyProject} from "../../src/capabilities/project.ts";
import {inputHash} from "../../src/server/agentClient.ts";

function fixture(){
 const ids=["a","b","c","d","e","f"];
 const project=emptyProject("deck-review","test",{draft_revision:1,title:"test",pages:ids.map(page_id=>({page_id,title:page_id,bullets:[]}))});
 project.revision_id="r1";project.pages=ids.map(page_id=>({page_id,page_revision:page_id+"-v1",html_ref:"slides/"+page_id+".html"}));
 const checks:any[]=[];let clock=0;
 const put=(kind:string,pages=ids,issues:any[]=[],global_summary=false)=>{
  checks.push({kind,page_ids:pages,issues,global_summary,revision_id:project.revision_id,created_at:String(++clock).padStart(4,"0"),
   page_revisions:Object.fromEntries(project.pages.filter(p=>pages.includes(p.page_id)).map(p=>[p.page_id,inputHash([p.page_revision,[]])])),
   constraints_hash:inputHash([project.constraints,project.outline.pages,project.sources]),template_hash:inputHash(project.visual??{})});
 };
 const decide=()=>{assert.equal(typeof agent.nextReviewAction,"function","缺少自动检查调度");return agent.nextReviewAction(project,checks)};
 return {project,ids,checks,put,decide};
}

test("检查按版面、内容、视觉4+2推进，收齐问题再逐页修订和全稿复核",()=>{
 const f=fixture(),block=(id:string)=>({severity:"blocker",code:"overlap",detail:"fix "+id,page_ids:[id]});
 assert.deepEqual(f.decide(),{action:"inspect",kinds:["layout","content"],page_ids:f.ids});
 f.put("layout");assert.deepEqual(f.decide(),{action:"assess",kind:"content",page_ids:f.ids,global_summary:true});
 f.put("content",f.ids,[],true);
 assert.deepEqual(f.decide(),{action:"assess",kind:"visual",page_ids:["a","b","c","d"],global_summary:false});
 f.put("visual",["a","b","c","d"],[block("a")]);
 assert.deepEqual(f.decide(),{action:"assess",kind:"visual",page_ids:["e","f"],global_summary:false});
 f.put("visual",["e","f"],[block("e")]);
 assert.equal(f.decide().action,"repair");
 f.project.revision_id="r2";f.project.pages[0].page_revision="a-v2";
 const remaining=f.decide();assert.equal(remaining.action,"repair");
 assert.deepEqual(remaining.issues.flatMap((x:any)=>x.page_ids),["e"],"不能每修一页就重新全稿检查");
 f.project.revision_id="r3";f.project.pages[4].page_revision="e-v2";
 assert.deepEqual(f.decide(),{action:"inspect",kinds:["layout","content"],page_ids:["a","e"]});
 f.put("layout",["a","e"]);
 assert.deepEqual(f.decide(),{action:"assess",kind:"visual",page_ids:["a","e"],global_summary:false});
 f.put("visual",["a","e"]);
 assert.deepEqual(f.decide(),{action:"assess",kind:"content",page_ids:f.ids,global_summary:true});
 f.put("content",f.ids,[],true);assert.deepEqual(f.decide(),{action:"finish"});
});

test("内容阻断先处理，不提前评审将被重做的页面视觉",()=>{
 const f=fixture();f.put("layout");
 f.put("content",f.ids,[{severity:"blocker",code:"fact",detail:"missing fact",page_ids:["b"]}],true);
 const result=f.decide();assert.equal(result.action,"repair");assert.equal(result.issues[0].kind,"content");
});

test("未生成完整时不强行检查，改进建议随交付保留，约束更新则检查失效",()=>{
 const f=fixture();f.project.pages.pop();assert.deepEqual(f.decide(),{action:"agent"});
 f.project.pages.push({page_id:"f",page_revision:"f-v1",html_ref:"slides/f.html"});
 f.put("layout");f.put("content",f.ids,[],true);
 f.put("visual",f.ids,[{severity:"improvement",code:"spacing",detail:"optional",page_ids:["a"]}]);
 assert.deepEqual(f.decide(),{action:"finish"});
 f.project.constraints.push({text:"new constraint",source:"user",confirmed_at:"now"});
 assert.equal(f.decide().action,"inspect");
});

test("多于四页的二次视觉复核仍须收齐当前批次再返工",()=>{
 const f=fixture();f.put("layout");f.put("content",f.ids,[],true);f.put("visual");
 f.project.revision_id="r2";
 for(const page of f.project.pages)page.page_revision+="-changed";
 f.put("layout");
 assert.deepEqual(f.decide().page_ids,["a","b","c","d"]);
 f.put("visual",["a","b","c","d"],[{severity:"blocker",code:"overlap",detail:"A",page_ids:["a"]}]);
 assert.deepEqual(f.decide(),{action:"assess",kind:"visual",page_ids:["e","f"],global_summary:false});
 f.put("visual",["e","f"]);
 assert.equal(f.decide().action,"repair");
});
