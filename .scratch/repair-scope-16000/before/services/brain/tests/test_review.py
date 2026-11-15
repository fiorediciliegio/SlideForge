import copy
import json
import unittest
from brain.harness import run_harness
from brain.agent_tools import model_messages
from brain.agent_state import AgentAPIError
from test_harness import HarnessState


class Stopped(BaseException):
    pass


class ReviewState(HarnessState):
    def __init__(self):
        super().__init__()
        self.stage=0
        self.receipts={}
        self.run["project_ref"]={"revision_id":"r1"}

    def tool(self,name,args,operation_id):
        if name=="_describe":
            names=["read_project","inspect_deck","record_assessment","revise_page","revise_pages","request_user","finish_deck"]
            return {"tools":[{"function":{"name":n}} for n in names],"context":{"project":{"brief":"test","sources":[],"outline":{"pages":[]}},"export_authorized":[]}}
        if name=="_review_next":
            if self.stage==0:return {"action":"tool","name":"inspect_deck","args":{"kinds":["layout","content"],"page_ids":["a","b"]},"operation_id":"auto-layout"}
            if self.stage<3:
                kind="content" if self.stage==1 else "visual"
                return {"action":"assess","kind":kind,"page_ids":["a","b"],"global_summary":kind=="content","key":kind,"evidence_id":kind,"evidence_ids":[kind],"evidence":[{"page_id":"a","text":"A"},{"page_id":"b","text":"B"}]}
            return {"action":"tool","name":"finish_deck","args":{},"operation_id":"auto-finish"}
        if name=="_observation":
            return {"images":[{"page_id":"a","image_url":"data:image/jpeg;base64,AAAA"}]}
        if operation_id in self.receipts:return self.receipts[operation_id]
        self.tools.append(name);self.operation_ids.append(operation_id)
        if name=="inspect_deck":self.stage=1
        if name=="record_assessment":self.stage+=1
        result={"completed":name=="finish_deck"}
        self.receipts[operation_id]=result
        return result


def assessment_model(calls):
    def model(config,state,call_id,messages,tools):
        calls.append(copy.deepcopy(messages))
        assert "revise_page" not in [t["function"]["name"] for t in tools]
        assert "revise_pages" not in [t["function"]["name"] for t in tools]
        kind="content" if state.stage==1 else "visual"
        args={"kind":kind,"page_ids":["a","b"],"evidence_ids":[kind],"issues":[],"global_summary":kind=="content"}
        return {"role":"assistant","tool_calls":[{"id":call_id,"function":{"name":"record_assessment","arguments":json.dumps(args)}}]}
    return model


class ReviewTests(unittest.TestCase):
    def test_batch_repair_is_one_tool_turn_in_revising_phase_and_resumes_saved_call(self):
        state=ReviewState();state.stage=3;original=state.tool;repairs=[];model_calls=[]
        def tool(name,args,operation_id):
            if name=="_review_next" and not repairs:
                return {"action":"repair","key":"repair","issues":[{"page_ids":["a","b"],"detail":"overlap"}]}
            if name=="revise_pages":
                self.assertEqual(state.run["phase"],"revising");repairs.append(operation_id)
                return {"pages":[{"page_id":"a"},{"page_id":"b"}],"failures":[]}
            return original(name,args,operation_id)
        state.tool=tool
        def model(config,state,call_id,messages,tools):
            model_calls.append(call_id);self.assertIn("revise_pages",[t["function"]["name"] for t in tools])
            return {"role":"assistant","content":None,"tool_calls":[{"id":"batch","function":{"name":"revise_pages","arguments":json.dumps({"revisions":[{"page_id":"a","instruction":"fix A"},{"page_id":"b","instruction":"fix B"}]})}}]}
        mutate=state.mutate;stopped=[]
        def crash(action,**fields):
            result=mutate(action,**fields)
            if action=="transition" and fields.get("phase")=="revising" and not stopped:
                stopped.append(1);raise Stopped()
            return result
        state.mutate=crash
        with self.assertRaises(Stopped):run_harness(None,state,"first",model=model,heartbeat=False)
        state.mutate=mutate
        run_harness(None,state,"resume",model=lambda *args:self.fail("saved tool call must execute before model"),heartbeat=False)
        self.assertEqual(repairs,["turn-0:batch"]);self.assertEqual(len(model_calls),1);self.assertEqual(state.run["phase"],"completed")

    def test_batch_tool_is_hidden_and_rejected_outside_collected_repair_stage(self):
        state=ReviewState();original=state.tool;state.stage=3;attempted=[]
        def tool(name,args,operation_id):
            if name=="_review_next" and not attempted:return {"action":"agent"}
            return original(name,args,operation_id)
        state.tool=tool
        def model(config,state,call_id,messages,tools):
            self.assertNotIn("revise_pages",[t["function"]["name"] for t in tools]);attempted.append(1)
            return {"role":"assistant","content":None,"tool_calls":[{"id":"unauthorized","function":{"name":"revise_pages","arguments":"{}"}}]}
        run_harness(None,state,"test",model=model,heartbeat=False)
        self.assertNotIn("revise_pages",state.tools);self.assertEqual(state.run["phase"],"completed")

    def test_user_initiated_edits_keep_single_page_tools_even_during_followup_repairs(self):
        state=ReviewState();original=state.tool;state.stage=3;attempted=[]
        def tool(name,args,operation_id):
            if name=="_describe":
                result=original(name,args,operation_id);result["context"]["instruction"]="用户要求修改指定页"
                return result
            if name=="_review_next" and not attempted:return {"action":"repair","key":"user-repair","issues":[{"page_ids":["a","b"]}]}
            return original(name,args,operation_id)
        state.tool=tool
        def model(config,state,call_id,messages,tools):
            self.assertNotIn("revise_pages",[t["function"]["name"] for t in tools]);attempted.append(1)
            return {"role":"assistant","content":None,"tool_calls":[{"id":"user-batch","function":{"name":"revise_pages","arguments":"{}"}}]}
        run_harness(None,state,"test",model=model,heartbeat=False)
        self.assertNotIn("revise_pages",state.tools);self.assertEqual(state.run["phase"],"completed")

    def test_program_checks_and_finishes_with_only_two_assessment_model_calls(self):
        state=ReviewState();calls=[]
        run_harness(None,state,"test",model=assessment_model(calls),heartbeat=False)
        self.assertEqual(state.run["phase"],"completed")
        self.assertEqual(state.tools,["inspect_deck","record_assessment","record_assessment","finish_deck"])
        self.assertEqual(len(calls),2,"取证和结束不得再发起模型决策")

    def test_cancelled_automatic_inspection_does_not_call_model_or_finish(self):
        state=ReviewState();original=state.tool;calls=[]
        def tool(name,args,operation_id):
            result=original(name,args,operation_id)
            if name=="inspect_deck":state.run.update(phase="cancelled",runner_epoch=2)
            return result
        state.tool=tool
        run_harness(None,state,"test",model=assessment_model(calls),heartbeat=False)
        self.assertEqual(state.run["phase"],"cancelled")
        self.assertEqual(calls,[])
        self.assertNotIn("finish_deck",state.tools)

    def test_automatic_budget_error_pauses_without_model_call(self):
        state=ReviewState();original=state.tool;calls=[]
        def tool(name,args,operation_id):
            if name=="inspect_deck":raise AgentAPIError(402,{"error":"budget","error_code":"budget_exhausted"})
            return original(name,args,operation_id)
        state.tool=tool
        run_harness(None,state,"test",model=assessment_model(calls),heartbeat=False)
        self.assertEqual(state.run["phase"],"paused_budget")
        self.assertEqual(calls,[])

    def test_completion_receipt_replays_after_checkpoint_crash_without_new_model_calls(self):
        state=ReviewState();calls=[];original=state.mutate
        def crash(action,**fields):
            if action=="transition" and fields.get("phase")=="completed":raise Stopped()
            return original(action,**fields)
        state.mutate=crash
        with self.assertRaises(Stopped):
            run_harness(None,state,"test",model=assessment_model(calls),heartbeat=False)
        state.mutate=original
        run_harness(None,state,"resume",model=assessment_model(calls),heartbeat=False)
        self.assertEqual(state.run["phase"],"completed")
        self.assertEqual(state.tools.count("finish_deck"),1)
        self.assertEqual(len(calls),2)

    def test_review_reference_does_not_leak_and_current_images_survive_a_read_interleave(self):
        state=ReviewState()
        saved=[{"role":"user","content":"old","_image_evidence_id":"old"},
               {"role":"user","content":"current","_image_evidence_id":"visual","_review_key":"visual"},
               {"role":"assistant","content":"read","_read_revision_id":"r1","_review_phase":"assess"},
               {"role":"tool","tool_call_id":"read","content":"{}"}]
        result=model_messages(saved,state,review_key="visual")
        self.assertEqual(result[0]["content"],"old")
        self.assertIsInstance(result[1]["content"],list)
        self.assertTrue(all(not any(k.startswith("_") for k in message) for message in result))
        self.assertIn("_review_key",saved[1])

    def test_collect_phase_rejects_early_revision_and_unexplained_inspection(self):
        for name in ("revise_page","revise_pages","inspect_deck"):
            with self.subTest(name=name):
                state=ReviewState();calls=[];attempted=[]
                good=assessment_model(calls)
                def model(*args):
                    if not attempted:
                        attempted.append(name)
                        return {"role":"assistant","tool_calls":[{"id":"too-early","function":{"name":name,"arguments":"{}"}}]}
                    return good(*args)
                run_harness(None,state,"test",model=model,heartbeat=False)
                self.assertEqual(state.run["phase"],"completed")
                self.assertNotIn("revise_page",state.tools)
                self.assertNotIn("revise_pages",state.tools)
                self.assertEqual(state.tools.count("inspect_deck"),1)

    def test_authorized_export_is_executed_before_automatic_finish(self):
        state=ReviewState();original=state.tool;calls=[]
        def tool(name,args,operation_id):
            if name=="_review_next" and state.stage==3 and "auto-export" not in state.receipts:
                return {"action":"tool","name":"export_deck","args":{"format":"pptx","revision_id":"r1"},"operation_id":"auto-export"}
            return original(name,args,operation_id)
        state.tool=tool
        run_harness(None,state,"test",model=assessment_model(calls),heartbeat=False)
        self.assertEqual(state.tools[-2:],["export_deck","finish_deck"])
        self.assertEqual(len(calls),2)

    def test_assessment_at_decision_limit_can_still_finish_without_another_model_call(self):
        state=ReviewState();calls=[];reads=[]
        good=assessment_model(calls)
        def model(*args):
            if len(reads)<18:
                reads.append(1)
                return {"role":"assistant","tool_calls":[{"id":"read-"+str(len(reads)),"function":{"name":"read_project","arguments":"{}"}}]}
            return good(*args)
        run_harness(None,state,"test",model=model,heartbeat=False)
        self.assertEqual(state.run["phase"],"completed")
        self.assertEqual(len(calls),2)

    def test_authoritative_time_budget_blocks_automatic_finish(self):
        state=ReviewState();state.stage=3;state.run["budget"]["active_seconds"]=601
        original=state.mutate;heartbeats=[]
        def mutate(action,**fields):
            if action=="heartbeat":
                heartbeats.append(1)
                if state.run["budget"]["active_seconds"]>=state.run["budget"]["limit_seconds"]:
                    state.run["phase"]="paused_budget"
            return original(action,**fields)
        state.mutate=mutate
        run_harness(None,state,"test",model=lambda *args:self.fail("no model"),heartbeat=False)
        self.assertTrue(heartbeats,"必须请求Go刷新计时，而非依赖10秒周期心跳")
        self.assertEqual(state.run["phase"],"paused_budget")
        self.assertNotIn("finish_deck",state.tools)

    def test_late_automatic_receipt_pauses_then_resumes_without_repeating_finish(self):
        state=ReviewState();state.stage=3;state.run["budget"]["active_seconds"]=599
        original_mutate=state.mutate;original_tool=state.tool
        def mutate(action,**fields):
            if action=="heartbeat" and state.run["budget"]["active_seconds"]>=state.run["budget"]["limit_seconds"]:
                state.run["phase"]="paused_budget"
            return original_mutate(action,**fields)
        def tool(name,args,operation_id):
            result=original_tool(name,args,operation_id)
            if name=="finish_deck":state.run["budget"]["active_seconds"]+=2
            return result
        state.mutate=mutate;state.tool=tool
        run_harness(None,state,"test",model=lambda *args:self.fail("no model"),heartbeat=False)
        self.assertEqual(state.run["phase"],"paused_budget")
        state.run["budget"]["limit_seconds"]=1000
        run_harness(None,state,"resume",model=lambda *args:self.fail("no model"),heartbeat=False)
        self.assertEqual(state.run["phase"],"completed")
        self.assertEqual(state.tools.count("finish_deck"),1)
