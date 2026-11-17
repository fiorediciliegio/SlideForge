import assert from "node:assert/strict";
import test from "node:test";
import {buildContextStatus} from "../../src/capabilities/contextStatus.ts";
import {emptyProject} from "../../src/capabilities/project.ts";

test("status derives current facts, successful source ranges and completed repair counts",()=>{
 const p=emptyProject("deck-status","原始需求",{title:"新版",draft_revision:2,pages:[{page_id:"a",title:"A",bullets:["73%是计划目标"]},{page_id:"b",title:"B",bullets:[]}]});
 p.revision_id="r2";p.constraints_revision=2;p.constraints=[{text:"保持73%，不能称已完成",source:"user",confirmed_at:"saved"}];
 p.pages=[{page_id:"a",page_revision:"pa",html_ref:"slides/a.html"}];
 p.sources=[{source_id:"s1",name:"资料",kind:"user",text_ref:"project/sources/s1.txt",chars:100}];
 const op=(result:unknown,status="completed")=>({status,input_hash:"h",result});
 const run:any={run_seq:2,runner_epoch:3,phase:"checking",options:{page_policy:{mode:"fixed",count:2},research_allowed:false},
  budget:{limit_seconds:600,active_seconds:12.8,limit_cny:2,spent_cny:.5,reserved_cny:.4},calls:{lost:{status:"unknown",cost:.1}},operations:{
   read1:op({source_id:"s1",start:0,end:40,text:"x"}),read2:op({source_id:"s1",start:20,end:60,text:"y"}),read3:op({source_id:"s1",start:80,end:100,text:"z"}),
   bad:op({source_id:"s1",start:60,end:80,text:"not delivered",error:"failed"}),pending:op({source_id:"s1",start:60,end:80,text:"pending"},"pending"),
   index:op({sources:[{source_id:"s1"}]}),removed:op({source_id:"old",start:0,end:999,text:"old"}),
   fixed:op({page_id:"a",repair:true,issues:[]}),notDone:op({page_id:"a",repair:true},"pending")}};
 const result=buildContextStatus(run,p,{export_authorized:[],user_response:"改为计划目标"},{action:"assess",kind:"visual",page_ids:["a"]});
 assert.equal(result.state.generated_pages,1);assert.deepEqual(result.state.pending_page_ids,["b"]);
 assert.deepEqual(result.state.source_coverage[0].read_ranges,[[0,60],[80,100]]);assert.deepEqual(result.state.source_coverage[0].unread_ranges,[[60,80]]);
 assert.equal(result.state.source_coverage[0].read_chars,80);assert.equal(result.state.source_coverage.length,1);
 assert.deepEqual(result.state.repair_counts,{a:1,b:0});assert.equal(result.state.budget.available_cny,1.1);assert.equal(result.state.budget.active_seconds,12);
 assert.deepEqual(result.state.unknown_call_ids,["lost"]);assert.equal(result.snapshot.outline.pages[0].bullets[0],"73%是计划目标");
 assert.equal(result.snapshot.user_response,"改为计划目标");assert.equal(result.state.stage,"visual_review");
 assert.equal(result.state.quality_checked,false);
});
