import unittest
import threading
from unittest.mock import patch
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
