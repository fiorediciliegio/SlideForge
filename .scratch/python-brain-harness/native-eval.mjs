import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp,writeFile,readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root=path.resolve(import.meta.dirname,"../.."),dataDir=await mkdtemp(path.join(os.tmpdir(),"sf-native-eval-"));
const port=47901,base=`http://127.0.0.1:${port}`,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cases=[
 {id:"enterprise-product",expected:"企业",brief:"生成2页中文企业产品介绍，受众是企业市场部门。产品名为演示助手，功能只有读取用户资料、生成演示、导出PPTX。第一页介绍产品，第二页总结价值。不得编造数字或日期，不要联网，不要导出文件，直接生成预览。"},
 {id:"enterprise-brand",expected:"企业",brief:"生成2页企业品牌传播方案。品牌是青禾咖啡，定位为社区日常咖啡，关键词是亲切、清爽、稳定。第一页表达品牌定位，第二页列出门店海报和公众号两种触点。不编造经营数据，不联网，只交付预览。"},
 {id:"enterprise-marketing",expected:"企业",brief:"制作2页企业市场活动提案。活动为产品体验日，面向现有客户，包含签到、产品体验、反馈收集三个环节。第一页目标与流程，第二页准备事项。无已确定日期和预算，不得编造数字，不联网，只需预览。"},
 {id:"tourism",expected:"旅游",brief:"生成2页北京周末旅行指南。只使用这些资料：地点为颐和园与天坛；旅行偏好为慢步行和拍照；不列门票价格、营业时间或交通班次。第一页行程，第二页出行准备。这是旅游用途，不是商务项目，不联网，不自动导出。"},
 {id:"education",expected:"学术/教育",brief:"生成2页初中数学教学演示，主题是勾股定理。只使用直角三角形两直角边平方和等于斜边平方这一事实；例子仅用3、4、5边长。第一页概念，第二页例子。不得编造历史人名或统计数字。不联网，仅预览。"},
 {id:"long-source",expected:"企业",brief:"生成2页企业资料汇报，请读取附件文本后规划，必须使用最后一节的核验数据：第一页面向市场部门汇总项目，第二页专门呈现末节的两个核验指标。不能忽略资料后半部分。不联网，不导出。",source_text:"【资料前段，仅为验收构造的企业项目说明】\n"+"项目的目标是规范演示资料的整理和复用。各段落仅是过程说明，不含新的统计指标。".repeat(450)+"\n【最后一节：必须覆盖的核验数据】\n资料复用率为73%，已确认模板数量为12个。仅为本次验收的虚构数据。"},
];
let prior;
try{prior=JSON.parse(await readFile(new URL("./native-eval.json",import.meta.url),"utf8"));}catch(error){if(error.code!=="ENOENT")throw error;}
const records=prior?.model===process.env.OPENAI_MODEL?prior.records.map(record=>({...record,data_dir:record.data_dir??prior.data_dir})):[];
const selected=cases.slice(0,Number(process.argv[2]??1)).filter(fixture=>!records.some(record=>record.id===fixture.id&&record.phase==="completed"&&record.baseline));let log="",key="";
const child=spawn(process.execPath,["scripts/dev-services.mjs"],{cwd:root,env:{...process.env,NODE_ENV:"development",GATEWAY_PORT:String(port),PORT:String(port+1),ENGINE_PORT:String(port+2),BRAIN_PORT:String(port+3),SLIDEFORGE_DATA_DIR:dataDir,GATEWAY_INTERNAL_TOKEN:"native-eval-internal",SLIDEFORGE_ADMIN_TOKEN:"native-eval-admin"},stdio:["ignore","pipe","pipe"],windowsHide:true});
child.stdout.on("data",chunk=>{log+=chunk});child.stderr.on("data",chunk=>{log+=chunk});
async function api(route,body,admin=false) {const response=await fetch(base+route,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",...(admin?{"x-admin-token":"native-eval-admin"}:{"x-api-key":key})},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${value.error}`);return value;}
try {
 let ready=false;for(let attempt=0;attempt<300;attempt++){try{if((await fetch(base+"/readyz")).ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await pause(100);}if(!ready)throw new Error("验收服务未就绪");
 key=(await api("/admin/keys",{name:"isolated-native-eval",points:1000},true)).key;
 for(const fixture of selected){
  let record=records.find(item=>item.id===fixture.id&&item.phase==="completed");
  if(!record){
  const started=Date.now(),created=await api("/decks",{brief:fixture.brief,source_text:fixture.source_text,agent_options:{version:1,generation_mode:"direct",page_policy:{mode:"fixed",count:2},research_allowed:false,budget:{active_seconds:600,estimated_cost_cny:2}}});
  let lastPhase,job;
  for(let attempt=0;attempt<630;attempt++){
   job=await api(`/decks/${created.deck_id}`);
   if(job.agent.phase!==lastPhase){lastPhase=job.agent.phase;console.log(`[native-eval] ${fixture.id}: ${lastPhase}`);}
   if(["completed","failed","cancelled","interrupted","paused_budget","waiting_user","waiting_outline"].includes(lastPhase))break;
   await pause(1000);
  }
  const project=(await api(`/decks/${created.deck_id}/project`)).project;
  record={id:fixture.id,deck_id:created.deck_id,data_dir:dataDir,phase:job.agent.phase,scene:project.scenario,expected_scene:fixture.expected,page_count:project.pages.length,elapsed_seconds:(Date.now()-started)/1000,budget:job.agent.budget,quality:job.agent.quality_state,error:job.agent.error,request:job.agent.request,project_revision:project.revision_id};
  records.push(record);await writeFile(new URL("./native-eval.json",import.meta.url),JSON.stringify({model:process.env.OPENAI_MODEL,data_dir:dataDir,records},null,2));console.log(JSON.stringify(record));
  if(record.phase!=="completed"||record.quality!=="checked"||record.scene.category!==fixture.expected){process.exitCode=1;break;}
  }
  const baselineStarted=Date.now(),baseline=await api("/decks",{brief:fixture.brief,source_text:fixture.source_text,page_count:2});let oldJob;
  for(let attempt=0;attempt<630;attempt++){oldJob=await api(`/decks/${baseline.deck_id}`);if(["ready","error"].includes(oldJob.status))break;await pause(1000);}
  const usage=await api("/usage"),entries=usage.entries.filter(entry=>entry.deck_id===baseline.deck_id);
  record.baseline={deck_id:baseline.deck_id,data_dir:dataDir,status:oldJob.status,elapsed_seconds:(Date.now()-baselineStarted)/1000,overflow_pages:oldJob.overflow_pages,error:oldJob.error,estimated_cost_cny:entries.reduce((total,entry)=>total+((entry.prompt_tokens??0)*Number(process.env.AGENT_INPUT_CNY_PER_MILLION)+(entry.completion_tokens??0)*Number(process.env.AGENT_OUTPUT_CNY_PER_MILLION))/1e6,0)};
  await writeFile(new URL("./native-eval.json",import.meta.url),JSON.stringify({model:process.env.OPENAI_MODEL,data_dir:dataDir,records},null,2));console.log(`[native-eval] ${fixture.id} baseline: ${oldJob.status} ${record.baseline.elapsed_seconds}s`);
 }
} finally {
 await writeFile(new URL("./native-eval-services.log",import.meta.url),log);
 if(child.exitCode===null){if(process.platform==="win32"){const killer=spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});await once(killer,"exit");}else{child.kill("SIGTERM");await Promise.race([once(child,"exit"),pause(5000)]);if(child.exitCode===null)child.kill("SIGKILL");}}
}
