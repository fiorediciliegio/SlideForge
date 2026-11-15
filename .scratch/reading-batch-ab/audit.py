"""Read-only audit of frozen runtime provenance and benchmark accounting."""
import hashlib
import json
from pathlib import Path

here=Path(__file__).resolve().parent
root=here.parents[1]
out=here/'20261113/results'
meta=json.loads((out/'metadata.json').read_text(encoding='utf-8'))
ledger=json.loads((out/'model-ledger.json').read_text(encoding='utf-8'))
audit=meta['baseline_audit']
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
checks={}
checks['all_twelve_recorded']=len(meta['records'])==12 and all(r.get('finished_at') for r in meta['records'])
checks['normal_finish']=meta['status']=='finished'
checks['all_provider_outcomes_settled']=all(c['status']=='completed' for c in ledger['calls'])
checks['global_budget_within_30']=sum(c.get('cost_peak_cny',c.get('reserved_cny',0)) for c in ledger['calls'])<=30
checks['frozen_files_unchanged']=all(digest(here/'20261113'/arm/f['file'])==f[arm+'_sha256'] for f in audit['runtime_files'] for arm in ['before','after'])
checks['current_runtime_unchanged']=all(digest(root/f['file'])==f['after_sha256'] for f in audit['runtime_files'])
manifest=json.loads((root/'.scratch/harness-real-eval/20261112-real-1/source-manifest.json').read_text(encoding='utf-8'))
excluded={f['file'] for f in audit['runtime_files']} | set(audit['other_changed_files'])
drift=[f['file'] for f in manifest if f['file'] not in excluded and (not (root/f['file']).exists() or digest(root/f['file'])!=f['sha256'])]
checks['shared_manifest_unchanged']=not drift
trials=[]
for r in meta['records']:
    tracefile=out/r['id']/'runtime-load.jsonl'
    trace=[json.loads(line) for line in tracefile.read_text(encoding='utf-8').splitlines()] if tracefile.exists() else []
    source_ok=all(any(t['file']==f['file'] and t['arm']==r['arm'] and t['sha256']==f[r['arm']+'_sha256'] for t in trace) for f in audit['runtime_files'])
    model=[c for c in ledger['calls'] if c['trial']==r['id']]
    spent=sum(c.get('cost_peak_cny',c.get('reserved_cny',0)) for c in model)
    native=r.get('raw_job',{}).get('agent',{}).get('budget',{}).get('spent_cny')
    trials.append({'id':r['id'],'frozen_runtime_verified':source_ok,'budget_within_2':spent<=2,'proxy_cny':spent,'native_cny':native,'accounting_match':native is not None and abs(spent-native)<1e-8,'delivery':r.get('delivery_success',False),'pptx_pass':r.get('export',{}).get('pass',False)})
checks['all_runtime_traces_match']=all(t['frozen_runtime_verified'] for t in trials)
checks['all_task_budgets_within_2']=all(t['budget_within_2'] for t in trials)
checks['all_accounting_matches']=all(t['accounting_match'] for t in trials)
checks['delivered_pptx_all_pass']=all(t['pptx_pass'] for t in trials if t['delivery'])
result={'status':'PASS' if all(checks.values()) else 'INCOMPLETE_OR_FAILED','checks':checks,'shared_runtime_drift':drift,'trials':trials,'provider_requests':len(ledger['calls']),'total_peak_cny':sum(t['proxy_cny'] for t in trials)}
(out/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
