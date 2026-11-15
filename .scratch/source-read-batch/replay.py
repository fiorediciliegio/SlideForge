"""Replay the existing real-model tool selection with zero provider requests."""
import importlib.util
import json
import sys
from pathlib import Path

root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'services/brain'))
spec=importlib.util.spec_from_file_location('source_batch_tests',root/'services/brain/tests/test_harness.py')
tests=importlib.util.module_from_spec(spec);spec.loader.exec_module(tests)
state=tests.SourceState()
fixtures=json.loads((root/'.scratch/harness-real-eval/20261112-172000/fixtures.json').read_text(encoding='utf-8'))
fixture=next(c for c in fixtures['cases'] if c['id']=='long-document');state.text=fixture['source'].strip()
prior=root/'.scratch/harness-real-eval/20261112-real-1'
message=json.loads((prior/'response-190.json').read_text(encoding='utf-8'))['choices'][0]['message']
model_calls=tests.SourceBatchTests().run_batch(state,message)
assert len(state.reads)==4
assert ''.join(r['text'] for r in state.receipts.values())==state.text
assert model_calls==['turn-0','turn-1']
result={'status':'PASS','mode':'offline-replay','actual_provider_requests':0,'saved_model_response':'response-190.json','source_model_decisions_before':4,'source_model_decisions_after':1,'source_tool_results':4,'source_chars':len(state.text),'full_source_equal':True,'operation_ids':[op for op,_ in state.reads]}
out=root/'.scratch/source-read-batch/20261112-outline-ab/replay.json'
out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
