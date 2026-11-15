"""Recover the four pre-batching runtime files and require historical SHA256 equality."""
import ast
import hashlib
import json
from pathlib import Path

root=Path(__file__).resolve().parents[2]
out=Path(__file__).resolve().parent/'20261113'
manifest=json.loads((root/'.scratch/harness-real-eval/20261112-real-1/source-manifest.json').read_text())
old={item['file']:item['sha256'] for item in manifest}
files={'services/brain/brain/harness.py':(root/'.scratch/source-read-batch/20261112-outline-ab/before/harness.py').read_bytes(),
       'services/brain/brain/agent_tools.py':(root/'.scratch/source-read-batch/20261112-outline-ab/before/agent_tools.py').read_bytes()}
model=(root/'services/brain/brain/models.py').read_text(encoding='utf-8')
helper='def _saved_message(result):\n    message = copy.deepcopy(result["choices"][0]["message"])\n    message["_read_revision_id"] = result.get("_project_revision_id")\n    return message\n\n\n'
model=model.replace(helper,'').replace('    decision_revision = (run.get("project_ref") or {}).get("revision_id", "")\n','').replace('        return _saved_message(state.read_response(existing["response_ref"]))','        return state.read_response(existing["response_ref"])["choices"][0]["message"]').replace('        result["_project_revision_id"] = decision_revision\n','').replace('        return _saved_message(result)','        return result["choices"][0]["message"]')
node=(root/'.scratch/page-history-batch/before/agent.ts').read_text(encoding='utf-8')
node=node.replace('  const sourceRead = input.name === "read_project" && input.args.section === "sources" && typeof input.args.source_id === "string" && input.args.source_id.length > 0;\n','').replace('if (!parsed.success && !sourceRead)','if (!parsed.success)').replace('const args = (parsed.success ? parsed.data : input.args) as','const args = parsed.data as')
node=node.replace('  if (!parsed.success) {\n    result = { error: parsed.error.message };\n  } else if (input.name === "read_project") {','  if (input.name === "read_project") {')
node=node.replace('''        const source = project.sources.find(item => item.source_id === args.source_id);
        if (!source) result = { error: "资料不存在" };
        else {
          const text = await readFile(projectPath(root, source.text_ref), "utf8"), start = args.start ?? 0;
          result = { source_id: source.source_id, start, end: Math.min(start + 4000, text.length), total: text.length, text: text.slice(start, start + 4000) };
        }''','''        const source = project.sources.find(item => item.source_id === args.source_id); if (!source) throw new HttpRequestError(404, "资料不存在");
        const text = await readFile(projectPath(root, source.text_ref), "utf8"), start = args.start ?? 0;
        result = { source_id: source.source_id, start, end: Math.min(start + 4000, text.length), total: text.length, text: text.slice(start, start + 4000) };''')
for name,text in [('services/brain/brain/models.py',model),('src/capabilities/agent.ts',node)]:
    matches=[data for data in [text.encode(),text.replace('\n','\r\n').encode()] if hashlib.sha256(data).hexdigest()==old[name]]
    assert len(matches)==1,name
    files[name]=matches[0]
audit=[]
for name,data in files.items():
    assert hashlib.sha256(data).hexdigest()==old[name],name
    if name.endswith('.py'):ast.parse(data.decode('utf-8'))
    for arm,content in [('before',data),('after',(root/name).read_bytes())]:
        target=out/arm/name
        assert not target.exists(),'Do not overwrite a frozen baseline'
        target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
    audit.append({'file':name,'before_sha256':hashlib.sha256(data).hexdigest(),'historical_sha256':old[name],'exact_match':True,'after_sha256':hashlib.sha256((root/name).read_bytes()).hexdigest()})
other_changes=[]
for item in manifest:
    if item['file'] in files:continue
    p=root/item['file']
    if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:other_changes.append(item['file'])
assert all(name.startswith(('tests/','services/brain/tests/')) for name in other_changes),other_changes
result={'status':'PASS','runtime_files':audit,'other_changed_files':other_changes,'other_manifest_entries_unchanged':len(manifest)-len(files)-len(other_changes),'provider_requests':0,'workspace_runtime_modified':False}
(out/'baseline-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False,indent=2))
