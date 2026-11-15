import importlib.abc
import importlib.util
import sys
import json
import os
import hashlib
import runpy
from pathlib import Path

here=Path(__file__).resolve().parent
arm=os.environ['SF_AB_ARM']
if arm not in ('before','after'):raise RuntimeError('Missing frozen Python runtime selection')
audit=json.loads((here/'20261113/baseline-audit.json').read_text())
expected={f['file']:f[arm+'_sha256'] for f in audit['runtime_files']}


class FrozenBrain(importlib.abc.MetaPathFinder):
    def find_spec(self,fullname,path=None,target=None):
        if fullname not in ('brain.harness','brain.agent_tools','brain.models'):return None
        name='services/brain/'+fullname.replace('.','/')+'.py'
        source=here/'20261113'/arm/name
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        if digest!=expected[name]:raise RuntimeError('Frozen Python source changed: '+name)
        with open(os.environ['SF_AB_TRACE'],'a',encoding='utf-8') as trace:
            trace.write(json.dumps({'language':'Python','pid':os.getpid(),'arm':arm,'file':name,'sha256':digest})+'\n')
        return importlib.util.spec_from_file_location(fullname,source)


sys.meta_path.insert(0,FrozenBrain())
runpy.run_path(str(here.parent/'harness-real-eval/sitecustomize.py'))
