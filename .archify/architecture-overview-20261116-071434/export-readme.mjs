import {createRequire} from 'node:module';
import {mkdir,rename,access,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';
const folder=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(folder,'../..');
const require=createRequire(path.join(root,'executas/ppt-engine/package.json'));
const puppeteer=require('puppeteer-core');
const downloadDir=path.join(folder,'evidence/exports');
await mkdir(downloadDir,{recursive:true});await mkdir(path.join(root,'docs/images'),{recursive:true});
const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',args:['--no-sandbox','--disable-gpu']});
try{
 const page=await browser.newPage();await page.setViewport({width:1440,height:1000,deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const cdp=await page.createCDPSession();
 await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true});
 await page.goto(pathToFileURL(path.join(folder,'slideforge-overview.html')).href,{waitUntil:'load'});
 await page.evaluate(()=>document.fonts.ready);
 for(const[format,name]of [['svg','architecture.svg'],['png','architecture.png']]){
  const target=path.join(root,'docs/images',name);
  try{await access(target);throw new Error('输出已存在，拒绝覆盖：'+target)}catch(e){if(e.code!=='ENOENT')throw e}
  const done=new Promise((resolve,reject)=>{
   let file;
   const timer=setTimeout(()=>{cleanup();reject(new Error('导出超时：'+format))},30000);
   function begin(event){file=event.suggestedFilename}
   function progress(event){if(event.state==='completed'){cleanup();resolve(file)}else if(event.state==='canceled'){cleanup();reject(new Error('导出取消'))}}
   function cleanup(){clearTimeout(timer);cdp.off('Browser.downloadWillBegin',begin);cdp.off('Browser.downloadProgress',progress)}
   cdp.on('Browser.downloadWillBegin',begin);cdp.on('Browser.downloadProgress',progress);
  });
  await page.click('#btn-export');await page.click('button[data-format="'+format+'"]');
  const downloaded=await done;await rename(path.join(downloadDir,downloaded),target);
  console.log(JSON.stringify({format,file:target}));
 }
 if(errors.length)throw new Error(errors.join('\n'));
 const svg=await readFile(path.join(root,'docs/images/architecture.svg'),'utf8');
 if(/<script\b|<foreignObject\b/i.test(svg))throw new Error('静态导出包含不适合README的活动内容');
 await writeFile(path.join(folder,'evidence/export-result.json'),JSON.stringify({svg_bytes:Buffer.byteLength(svg),browser_errors:errors,canonical:true},null,2));
}finally{await browser.close()}

