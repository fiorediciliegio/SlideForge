import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {getSharedBrowser,closeValidatorBrowser} from '../../scripts/m0/validatePage.ts';
import {inspectEngineWorkspace} from '../../src/server/engineClient.ts';

export async function score(record,fixture,dir,rawJob,reuseInspection=false) {
  await mkdir(dir,{recursive:true});const started=performance.now(),runDir=rawJob.runDir;
  const inspection=reuseInspection?{pages:JSON.parse(await readFile(path.join(dir,'score-initial.json'),'utf8')).reports}:await inspectEngineWorkspace(runDir,{layout:true,visual:true},{ownerKeyHash:rawJob.ownerKeyHash});
  const reports=[];
  for(const item of inspection.pages??[]){if(item.image)await writeFile(path.join(dir,`page-${item.page}.jpg`),Buffer.from(item.image,'base64'));reports.push({...item,image:undefined});}
  const browser=await getSharedBrowser(),page=await browser.newPage();let visible;
  try {
    await page.setJavaScriptEnabled(false);await page.setViewport({width:1920,height:1080});
    await page.goto(pathToFileURL(path.join(runDir,'deck.html')).href,{waitUntil:'networkidle0'});
    visible=await page.evaluate(()=>{
      return [...document.querySelectorAll('[data-presenton-slide-shell]')].map((shell,index)=>{
        const root=shell.querySelector('main.slide')??shell,blocks=new Set(),headings=[],groups=new Map();
        const isVisible=el=>{for(let p=el;p&&p!==shell.parentElement;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}const r=el.getBoundingClientRect();return r.width>0&&r.height>0;};
        const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
        while(node=walk.nextNode()){
          const el=node.parentElement;
          if(!node.textContent.trim()||/^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)||!isVisible(el))continue;
          const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect(),bounds=root.getBoundingClientRect();
          if(r.bottom<=bounds.top||r.top>=bounds.bottom||r.right<=bounds.left||r.left>=bounds.right)continue;
          const text=node.textContent.trim();blocks.add(text);
          for(let p=el;p&&p!==root.parentElement;p=p.parentElement){if(!groups.has(p))groups.set(p,[]);groups.get(p).push(text);}
        }
        for(const [el,texts] of groups){const text=texts.join(' ');if(text.length<=240)blocks.add(text);if(el.matches('h1,h2,h3,h4,[role="heading"]')||(text.length<=100&&parseFloat(getComputedStyle(el).fontSize)>=40))headings.push(text);}
        return {page:index+1,blocks:[...blocks],headings};
      });
    });
  }finally{await page.close();await closeValidatorBrowser();}
  const norm=s=>s.normalize('NFKC').replace(/\s+/g,'');
  const facts=fixture.facts.map(f=>{
    const n=norm(f.subject),value=norm(f.value+f.unit);let match;
    const hasValue=block=>{const text=norm(block);let i=text.indexOf(value);while(i>=0){if(i===0||!/[0-9.+−-]/.test(text[i-1]))return true;i=text.indexOf(value,i+1);}return false;};
    for(const p of visible)for(const block of p.blocks)if(norm(block).includes(n)&&hasValue(block)&&!match)match={page:p.page,text:block};
    return {...f,matched:!!match,value_present:visible.some(p=>p.blocks.some(hasValue)),evidence:match};
  });
  const sections=fixture.sections.map(title=>({title,matched:visible.some(p=>p.headings.some(h=>norm(h).includes(norm(title))))}));
  const overflow=reports.filter(p=>p.report?.ok===false).map(p=>p.page);
  const result={page_count:visible.length,page_count_ok:visible.length===6,facts,facts_hit:facts.filter(f=>f.matched).length,facts_total:facts.length,sections,section_hits:sections.filter(s=>s.matched).length,overflow_pages:overflow,layout_ok:reports.length===visible.length&&reports.length>0&&reports.every(p=>p.report?.ok),reports,scoring_ms:performance.now()-started};
  result.rules_pass=result.page_count_ok&&result.facts_hit===result.facts_total&&result.section_hits===sections.length&&result.layout_ok;
  await writeFile(path.join(dir,'visible-text.json'),JSON.stringify(visible,null,2));await writeFile(path.join(dir,'score.json'),JSON.stringify(result,null,2));
  record.score=result;return result;
}
