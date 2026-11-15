import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const enabled = process.env.SLIDEFORGE_AGENT_INTEGRATION === "1";
const root = path.resolve(import.meta.dirname,"../..");
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const JSZip = createRequire(import.meta.url)("../../executas/ppt-engine/node_modules/jszip");
async function stop(child:ChildProcess) {
  if(child.exitCode!==null)return;
  if(process.platform==="win32") {const killer=spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});await once(killer,"exit");}
  else {child.kill("SIGTERM");await Promise.race([once(child,"exit"),delay(5000)]);if(child.exitCode===null)child.kill("SIGKILL");}
}
const validHtml = (title:string,overflow=false) => `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}.slide{width:1920px;height:1080px;overflow:hidden;position:relative;background:#fff;color:#182033}h1{position:absolute;top:${overflow?1200:80}px;left:80px;font-size:64px}</style></head><body><main class="slide"><h1>${title.replace(/[<>&]/g,"")}</h1></main></body></html>`;

test("four-process Harness confirms drafts, survives restart, repairs overflow, enforces budgets and exports idempotently", {skip:!enabled,timeout:600_000}, async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),"sf-agent-e2e-"));
  const reportDir=process.env.SLIDEFORGE_EVAL_REPORT_DIR;
  const metrics:any={provider:"local-fake-model",completed:false,requests:[],checks:{}};
  const started=performance.now();
  const measure=async(name:string,value:unknown)=>{metrics.checks[name]=value;if(reportDir)await writeFile(path.join(reportDir,"e2e-metrics.json"),JSON.stringify(metrics,null,2));};
  const ids:string[]=[];let child:ChildProcess|undefined;let log="",modelCalls=0,pageCalls=0,unknownInjected=false,overflowInjected=false,earlyCommitted=false,earlyId="";
  const model=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString());modelCalls++;
    const raw=body.messages.map((message:any)=>typeof message.content==="string"?message.content:"").join("\n");
    if(!body.tools) {
      if(raw.includes("PPT 大纲规划器")) {res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({title:"旧链路资料验收",pages:[{title:"第一页",bullets:["资料"]},{title:"第二页",bullets:["总结"]}]})}}],usage:{prompt_tokens:100,completion_tokens:100}}));return;}
      pageCalls++;
      const title=raw.includes("续改版本")?"续改版本":raw.match(/标题「([^」]+)」/)?.[1]??"页面";
      if(raw.includes("early-page-test")&&title.includes("二")) {
        for(let attempt=0;attempt<80;attempt++) {
          if(earlyId){const response=await fetch(base+`/decks/${earlyId}/project`,{headers:{"x-api-key":key}});const value=await response.json() as any;if(value.project?.pages.length===1){earlyCommitted=true;break;}}
          await delay(100);
        }
      }
      const overflow=raw.includes("inject-overflow")&&title.includes("一")&&!overflowInjected;
      if(overflow)overflowInjected=true;
      res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{role:"assistant",content:validHtml(title,overflow)}}],usage:{prompt_tokens:100,completion_tokens:100}}));return;
    }
    const parsedUsers=body.messages.filter((message:any)=>message.role==="user"&&typeof message.content==="string").flatMap((message:any)=>{try{return[JSON.parse(message.content)];}catch{return[];}});
    const initial=parsedUsers.find((value:any)=>value["需求"]), brief=initial?.["需求"]??"";
    if(brief.includes("unknown-test")&&!unknownInjected){unknownInjected=true;req.socket.destroy();return;}
    const names=new Map<string,string>(),argumentsById=new Map<string,any>();for(const message of body.messages)for(const call of message.tool_calls??[]){names.set(call.id,call.function.name);argumentsById.set(call.id,JSON.parse(call.function.arguments));}
    const results=body.messages.filter((message:any)=>message.role==="tool").map((message:any)=>({name:names.get(message.tool_call_id),args:argumentsById.get(message.tool_call_id),result:JSON.parse(message.content)}));
    const latest=(name:string)=>results.filter((item:any)=>item.name===name&&!item.result.error).at(-1)?.result;
    const resumed=parsedUsers.filter((value:any)=>value["恢复后的当前大纲"]).at(-1), saved=latest("save_plan")??(resumed?.["已确认大纲"]?{outline:resumed["恢复后的当前大纲"]}:undefined);
    const outline=resumed?.["恢复后的当前大纲"]?.pages?.length?resumed["恢复后的当前大纲"]:saved?.outline??initial?.["当前大纲"];
    let name:string,args:Record<string,unknown>;
    if(initial?.["本次修改指令"]){
      const target=initial["指定页"][0],visual=results.find((item:any)=>item.name==="inspect_deck"&&item.args.kinds.includes("visual")),content=results.find((item:any)=>item.name==="inspect_deck"&&item.args.kinds.includes("content"));
      if(!latest("revise_page")){name="revise_page";args={page_id:target,instruction:initial["本次修改指令"],issue_ids:[]};}
      else if(!visual){name="inspect_deck";args={kinds:["layout","visual"],page_ids:[target]};}
      else if(!content){name="inspect_deck";args={kinds:["content"],page_ids:outline.pages.map((page:any)=>page.page_id)};}
      else if(!results.some((item:any)=>item.name==="record_assessment"&&item.args.kind==="content")){name="record_assessment";args={kind:"content",page_ids:outline.pages.map((page:any)=>page.page_id),evidence_ids:[content.result.evidence_id],issues:[],global_summary:true};}
      else if(!results.some((item:any)=>item.name==="record_assessment"&&item.args.kind==="visual")){name="record_assessment";args={kind:"visual",page_ids:[target],evidence_ids:[visual.result.evidence_id],issues:[]};}
      else{name="finish_deck";args={assessment:"只重查修改页并复核全稿",check_ids:[],remaining_issues:[]};}
    }
    else if(!latest("read_project")){name="read_project";args={section:"context"};}
    else if(brief.includes("structure-test")&&!latest("request_user")){name="request_user";args={reason_code:"structure",question:"建议调整结构，请打开建议大纲编辑后确认",proposal:{draft_revision:1,title:"结构建议",pages:[{page_id:"proposal-a",title:"第一页",bullets:["说明"]},{page_id:"proposal-b",title:"第二页",bullets:["总结"]}]}};}
    else if(!saved){name="save_plan";args={scenario:{category:"企业",subtype:"产品发布",reason:"企业产品发布验收"},title:"Harness验收",pages:brief.includes("engine-load")?Array.from({length:initial["执行选项"].page_policy.count},(_,index)=>({title:`第${index+1}页`,bullets:["固定企业资料"]})):[{title:"第一页",bullets:["用户资料"]},{title:"第二页",bullets:["总结"]}]};}
    else if(!latest("generate_pages")){name="generate_pages";args={page_ids:outline.pages.map((page:any)=>page.page_id)};}
    else {
      const generated=latest("generate_pages");
      const repaired=latest("revise_page");
      const failed=generated.pages?.find((page:any)=>page.issues?.length&&!repaired?.pages?.some((fixed:any)=>fixed.page_id===page.page_id&&!fixed.issues?.length));
      const inspected=latest("inspect_deck");
      if(brief.includes("engine-load")) {
        const all=outline.pages.map((page:any)=>page.page_id);
        const batches=results.filter((item:any)=>item.name==="inspect_deck"&&item.args.kinds.includes("visual"));
        const assessed=new Set(results.filter((item:any)=>item.name==="record_assessment"&&item.args.kind==="visual").flatMap((item:any)=>item.args.evidence_ids));
        const pending=batches.find((item:any)=>!assessed.has(item.result.evidence_id));
        const covered=new Set(batches.flatMap((item:any)=>item.args.page_ids));
        const missing=all.filter((id:string)=>!covered.has(id));
        const content=results.find((item:any)=>item.name==="inspect_deck"&&item.args.kinds.includes("content"));
        if(pending){name="record_assessment";args={kind:"visual",page_ids:pending.args.page_ids,evidence_ids:[pending.result.evidence_id],issues:[]};}
        else if(missing.length){name="inspect_deck";args={kinds:["layout","visual"],page_ids:missing.slice(0,4)};}
        else if(!content){name="inspect_deck";args={kinds:["content"],page_ids:all};}
        else if(!results.some((item:any)=>item.name==="record_assessment"&&item.args.kind==="content")){name="record_assessment";args={kind:"content",page_ids:all,evidence_ids:[content.result.evidence_id],issues:[],global_summary:true};}
        else if(!latest("export_deck")){name="export_deck";args={format:initial["已授权导出格式"][0],revision_id:content.result.revision_id};}
        else{name="finish_deck";args={assessment:"固定输入并发验收通过",check_ids:[],remaining_issues:[]};}
      }
      else if(failed){name="revise_page";args={page_id:failed.page_id,instruction:"修复页面溢出，所有内容放在1920x1080画布内",candidate_id:failed.candidate_id,issue_ids:[]};}
      else if(!inspected){name="inspect_deck";args={kinds:["layout","content","visual"],page_ids:outline.pages.map((page:any)=>page.page_id)};}
      else if(!results.some((item:any)=>item.name==="record_assessment"&&item.result.check_id?.startsWith("content-"))){name="record_assessment";args={kind:"content",page_ids:outline.pages.map((page:any)=>page.page_id),evidence_ids:[inspected.evidence_id],issues:[],global_summary:true};}
      else if(!results.some((item:any)=>item.name==="record_assessment"&&item.result.check_id?.startsWith("visual-"))){name="record_assessment";args={kind:"visual",page_ids:outline.pages.map((page:any)=>page.page_id),evidence_ids:[inspected.evidence_id],issues:[],global_summary:false};}
      else if(initial?.["已授权导出格式"]?.length&&!latest("export_deck")){name="export_deck";args={format:initial["已授权导出格式"][0],revision_id:inspected.revision_id};}
      else {name="finish_deck";args={assessment:"三类检查通过",check_ids:results.filter((item:any)=>item.name==="record_assessment").map((item:any)=>item.result.check_id),remaining_issues:[]};}
    }
    res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{role:"assistant",content:null,tool_calls:[{id:`call-${modelCalls}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]}}],usage:{prompt_tokens:100,completion_tokens:100}}));
  });
  model.listen(0,"127.0.0.1");await once(model,"listening");const modelPort=(model.address() as any).port;
  const port=45000+Math.floor(Math.random()*600),base=`http://127.0.0.1:${port}`;
  const env={...process.env,NODE_ENV:"development",GATEWAY_PORT:String(port),PORT:String(port+700),ENGINE_PORT:String(port+701),BRAIN_PORT:String(port+702),SLIDEFORGE_DATA_DIR:dataDir,
    ENGINE_UPSTREAM_URL:`http://127.0.0.1:${port+700}`,NODE_ENGINE_URL:`http://127.0.0.1:${port+701}`,BRAIN_URL:`http://127.0.0.1:${port+702}`,
    SLIDEFORGE_BILLING_API_URL:`${base}/internal`,SLIDEFORGE_JOB_API_URL:`${base}/internal/jobs`,SLIDEFORGE_FILE_API_URL:`${base}/internal/files`,SLIDEFORGE_ENGINE_API_URL:`${base}/internal/engine`,SLIDEFORGE_BRAIN_API_URL:`http://127.0.0.1:${port+702}/internal/brain`,
    GATEWAY_INTERNAL_TOKEN:"agent-e2e-internal",SLIDEFORGE_ADMIN_TOKEN:"agent-e2e-admin",OPENAI_API_KEY:"fake-model-key",OPENAI_BASE_URL:`http://127.0.0.1:${modelPort}`,OPENAI_MODEL:"fake-agent-model",
    AGENT_INPUT_CNY_PER_MILLION:"2",AGENT_OUTPUT_CNY_PER_MILLION:"8",AGENT_PRICING_VERSION:"fixture"};
  const launch=async()=>{
    child=spawn(process.execPath,["scripts/dev-services.mjs"],{cwd:root,env,stdio:["ignore","pipe","pipe"],windowsHide:true});
    child.stdout?.on("data",chunk=>{log+=chunk});child.stderr?.on("data",chunk=>{log+=chunk});
    for(let attempt=0;attempt<250;attempt++){try{if((await fetch(base+"/readyz")).ok)return;}catch{}if(child.exitCode!==null)throw new Error(log);await delay(100);}
    throw new Error("services did not become ready\n"+log);
  };
  let key="";
  const request=async(route:string,body?:unknown,method=body===undefined?"GET":"POST")=>{
    const began=performance.now();
    const response=await fetch(base+route,{method,headers:{"content-type":"application/json","x-api-key":key},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json() as any;
    if(reportDir)metrics.requests.push({route:route.replace(/deck-[\w-]+/g,"{deck_id}"),method,status:response.status,ms:performance.now()-began});
    return {status:response.status,data};
  };
  const wait=async(id:string,phase:string)=>{
    let last:any;
    for(let attempt=0;attempt<400;attempt++){last=(await request(`/decks/${id}`)).data;if(last.agent?.phase===phase)return last;if(["failed","interrupted","waiting_user","paused_budget"].includes(last.agent?.phase)&&phase!==last.agent.phase)throw new Error(JSON.stringify(last)+"\n"+log);await delay(100);}
    throw new Error("phase timeout "+JSON.stringify(last)+"\n"+log);
  };
  const exportRequest=async(id:string,body:unknown)=>{
    const start=await request(`/decks/${id}/export`,body);assert.equal(start.status,202,JSON.stringify(start.data));
    for(let attempt=0;attempt<1200;attempt++) {
      const polled=await request(start.data.status_url);
      if(polled.data.state==="completed")return {status:200,data:polled.data.result};
      if(polled.data.error||["failed","cancelled"].includes(polled.data.state))throw new Error(JSON.stringify(polled.data));
      await delay(1000);
    }
    throw new Error("export timed out");
  };
  const create=async(brief:string,mode="direct",cost=2)=>{
    const response=await request("/decks",{brief,source_text:"用户提供：产品面向企业市场部门。",agent_options:{version:1,generation_mode:mode,page_policy:{mode:"fixed",count:2},research_allowed:false,budget:{active_seconds:600,estimated_cost_cny:cost}}});
    assert.equal(response.status,202,JSON.stringify(response.data));ids.push(response.data.deck_id);return response.data.deck_id as string;
  };
  try {
    await launch();
    const issued=await fetch(base+"/admin/keys",{method:"POST",headers:{"content-type":"application/json","x-admin-token":"agent-e2e-admin"},body:JSON.stringify({name:"agent-e2e",points:100})});key=(await issued.json() as any).key;assert.ok(key);
    const id=await create("企业产品发布，先规划一下", "direct");
    const waiting=await wait(id,"waiting_outline");assert.equal(waiting.agent.options.generation_mode,"outline_first");
    const before=(await request(`/decks/${id}/project`)).data;
    const revised={...before.draft,title:"用户确认的文稿",pages:[...before.draft.pages].reverse()};revised.pages[0].title="用户编辑后的标题";
    const save=await request(`/decks/${id}/outline-draft`,{expected_draft_revision:waiting.agent.draft_revision,title:revised.title,pages:revised.pages},"PUT");assert.equal(save.status,200);
    const stale=await request(`/decks/${id}/outline-confirm`,{draft_revision:waiting.agent.draft_revision});assert.equal(stale.status,409);
    const draftRestart=performance.now(),callsBeforeRestart=modelCalls;await stop(child!);await launch();
    const reopened=(await request(`/decks/${id}/project`)).data;assert.equal(reopened.draft.title,revised.title);assert.equal(reopened.agent.phase,"waiting_outline");
    assert.deepEqual(reopened.project.sources,before.project.sources);assert.deepEqual(reopened.project.constraints,before.project.constraints);
    assert.equal(modelCalls,callsBeforeRestart);
    await measure("draft_restart",{ms:performance.now()-draftRestart,sources_restored:reopened.project.sources.length,constraints_restored:reopened.project.constraints.length,extra_model_calls:modelCalls-callsBeforeRestart,phase:reopened.agent.phase});
    const confirm=await request(`/decks/${id}/outline-confirm`,{draft_revision:save.data.agent.draft_revision});assert.equal(confirm.status,200,JSON.stringify(confirm.data));
    const finished=await wait(id,"completed");assert.equal(finished.agent.quality_state,"checked");
    const project=(await request(`/decks/${id}/project`)).data.project;assert.equal(project.pages.length,2);assert.equal(project.outline.pages[0].title,"用户编辑后的标题");
    if(reportDir){
      const pageRestart=performance.now(),priorCalls=modelCalls;await stop(child!);await launch();
      const restored=(await request(`/decks/${id}/project`)).data;
      assert.deepEqual(restored.project.pages,project.pages);assert.deepEqual(restored.project.sources,project.sources);assert.deepEqual(restored.project.constraints,project.constraints);assert.equal(restored.agent.phase,"completed");assert.equal(modelCalls,priorCalls);
      await measure("page_restart",{ms:performance.now()-pageRestart,pages_restored:restored.project.pages.length,sources_restored:restored.project.sources.length,constraints_restored:restored.project.constraints.length,extra_model_calls:modelCalls-priorCalls});
    }
    const useBefore=(await request("/usage")).data;assert.equal(useBefore.balance,100,"generation must not charge product points");
    const exported=await exportRequest(id,{format:"pptx",idempotency_key:"agent-test-pptx"});assert.equal(exported.status,200,JSON.stringify(exported.data));assert.ok(exported.data.download_url);
    const download=await fetch(base+exported.data.download_url,{headers:{"x-api-key":key}});assert.equal(download.status,200);
    const firstPptx=await JSZip.loadAsync(Buffer.from(await download.arrayBuffer()));
    assert.match(await firstPptx.file("ppt/slides/slide1.xml").async("string"),/用户编辑后的标题/);
    assert.ok((await firstPptx.file("ppt/slides/slide2.xml").async("string")).includes(project.outline.pages[1].title));
    assert.equal((await fetch(base+exported.data.download_url)).status,402);
    const duplicate=await exportRequest(id,{format:"pptx",idempotency_key:"agent-test-pptx"});assert.equal(duplicate.data.idempotent,true);
    const afterDuplicate=(await request("/usage")).data.balance;assert.equal(afterDuplicate,90);assert.equal(duplicate.data.file_id,exported.data.file_id);
    await measure("duplicate_export",{requests:2,unique_file_ids:new Set([exported.data.file_id,duplicate.data.file_id]).size,expected_first_charge:10,observed_total_charge:useBefore.balance-afterDuplicate,extra_charge:useBefore.balance-afterDuplicate-10});
    const edit=await request(`/decks/${id}/agent-revise`,{page_ids:[project.pages[0].page_id],instruction:"将本页标题改为续改版本",expected_project_revision:project.revision_id});assert.equal(edit.status,202,JSON.stringify(edit.data));await wait(id,"completed");
    const edited=(await request(`/decks/${id}/project`)).data.project;assert.equal(edited.pages[1].page_revision,project.pages[1].page_revision);assert.notEqual(edited.pages[0].page_revision,project.pages[0].page_revision);assert.ok(edited.page_constraints[project.pages[0].page_id].some((value:any)=>value.text.includes("续改版本")));
    await measure("single_page_edit",{requested_pages:1,changed_pages:edited.pages.filter((page:any,index:number)=>page.page_revision!==project.pages[index].page_revision).length,untargeted_pages:1,untargeted_changed:edited.pages.slice(1).filter((page:any,index:number)=>page.page_revision!==project.pages[index+1].page_revision).length});
    const history=(await request(`/decks/${id}/pages/${project.pages[0].page_id}/history`)).data;assert.ok(history.length>=2);
    const rolled=await request(`/decks/${id}/pages/${project.pages[0].page_id}/rollback`,{target_page_revision:project.revision_id,expected_project_revision:edited.revision_id});assert.equal(rolled.status,200,JSON.stringify(rolled.data));assert.equal(rolled.data.agent.quality_state,"draft");assert.deepEqual(rolled.data.project.page_constraints,edited.page_constraints);
    const invalid=await request(`/decks/${id}/page-html`,{page:1,html:'<script>alert(1)</script>'});assert.notEqual(invalid.status,200);
    const manual=await request(`/decks/${id}/page-html`,{page:1,html:validHtml("手动保存版本")});assert.equal(manual.status,200,JSON.stringify(manual.data));
    const afterManual=(await request(`/decks/${id}/project`)).data.project;
    const corrected=await request(`/decks/${id}/scenario`,{expected_project_revision:afterManual.revision_id,scenario:{category:"旅游",subtype:"周末旅行",reason:"用户纠正"}});assert.equal(corrected.status,200,JSON.stringify(corrected.data));assert.equal(corrected.data.project.scenario.user_confirmed,true);
    assert.equal((await request("/usage")).data.balance,90,"edits and rollback must not charge product points");
    const historicalExport=await exportRequest(id,{format:"pptx",revision_id:rolled.data.project.revision_id,idempotency_key:"agent-test-pptx"});assert.equal(historicalExport.status,200,JSON.stringify(historicalExport.data));assert.ok(historicalExport.data.export_id);
    const historicalDownload=await fetch(base+historicalExport.data.download_url,{headers:{"x-api-key":key}});
    const historicalPptx=await JSZip.loadAsync(Buffer.from(await historicalDownload.arrayBuffer()));
    const firstSlide=await historicalPptx.file("ppt/slides/slide1.xml").async("string");assert.match(firstSlide,/用户编辑后的标题/);assert.doesNotMatch(firstSlide,/续改版本|手动保存版本/);
    const pdf=await exportRequest(id,{format:"pdf",revision_id:rolled.data.project.revision_id,idempotency_key:"agent-test-pdf"});assert.equal(pdf.status,200,JSON.stringify(pdf.data));
    const pdfDownload=await fetch(base+pdf.data.download_url,{headers:{"x-api-key":key}});assert.equal(pdfDownload.status,200);assert.equal(Buffer.from(await pdfDownload.arrayBuffer()).subarray(0,5).toString(),"%PDF-");
    assert.equal((await request("/usage")).data.balance,70,"each new revision/format export charges once");
    const initialPageCalls=pageCalls;const repairedId=await create("企业产品发布 inject-overflow");await wait(repairedId,"completed");assert.equal(pageCalls-initialPageCalls,3,"repair only the overflowing page");
    await measure("overflow_repair",{pages:2,injected_bad_pages:1,page_calls:pageCalls-initialPageCalls,repair_page_calls:pageCalls-initialPageCalls-2});
    const callsBeforeBudget=modelCalls,limited=await create("企业产品发布 budget-test","direct",0.00000001);const paused=await wait(limited,"paused_budget");
    assert.equal(modelCalls,callsBeforeBudget);
    await measure("budget_block",{provider_calls:modelCalls-callsBeforeBudget,phase:paused.agent.phase});
    const added=await request(`/decks/${limited}/continue`,{expected_checkpoint:paused.agent.checkpoint_seq,budget_addition:{active_seconds:10,estimated_cost_cny:1}});assert.equal(added.status,200);const resumed=await wait(limited,"completed");assert.equal(resumed.agent.budget.limit_seconds,610);assert.ok(resumed.agent.budget.active_seconds>=paused.agent.budget.active_seconds);
    const unknown=await create("企业产品发布 unknown-test");const interrupted=await wait(unknown,"interrupted");assert.equal(interrupted.agent.unknown_calls.length,1);
    const callsBeforeDenied=modelCalls,denied=await request(`/decks/${unknown}/continue`,{expected_checkpoint:interrupted.agent.checkpoint_seq});assert.equal(denied.status,409);assert.equal(modelCalls,callsBeforeDenied);
    await measure("unknown_without_consent",{unknown_calls:interrupted.agent.unknown_calls.length,continue_status:denied.status,extra_provider_calls:modelCalls-callsBeforeDenied});
    const accepted=await request(`/decks/${unknown}/continue`,{expected_checkpoint:interrupted.agent.checkpoint_seq,retry_unknown_call_ids:interrupted.agent.unknown_calls.map((call:any)=>call.call_id),budget_addition:{estimated_cost_cny:1}});assert.equal(accepted.status,200,JSON.stringify(accepted.data));await wait(unknown,"completed");
    const callsBeforeConflict=modelCalls;
    const conflict=await request("/decks",{brief:"生成2页企业介绍",agent_options:{version:1,page_policy:{mode:"fixed",count:3}}});assert.equal(conflict.status,202);ids.push(conflict.data.deck_id);
    const pageConflict=await wait(conflict.data.deck_id,"waiting_user");assert.equal(pageConflict.agent.request.reason_code,"page_policy");assert.equal(modelCalls,callsBeforeConflict,"explicit conflict should not spend a model call");
    const acceptedCount=await request(`/decks/${conflict.data.deck_id}/respond`,{request_id:pageConflict.agent.request.request_id,expected_checkpoint:pageConflict.agent.checkpoint_seq,accept_page_count:true});assert.equal(acceptedCount.status,200,JSON.stringify(acceptedCount.data));assert.equal(acceptedCount.data.agent.options.page_policy.count,2);await wait(conflict.data.deck_id,"completed");
    const structure=await create("企业介绍 structure-test"),proposal=await wait(structure,"waiting_user");
    const proposed=await request(`/decks/${structure}/respond`,{request_id:proposal.agent.request.request_id,expected_checkpoint:proposal.agent.checkpoint_seq,accept_outline:true});assert.equal(proposed.status,200,JSON.stringify(proposed.data));assert.equal(proposed.data.agent.phase,"waiting_outline");
    const proposedProject=(await request(`/decks/${structure}/project`)).data;assert.equal(proposedProject.draft.title,"结构建议");
    const approved=await request(`/decks/${structure}/outline-confirm`,{draft_revision:proposedProject.agent.draft_revision});assert.equal(approved.status,200,JSON.stringify(approved.data));await wait(structure,"completed");
    const badOwner=await fetch(base+`/decks/${id}/project`,{headers:{"x-api-key":"wrong-key"}});assert.notEqual(badOwner.status,200);
    earlyId=await create("企业产品发布 early-page-test");await wait(earlyId,"completed");assert.equal(earlyCommitted,true,"a fast page must be committed while the sibling provider call is still pending");
    if(process.env.SLIDEFORGE_ENGINE_LOAD==="1") {
      const started=Date.now(),loads:any[]=[];let peakActive=0;
      for(let index=0;index<5;index++) {
        const issued=await fetch(base+"/admin/keys",{method:"POST",headers:{"content-type":"application/json","x-admin-token":"agent-e2e-admin"},body:JSON.stringify({name:`engine-load-${index}`,points:100})});
        const loadKey=(await issued.json() as any).key,count=index===4?20:6;
        const created=await fetch(base+"/decks",{method:"POST",headers:{"content-type":"application/json","x-api-key":loadKey},body:JSON.stringify({brief:`企业产品介绍 engine-load-${index}，请导出${index===4?"PDF":"PPTX"}`,agent_options:{version:1,generation_mode:"direct",page_policy:{mode:"fixed",count},budget:{active_seconds:600,estimated_cost_cny:2}}})});
        const body=await created.json() as any;assert.equal(created.status,202,JSON.stringify(body));ids.push(body.deck_id);loads.push({id:body.deck_id,key:loadKey,pages:count});
      }
      while(loads.some(load=>!load.done)) {
        let active=0;
        for(const load of loads) {
          if(load.done)continue;
          const value=await (await fetch(base+`/decks/${load.id}`,{headers:{"x-api-key":load.key}})).json() as any;
          if(["planning","generating","checking","revising"].includes(value.agent?.phase))active++;
          if(["failed","interrupted","waiting_user","paused_budget"].includes(value.agent?.phase))throw new Error(JSON.stringify(value));
          if(value.agent?.phase==="completed"){load.done=true;load.ms=Date.now()-started;load.budget=value.agent.budget;assert.equal(value.agent.quality_state,"checked");}
        }
        peakActive=Math.max(peakActive,active);if(Date.now()-started>360000)throw new Error("5-user generation timed out");await delay(500);
      }
      assert.equal(peakActive,5,"all five customers must make progress concurrently");
      const loadMetrics={peak_active_projects:peakActive,provider:"local-fake-model",engine_concurrency:1,loads:loads.map(({key,...load})=>load)};
      await writeFile(reportDir?path.join(reportDir,"load-metrics.json"):path.join(root,".scratch/engine-job-service/harness-load-metrics.json"),JSON.stringify(loadMetrics,null,2));
      await measure("five_customers",{completed:loads.filter(load=>load.done).length,pages:loads.reduce((sum,load)=>sum+load.pages,0),peak_active:peakActive});
    }
    const legacy=await request("/decks",{brief:"生成2页资料验收",page_count:2,source_text:"source-marker-retained"});assert.equal(legacy.status,202);ids.push(legacy.data.deck_id);
    let legacyJob;for(let attempt=0;attempt<300;attempt++){legacyJob=(await request(`/decks/${legacy.data.deck_id}`)).data;if(legacyJob.status!=="creating")break;await delay(100);}assert.equal(legacyJob.status,"ready",JSON.stringify(legacyJob));
    const {readFile}=await import("node:fs/promises");assert.match(await readFile(path.join(root,"artifacts/decks",legacy.data.deck_id,"brief.txt"),"utf8"),/source-marker-retained/);
    metrics.completed=true;
  } finally {
    if(child)await stop(child);model.close();await once(model,"close");
    await writeFile(reportDir?path.join(reportDir,"agent-services.log"):path.join(root,".scratch/python-brain-harness/agent-e2e.log"),log);
    if(reportDir){metrics.elapsed_ms=performance.now()-started;metrics.local_model_calls=modelCalls;metrics.local_page_calls=pageCalls;metrics.early_page_visible=earlyCommitted;await writeFile(path.join(reportDir,"e2e-metrics.json"),JSON.stringify(metrics,null,2));}
    const targetRoot=path.join(root,"artifacts/decks");
    for(const id of ids){const target=path.resolve(targetRoot,id);if(path.dirname(target)!==targetRoot||!/^[\w-]+$/.test(id))throw new Error("unsafe test cleanup target");await rm(target,{recursive:true,force:true});}
  }
});
