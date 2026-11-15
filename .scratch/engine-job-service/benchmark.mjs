// 固定输入、顺序暖启动；不调用模型。MODE=baseline 在重构前执行。
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { exportDeck, getDeckPreview } from '../../src/capabilities/deck.ts';
import { buildDeckHtml } from '../../scripts/m0/deck.ts';
import { validateSlideHtmlFile, closeValidatorBrowser } from '../../scripts/m0/validatePage.ts';
const mode=process.env.MODE??'baseline';
const root=await mkdtemp(path.join(os.tmpdir(),'slideforge-engine-benchmark-'));
const metrics=[];
let peakRSS=0;
const sampler=setInterval(()=>{peakRSS=Math.max(peakRSS,process.memoryUsage().rss)},100);
try {
 for(const count of [6,20]) {
  const runDir=path.join(root,`deck-benchmark-${count}`);
  const {mkdir}=await import('node:fs/promises');await mkdir(runDir);
  const slides=[];
  for(let i=1;i<=count;i++) {
   const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0}main.slide{width:1920px;height:1080px;background:#f4f6fc;box-sizing:border-box;padding:100px;color:#123;font-family:Arial}h1{font-size:80px}p{font-size:40px}.cards{display:flex;gap:40px}.card{width:700px;padding:40px;background:white;border-radius:20px}</style></head><body><main class="slide"><h1>SlideForge 固定验收 ${i}</h1><p>企业产品介绍 · 质量与效率</p><div class="cards"><div class="card"><p>效率提升73%</p><p>12个业务团队</p></div><div class="card"><p>版本固定</p><p>跨机器任务交付</p></div></div></main></body></html>`;
   await writeFile(path.join(runDir,`page-${i}.html`),html);
   const {splitSlideDocument}=await import('../../scripts/m0/deck.ts');slides.push(splitSlideDocument(html));
  }
  await writeFile(path.join(runDir,'outline.json'),JSON.stringify({title:'固定验收',pages:slides.map(()=>({title:'固定页',bullets:[]}))}));
  await writeFile(path.join(runDir,'deck.html'),buildDeckHtml({title:'固定验收',slides}));
  const actions={validate:()=>validateSlideHtmlFile(path.join(runDir,'page-1.html')),preview:()=>getDeckPreview({runDir,pages:[1,2,3,4]}),pptx:()=>exportDeck({runDir,format:'pptx'}),pdf:()=>exportDeck({runDir,format:'pdf'})};
  for(const [kind,action] of Object.entries(actions)) {
   await action();
   for(let round=0;round<5;round++){const start=performance.now();await action();metrics.push({pages:count,kind,round,ms:performance.now()-start});}
   await writeFile(new URL(`./${mode}-metrics.json`,import.meta.url),JSON.stringify({mode,metrics,peak_node_rss:peakRSS,hardware:{cpus:os.cpus().length,total_memory:os.totalmem(),free_memory:os.freemem()}},null,2));
   console.log(count,kind,'done');
  }
 }
}finally{clearInterval(sampler);await closeValidatorBrowser();await rm(root,{recursive:true,force:true});}
