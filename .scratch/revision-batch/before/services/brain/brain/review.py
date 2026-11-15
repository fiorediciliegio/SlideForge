import json


def advance_review(state, messages):
    """Run deterministic check work; leave judgments and revisions to the model."""
    while True:
        run=state.snapshot()["agent"]
        if run["runner_epoch"]!=state.runner_epoch or run["phase"] not in ("planning","generating","checking","revising"):
            return {"action":"stop"}
        work=state.tool("_review_next",{},"review-next")
        run=state.snapshot()["agent"]
        if run["runner_epoch"]!=state.runner_epoch or run["phase"] not in ("planning","generating","checking","revising"):
            return {"action":"stop"}
        if work["action"]=="agent":
            return work
        if work["action"]=="tool":
            state.mutate("transition",expected_checkpoint=run["checkpoint_seq"],phase="checking",messages=messages)
            # Go owns effective time, including exclusion of engine queue waits.
            run=state.mutate("heartbeat")["agent"]
            if run["runner_epoch"]!=state.runner_epoch or run["phase"] not in ("planning","generating","checking","revising"):
                return {"action":"stop"}
            result=state.tool(work["name"],work["args"],work["operation_id"])
            run=state.snapshot()["agent"]
            if run["runner_epoch"]!=state.runner_epoch or run["phase"] not in ("planning","generating","checking","revising"):
                return {"action":"stop"}
            run=state.mutate("heartbeat")["agent"]
            if run["runner_epoch"]!=state.runner_epoch or run["phase"] not in ("planning","generating","checking","revising"):
                return {"action":"stop"}
            if result.get("completed"):
                state.mutate("transition",expected_checkpoint=run["checkpoint_seq"],phase="completed",messages=messages)
                return {"action":"stop"}
            continue
        if work["action"] not in ("assess","repair"):
            raise ValueError("未知检查工作："+str(work["action"]))
        if not any(message.get("_review_key")==work["key"] for message in messages):
            if work["action"]=="assess":
                prompt={"程序安排":"请评审本批证据并用record_assessment记录；同阶段其他批次由程序继续提供，先不要修订。",
                    "kind":work["kind"],"page_ids":work["page_ids"],"evidence_ids":work["evidence_ids"],
                    "global_summary":work["global_summary"],"evidence":work["evidence"]}
            else:
                prompt={"程序安排":"本阶段检查已收齐。请用现有工具逐页处理以下阻断问题；程序在本轮已知问题修完后补齐复核。需要进一步取证时说明具体原因。","issues":work["issues"]}
            message={"role":"user","content":json.dumps(prompt,ensure_ascii=False),"_review_key":work["key"]}
            if work["action"]=="assess" and work["kind"]=="visual":
                message["_image_evidence_id"]=work["evidence_id"]
            messages.append(message)
            state.mutate("transition",expected_checkpoint=run["checkpoint_seq"],phase="checking",messages=messages)
        return work
