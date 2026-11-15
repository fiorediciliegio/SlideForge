import path from "node:path";
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { runExportOnly } from "../../executas/ppt-engine/src/export-only/index.js";
import { buildDeckHtml,splitSlideDocument } from "../../scripts/m0/deck.js";

export interface ExportTask {directory:string;title:string;count:number;format:"pptx"|"pdf"}
export async function runLocalExport({directory,title,count,format}:ExportTask) {
 const base={request_id:`export-${process.pid}`,source_root:directory,deck_html_file:"deck.html",expected_slide_count:count,title,output_dir:directory};
 const slides:string[]=[];
 if(format==="pdf") {
  await mkdir(path.join(directory,"pdf-pages"));
  for(let index=1;index<=count;index++) {
   const html=await readFile(path.join(directory,`page-${index}.html`),"utf8");
   const name=`pdf-pages/page-${index}.html`;await writeFile(path.join(directory,name),buildDeckHtml({title,slides:[splitSlideDocument(html)]}));slides.push(name);
  }
 }
 const result=format==="pdf"?await runExportOnly({...base,format,slide_html_files:slides}):await runExportOnly({...base,format});
 if(result.status!=="completed")throw new Error(result.error?.message??"导出失败");
 return {outPath:result.output_path!,warnings:result.warnings};
}
