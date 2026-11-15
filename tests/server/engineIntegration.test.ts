import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {buildDeckHtml,splitSlideDocument} from "../../scripts/m0/deck.js";
import {createServer} from "node:http";
import { engineHarness,fixedWorkspace,testOwner } from "../helpers/engineHarness.js";
import { snapshotWorkspace,submitEngineSnapshot,waitEngineJob } from "../../src/server/engineClient.js";
import { beginEngineExport,engineExportStatus } from "../../src/server/exportCoordinator.js";
import { engineTransport } from "../../src/server/engineTransport.js";

test("isolated engine renders immutable snapshots, recovers a worker and delivers each export once",{skip:!process.env.SLIDEFORGE_GO_BINARY,timeout:360000},async()=>{
 const h=await engineHarness(),owner=testOwner(h.keys[0]);
 try {
  const runDir=await fixedWorkspace(h.business,6),snapshot=await snapshotWorkspace(runDir);
  let outsideRequests=0;const remote=createServer((_req,res)=>{outsideRequests++;res.end("private")});
  await new Promise<void>(resolve=>remote.listen(0,"127.0.0.1",resolve));
  try {
    const address=`http://127.0.0.1:${(remote.address() as any).port}/private`;
    const escaped={...snapshot,pages:snapshot.pages.slice(0,2).map(page=>({...page,html:page.html.replace("</style>",`.card{background-image:image-set("${address}" 1x)}</style>`)})),deck_html:snapshot.deck_html!.replace("</style>",`.card{background-image:image-set("${address}" 1x)}</style>`)};
    escaped.deck_html=buildDeckHtml({title:escaped.title,slides:escaped.pages.map(page=>splitSlideDocument(page.html))});
    for(const format of ["pdf","pptx"] as const){const job=await submitEngineSnapshot(escaped,"export",{format},{ownerKeyHash:owner});await assert.rejects(waitEngineJob(job),/outside|unreadable/)}
    assert.equal(outsideRequests,0,"PDF and PPTX must not access resources outside the snapshot");
  }finally{await new Promise<void>(resolve=>remote.close(()=>resolve()))}
  const input={ownerKeyHash:owner,deckId:snapshot.deck_id,runDir,format:"pptx" as const,outPath:"unused"};
  const first=await beginEngineExport(input),repeated=await beginEngineExport(input);assert.equal(repeated.job_id,first.job_id);
  await rm(runDir,{recursive:true,force:true});
  await waitEngineJob(first);
  const delivered=await engineExportStatus(snapshot.deck_id,owner,first.job_id),again=await engineExportStatus(snapshot.deck_id,owner,first.job_id);
  assert.equal(delivered.result?.file_id,again.result?.file_id);
  const response=await fetch(h.base+delivered.result!.download_url,{headers:{"x-api-key":h.keys[0]}});assert.equal(response.status,200);assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,2).toString(),"PK");
  assert.equal((await fetch(h.base+delivered.result!.download_url,{headers:{"x-api-key":h.keys[1]}})).status,404);
  const inspection=await submitEngineSnapshot(snapshot,"inspect",{pages:[1,6],layout:true,visual:true},{ownerKeyHash:owner});
  const report=await waitEngineJob(inspection);assert.equal(report.pages?.length,2);assert.ok(report.pages?.every(page=>page.report?.ok&&page.image));
  const pdf=await submitEngineSnapshot(snapshot,"export",{format:"pdf"},{ownerKeyHash:owner});
  let running=pdf;while(running.state==="queued"){await new Promise(resolve=>setTimeout(resolve,100));running=await engineTransport.get(pdf.job_id,owner)}
  await h.restartEngine();
  const finished=await waitEngineJob(pdf);const recovered=await engineTransport.get(pdf.job_id,owner);assert.equal(recovered.attempt,2);
  assert.equal((await engineTransport.read(finished.file_ref!,owner)).subarray(0,4).toString(),"%PDF");
  await assert.rejects(engineTransport.update(pdf.job_id,running.lease_token!,"complete",recovered.result_ref),/租约|身份/);
  const cancelled=await submitEngineSnapshot({...snapshot,title:"cancelled"},"export",{format:"pdf"},{ownerKeyHash:owner});await engineTransport.cancel(cancelled.job_id,owner);
  assert.equal((await engineTransport.get(cancelled.job_id,owner)).state,"cancelled");
 }catch(error){console.error(h.logs.slice(-15).join("\n"));throw error}finally{await h.close()}
});
