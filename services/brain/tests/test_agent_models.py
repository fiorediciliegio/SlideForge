import unittest
from unittest.mock import patch
import json
import threading
from brain.config import BrainConfig
from brain.models import agent_complete
from brain.agent_state import AgentAPIError

class FakeState:
    def __init__(self):
        self.actions = []
        self.run = {"run_seq":1,"runner_epoch":1,"phase":"planning","calls": {}, "pricing": {"input_cny_per_million": 1, "output_cny_per_million": 2, "version": "test"}, "budget": {"limit_seconds": 600, "active_seconds": 0,"limit_cny":2,"spent_cny":0,"reserved_cny":0}}
    def snapshot(self,include_messages=True): return {"agent": self.run}
    def mutate(self, action, **kwargs):
        self.actions.append(action)
        return {"agent": self.run}
    def save_response(self, call_id, payload): self.response = payload; return "project/responses/test.json"
    def read_response(self, ref): return self.response

class AgentModelTests(unittest.TestCase):
    def test_settlement_before_budget_snapshot_retries_admission_instead_of_interrupting(self):
        state=FakeState();original=state.mutate;attempts=[]
        state.run["calls"]["old"]={"status":"completed"}
        def mutate(action,**kwargs):
            if action=="reserve_call":
                attempts.append(kwargs["call_id"])
                if len(attempts)==1:raise AgentAPIError(409,{"error":"inflight","error_code":"budget_inflight"})
            return original(action,**kwargs)
        state.mutate=mutate
        payload={"choices":[{"message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return json.dumps(payload).encode()
        with patch("urllib.request.urlopen",return_value=Response()) as request:
            agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"),state,"turn-0",[],[])
        self.assertEqual(attempts,["turn-0","turn-0"])
        self.assertEqual(request.call_count,1)

    def test_cancel_returns_before_provider_and_late_response_only_settles(self):
        state=FakeState();started=threading.Event();release=threading.Event();settled=threading.Event();errors=[];results=[]
        original=state.mutate
        def mutate(action,**kwargs):
            result=original(action,**kwargs)
            if action=="settle_call":settled.set()
            return result
        state.mutate=mutate
        payload={"choices":[{"message":{"role":"assistant","content":"late"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):
                started.set();release.wait(5)
                return json.dumps(payload).encode()
        def execute():
            try:results.append(agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"),state,"turn-0",[],[]))
            except Exception as error:errors.append(error)
        with patch("urllib.request.urlopen",return_value=Response()) as request:
            thread=threading.Thread(target=execute);thread.start()
            try:
                self.assertTrue(started.wait(1))
                state.run["phase"]="cancelled"
                thread.join(1.5)
                self.assertFalse(thread.is_alive(),"cancelled controller still occupies project worker")
                self.assertEqual(len(errors),1)
                self.assertIsInstance(errors[0],AgentAPIError)
                self.assertFalse(settled.is_set())
            finally:
                release.set();thread.join(2)
                self.assertTrue(settled.wait(2))
            self.assertEqual(request.call_count,1)
            self.assertEqual(results,[])
            self.assertNotIn("mark_unknown",state.actions)

    def test_inflight_budget_wait_reuses_admission_identity_and_sends_once(self):
        state=FakeState();original=state.mutate;reservations=[]
        state.run["calls"]["page"]={"status":"sent"}
        def mutate(action,**kwargs):
            if action=="reserve_call":
                reservations.append(kwargs["call_id"])
                if len(reservations)==1:
                    raise AgentAPIError(409,{"error":"inflight","error_code":"budget_inflight"})
            return original(action,**kwargs)
        state.mutate=mutate
        payload={"choices":[{"message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return json.dumps(payload).encode()
        with patch("urllib.request.urlopen",return_value=Response()) as request,patch("brain.models.time.sleep"):
            agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"),state,"turn-0",[],[])
        self.assertEqual(reservations,["turn-0","turn-0"])
        self.assertEqual(request.call_count,1)
        self.assertEqual(state.actions.count("send_call"),1)
        self.assertIn("work_state",state.actions)

    def test_cancel_during_budget_wait_does_not_send_provider_request(self):
        state=FakeState();original=state.mutate;attempts=[]
        state.run["calls"]["page"]={"status":"sent"}
        def mutate(action,**kwargs):
            if action=="reserve_call":
                attempts.append(action)
                raise AgentAPIError(409,{"error":"inflight" if len(attempts)==1 else "cancelled","error_code":"budget_inflight" if len(attempts)==1 else "conflict"})
            return original(action,**kwargs)
        state.mutate=mutate
        with patch("urllib.request.urlopen",side_effect=AssertionError("no provider request")) as request,patch("brain.models.time.sleep"):
            with self.assertRaisesRegex(AgentAPIError,"cancelled"):
                agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"),state,"turn-0",[],[])
        self.assertEqual(request.call_count,0)
        self.assertNotIn("send_call",state.actions)

    def test_failed_send_admission_releases_known_unsent_reservation(self):
        state=FakeState();original=state.mutate
        def mutate(action,**kwargs):
            if action=="send_call":raise AgentAPIError(402,{"error":"expired","error_code":"budget_exhausted"})
            return original(action,**kwargs)
        state.mutate=mutate
        with patch("urllib.request.urlopen",side_effect=AssertionError("no provider request")) as request:
            with self.assertRaises(AgentAPIError):
                agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"),state,"turn-0",[],[])
        self.assertEqual(request.call_count,0)
        self.assertEqual(state.actions[-1],"reject_call")

    def test_controller_output_limit_and_reservation_use_the_same_8192_budget(self):
        state=FakeState();original=state.mutate;reservations=[]
        def mutate(action,**kwargs):
            if action=="reserve_call":reservations.append(kwargs["cost"])
            return original(action,**kwargs)
        state.mutate=mutate
        payload={"choices":[{"message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return json.dumps(payload).encode()
        with patch("urllib.request.urlopen",return_value=Response()) as request:
            agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"),state,"turn-0",[],[])
        sent=request.call_args.args[0].data
        self.assertEqual(json.loads(sent)["max_tokens"],8192)
        self.assertAlmostEqual(reservations[0],(len(sent)+8192*2)/1_000_000)

    def test_saved_decision_keeps_its_original_project_revision(self):
        state=FakeState();state.run["project_ref"]={"revision_id":"r1"}
        payload={"choices":[{"message":{"role":"assistant","content":"saved decision"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):return json.dumps(payload).encode()
        config=BrainConfig("127.0.0.1",3212,"token",openai_api_key="test")
        with patch("urllib.request.urlopen",return_value=Response()):
            first=agent_complete(config,state,"turn-0",[],[])
        self.assertEqual(first.get("_read_revision_id"),"r1")
        state.run["calls"]["turn-0"]={"status":"completed","response_ref":"saved"}
        state.run["project_ref"]={"revision_id":"r2"}
        with patch("urllib.request.urlopen",side_effect=AssertionError("must replay, not resend")):
            replayed=agent_complete(config,state,"turn-0",[],[])
        self.assertEqual(replayed["_read_revision_id"],"r1")

    def test_deepseek_screenshot_reservation_excludes_base64_but_preserves_images(self):
        from brain.agent_state import AgentAPIError
        class BudgetState(FakeState):
            def mutate(self, action, **kwargs):
                if action == "reserve_call":
                    self.reserved = kwargs["cost"]
                    if self.reserved > 2 - 0.951346:
                        raise AgentAPIError(402, {"error": "reservation exceeds remaining budget", "error_code": "budget_exhausted"})
                return super().mutate(action, **kwargs)
        state = BudgetState()
        state.run["pricing"].update(input_cny_per_million=2,output_cny_per_million=8)
        messages = [{"role":"user","content":[{"type":"text","text":"检查四张页面截图"}]+[
            {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+"A"*size}}
            for size in [140264,209940,227352,167424]]}]
        payload = {"choices":[{"message":{"role":"assistant","content":"检查结果"}}],"usage":{"prompt_tokens":5000,"completion_tokens":10}}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps(payload).encode()
        with patch("urllib.request.urlopen",return_value=Response()) as request:
            agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test",openai_model="deepseek-v4-flash"),state,"turn-1",messages,[])
        self.assertLess(state.reserved,0.1)  # 8192输出预留，仍远小于把Base64误计为正文的费用。
        self.assertEqual(json.loads(request.call_args.args[0].data)["messages"],messages)
        self.assertEqual(request.call_count,1)

    def test_resumed_run_cannot_silently_switch_its_priced_model(self):
        state=FakeState();state.run["pricing"]["model"]="original-model"
        with patch("urllib.request.urlopen",side_effect=AssertionError("provider request must not be sent after model changes")) as request:
            with self.assertRaisesRegex(ValueError,"模型|端点"):
                agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test",openai_model="other-model"),state,"turn-1",[],[])
        self.assertEqual(request.call_count,0)
    def test_native_tool_message_and_usage_are_preserved_without_retries(self):
        state = FakeState()
        payload = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "read_project", "arguments": "{}"}}], "reasoning_content": "provider continuation"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return json.dumps(payload).encode()
        with patch("urllib.request.urlopen", return_value=Response()) as request:
            result = agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"), state, "turn-1", [{"role":"user","content":"开始"}], [{"type":"function","function":{"name":"read_project","parameters":{"type":"object"}}}])
        self.assertEqual(result["tool_calls"][0]["id"], "call_1")
        self.assertIn("reasoning_content", result)
        self.assertEqual(state.actions, ["reserve_call", "send_call", "settle_call"])
        self.assertEqual(request.call_count, 1)
    def test_lost_response_becomes_unknown_and_is_not_retried(self):
        state = FakeState()
        with patch("urllib.request.urlopen", side_effect=TimeoutError("lost")) as request:
            with self.assertRaises(TimeoutError):
                agent_complete(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"),state,"turn-1",[],[])
        self.assertEqual(request.call_count,1)
        self.assertEqual(state.actions[-1],"mark_unknown")
