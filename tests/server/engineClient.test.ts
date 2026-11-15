import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,writeFile,rm,mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotWorkspace,submitEngineSnapshot,waitEngineJob } from "../../src/server/engineClient.js";
import { deckJobs } from "../../src/server/jobs.js";
import { engineTransport } from "../../src/server/engineTransport.js";

test("snapshot contains fixed HTML and never exposes the business directory",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"deck-engine-input-"));
 try {
  await writeFile(path.join(root,"outline.json"),JSON.stringify({title:"fixed",pages:[{title:"one"}]}));
  await writeFile(path.join(root,"page-1.html"),"<html>original</html>");await writeFile(path.join(root,"deck.html"),"<html>original deck</html>");
  const snapshot=await snapshotWorkspace(root);await writeFile(path.join(root,"page-1.html"),"changed");
  assert.equal(snapshot.pages[0].html,"<html>original</html>");assert.equal(JSON.stringify(snapshot).includes(root),false);
 }finally{await rm(root,{recursive:true,force:true})}
});
test("a cancelled Agent cannot consume a cached completed engine result",async()=>{
 const id="deck-cached-fenced",original=engineTransport.read;let reads=0;
 deckJobs.set(id,{id,agent:{run_seq:1,runner_epoch:2,phase:"cancelled"}} as any);
 engineTransport.read=async()=>{reads++;return Buffer.from("{}")};
 try {await assert.rejects(waitEngineJob({state:"completed",job_id:"engine-cached",owner_key_hash:"owner",result_ref:"saved"} as any,{agent:{deck_id:id,run_seq:1,runner_epoch:1}}),/原 Agent 执行已失效/);assert.equal(reads,0)}
 finally{engineTransport.read=original;deckJobs.delete(id)}
});
test("snapshot embeds image assets without rewriting captions or presentation hyperlinks",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"deck-engine-assets-"));
 try {
  await mkdir(path.join(root,"assets"));await writeFile(path.join(root,"assets/logo.svg"),'<svg xmlns="http://www.w3.org/2000/svg"/>');
  const html='<html><head></head><body><p>assets/logo.svg</p><img src="assets/logo.svg"><a href="https://example.com">企业网站</a></body></html>';
  await writeFile(path.join(root,"outline.json"),JSON.stringify({title:"assets",pages:[{}]}));await writeFile(path.join(root,"page-1.html"),html);await writeFile(path.join(root,"deck.html"),html);
  const snapshot=await snapshotWorkspace(root);assert.match(snapshot.pages[0].html,/<p>assets\/logo.svg<\/p>/);assert.match(snapshot.pages[0].html,/src="data:image\/svg\+xml;base64,/);assert.match(snapshot.pages[0].html,/href="https:\/\/example.com"/);
 }finally{await rm(root,{recursive:true,force:true})}
});
test("engine unavailable is reported and does not execute a local fallback",async()=>{
 const server=createServer((_req,res)=>{res.writeHead(503,{"content-type":"application/json"});res.end(JSON.stringify({error:"engine offline"}))});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const previous=process.env.SLIDEFORGE_ENGINE_API_URL;process.env.SLIDEFORGE_ENGINE_API_URL=`http://127.0.0.1:${(server.address() as any).port}`;
 try {await assert.rejects(submitEngineSnapshot({schema_version:1,deck_id:"deck-one",title:"one",pages:[{page_id:"p1",html:"fixed"}]},"validate",{}),/engine offline/)}
 finally{if(previous===undefined)delete process.env.SLIDEFORGE_ENGINE_API_URL;else process.env.SLIDEFORGE_ENGINE_API_URL=previous;await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
