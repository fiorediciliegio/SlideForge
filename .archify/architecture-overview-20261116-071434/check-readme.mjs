import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const folder=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(folder,'../..');
const puppeteer=createRequire(path.join(root,'executas/ppt-engine/package.json'))('puppeteer-core');
const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',args:['--no-sandbox','--disable-gpu']});
try{
 const page=await browser.newPage();await page.setViewport({width:1440,height:1100});
 const rows=[];
 for(const theme of ['light','dark']){
  await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);
  await page.goto(pathToFileURL(path.join(root,'docs/images/architecture.svg')).href,{waitUntil:'load'});
  await page.evaluate(()=>document.fonts.ready);
  rows.push(await page.evaluate(theme=>({theme,nodes:document.querySelectorAll('[data-node-id]').length,connections:document.querySelectorAll('[data-edge-id]').length,overflow:document.documentElement.scrollWidth>window.innerWidth}),theme));
  await page.screenshot({path:path.join(folder,'evidence/svg-'+theme+'.png'),fullPage:true});
 }
 const readme=await readFile(path.join(root,'README.md'),'utf8');
 const svg=readme.match(/!\[[^\]]*\]\((docs\/images\/architecture\.svg)\)/)[1];
 const preview='<!doctype html><html><meta charset="utf-8"><style>body{margin:40px auto;max-width:1000px;font:16px/1.7 system-ui;color:#1f2328}img{max-width:100%;height:auto}p{margin:16px 0}</style><h1>SlideForge</h1><h2>总体架构</h2><img src="'+pathToFileURL(path.join(root,svg)).href+'"><p>Python Brain 负责规划、工具决策与评审，业务 Node 执行页面生成和项目版本工具，Go 管理鉴权、状态、预算与引擎任务，独立 Node 引擎执行检查、预览和导出。</p>';
 const previewFile=path.join(folder,'evidence/readme-preview.html');
 await writeFile(previewFile,preview);
 await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:'light'}]);await page.goto(pathToFileURL(previewFile).href,{waitUntil:'load'});
 const embedded=await page.$eval('img',el=>({loaded:el.complete&&el.naturalWidth>0,width:el.getBoundingClientRect().width,naturalWidth:el.naturalWidth,overflow:document.documentElement.scrollWidth>window.innerWidth}));
 if(!embedded.loaded||embedded.overflow)throw new Error('README图像加载或宽度检查失败');
 await page.screenshot({path:path.join(folder,'evidence/readme-preview.png'),fullPage:true});
 console.log(JSON.stringify({svg:rows,readme:embedded}));
 await writeFile(path.join(folder,'evidence/readme-check.json'),JSON.stringify({svg:rows,readme:embedded},null,2));
}finally{await browser.close()}

