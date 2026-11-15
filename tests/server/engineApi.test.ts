import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {testPort,waitHealthy,stopChild} from "../helpers/engineHarness.js";
import {engineSnapshotSchema} from "../../src/contracts/engine.js";
import {confinedHTML} from "../../src/engine/executor.js";

test("engine refuses local-directory APIs and snapshots reject executable or external resources",{timeout:30000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"engine-boundary-")),port=await testPort();
 const child=spawn(process.execPath,["--import","tsx/esm","src/http/engineServer.ts"],{cwd:path.resolve(import.meta.dirname,"../.."),env:{...process.env,ENGINE_PORT:String(port),GATEWAY_INTERNAL_TOKEN:"test-only",SLIDEFORGE_ENGINE_API_URL:"http://127.0.0.1:1/internal/engine",ENGINE_WORK_ROOT:root},stdio:"ignore"});
 try {
  const base=`http://127.0.0.1:${port}`;for(let i=0;i<100;i++){try{await fetch(base+"/healthz");break}catch{}await new Promise(resolve=>setTimeout(resolve,100))}
  for(const route of ["preview","export","validate-page"]){const response=await fetch(`${base}/internal/engine/${route}`,{method:"POST",headers:{"content-type":"application/json","x-internal-token":"test-only"},body:JSON.stringify({runDir:root})});assert.equal(response.status,404)}
  assert.throws(()=>engineSnapshotSchema.parse({schema_version:1,deck_id:"deck-test",title:"t",pages:[{page_id:"p1",html:"html"}],runDir:root}));
  for(const html of ['<script>alert(1)</script>','<img src="file:///private">','<style>@import "https://test";</style>','<svg onload="alert(1)"></svg>','<img src="https://test/image">'])assert.throws(()=>confinedHTML(html));
 }finally{await stopChild(child);await rm(root,{recursive:true,force:true})}
});
