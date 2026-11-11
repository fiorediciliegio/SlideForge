import { writeFile } from "node:fs/promises";
import { getSharedBrowser, closeValidatorBrowser } from "../../scripts/m0/validatePage.ts";

const key=process.env.OPENAI_API_KEY,base=process.env.OPENAI_BASE_URL?.replace(/\/$/,""),model=process.env.OPENAI_MODEL;
if(!key||!base||!model)throw new Error("模型配置不完整");
const inputPrice=Number(process.env.AGENT_INPUT_CNY_PER_MILLION),outputPrice=Number(process.env.AGENT_OUTPUT_CNY_PER_MILLION);
const limit=0.2;let spent=0,requests=0;
const started=Date.now();
async function call(messages,tools) {
 const payload={model,messages,tools,max_tokens:512,thinking:{type:"disabled"}};
 const reservation=(Buffer.byteLength(JSON.stringify(payload))*inputPrice+512*outputPrice)/1e6;
 if(!Number.isFinite(reservation)||spent+reservation>limit)throw new Error("能力探测预算不足，未发送请求");
 const response=await fetch(base+"/chat/completions",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${key}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});requests++;
 if(!response.ok)throw new Error(`能力探测 HTTP ${response.status}`);
 const result=await response.json();
 spent+=(result.usage.prompt_tokens*inputPrice+result.usage.completion_tokens*outputPrice)/1e6;
 return result.choices[0].message;
}
try {
 const browser=await getSharedBrowser(),page=await browser.newPage();
 await page.setViewport({width:640,height:320});await page.setContent('<body style="margin:0;background:white"><div style="background:#159447;color:white;padding:60px;font:80px Arial">SF41</div></body>');
 const screenshot=await page.screenshot({type:"png"});await page.close();
 const tools=[{type:"function",function:{name:"report_code",description:"报告截图中的文字验证码",parameters:{type:"object",properties:{code:{type:"string"}},required:["code"]}}}];
 const messages=[{role:"user",content:[{type:"text",text:"读取截图中的验证码，必须调用report_code报告。"},{type:"image_url",image_url:{url:`data:image/png;base64,${Buffer.from(screenshot).toString("base64")}`}}]}];
 const first=await call(messages,tools),tool=first.tool_calls?.[0];
 if(!tool||tool.function.name!=="report_code"||JSON.parse(tool.function.arguments).code!=="SF41")throw new Error("工具调用或截图识别不符合探测要求");
 messages.push(first,{role:"tool",tool_call_id:tool.id,content:'{"ok":true}'});
 const second=await call(messages,tools);if(!second.content)throw new Error("工具结果回传后缺少回答");
 const report={model,tool_call:true,image_input:true,tool_reply:true,requests,estimated_cost_cny:spent,budget_cny:limit,elapsed_seconds:(Date.now()-started)/1000};
 await writeFile(new URL("./model-capability.json",import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {await closeValidatorBrowser();}
