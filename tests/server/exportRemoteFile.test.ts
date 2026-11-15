import assert from "node:assert/strict";
import {createServer} from "node:http";
import test from "node:test";
import {engineExportStatus} from "../../src/server/exportCoordinator.js";

test("completed exports use the Go delivery receipt without a second Node charge",async()=>{
 const calls:string[]=[];
 const server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body.action);res.setHeader("content-type","application/json");res.end(JSON.stringify(body.action==="get"?{job:{job_id:"engine-one",deck_id:"deck-test",kind:"export",state:"completed"}}:{file_id:"file-one",download_url:"/files/file-one",billing:{points:10,balance:90}}))});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const old=process.env.SLIDEFORGE_ENGINE_API_URL;process.env.SLIDEFORGE_ENGINE_API_URL=`http://127.0.0.1:${(server.address() as any).port}`;
 try{const status=await engineExportStatus("deck-test","owner","engine-one");assert.equal(status.result?.download_url,"/files/file-one");assert.deepEqual(calls,["get","deliver"])}
 finally{if(old===undefined)delete process.env.SLIDEFORGE_ENGINE_API_URL;else process.env.SLIDEFORGE_ENGINE_API_URL=old;await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
