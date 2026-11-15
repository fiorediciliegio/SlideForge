import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const out=path.resolve(process.argv[2]);
const json=async p=>JSON.parse(await readFile(path.join(out,p),'utf8'));
const meta=await json('metadata.json'),ledger=await json('model-ledger.json');
if(!['finished','stopped'].includes(meta.status))throw new Error('测评尚未结束');
const failures=[],per_case=[];
const demand=(ok,message)=>{if(!ok)failures.push(message)};
let globalPeak=0,active=0;
const events=ledger.calls.filter(c=>c.kind==='page').flatMap(c=>[[Date.parse(c.started_at),1],[Date.parse(c.finished_at),-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
for(const [,delta]of events){active+=delta;globalPeak=Math.max(globalPeak,active)}
demand(globalPeak<=2,'页面并发超过2');
demand(meta.records.length===6,'实际案例数不等于6');
demand(ledger.calls.every(c=>c.status==='completed'&&c.reserved_cny===0),'存在未知、未完成或未结算调用');
demand(ledger.calls.reduce((s,c)=>s+c.cost_peak_cny,0)<=15,'总费用超出15元');
for(const r of meta.records){
 const calls=ledger.calls.filter(c=>c.trial===r.id),budget=r.raw_job?.agent?.budget;
 const proxyCost=calls.reduce((s,c)=>s+c.cost_peak_cny,0);
 const nativeCalls=Object.values(r.raw_job?.agent?.calls??{});
 const files=await readdir(path.join(out,r.id),{recursive:true});
 const previews=files.filter(f=>/\.(?:jpg|jpeg)$/i.test(f)).length;
 const audit={case_id:r.case_id,calls:calls.length,native_calls:nativeCalls.length,proxy_peak_cny:proxyCost,native_peak_cny:budget?.spent_cny,
  cost_delta:Math.abs(proxyCost-(budget?.spent_cny??NaN)),active_seconds:budget?.active_seconds,remaining_reserve:budget?.reserved_cny,
  native_unknown:nativeCalls.filter(c=>c.status!=='completed').length,pptx:files.includes('deck.pptx'),previews};
 per_case.push(audit);
 demand(r.phase==='completed'&&r.delivery_success&&r.export?.pass,'案例未成功交付/PPTX检查失败：'+r.case_id);
 demand(audit.cost_delta<0.000001,'费用账本不一致：'+r.case_id);
 demand(budget.spent_cny<=2&&budget.active_seconds<=600&&budget.reserved_cny===0,'案例预算/预留异常：'+r.case_id);
 demand(nativeCalls.length===calls.length&&audit.native_unknown===0,'原生与代理调用不一致：'+r.case_id);
 demand(audit.pptx&&previews===6,'导出/预览文件数异常：'+r.case_id);
}
const result={status:failures.length?'failed':'passed',failures,page_concurrency_peak:globalPeak,system_fingerprints:[...new Set(ledger.calls.map(c=>c.system_fingerprint))],per_case};
await writeFile(path.join(out,'最终审计.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(failures.length)process.exitCode=1;
