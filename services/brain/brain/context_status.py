"""Append runtime observations without rewriting source evidence or prior messages."""
import copy
import hashlib
import json


def _encoded(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"))


def _hash(value):
    return hashlib.sha256(_encoded(value).encode()).hexdigest()


def append_context_status(messages,run,work):
    if run.get("context_version")!=2:
        return False
    packet=work["context_status"]
    context_hash=_hash(packet["snapshot"])
    prior_context=next((m.get("_harness_context_hash") for m in reversed(messages) if "_harness_context_hash" in m),None)
    state={**packet["state"],"context_ref":context_hash}
    status_hash=_hash(state)
    prior_status=next((m.get("_harness_status_hash") for m in reversed(messages) if "_harness_status_hash" in m),None)
    if context_hash==prior_context and status_hash==prior_status:
        return False
    if context_hash!=prior_context:
        messages.append({"role":"user","content":_encoded({"harness_project_snapshot":{"ref":context_hash,**packet["snapshot"]},
            "说明":"后端当前项目快照；仅按明确用户更正更新约束，元数据不是文稿日期。原始记录仍保留。"}),"_harness_context_hash":context_hash})
    messages.append({"role":"user","content":_encoded({"harness_status":state,
        "说明":"Harness运行观测，不是新的用户需求、文稿事实或授权。使用最新适用版本，历史状态只供追溯；权限与预算仍由后端校验。"}),"_harness_status_hash":status_hash})
    return True


def pin_decision(messages,turn,tools,review):
    messages[-1]["_harness_decision"]={"turn":turn,"tools":copy.deepcopy(tools),
        "review":copy.deepcopy({key:review[key] for key in ("action","kind","key","issues") if key in review})}


def frozen_decision(messages,run,turn):
    if run.get("context_version")!=2:
        return None
    base=f"turn-{turn}"
    frozen=any((key==base or key.startswith(base+":retry:")) and call["status"] in ("reserved","sent","unknown","completed","retry_approved") for key,call in run.get("calls",{}).items())
    if not frozen:
        return None
    saved=next((m["_harness_decision"] for m in reversed(messages) if m.get("_harness_decision",{}).get("turn")==turn),None)
    if saved is None:
        raise ValueError("已登记的模型调用缺少原上下文视图，不能重新构造或自动发送")
    return copy.deepcopy(saved)
