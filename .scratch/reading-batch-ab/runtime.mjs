import {registerHooks} from 'node:module';
import {readFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
await import('../harness-real-eval/redirect.mjs');
const root=path.resolve(import.meta.dirname,'../..'),arm=process.env.SF_AB_ARM;
if(!['before','after'].includes(arm))throw new Error('Missing frozen runtime selection');
const name='src/capabilities/agent.ts',target=pathToFileURL(path.join(root,name)).href;
const audit=JSON.parse(readFileSync(path.join(import.meta.dirname,'20261113/baseline-audit.json'),'utf8'));
const source=readFileSync(path.join(import.meta.dirname,'20261113',arm,name));
const hash=createHash('sha256').update(source).digest('hex');
if(hash!==audit.runtime_files.find(f=>f.file===name)[arm+'_sha256'])throw new Error('Frozen Node code hash changed');
registerHooks({load(url,context,next){
 if(url!==target)return next(url,context);
 appendFileSync(process.env.SF_AB_TRACE,JSON.stringify({language:'Node',pid:process.pid,arm,file:name,sha256:hash})+'\n');
 return {format:'module',source:ts.transpileModule(source.toString('utf8'),{fileName:'agent.ts',compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,shortCircuit:true};
}});
