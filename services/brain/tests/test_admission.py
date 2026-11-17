import os
import json
import threading
import time
import copy
import unittest
from collections import Counter
from unittest.mock import patch

from brain.harness import AgentRunner
from brain.config import BrainConfig
from brain.models import agent_complete
from brain.agent_state import AgentAPIError


class AdmissionTests(unittest.TestCase):
    def test_cancelled_controller_releases_project_slot_before_late_settlement(self):
        started=threading.Event();release=threading.Event();settled=threading.Event();next_done=threading.Event()
        states={key:{"ownerKeyHash":"a","agent":{"phase":"queued","run_seq":1,"runner_epoch":0,"calls":{},
            "pricing":{"input_cny_per_million":1,"output_cny_per_million":2},
            "budget":{"limit_seconds":600,"active_seconds":0,"limit_cny":2,"spent_cny":0,"reserved_cny":0}}} for key in ("first","next")}
        class State:
            def __init__(self,config,deck_id,run_seq,epoch=0):self.deck_id=deck_id
            def snapshot(self,include_messages=True):return copy.deepcopy(states[self.deck_id])
            def mutate(self,action,**fields):
                run=states[self.deck_id]["agent"]
                if action=="schedule":run["instance_id"]=fields["instance_id"]
                if action=="settle_call" and self.deck_id=="first":settled.set()
                return self.snapshot()
            def save_response(self,*args):return "saved"
        class Response:
            def __init__(self,first):self.first=first
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self):
                if self.first:started.set();release.wait(5)
                return json.dumps({"choices":[{"message":{"role":"assistant","content":"done"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}).encode()
        def run(config,state,*args,**kwargs):
            states[state.deck_id]["agent"]["phase"]="planning"
            try:agent_complete(config,state,state.deck_id,[{"role":"user","content":state.deck_id}],[])
            except AgentAPIError:pass
            finally:
                if state.deck_id=="next":next_done.set()
        with patch.dict(os.environ,{"AGENT_PROJECT_CONCURRENCY":"1","AGENT_OWNER_PROJECT_CONCURRENCY":"1"}), \
                patch("brain.harness.AgentState",State),patch("brain.harness.run_harness",run), \
                patch("urllib.request.urlopen",side_effect=lambda request,**kwargs:Response(json.loads(request.data)["messages"][0]["content"]=="first")):
            runner=AgentRunner(BrainConfig("127.0.0.1",3212,"token",openai_api_key="test"))
            try:
                runner.enqueue("first",1)
                self.assertTrue(started.wait(1))
                runner.enqueue("next",1)
                states["first"]["agent"]["phase"]="cancelled"
                states["first"]["agent"]["runner_epoch"]+=1
                self.assertTrue(next_done.wait(1.5),"next project stayed blocked by cancelled controller")
                self.assertFalse(settled.is_set())
            finally:
                release.set();self.assertTrue(settled.wait(2));runner.close()

    def test_cancelled_queued_project_is_removed_without_waiting_for_a_slot(self):
        state={"ownerKeyHash":"a","agent":{"run_seq":1,"runner_epoch":0,"phase":"queued"}}
        class State:
            def __init__(self,*args): pass
            def snapshot(self): return state
            def mutate(self,action,**fields):
                state["agent"].update({k:v for k,v in fields.items() if k=="instance_id"})
                return state
        with patch("brain.harness.AgentState",State), patch("threading.Thread.start"):
            runner=AgentRunner(None)
            runner.enqueue("cancelled",1)
            state["agent"]["phase"]="cancelled"
            with patch.object(runner.stopping,"wait",side_effect=[False,True]):
                runner._heartbeat()
            self.assertEqual(runner.waiting,0)
            self.assertFalse(runner.pending)
            self.assertFalse(runner.queue)
            self.assertFalse(runner.owners)
            runner.close()

    def test_owner_limit_skips_blocked_head_and_fills_five_slots(self):
        jobs = {f"a{i}": "a" for i in range(6)} | {k: k for k in "bcde"}
        result=self.exercise(jobs, ["a0", "a1", "a2", "a3", "a4", "a5", "b", "c", "d", "e"])
        print(json.dumps(result))

    def exercise(self, owners, order):
        gates = {key: threading.Event() for key in owners}
        changed = threading.Condition()
        active = Counter()
        started = []
        peaks = Counter()
        states = {}
        for key, owner in owners.items():
            states[key] = {"ownerKeyHash": owner, "agent": {"run_seq": 1, "runner_epoch": 0,
                "checkpoint_seq": 0, "phase": "queued"}}

        class State:
            def __init__(self, config, deck_id, run_seq, epoch=0):
                self.deck_id = deck_id
                self.runner_epoch = epoch

            def snapshot(self):
                return states[self.deck_id]

            def mutate(self, action, **fields):
                states[self.deck_id]["agent"].update({k: v for k, v in fields.items()
                    if k == "instance_id"})
                return states[self.deck_id]

        def run(_config, state, _instance, **_kwargs):
            key = state.deck_id
            with changed:
                active[owners[key]] += 1
                peaks[owners[key]] = max(peaks[owners[key]], active[owners[key]])
                peaks["total"] = max(peaks["total"], sum(active.values()))
                started.append(key)
                states[key]["agent"]["phase"] = "generating"
                changed.notify_all()
            gates[key].wait(5)
            with changed:
                active[owners[key]] -= 1
                states[key]["agent"]["phase"] = "waiting_outline"
                changed.notify_all()

        with patch.dict(os.environ, {"AGENT_PROJECT_CONCURRENCY": "5", "AGENT_OWNER_PROJECT_CONCURRENCY": "2"}), \
                patch("brain.harness.AgentState", State), patch("brain.harness.run_harness", run):
            runner = AgentRunner(None)
            try:
                for key in order:
                    runner.enqueue(key, 1)
                runner.enqueue(order[0], 1)
                with changed:
                    self.assertTrue(changed.wait_for(lambda: len(started) >= 5, timeout=2))
                    self.assertEqual(peaks["total"], 5)
                    self.assertLessEqual(peaks["a"], 2)
                    self.assertTrue(any(key in started for key in "bcde"))
                    self.assertEqual(started.count(order[0]), 1)
                gates["a0"].set()
                for key in "bcde":
                    gates[key].set()
                with changed:
                    self.assertTrue(changed.wait_for(lambda: "a2" in started, timeout=2))
                self.assertLessEqual(peaks["a"], 2)
            finally:
                for event in gates.values():
                    event.set()
                with changed:
                    self.assertTrue(changed.wait_for(lambda: len(started)==len(owners) and sum(active.values()) == 0, timeout=2))
                runner.close()
                time.sleep(0.05)
        return {"scenario":"project-admission-burst10","completed":len(started),"peak_active_projects":peaks["total"],"peak_same_key_projects":peaks["a"],"real_provider_requests":0}
