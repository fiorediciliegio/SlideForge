import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { engineSnapshotSchema,type EngineJob,type EngineResult } from "../contracts/engine.js";
import { buildDeckHtml,splitSlideDocument } from "../../scripts/m0/deck.js";
import { executeExport } from "./exportPool.js";
import { inspectSlideHtmlFile,inspectHtmlPages } from "../../scripts/m0/validatePage.js";

// This is a trust boundary. Snapshots must not execute user JS, fetch URLs or
// read files on the worker. Browser CSP also confines embedded SVG resources.
export function confinedHTML(html:string):string {
  if(/<(?:script|iframe|object|embed|base|link|audio|video)\b|\bon[a-z]+\s*=|@import\b|<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html))throw new Error("引擎输入必须是无脚本、自包含 HTML");
  const resources=html.replace(/<a\b([^>]*)>/gi,tag=>tag.replace(/\bhref\s*=\s*(["'])https?:\/\/[^"']+\1/gi,""));
  for(const match of resources.matchAll(/\b(?:src|href|xlink:href|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)){
    const value=match[1]??match[2]??match[3];if(value&&!value.startsWith("data:")&&!value.startsWith("#"))throw new Error("引擎输入含未内嵌资源");
  }
  for(const match of html.matchAll(/url\(\s*["']?([^)"']+)/gi)){const value=match[1].trim();if(!value.startsWith("data:")&&!value.startsWith("#"))throw new Error("引擎输入含未内嵌 CSS 资源")}
  const csp=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">`;
  return html.replace(/<head\b[^>]*>/i,match=>match+csp);
}


export async function executeSnapshot(input:Buffer,job:EngineJob,signal:AbortSignal):Promise<EngineResult & {file?:Buffer}> {
  const start=performance.now(),snapshot=engineSnapshotSchema.parse(JSON.parse(input.toString("utf8")));
  if(snapshot.deck_id!==job.deck_id)throw new Error("输入归属与引擎任务不符");
  const temporary=await mkdtemp(path.join(process.env.ENGINE_WORK_ROOT??os.tmpdir(),"slideforge-engine-"));
  try {
    const pages=snapshot.pages.map(page=>({...page,html:confinedHTML(page.html)}));
    const deck=confinedHTML(snapshot.deck_html??buildDeckHtml({title:snapshot.title,slides:pages.map(page=>splitSlideDocument(page.html))}));
    await writeFile(path.join(temporary,"deck.html"),deck);
    for(let index=0;index<pages.length;index++)await writeFile(path.join(temporary,`page-${index+1}.html`),pages[index].html);
    let result:EngineResult & {file?:Buffer};
    if(job.kind==="export") {
      if(pages.length<2)throw new Error("导出至少需要2页");
      const format=job.params.format??"pptx",output=await executeExport({directory:temporary,title:snapshot.title,count:pages.length,format},signal);
      result={file:await readFile(output.outPath),name:`${snapshot.title.replace(/[\\/:*?"<>|\r\n]/g,"-").slice(0,60)||"deck"}.${format}`,media_type:format==="pdf"?"application/pdf":"application/vnd.openxmlformats-officedocument.presentationml.presentation",slide_count:pages.length,warnings:output.warnings};
    } else {
      const targets=job.params.pages??pages.map((_,index)=>index+1),results:NonNullable<EngineResult["pages"]>=[];
      if(targets.some(number=>!Number.isInteger(number)||!pages[number-1]))throw new Error("引擎页码越界");
      const batch=job.kind==="inspect"?await inspectHtmlPages(path.join(temporary,"deck.html"),targets,{signal,capture:job.params.visual??false}):undefined;
      for(const number of targets) {
        signal.throwIfAborted();const source=pages[number-1];if(!source)throw new Error(`引擎页码越界 ${number}`);
        const report=job.kind==="inspect"?batch!.find(page=>page.page===number)!:await inspectSlideHtmlFile(path.join(temporary,`page-${number}.html`),{signal,capture:job.params.visual??false});
        results.push({page:number,page_id:source.page_id,...(job.params.layout!==false?{report:{ok:report.ok,issues:report.issues}}:{}),...(report.image?{image:report.image}:{})});
      }
      result={pages:results};
    }
    signal.throwIfAborted();return {...result,timings_ms:{execution:performance.now()-start}};
  } finally {await rm(temporary,{recursive:true,force:true})}
}
