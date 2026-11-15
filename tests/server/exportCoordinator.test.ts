import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {beginEngineExport} from "../../src/server/exportCoordinator.js";
import {runIdempotentExport} from "../../src/server/exportCoordinator.js";
import {createHash} from "node:crypto";

test("exports submit immutable inputs and stable operation IDs to the durable coordinator",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"engine-export-")),runDir=path.join(root,"deck-test");await mkdir(runDir);
 const requests:any[]=[];
 const server=createServer(async(req,res)=>{if(req.method==="GET"){res.writeHead(200);res.end("{}");return;}const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push({route:req.url,body});res.setHeader("content-type","application/json");res.end(JSON.stringify(req.url==="/artifacts"?{artifact:{artifact_id:"fixed",sha256:"hash",size_bytes:1}}:{job:{...body.request,job_id:"engine-one",state:"queued"}}))});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const oldNode=process.env.NODE_ENGINE_URL;const old=process.env.SLIDEFORGE_ENGINE_API_URL;process.env.SLIDEFORGE_ENGINE_API_URL=`http://127.0.0.1:${(server.address() as any).port}`;
 process.env.NODE_ENGINE_URL=process.env.SLIDEFORGE_ENGINE_API_URL;
 try {
  await writeFile(path.join(runDir,"outline.json"),JSON.stringify({title:"test",pages:[{},{}]}));await writeFile(path.join(runDir,"deck.html"),"fixed");for(const i of [1,2])await writeFile(path.join(runDir,`page-${i}.html`),"<html>fixed</html>");
  const input={ownerKeyHash:"owner",deckId:"deck-test",runDir,format:"pptx" as const,outPath:path.join(runDir,"deck.pptx"),idempotencyKey:"client-key"};
  await Promise.all([beginEngineExport(input),beginEngineExport(input)]);
  const submits=requests.filter(item=>item.route==="/jobs");assert.equal(submits[0].body.request.operation_id,submits[1].body.request.operation_id);
  const fresh=await beginEngineExport({...input,idempotencyKey:undefined}),next=await beginEngineExport({...input,idempotencyKey:undefined});
  assert.notEqual(fresh.operation_id,next.operation_id,"an explicit retry without a key must not remain stuck on a failed operation");
  assert.equal(JSON.stringify(requests).includes(runDir.replaceAll("\\","\\\\")),false);
  assert.ok(requests.every(item=>item.route==="/jobs"||item.route==="/artifacts"));
  await assert.rejects(beginEngineExport({...input,idempotencyKey:"bad key"}),/Idempotency-Key/);
  const oldData=process.env.SLIDEFORGE_DATA_DIR;process.env.SLIDEFORGE_DATA_DIR=root;
  try {
    const fingerprint=createHash("sha256").update("pptx\0fixed").digest("hex"),id=createHash("sha256").update("owner\0deck-test\0pptx\0key:client-key").digest("hex");
    await writeFile(path.join(root,"export-receipts.json"),JSON.stringify({[id]:{operationId:id,fingerprint,result:{download_url:"/files/previous",file_id:"file-old"},charge:{points:10,balance:90}}}));
    const before=requests.length;assert.equal((await runIdempotentExport(input)).file_id,"file-old");assert.equal(requests.length,before);
  }finally{if(oldData===undefined)delete process.env.SLIDEFORGE_DATA_DIR;else process.env.SLIDEFORGE_DATA_DIR=oldData}
  await writeFile(path.join(runDir,"project.json"),JSON.stringify({deck_id:"deck-test",revision_id:"partial",pages:[1,2].map(i=>({page_id:`p${i}`,html_ref:`page-${i}.html`}))}));
  await writeFile(path.join(runDir,"outline.json"),JSON.stringify({title:"test",pages:[{},{},{}]}));
  await assert.rejects(beginEngineExport(input),/页面尚未完整/);
 } finally {if(oldNode===undefined)delete process.env.NODE_ENGINE_URL;else process.env.NODE_ENGINE_URL=oldNode;if(old===undefined)delete process.env.SLIDEFORGE_ENGINE_API_URL;else process.env.SLIDEFORGE_ENGINE_API_URL=old;await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});
