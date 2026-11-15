import unittest
import threading
import copy
import json
from unittest.mock import patch
from brain.agent_state import AgentAPIError
from brain.harness import AgentRunner
from brain.harness import run_harness

class HarnessState:
    def __init__(self, pause=False):
        self.run = {"run_seq":1,"runner_epoch":0,"checkpoint_seq":0,"phase":"queued","options":{"research_allowed":False,"generation_mode":"direct","page_policy":{"mode":"fixed","count":2}},"messages":[],"calls":{},"budget":{"active_seconds":0,"limit_seconds":600}}
        self.runner_epoch=0;self.run_seq=1;self.pause=pause;self.tools=[];self.operation_ids=[]
    def snapshot(self): return {"agent": self.run}
    def mutate(self,action,**fields):
        if action=="claim": self.run.update(runner_epoch=1,phase="planning")
        if action=="transition": self.run.update({key:value for key,value in fields.items() if key in ("phase","messages","request","error","pricing")})
        self.run["checkpoint_seq"]+=1
        return self.snapshot()
    def tool(self,name,args,operation_id):
        if name=="_describe": return {"tools":[],"context":{"project":{"brief":"测试","sources":[],"outline":{"pages":[]}},"export_authorized":[]}}
        self.tools.append(name)
        self.operation_ids.append(operation_id)
        if self.pause: return {"pause":"waiting_outline","outline":{"title":"标题","pages":[]}}
        return {"completed":name=="finish_deck"}

class HarnessTests(unittest.TestCase):
    def test_continue_is_queued_even_while_the_old_epoch_worker_is_returning(self):
        state=HarnessState();state.run_seq=1
        first_started=threading.Event();release=threading.Event();second_started=threading.Event();count=[]
        def worker(*args,**kwargs):
            count.append(1)
            if len(count)==1:
                state.run["phase"]="generating";state.run["runner_epoch"]=1;first_started.set();release.wait(3)
            else: second_started.set()
        with patch("brain.harness.AgentState",return_value=state),patch("brain.harness.run_harness",side_effect=worker):
            runner=AgentRunner(None)
            try:
                runner.enqueue("deck-a",1);self.assertTrue(first_started.wait(1))
                state.run["phase"]="queued";state.run["runner_epoch"]=2
                runner.enqueue("deck-a",1);release.set()
                self.assertTrue(second_started.wait(1),"continue was lost behind an older in-flight worker")
            finally: release.set();runner.close()
    def test_resume_replays_persisted_assistant_tool_before_requesting_model(self):
        state=HarnessState()
        state.run["messages"]=[{"role":"user","content":"开始"},{"role":"assistant","content":None,"tool_calls":[{"id":"selected-tool","type":"function","function":{"name":"read_project","arguments":"{}"}}]}]
        def model(*args): return {"role":"assistant","content":None,"tool_calls":[{"id":"done","type":"function","function":{"name":"finish_deck","arguments":"{}"}}]}
        run_harness(None,state,"test",model=model,heartbeat=False)
        self.assertEqual(state.tools[0],"read_project")
        self.assertEqual(state.operation_ids[0],"turn-0:selected-tool")
    def test_closed_loop_preserves_tool_ids_and_finishes_only_with_tool(self):
        state=HarnessState()
        steps=iter(["read_project","save_plan","generate_pages","inspect_deck","revise_page","inspect_deck","finish_deck"])
        def model(config,state,call_id,messages,tools):
            name=next(steps)
            return {"role":"assistant","content":None,"tool_calls":[{"id":call_id,"type":"function","function":{"name":name,"arguments":"{}"}}]}
        run_harness(None,state,"test",model=model,heartbeat=False)
        self.assertEqual(state.run["phase"],"completed")
        self.assertEqual(state.tools,["read_project","save_plan","generate_pages","inspect_deck","revise_page","inspect_deck","finish_deck"])
        self.assertEqual(len([item for item in state.run["messages"] if item["role"]=="tool"]),7)
    def test_outline_pause_releases_execution_without_page_generation(self):
        state=HarnessState(pause=True)
        def model(*args): return {"role":"assistant","tool_calls":[{"id":"a","type":"function","function":{"name":"save_plan","arguments":"{}"}}],"content":None}
        run_harness(None,state,"test",model=model,heartbeat=False)
        self.assertEqual(state.run["phase"],"waiting_outline")
        self.assertNotIn("generate_pages",state.tools)


class ProcessStopped(BaseException):
    pass


def source_message(count=4):
    return {"role":"assistant","content":None,"tool_calls":[{
        "id":f"read-{i}","type":"function","function":{"name":"read_project",
        "arguments":json.dumps({"section":"sources","source_id":"source-a","start":i*4000})}}
        for i in range(count)]}


def finished_model(*args):
    return {"role":"assistant","content":None,"tool_calls":[{"id":"done","type":"function","function":{"name":"finish_deck","arguments":"{}"}}]}


class SourceState(HarnessState):
    def __init__(self):
        super().__init__()
        self.text="甲"*4000+"乙"*4000+"丙"*4000+"丁"*3409
        self.reads=[];self.receipts={};self.after_read=None;self.after_checkpoint=None

    def snapshot(self): return copy.deepcopy({"agent":self.run})

    def mutate(self,action,**fields):
        if action=="claim": self.run.update(runner_epoch=self.run["runner_epoch"]+1,phase="planning")
        elif action=="interrupt": self.run.update(phase="interrupted",error=fields.get("error"))
        elif action=="transition": self.run.update({key:copy.deepcopy(value) for key,value in fields.items() if key in ("phase","messages","request","error","pricing")})
        self.run["checkpoint_seq"]+=1
        if action=="transition" and self.after_checkpoint:self.after_checkpoint(self)
        return self.snapshot()

    def tool(self,name,args,operation_id):
        if name!="read_project": return super().tool(name,args,operation_id)
        if operation_id in self.receipts:return copy.deepcopy(self.receipts[operation_id])
        self.reads.append((operation_id,copy.deepcopy(args)))
        if args["start"]<0:raise AgentAPIError(400,{"error":"起始位置不能为负数"})
        if args["source_id"]=="missing":raise AgentAPIError(404,{"error":"资料不存在"})
        if args["source_id"]=="service-error":raise AgentAPIError(503,{"error":"资料服务不可用"})
        start=args["start"]
        result={"source_id":args["source_id"],"start":start,"end":min(start+4000,len(self.text)),"total":len(self.text),"text":self.text[start:start+4000]}
        self.receipts[operation_id]=copy.deepcopy(result)
        if self.after_read:self.after_read(self)
        return result


class SourceBatchTests(unittest.TestCase):
    def run_batch(self,state,message=None):
        replies=iter([message or source_message(),finished_model()])
        calls=[]
        def model(*args):calls.append(args[2]);return next(replies)
        run_harness(None,state,"test",model=model,heartbeat=False)
        return calls

    def test_four_source_reads_share_one_model_decision(self):
        state=SourceState();calls=self.run_batch(state)
        self.assertEqual(len(state.reads),4)
        self.assertEqual(calls,["turn-0","turn-1"])
        self.assertEqual("".join(r["text"] for r in state.receipts.values()),state.text)
        self.assertEqual(state.run["phase"],"completed")

    def test_source_batch_rejects_more_than_four_without_reading(self):
        state=SourceState();self.run_batch(state,source_message(5))
        self.assertEqual(state.reads,[])
        results=[json.loads(m["content"]) for m in state.run["messages"] if m["role"]=="tool"][:5]
        self.assertTrue(all("4" in r["error"] for r in results))

    def test_missing_source_is_reported_and_other_reads_continue(self):
        state=SourceState();message=source_message()
        args=json.loads(message["tool_calls"][1]["function"]["arguments"]);args["source_id"]="missing"
        message["tool_calls"][1]["function"]["arguments"]=json.dumps(args)
        self.run_batch(state,message)
        self.assertEqual(len(state.reads),4)
        self.assertEqual(len(state.receipts),3)
        result=next(m for m in state.run["messages"] if m.get("tool_call_id")=="read-1")
        self.assertIn("资料不存在",json.loads(result["content"])["error"])

    def test_invalid_offset_does_not_block_other_sources(self):
        state=SourceState();message=source_message()
        args=json.loads(message["tool_calls"][1]["function"]["arguments"]);args["start"]=-1
        message["tool_calls"][1]["function"]["arguments"]=json.dumps(args)
        args=json.loads(message["tool_calls"][2]["function"]["arguments"]);args["source_id"]="source-b"
        message["tool_calls"][2]["function"]["arguments"]=json.dumps(args)
        self.run_batch(state,message)
        self.assertEqual(len(state.reads),4)
        self.assertEqual(len(state.receipts),3)
        self.assertEqual(list(state.receipts.values())[1]["source_id"],"source-b")
        self.assertEqual(state.run["phase"],"completed")

    def test_partial_checkpoint_skips_success_and_definite_error_on_resume(self):
        state=SourceState();message=source_message()
        args=json.loads(message["tool_calls"][1]["function"]["arguments"]);args["source_id"]="missing"
        message["tool_calls"][1]["function"]["arguments"]=json.dumps(args)
        def crash(s):
            if len([m for m in s.run["messages"] if m["role"]=="tool"])==2:
                s.after_checkpoint=None;raise ProcessStopped()
        state.after_checkpoint=crash
        with self.assertRaises(ProcessStopped):self.run_batch(state,message)
        self.assertEqual(len(state.reads),2)
        run_harness(None,state,"resume",model=finished_model,heartbeat=False)
        self.assertEqual([a["start"] for _,a in state.reads],[0,4000,8000,12000])
        self.assertEqual([m["tool_call_id"] for m in state.run["messages"] if m["role"]=="tool"],["read-0","read-1","read-2","read-3","done"])
        self.assertEqual(state.run["phase"],"completed")

    def test_receipt_survives_crash_before_result_checkpoint(self):
        state=SourceState()
        def crash(s):s.after_read=None;raise ProcessStopped()
        state.after_read=crash
        with self.assertRaises(ProcessStopped):self.run_batch(state)
        self.assertEqual(len(state.receipts),1)
        run_harness(None,state,"resume",model=finished_model,heartbeat=False)
        self.assertEqual(len(state.reads),4)
        self.assertEqual(state.reads[0][0],"turn-0:read-0")
        self.assertEqual(state.run["phase"],"completed")

    def test_cancel_during_first_read_stops_remaining_reads(self):
        state=SourceState()
        def cancel(s):s.run.update(phase="cancelled",runner_epoch=s.run["runner_epoch"]+1)
        state.after_read=cancel;self.run_batch(state)
        self.assertEqual(len(state.reads),1)
        self.assertEqual(state.run["phase"],"cancelled")

    def test_budget_pause_between_reads_stops_the_batch(self):
        state=SourceState()
        def pause(s):
            if any(m["role"]=="tool" for m in s.run["messages"]):s.run["phase"]="paused_budget"
        state.after_checkpoint=pause;self.run_batch(state)
        self.assertEqual(len(state.reads),1)
        self.assertEqual(state.run["phase"],"paused_budget")

    def test_service_failure_keeps_previous_result_checkpoint(self):
        state=SourceState();message=source_message()
        args=json.loads(message["tool_calls"][1]["function"]["arguments"]);args["source_id"]="service-error"
        message["tool_calls"][1]["function"]["arguments"]=json.dumps(args)
        self.run_batch(state,message)
        self.assertEqual(len(state.reads),2)
        self.assertEqual(state.run["phase"],"interrupted")
        self.assertEqual([m["tool_call_id"] for m in state.run["messages"] if m["role"]=="tool"],["read-0"])

    def test_error_receipt_is_reused_when_message_checkpoint_fails(self):
        state=SourceState();message=source_message()
        args=json.loads(message["tool_calls"][1]["function"]["arguments"]);args["source_id"]="missing"
        message["tool_calls"][1]["function"]["arguments"]=json.dumps(args)
        original_tool=state.tool
        def durable_tool(name,args,operation_id):
            try:return original_tool(name,args,operation_id)
            except AgentAPIError as error:
                if error.status!=404:raise
                result={"error":str(error)};state.receipts[operation_id]=result
                return result
        state.tool=durable_tool
        original_mutate=state.mutate
        def fail_checkpoint(action,**fields):
            if action=="transition" and any(m.get("tool_call_id")=="read-1" for m in fields.get("messages",[])):
                state.mutate=original_mutate
                raise OSError("checkpoint storage unavailable")
            return original_mutate(action,**fields)
        state.mutate=fail_checkpoint
        self.run_batch(state,message)
        self.assertEqual(state.run["phase"],"interrupted")
        self.assertEqual(len(state.reads),2)
        run_harness(None,state,"resume",model=finished_model,heartbeat=False)
        self.assertEqual([a["start"] for _,a in state.reads],[0,4000,8000,12000])
        self.assertEqual(state.run["phase"],"completed")

    def test_mixed_calls_keep_single_tool_behavior(self):
        state=SourceState();message=source_message(1)
        message["tool_calls"]+=finished_model()["tool_calls"]
        self.run_batch(state,message)
        self.assertEqual(len(state.reads),1)
        self.assertEqual(state.tools,["finish_deck"])
        results=[m for m in state.run["messages"] if m["role"]=="tool"]
        self.assertIn("每回合只执行一个工具",json.loads(results[1]["content"])["error"])


def page_read_message():
    calls=[]
    for i,args in enumerate([{"section":"pages","page_ids":["a","b"]},{"section":"history","page_ids":["a","b"]},{"section":"sources","source_id":"source-a","start":0}]):
        calls.append({"id":f"item-{i}","type":"function","function":{"name":"read_project","arguments":json.dumps(args)}})
    return {"role":"assistant","content":None,"tool_calls":calls}


class PageState(SourceState):
    def __init__(self):
        super().__init__();self.run["project_ref"]={"revision_id":"r1"}

    def tool(self,name,args,operation_id):
        if name=="_describe":
            value=super().tool(name,args,operation_id)
            value["context"]["project"]["revision_id"]=self.run["project_ref"]["revision_id"]
            return value
        if name!="read_project" or args.get("section")=="sources":return super().tool(name,args,operation_id)
        if operation_id in self.receipts:return copy.deepcopy(self.receipts[operation_id])
        self.reads.append((operation_id,copy.deepcopy(args)))
        revision=self.run["project_ref"]["revision_id"]
        result={"revision_id":revision}
        if args["section"]=="pages":result["pages"]=[{"page_id":p,"html":f"<main>{revision}:{p}</main>"} for p in args["page_ids"]]
        else:result["history"]=[{"page_id":p,"versions":[{"revision_id":revision,"instruction":"虚构修改"}]} for p in args["page_ids"]]
        self.receipts[operation_id]=copy.deepcopy(result)
        if self.after_read:self.after_read(self)
        return result


class PageBatchTests(unittest.TestCase):
    def run_batch(self,state,message=None):
        replies=iter([message or page_read_message(),finished_model()])
        run_harness(None,state,"test",model=lambda *args:next(replies),heartbeat=False)

    def test_pages_history_and_source_share_one_decision(self):
        state=PageState();self.run_batch(state)
        self.assertEqual([args["section"] for _,args in state.reads],["pages","history","sources"])
        self.assertEqual(state.run["phase"],"completed")

    def test_partial_page_batch_resumes_original_ids(self):
        state=PageState()
        def crash(s):
            if any(m["role"]=="tool" for m in s.run["messages"]):s.after_checkpoint=None;raise ProcessStopped()
        state.after_checkpoint=crash
        with self.assertRaises(ProcessStopped):self.run_batch(state)
        run_harness(None,state,"resume",model=finished_model,heartbeat=False)
        self.assertEqual([op for op,_ in state.reads],["turn-0:item-0","turn-0:item-1","turn-0:item-2"])

    def test_changed_revision_stops_pending_reads_and_requests_new_evidence(self):
        state=PageState()
        def crash(s):s.after_read=None;raise ProcessStopped()
        state.after_read=crash
        with self.assertRaises(ProcessStopped):self.run_batch(state)
        self.assertEqual(len(state.reads),1)
        state.run["project_ref"]={"revision_id":"r2"}
        seen=[]
        def model(config,state,call_id,messages,tools):seen.extend(copy.deepcopy(messages));return finished_model()
        run_harness(None,state,"resume",model=model,heartbeat=False)
        self.assertEqual(len(state.reads),1,"old batch must not complete against a different revision")
        errors=[json.loads(m["content"]) for m in seen if m["role"]=="tool"]
        self.assertTrue(all(e.get("error_code")=="read_revision_changed" for e in errors))
        self.assertTrue(any("r2" in m.get("content","") for m in seen if m["role"]=="user"))

    def test_read_revision_metadata_is_not_forwarded_to_provider(self):
        from brain.agent_tools import model_messages
        saved=[{"role":"assistant","content":None,"tool_calls":page_read_message()["tool_calls"],"_read_revision_id":"r1"}]
        self.assertNotIn("_read_revision_id",model_messages(saved,PageState())[0])

    def test_cancel_stops_history_and_source_after_page_read(self):
        state=PageState()
        def cancel(s):s.run.update(phase="cancelled",runner_epoch=s.run["runner_epoch"]+1)
        state.after_read=cancel;self.run_batch(state)
        self.assertEqual(len(state.reads),1)
        self.assertEqual(state.run["phase"],"cancelled")

    def test_over_limit_page_batch_does_not_read(self):
        state=PageState();message=page_read_message();message["tool_calls"]+=copy.deepcopy(message["tool_calls"][:2])
        for i,c in enumerate(message["tool_calls"]):c["id"]=f"over-{i}"
        self.run_batch(state,message)
        self.assertEqual(state.reads,[])

    def test_model_receipt_before_assistant_checkpoint_preserves_old_revision(self):
        from brain.models import agent_complete
        from brain.config import BrainConfig
        state=PageState();state.run["pricing"]={"input_cny_per_million":1,"output_cny_per_million":2}
        saved={}
        def save_response(call_id,payload):saved[call_id]=copy.deepcopy(payload);return call_id
        state.save_response=save_response;state.read_response=lambda ref:saved[ref]
        original_mutate=state.mutate
        def crash(action,**fields):
            if action=="settle_call":state.run["calls"][fields["call_id"]]={"status":"completed","response_ref":fields["response_ref"]}
            if action=="transition" and fields.get("messages",[{}])[-1].get("role")=="assistant":raise ProcessStopped()
            return original_mutate(action,**fields)
        state.mutate=crash
        payload={"choices":[{"message":page_read_message()}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return json.dumps(payload).encode()
        config=BrainConfig("127.0.0.1",3212,"token",openai_api_key="test")
        def model(config,state,call_id,messages,tools):
            return agent_complete(config,state,call_id,messages,tools) if call_id=="turn-0" else finished_model()
        with patch("urllib.request.urlopen",return_value=Response()) as provider:
            with self.assertRaises(ProcessStopped):run_harness(config,state,"test",model=model,heartbeat=False)
            state.mutate=original_mutate;state.run["project_ref"]={"revision_id":"r2"}
            run_harness(config,state,"resume",model=model,heartbeat=False)
            self.assertEqual(provider.call_count,1)
        self.assertEqual(state.reads,[],"the replayed r1 decision must not execute against r2")
        errors=[json.loads(m["content"]) for m in state.run["messages"] if m["role"]=="tool"]
        self.assertTrue(all(e.get("error_code")=="read_revision_changed" for e in errors[:-1]))
