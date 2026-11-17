import {readFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const dir=path.resolve(process.argv[2]);
const deadline=Date.now()+2*3600_000;
while(Date.now()<deadline){
 const meta=JSON.parse(await readFile(path.join(dir,'metadata.json'),'utf8'));
 const ledger=JSON.parse(await readFile(path.join(dir,'model-ledger.json'),'utf8'));
 const inflight=ledger.calls.filter(call=>call.status==='inflight');
 const sample={time:new Date().toISOString(),machine_total_bytes:os.totalmem(),machine_free_bytes:os.freemem(),
  inflight_calls:inflight.length,inflight_pages:inflight.filter(call=>call.kind==='page').length,
  completed_calls:ledger.calls.filter(call=>call.status==='completed').length};
 await appendFile(path.join(dir,'resource-samples.jsonl'),JSON.stringify(sample)+'\n');
 if(meta.status!=='running')break;
 await new Promise(resolve=>setTimeout(resolve,10_000));
}
