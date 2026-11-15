"""Only used by the isolated real-model read acceptance process."""
import json
import os
import runpy
from pathlib import Path
from brain.agent_state import AgentState

runpy.run_path(str(Path(__file__).resolve().parent.parent/'harness-real-eval/sitecustomize.py'))
original_tool=AgentState.tool


def readonly_tool(self,name,args,operation_id):
    if name not in ('_describe','read_project','request_user'):
        raise RuntimeError('Read-only acceptance blocked tool: '+name)
    result=original_tool(self,name,args,operation_id)
    if name=='_describe':
        result['tools']=[t for t in result['tools'] if t['function']['name'] in ('read_project','request_user')]
    trace={'deck_id':self.deck_id,'name':name,'args':args,'operation_id':operation_id,'revision_id':result.get('revision_id')}
    with open(os.environ['SF_READONLY_TRACE'],'a',encoding='utf-8') as output:
        output.write(json.dumps(trace,ensure_ascii=False)+'\n')
    return result


AgentState.tool=readonly_tool
