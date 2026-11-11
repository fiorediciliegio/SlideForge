import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getSharedBrowser, closeValidatorBrowser } from "../../scripts/m0/validatePage.ts";

async function harnessPage(conflict=false) {
 const html=await readFile(new URL("../../src/http/app.html",import.meta.url),"utf8");
 const script=await readFile(new URL("../../src/http/agent-ui.js",import.meta.url),"utf8");
 const browser=await getSharedBrowser(),page=await browser.newPage();
 const writes:any[]=[];const revisions:any[]=[];let confirms=0;
 const options={version:1,generation_mode:"outline_first",research_allowed:false,page_policy:{mode:"fixed",count:2},budget:{active_seconds:600,estimated_cost_cny:2}};
 let run:any={version:1,run_seq:1,checkpoint_seq:10,phase:"waiting_outline",options,draft_revision:1,budget:{active_seconds:1,limit_seconds:600,spent_cny:0.01,reserved_cny:0,limit_cny:2},quality_state:"draft"};
 let draft:any={draft_revision:1,title:"初始大纲",pages:[{page_id:"a",title:"第一页",bullets:["一个要点"]},{page_id:"b",title:"第二页",bullets:["总结"]}]};
 const project:any={revision_id:"plan-1",outline:draft,pages:[],sources:[],constraints:[],missing:[],scenario:{category:"企业",subtype:"产品发布"}};
 await page.evaluateOnNewDocument(()=>localStorage.setItem("sf-api-key","ui-test-key"));
 await page.setRequestInterception(true);
 page.on("request",async(request:any)=>{
  const url=new URL(request.url());
  if(url.hostname!=="slideforge.test")return request.respond({status:204});
  if(url.pathname==="/app")return request.respond({status:200,contentType:"text/html",body:html});
  if(url.pathname==="/agent-ui.js")return request.respond({status:200,contentType:"text/javascript",body:script});
  let body:any=[],status=200;
  if(url.pathname==="/usage")body={enabled:false};
  if(url.pathname==="/decks"&&request.method()==="POST")body={deck_id:"deck-ui",status:"creating",agent:run};
  if(url.pathname==="/decks/deck-ui")body={deck_id:"deck-ui",status:"creating",agent:run};
  if(url.pathname==="/decks/deck-ui/project")body={project,draft,agent:run};
  if(url.pathname==="/decks/deck-old")body={deck_id:"deck-old",status:"ready"};
  if(url.pathname==="/decks/deck-ui/events")return request.respond({status:200,contentType:"text/event-stream",body:`event: job\ndata: ${JSON.stringify({deck_id:"deck-ui",status:"creating",agent:run})}\n\n`});
  if(url.pathname==="/decks/deck-ui/agent-revise"){revisions.push(JSON.parse(request.postData()));body={error:"版本冲突"};status=409;}
  if(url.pathname==="/decks/deck-ui/outline-draft"){
   const input=JSON.parse(request.postData());writes.push(input);
   if(conflict||input.expected_draft_revision!==run.draft_revision){status=409;body={error:"大纲已在另一标签页修改",error_code:"conflict"};}
   else {run={...run,draft_revision:run.draft_revision+1,checkpoint_seq:run.checkpoint_seq+1};draft={...input,draft_revision:run.draft_revision};body={draft,agent:run};}
  }
  if(url.pathname==="/decks/deck-ui/outline-confirm"){confirms++;const input=JSON.parse(request.postData());assert.equal(input.draft_revision,run.draft_revision);run={...run,phase:"queued",checkpoint_seq:run.checkpoint_seq+1};body={agent:run};}
  await request.respond({status,contentType:"application/json",body:JSON.stringify(body)});
 });
 const errors:string[]=[];page.on("pageerror",(error:Error)=>errors.push(error.message));
 await page.goto("http://slideforge.test/app");
 await page.evaluate(()=>{(document.getElementById("brief") as HTMLTextAreaElement).value="先规划一下，生成两页产品介绍";document.getElementById("generate")!.click();});
 await page.waitForFunction(()=>document.getElementById("agentDraft")?.style.display==="block");
 return {page,writes,errors,revisions,get confirms(){return confirms;},get draft(){return draft;},
  remoteEdit(){run={...run,draft_revision:2,checkpoint_seq:11};draft={...draft,title:"另一标签的保存",draft_revision:2};},
  generated(){run={...run,phase:"generating",preview_revision:"generated",checkpoint_seq:12};project.revision_id="generated";project.pages=[{page_id:"a"},{page_id:"b"}];},
  completed(){run={...run,phase:"completed",checkpoint_seq:13};},
  manualEdit(){project.revision_id="manual-version";}
 };
}
test("outline editing autosaves, restores after reload and confirms the saved revision",{timeout:30_000},async()=>{
 const fixture=await harnessPage();
 try {
  await fixture.page.$eval("#outlineTitle",(element:any)=>{element.value="用户编辑的大纲";element.dispatchEvent(new Event("input",{bubbles:true}));});
  await fixture.page.waitForFunction(()=>document.getElementById("outlineSaveStatus")?.textContent==="已保存");
  assert.equal(fixture.writes.length,1);assert.equal(fixture.writes[0].title,"用户编辑的大纲");
  await fixture.page.reload();
  await fixture.page.waitForFunction(()=>(document.getElementById("outlineTitle") as HTMLInputElement)?.value==="用户编辑的大纲");
  await fixture.page.click("#outlineConfirm");
  await fixture.page.waitForFunction(()=>document.getElementById("agentProgress")?.textContent?.includes("排队中"));
  assert.equal(fixture.confirms,1);assert.deepEqual(fixture.errors,[]);
 } finally {await fixture.page.close();await closeValidatorBrowser();}
});
test("autosave conflicts preserve local edits and block stale confirmation",{timeout:30_000},async()=>{
 const fixture=await harnessPage(true);
 try {
  await fixture.page.$eval("#outlineTitle",(element:any)=>{element.value="尚未保存的本地修改";element.dispatchEvent(new Event("input",{bubbles:true}));});
  await fixture.page.waitForFunction(()=>document.getElementById("outlineSaveStatus")?.textContent?.includes("保存失败"));
  await fixture.page.click("#outlineConfirm");
  assert.equal(fixture.confirms,0);assert.equal(await fixture.page.$eval("#outlineTitle",(element:any)=>element.value),"尚未保存的本地修改");assert.deepEqual(fixture.errors,[]);
 } finally {await fixture.page.close();await closeValidatorBrowser();}
});

test("a remote draft update cannot change the base of unsaved local edits",{timeout:30_000},async()=>{
 const fixture=await harnessPage();
 try {
  await fixture.page.evaluate(()=>{const original=window.setTimeout;window.setTimeout=((handler:any,delay:number,...args:any[])=>original(handler,delay===500?3500:delay,...args)) as typeof window.setTimeout;});
  await fixture.page.$eval("#outlineTitle",(element:any)=>{element.value="本地未保存稿";element.dispatchEvent(new Event("input",{bubbles:true}));});
  fixture.remoteEdit();
  await fixture.page.waitForFunction(()=>{const value=document.getElementById("outlineSaveStatus")?.textContent;return value==="已保存"||value?.includes("保存失败");},{timeout:8000});
  assert.equal(fixture.writes[0]?.expected_draft_revision,1);
  assert.equal(fixture.draft.title,"另一标签的保存");
  assert.equal(await fixture.page.$eval("#outlineTitle",(element:any)=>element.value),"本地未保存稿");
 } finally {await fixture.page.close();await closeValidatorBrowser();}
});

test("completion enables editing and later revisions are refreshed before AI edits",{timeout:30_000},async()=>{
 const fixture=await harnessPage();
 try {
  fixture.generated();
  await fixture.page.waitForFunction(()=>document.getElementById("agentProgress")?.textContent?.includes("生成页面"));
  fixture.completed();
  await fixture.page.waitForFunction(()=>document.getElementById("agentProgress")?.textContent?.includes("预览已交付"));
  assert.equal(await fixture.page.$eval("#applyEdit",(element:any)=>element.disabled),false);
  fixture.manualEdit();
  await fixture.page.evaluate('state.editingPage=1; agentUI.revise("保留手动改动，调整标题")');
  assert.equal(fixture.revisions[0]?.expected_project_revision,"manual-version");
 } finally {await fixture.page.close();await closeValidatorBrowser();}
});

test("AI edits refresh the revision after a manual save",{timeout:30_000},async()=>{
 const fixture=await harnessPage();
 try {
  fixture.generated();fixture.completed();await fixture.page.evaluate('agentUI.watch("deck-ui")');
  fixture.manualEdit();await fixture.page.evaluate('state.editingPage=1; agentUI.revise("继续修改")');
  assert.equal(fixture.revisions[0]?.expected_project_revision,"manual-version");
 } finally {await fixture.page.close();await closeValidatorBrowser();}
});

test("opening a legacy deck detaches controls from the previous Agent deck",{timeout:30_000},async()=>{
 const fixture=await harnessPage();
 try {
  await fixture.page.evaluate('openDeck("deck-old")');
  assert.equal(await fixture.page.$eval("#agentPanel",(element:any)=>element.style.display),"none");
  assert.equal(await fixture.page.evaluate('state.deckId'),"deck-old");
 } finally {await fixture.page.close();await closeValidatorBrowser();}
});
