// 8192运行协议专用代理；冻结v1代理保留原样。
import http from 'node:http';
import {appendFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';

export async function startProxy({out,key,port,upstreamFetch=fetch,limitCny=30,initialCalls=[]}) {
  const calls=[...initialCalls], trials=new Map(); let current, fatal;
  const persist=()=>writeFileSync(path.join(out,'model-ledger.json'),JSON.stringify({limit_cny:limitCny,fatal,calls},null,2));
  const used=(list)=>list.reduce((sum,c)=>sum+(c.cost_peak_cny??c.reserved_cny??0),0);
  const setTrial=(id,limit=2)=>{if(calls.some(c=>c.status==='inflight'))throw new Error('Previous provider request still in flight');current=id;trials.set(id,{limit,blocked:false});};
  const server=http.createServer(async(req,res)=>{
    const reject=(status,error)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error,type:'evaluation_gate'}}));};
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw), trial=trials.get(current);
      if(!trial||trial.blocked||fatal)return reject(409,'Evaluation trial is blocked; no provider dispatch');
      if(req.url!=='/chat/completions')return reject(400,'Unsupported evaluation route');
      const kind=body.tools?.length?'controller':String(body.messages?.[0]?.content).includes('大纲规划器')?'outline':'page';
      const before=body.max_tokens;body.max_tokens=kind==='page'?12000:kind==='controller'?8192:4096;body.stream=false;body.model='deepseek-flash';
      let images=0;
      const estimate=JSON.parse(JSON.stringify(body));
      for(const m of estimate.messages)if(Array.isArray(m.content))for(const p of m.content)if(p.type==='image_url'){images++;p.image_url={};}
      const inputBound=Buffer.byteLength(JSON.stringify(estimate))+images*1024+1024;
      const reserve=(inputBound*2+body.max_tokens*8)/1e6;
      if(used(calls)+reserve>limitCny||used(calls.filter(c=>c.trial===current))+reserve>trial.limit){trial.blocked=true;persist();return reject(409,'Evaluation budget reservation denied');}
      const call={id:calls.length+1,trial:current,kind,images,started_at:new Date().toISOString(),status:'inflight',reserved_cny:reserve,input_bound_tokens:inputBound,max_tokens:body.max_tokens,normalized_max_tokens:before!==body.max_tokens};
      calls.push(call);persist();
      writeFileSync(path.join(out,`request-${call.id}.json`),JSON.stringify(body));
      const started=performance.now();
      res.once('close',()=>{if(!res.writableEnded){trial.blocked=true;call.consumer_disconnected=true;persist();}});
      try {
        const upstream=await upstreamFetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(240000)});
        const bytes=await upstream.text();call.http_status=upstream.status;call.request_id=upstream.headers.get('x-request-id');
        writeFileSync(path.join(out,`response-${call.id}.json`),bytes);
        if(!upstream.ok){
          if(upstream.status>=400&&upstream.status<500){call.status='rejected';call.reserved_cny=0;fatal=`Provider HTTP ${upstream.status}`;}
          else {call.status='unknown';trial.blocked=true;fatal=`Provider HTTP ${upstream.status}, accounting uncertain`;}
          res.writeHead(upstream.status,{'content-type':'application/json'});res.end(bytes);return;
        }
        const result=JSON.parse(bytes),u=result.usage;
        if(!Number.isFinite(u?.prompt_tokens)||!Number.isFinite(u?.completion_tokens))throw new Error('Missing settlement usage');
        call.usage=u;call.model=result.model;call.created=result.created;call.system_fingerprint=result.system_fingerprint;
        call.finish_reason=result.choices?.[0]?.finish_reason;call.tool_names=result.choices?.[0]?.message?.tool_calls?.map(t=>t.function.name)??[];
        call.cost_peak_cny=(u.prompt_tokens*2+u.completion_tokens*8)/1e6;
        const bj=new Date(new Date(call.started_at).getTime()+8*3600000),h=bj.getUTCHours(),weekday=bj.getUTCDay();
        const peak=weekday>=1&&weekday<=5&&(h>=9&&h<12||h>=14&&h<18);
        const hit=u.prompt_cache_hit_tokens??0;
        call.cost_time_cache_cny=((u.prompt_tokens-hit)*(peak?2:1)+hit*(peak?.04:.02)+u.completion_tokens*(peak?8:4))/1e6;
        call.status='completed';call.reserved_cny=0;
        if(call.cost_peak_cny>reserve){fatal='Usage exceeded conservative reservation';trial.blocked=true;}
        res.writeHead(200,{'content-type':'application/json'});res.end(bytes);
      }catch(error){call.status='unknown';call.error=String(error);trial.blocked=true;fatal='Provider outcome unknown; no automatic retry';if(!res.destroyed)reject(502,'Provider outcome unknown');}
      finally{call.elapsed_ms=performance.now()-started;call.finished_at=new Date().toISOString();persist();appendFileSync(path.join(out,'model-events.jsonl'),JSON.stringify(call)+'\n');console.log(`[model] ${call.trial} #${call.id} ${call.kind} ${call.status} ${(call.cost_peak_cny??call.reserved_cny).toFixed(4)} CNY`);}
    }catch(error){fatal=String(error);persist();if(!res.destroyed)reject(500,'Evaluation proxy error');}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));persist();
  return {server,calls,setTrial,get fatal(){return fatal},block(){if(current)trials.get(current).blocked=true;persist();},spent:()=>used(calls)};
}
