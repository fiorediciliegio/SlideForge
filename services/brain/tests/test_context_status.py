import copy
import unittest
from brain.context_status import append_context_status, pin_decision, frozen_decision
from brain.agent_tools import model_messages
from brain.harness import run_harness
from test_harness import HarnessState


def work():
    return {"action":"assess","kind":"visual","key":"visual-r1","context_status":{
        "snapshot":{"outline":{"title":"原稿","pages":[]},"constraints":[{"text":"73%是计划目标"}],"user_response":None},
        "state":{"project_revision":"r1","budget":{"spent_cny":0},"stage":"visual_review"}}}


class ContextStatusTests(unittest.TestCase):
    def test_append_only_changes_and_full_context_only_when_changed(self):
        run={"context_version":2,"calls":{}};messages=[{"role":"system","content":"rule"},{"role":"assistant","content":None,"reasoning_content":"keep","tool_calls":[]}]
        original=copy.deepcopy(messages);w=work()
        self.assertTrue(append_context_status(messages,run,w));self.assertEqual(messages[:2],original)
        self.assertEqual(len(messages),4);self.assertFalse(append_context_status(messages,run,w))
        w["context_status"]["state"]["project_revision"]="r2"
        self.assertTrue(append_context_status(messages,run,w));self.assertEqual(len(messages),5)
        w["context_status"]["snapshot"]["constraints"][0]["text"]="改为75%，仍是计划目标"
        self.assertTrue(append_context_status(messages,run,w));self.assertEqual(len(messages),7)
        self.assertIn("75%",messages[-2]["content"])
        legacy=copy.deepcopy(original)
        self.assertFalse(append_context_status(legacy,{"calls":{}},w));self.assertEqual(legacy,original)

    def test_frozen_request_keeps_original_tools_and_status_on_resume(self):
        run={"context_version":2,"calls":{}};messages=[{"role":"user","content":"original"}];w=work();tools=[{"function":{"name":"record_assessment"}}]
        append_context_status(messages,run,w);pin_decision(messages,0,tools,w)
        before=model_messages(messages,object())
        run["calls"]["turn-0"]={"status":"completed"}
        pinned=frozen_decision(messages,run,0)
        self.assertEqual(pinned["tools"],tools)
        self.assertEqual(model_messages(messages,object()),before)
        self.assertIsNone(frozen_decision(messages,run,1))
        for m in before:self.assertFalse(any(k.startswith("_harness") for k in m))

    def test_status_at_tail_does_not_hide_visual_images_or_reasoning(self):
        class State:
            def tool(self,*args):return {"images":[{"page_id":"a","image_url":"data:image/jpeg;base64,AAAA"}]}
        messages=[{"role":"assistant","content":None,"reasoning_content":"keep"},{"role":"user","content":"judge","_review_key":"visual-r1","_image_evidence_id":"e"}]
        append_context_status(messages,{"context_version":2},work())
        sent=model_messages(messages,State(),review_key="visual-r1")
        self.assertEqual(sent[0]["reasoning_content"],"keep")
        self.assertEqual(sum(p["type"]=="image_url" for m in sent if isinstance(m.get("content"),list) for p in m["content"]),1)
        self.assertEqual(sent[-1]["role"],"user")

    def test_checkpoint_before_model_and_completed_decision_replay_keep_messages(self):
        class Stopped(BaseException):pass
        class State(HarnessState):
            def __init__(self):super().__init__();self.run["context_version"]=2
            def tool(self,name,args,operation_id):
                if name=="_review_next":return {**work(),"action":"agent"}
                return super().tool(name,args,operation_id)
        state=State();seen=[]
        def first(config,state,call_id,messages,tools):
            seen.append(copy.deepcopy(messages));self.assertTrue(any("_harness_decision" in m for m in state.run["messages"]))
            state.run["calls"][call_id]={"status":"completed"};raise Stopped()
        with self.assertRaises(Stopped):run_harness(None,state,"test",model=first,heartbeat=False)
        def replay(config,state,call_id,messages,tools):
            self.assertEqual(messages,seen[0])
            return {"role":"assistant","content":None,"tool_calls":[{"id":"done","function":{"name":"finish_deck","arguments":"{}"}}]}
        run_harness(None,state,"test",model=replay,heartbeat=False)
        self.assertEqual(state.run["phase"],"completed")

    def test_budget_resume_without_registered_call_keeps_manual_images_and_reuses_snapshot(self):
        class State(HarnessState):
            def __init__(self):super().__init__();self.run["context_version"]=2
            def tool(self,name,args,operation_id):
                if name=="_review_next":return {**work(),"action":"agent"}
                if name=="_observation":return {"images":[{"page_id":"a","image_url":"data:image/jpeg;base64,AAAA"}]}
                return super().tool(name,args,operation_id)
        state=State()
        # The prior decision reached its budget limit before reserve_call was admitted.
        original=[{"role":"user","content":"原始资料保留"},{"role":"user","content":"当前主动取证","_image_evidence_id":"manual"}]
        state.run["messages"]=copy.deepcopy(original)
        append_context_status(state.run["messages"],state.run,{**work(),"action":"agent"})
        sent_before=model_messages(state.run["messages"],state);sent=[]
        def model(config,state,call_id,messages,tools):
            sent.extend(copy.deepcopy(messages))
            return {"role":"assistant","content":None,"tool_calls":[{"id":"done","function":{"name":"finish_deck","arguments":"{}"}}]}
        run_harness(None,state,"test",model=model,heartbeat=False)
        self.assertEqual(state.run["phase"],"completed")
        self.assertEqual(sum(p["type"]=="image_url" for m in sent if isinstance(m.get("content"),list) for p in m["content"]),1)
        self.assertEqual(sent,sent_before,"unchanged resume duplicated or rewrote model context")
        self.assertEqual(state.run["messages"][:2],original)
