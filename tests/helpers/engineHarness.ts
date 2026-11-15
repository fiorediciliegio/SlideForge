import { spawn,type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { buildDeckHtml,splitSlideDocument } from "../../scripts/m0/deck.js";
export const testOwner=(key:string)=>createHash("sha256").update(key).digest("hex");
export async function testPort() {const server=createServer();await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const port=(server.address() as any).port as number;await new Promise<void>(resolve=>server.close(()=>resolve()));return port}
export async function stopChild(child:ChildProcess) {
 if(!child.pid||child.exitCode!==null)return;
 if(process.platform==="win32") {const killer=spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});await once(killer,"exit")}
 else {process.kill(-child.pid,"SIGKILL");await once(child,"exit")}
}
export async function waitHealthy(base:string,child?:ChildProcess) {
 for(let i=0;i<150;i++) {if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error("test service exited");try{if((await fetch(base+"/healthz")).ok)return}catch{}await new Promise(resolve=>setTimeout(resolve,100))}
 throw new Error(`service not healthy: ${base}`);
}
export async function engineHarness(concurrency=1) {
 const root=await mkdtemp(path.join(os.tmpdir(),"slideforge-engine-test-")),gatewayPort=await testPort(),enginePort=await testPort();
 const data=path.join(root,"gateway"),work=path.join(root,"engine-only"),business=path.join(root,"business-only");await Promise.all([mkdir(data),mkdir(work),mkdir(business)]);
 const keys=Array.from({length:10},(_,i)=>`sk-engine-synthetic-${i}`);
 await writeFile(path.join(data,"api-keys.json"),JSON.stringify(Object.fromEntries(keys.map(key=>[testOwner(key),{name:key,balance:1000}]))));
 const base=`http://127.0.0.1:${gatewayPort}`,env={...process.env,GATEWAY_PORT:String(gatewayPort),ENGINE_PORT:String(enginePort),NODE_ENGINE_URL:`http://127.0.0.1:${enginePort}`,NODE_ENV:"development",SLIDEFORGE_DATA_DIR:data,SLIDEFORGE_ENGINE_API_URL:`${base}/internal/engine`,GATEWAY_INTERNAL_TOKEN:"engine-test-only",ENGINE_WORK_ROOT:work,ENGINE_CONCURRENCY:String(concurrency),DATABASE_URL:"",JOBS_DATABASE_URL:"",FILES_DATABASE_URL:""};
 const logs:string[]=[];
 function spawnTest(command:string,args:string[],cwd:string){const child=spawn(command,args,{cwd,env,stdio:["ignore","pipe","pipe"],windowsHide:true,detached:process.platform!=="win32"});child.stdout?.on("data",chunk=>logs.push(String(chunk)));child.stderr?.on("data",chunk=>logs.push(String(chunk)));return child}
 const gateway=spawnTest(process.env.SLIDEFORGE_GO_BINARY!,[],path.resolve(import.meta.dirname,"../../services/gateway"));
 let engine:ChildProcess|undefined;
 try{await waitHealthy(base,gateway);engine=spawnTest(process.execPath,["--import","tsx/esm",path.resolve(import.meta.dirname,"../../src/http/engineServer.ts")],path.resolve(import.meta.dirname,"../.."));await waitHealthy(`http://127.0.0.1:${enginePort}`,engine)}catch(error){await stopChild(gateway);if(engine)await stopChild(engine);throw new Error(String(error)+logs.slice(-10).join("\n"))}
 const previous={node:process.env.NODE_ENGINE_URL,engine:process.env.SLIDEFORGE_ENGINE_API_URL,token:process.env.GATEWAY_INTERNAL_TOKEN};process.env.NODE_ENGINE_URL=env.NODE_ENGINE_URL;process.env.SLIDEFORGE_ENGINE_API_URL=env.SLIDEFORGE_ENGINE_API_URL;process.env.GATEWAY_INTERNAL_TOKEN=env.GATEWAY_INTERNAL_TOKEN;
 return {root,data,work,business,base,keys,logs,get engine(){return engine!},gateway,
  async restartEngine(){await stopChild(engine!);engine=spawnTest(process.execPath,["--import","tsx/esm",path.resolve(import.meta.dirname,"../../src/http/engineServer.ts")],path.resolve(import.meta.dirname,"../.."));await waitHealthy(`http://127.0.0.1:${enginePort}`,engine)},
  async close(){await stopChild(engine!);await stopChild(gateway);if(previous.node===undefined)delete process.env.NODE_ENGINE_URL;else process.env.NODE_ENGINE_URL=previous.node;if(previous.engine===undefined)delete process.env.SLIDEFORGE_ENGINE_API_URL;else process.env.SLIDEFORGE_ENGINE_API_URL=previous.engine;if(previous.token===undefined)delete process.env.GATEWAY_INTERNAL_TOKEN;else process.env.GATEWAY_INTERNAL_TOKEN=previous.token;await rm(root,{recursive:true,force:true})}
 };
}
export async function fixedWorkspace(root:string,count:number,id=`deck-fixed-${count}`) {
 const directory=path.join(root,id);await mkdir(directory,{recursive:true});const slides=[];
 for(let i=1;i<=count;i++) {
  const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0}main.slide{width:1920px;height:1080px;background:#f4f6fc;box-sizing:border-box;padding:100px;color:#123;font-family:Arial}h1{font-size:80px}p{font-size:40px}.cards{display:flex;gap:40px}.card{width:700px;padding:40px;background:white;border-radius:20px}</style></head><body><main class="slide"><h1>SlideForge 固定验收 ${i}</h1><p>企业产品介绍 · 质量与效率</p><div class="cards"><div class="card"><p>效率提升73%</p><p>12个业务团队</p></div><div class="card"><p>版本固定</p><p>跨机器任务交付</p></div></div></main></body></html>`;
  await writeFile(path.join(directory,`page-${i}.html`),html);slides.push(splitSlideDocument(html));
 }
 await writeFile(path.join(directory,"outline.json"),JSON.stringify({title:"固定验收",pages:slides.map(()=>({title:"固定页",bullets:[]}))}));await writeFile(path.join(directory,"deck.html"),buildDeckHtml({title:"固定验收",slides}));return directory;
}
