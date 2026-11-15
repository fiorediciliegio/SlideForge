// One final local-only scoring pass: keep original measurements; reuse engine reports/screenshots.
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {score} from './score.mjs';
const out=path.resolve(process.argv[2]),meta=JSON.parse(await readFile(path.join(out,'metadata.json'),'utf8'));
const fixtures=JSON.parse(await readFile(new URL('./20261112-172000/fixtures.json',import.meta.url),'utf8'));
for(const record of meta.records.filter(r=>r.score)){
 const dir=path.join(out,record.id);
 await copyFile(path.join(dir,'score.json'),path.join(dir,'score-initial.json'));
 await copyFile(path.join(dir,'visible-text.json'),path.join(dir,'visible-text-initial.json'));
 record.initial_score=record.score;
 await score(record,fixtures.cases.find(c=>c.id===record.case_id),dir,record.raw_job,true);
 await writeFile(path.join(dir,'record.json'),JSON.stringify(record,null,2));
 console.log(record.id,record.score.facts_hit+'/'+record.score.facts_total,record.score.section_hits+'/4');
}
meta.scoring_finalized_at=new Date().toISOString();meta.scoring_note='Local-only rerender of visible text, excluding hidden descendants and text fully outside the canvas; original score/text retained. Existing deterministic layout reports reused. No model requests.';
await writeFile(path.join(out,'metadata.json'),JSON.stringify(meta,null,2));
