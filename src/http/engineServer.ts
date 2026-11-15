import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { loadDotEnv } from "../server/env.js";
import { runEngineWorker } from "../engine/worker.js";
import { closeExportPool } from "../engine/exportPool.js";
import { engineQueueConnected } from "../server/engineTransport.js";
import { executeSnapshot } from "../engine/executor.js";
import { closeValidatorBrowser } from "../../scripts/m0/validatePage.js";
loadDotEnv();
const concurrency=Number(process.env.ENGINE_CONCURRENCY??1);
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error("ENGINE_CONCURRENCY 必须为1–8的整数");
if(!process.env.GATEWAY_INTERNAL_TOKEN)throw new Error("引擎需要 GATEWAY_INTERNAL_TOKEN，请通过 npm run dev 启动");
if(process.env.ENGINE_WORK_ROOT)await mkdir(process.env.ENGINE_WORK_ROOT,{recursive:true});
const controller=new AbortController();
const server=createServer((req,res)=>{
  res.setHeader("content-type","application/json; charset=utf-8");
  if(req.method==="GET"&&req.url==="/healthz"){const ready=engineQueueConnected();res.statusCode=ready?200:503;return res.end(JSON.stringify({ok:ready,service:"slideforge-engine",concurrency}))}
  res.writeHead(404);res.end(JSON.stringify({error:"not found"}));
});
server.listen(Number(process.env.ENGINE_PORT??3211),()=>console.log(`[slideforge-engine] listening; heavy concurrency=${concurrency}`));
const work=runEngineWorker(controller.signal,concurrency,executeSnapshot);
let stopping=false;
async function shutdown(){
  if(stopping)return;stopping=true;controller.abort();server.close();server.closeAllConnections();
  await work;await closeExportPool();await closeValidatorBrowser();
}
process.once("SIGINT",()=>void shutdown());process.once("SIGTERM",()=>void shutdown());
