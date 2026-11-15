import json
import logging
import os
import queue
import threading
import uuid

from .agent_state import AgentState, AgentAPIError
from .agent_tools import initial_messages, model_messages
from .models import agent_complete

logger = logging.getLogger(__name__)


def _pending_turn(messages):
    index = len(messages) - 1
    while index >= 0 and messages[index]["role"] == "tool":
        index -= 1
    if index < 0 or messages[index]["role"] != "assistant":
        return None
    assistant = messages[index]
    calls = assistant.get("tool_calls") or []
    answered = {message["tool_call_id"] for message in messages[index + 1:]}
    if any(call["id"] not in answered for call in calls):
        return assistant, answered
    return None


def run_harness(config, state, instance_id, model=agent_complete, heartbeat=True):
    run = state.snapshot()["agent"]
    if run["runner_epoch"]!=state.runner_epoch:
        return
    claimed = state.mutate("claim", expected_checkpoint=run["checkpoint_seq"], instance_id=instance_id)["agent"]
    state.runner_epoch = claimed["runner_epoch"]
    stop = threading.Event()
    if heartbeat:
        def pulse():
            while not stop.wait(10):
                try: state.mutate("heartbeat")
                except Exception as error:
                    logger.error("Agent heartbeat failed: %s", type(error).__name__)
                    return
        threading.Thread(target=pulse, daemon=True).start()
    try:
        description = state.tool("_describe", {}, "describe")
        run = state.snapshot()["agent"]
        messages = run.get("messages") or initial_messages(description, run["options"])
        conflict=description.get("page_count_conflict")
        if conflict and not description["context"].get("user_response"):
            current=state.snapshot()["agent"]
            state.mutate("transition",expected_checkpoint=current["checkpoint_seq"],phase="waiting_user",messages=messages,
                request={"request_id":str(uuid.uuid4()),"reason_code":"page_policy","question":f"需求明确要求{conflict['requested']}页，与当前页数规则冲突。请选择需求页数，或说明以当前控件规则为准。全部页面须在2–20页内。","proposal":conflict})
            return
        # A resumed task needs the current user confirmation/answer, without inventing a tool call.
        if run.get("messages") and _pending_turn(messages) is None:
            context = description["context"]
            resumed={"role":"user","content":json.dumps({"恢复后的当前大纲":context["project"]["outline"],"已确认大纲":context["project"].get("confirmed_outline_revision"),"场景":context["project"].get("scenario"),"约束":context["project"].get("constraints"),"本次修改":context.get("instruction"),"用户补充":context.get("user_response")},ensure_ascii=False)}
            if messages[-1].get("_image_evidence_id"): messages=messages[:-1]+[resumed,messages[-1]]
            else: messages=messages+[resumed]
        policy = run["options"]["page_policy"]
        target = policy.get("count", policy.get("max", 20))
        for _ in range(12 + 4 * target):
            run = state.snapshot()["agent"]
            if run["runner_epoch"]!=state.runner_epoch:
                return
            if run["phase"] in ("cancelled", "paused_budget", "interrupted"):
                return
            prices = run.get("pricing")
            if prices is None and os.getenv("AGENT_INPUT_CNY_PER_MILLION") and os.getenv("AGENT_OUTPUT_CNY_PER_MILLION"):
                prices = {"input_cny_per_million":float(os.environ["AGENT_INPUT_CNY_PER_MILLION"]),"output_cny_per_million":float(os.environ["AGENT_OUTPUT_CNY_PER_MILLION"]),"version":os.getenv("AGENT_PRICING_VERSION",config.openai_model if config else "configured"),"model":config.openai_model if config else "test","base_url":config.openai_base_url if config else "test","currency":"CNY"}
            state.mutate("transition", expected_checkpoint=run["checkpoint_seq"], phase="planning", messages=messages, **({"pricing":prices} if prices else {}))
            turn = sum(item["role"] == "assistant" for item in messages)
            # Resume the unreturned calls of a saved assistant turn using their original IDs.
            pending = _pending_turn(messages)
            if pending is not None:
                turn -= 1
            if pending is None:
                assistant = model(config, state, f"turn-{turn}", model_messages(messages,state), description["tools"])
                messages.append(assistant)
                current = state.snapshot()["agent"]
                selected = (assistant.get("tool_calls") or [{}])[0].get("function",{}).get("name")
                phase = {"generate_pages":"generating","revise_page":"revising","inspect_deck":"checking","record_assessment":"checking"}.get(selected,"planning")
                state.mutate("transition", expected_checkpoint=current["checkpoint_seq"], phase=phase, messages=messages)
            else:
                assistant = pending[0]
            calls = assistant.get("tool_calls") or []
            if not calls:
                messages.append({"role":"user","content":"请根据观察选择一个工具；交付必须调用finish_deck，需要用户则request_user。"})
                continue
            source_batch = bool(calls)
            for call in calls:
                try:
                    args = json.loads(call["function"]["arguments"])
                except json.JSONDecodeError:
                    source_batch = False
                    break
                if call["function"]["name"] != "read_project" or not isinstance(args,dict) or args.get("section") != "sources" or not isinstance(args.get("source_id"),str) or not args["source_id"]:
                    source_batch = False
                    break
            answered = pending[1] if pending else set()
            pause = None; completed = False; images = None
            for index, call in enumerate(calls):
                if call["id"] in answered:
                    continue
                if source_batch:
                    current = state.snapshot()["agent"]
                    if current["runner_epoch"] != state.runner_epoch or current["phase"] in ("cancelled","paused_budget","interrupted"):
                        return
                if source_batch and len(calls) > 4:
                    result = {"error":"资料正文读取每批最多4项，每项最多4000字符；请拆批重新选择，本批未执行"}
                elif index and not source_batch:
                    result = {"error":"每回合只执行一个工具，请下一回合重新选择"}
                else:
                    try:
                        args = json.loads(call["function"]["arguments"])
                        result = state.tool(call["function"]["name"], args, f"turn-{turn}:{call['id']}")
                    except (json.JSONDecodeError, AgentAPIError) as error:
                        if isinstance(error,AgentAPIError) and (error.status >= 500 or error.code == "budget_exhausted"):
                            raise
                        result = {"error": str(error)}
                if source_batch:
                    current = state.snapshot()["agent"]
                    if current["runner_epoch"] != state.runner_epoch or current["phase"] in ("cancelled","paused_budget","interrupted"):
                        return
                if result.get("images") or result.get("has_images"):
                    images = result["evidence_id"]
                    result = {key:value for key,value in result.items() if key!="images"}
                messages.append({"role":"tool","tool_call_id":call["id"],"content":json.dumps(result,ensure_ascii=False)})
                if source_batch:
                    state.mutate("transition",expected_checkpoint=current["checkpoint_seq"],phase="planning",messages=messages)
                pause = result if result.get("pause") else pause
                completed = completed or bool(result.get("completed"))
            if source_batch:
                continue
            if images:
                messages.append({"role":"user","content":"查看本批视觉证据，按页面ID记录判断。","_image_evidence_id":images})
            current = state.snapshot()["agent"]
            if current["runner_epoch"]!=state.runner_epoch:
                return
            state.mutate("transition", expected_checkpoint=current["checkpoint_seq"], phase=pause["pause"] if pause else "completed" if completed else "planning", messages=messages, **({"request":pause["request"]} if pause and pause.get("request") else {}))
            if pause or completed: return
        current = state.snapshot()["agent"]
        state.mutate("transition",expected_checkpoint=current["checkpoint_seq"],phase="waiting_user",messages=messages,request={"request_id":str(uuid.uuid4()),"reason_code":"repair_limit","question":"已达到本次决策回合上限，现有结果已保存。请调整要求后继续，或结束本次执行。"})
    except Exception as error:
        current = state.snapshot()["agent"]
        if current["runner_epoch"]!=state.runner_epoch:
            return
        if current["phase"] in ("cancelled","paused_budget","interrupted"):
            return
        if isinstance(error,AgentAPIError) and error.code == "budget_exhausted":
            state.mutate("transition",expected_checkpoint=current["checkpoint_seq"],phase="paused_budget",error=str(error))
        else:
            state.mutate("interrupt",error=str(error))
        logger.error("Agent run interrupted (%s): %s",state.deck_id if hasattr(state,"deck_id") else "test",type(error).__name__)
    finally:
        stop.set()


class AgentRunner:
    def __init__(self,config):
        self.config = config
        self.instance_id = str(uuid.uuid4())
        self.queue = queue.Queue(maxsize=50)
        self.pending = set()
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        concurrency = int(os.environ.get("AGENT_PROJECT_CONCURRENCY", "5"))
        if not 1 <= concurrency <= 20:
            raise ValueError("AGENT_PROJECT_CONCURRENCY 必须为1–20的整数")
        for _ in range(concurrency):
            threading.Thread(target=self._worker,daemon=True).start()
        threading.Thread(target=self._heartbeat,daemon=True).start()

    def enqueue(self,deck_id,run_seq):
        with self.lock:
            state=AgentState(self.config,deck_id,run_seq)
            run=state.snapshot()["agent"]
            if run["run_seq"]!=run_seq: raise ValueError("执行版本已改变")
            if run["phase"]!="queued":
                if run["phase"] in ("planning","generating","checking","revising","waiting_outline","waiting_user","completed"):
                    return {"accepted":True,"duplicate":True}
                raise ValueError("任务未排队，请先由用户确认继续")
            key=(deck_id,run_seq,run["runner_epoch"])
            if key in self.pending: return {"accepted":True,"duplicate":True}
            state.runner_epoch=run["runner_epoch"]
            state.mutate("schedule",instance_id=self.instance_id)
            self.queue.put_nowait(key)
            self.pending.add(key)
        return {"accepted":True}

    def _worker(self):
        while not self.stopping.is_set():
            try: key=self.queue.get(timeout=1)
            except queue.Empty: continue
            try:
                run_harness(self.config,AgentState(self.config,*key),self.instance_id,heartbeat=False)
            except Exception as error:
                logger.error("Agent worker failed: %s",type(error).__name__)
            finally:
                with self.lock: self.pending.discard(key)
                self.queue.task_done()

    def _heartbeat(self):
        while not self.stopping.wait(10):
            with self.lock: keys=list(self.pending)
            for key in keys:
                try:
                    state=AgentState(self.config,*key);run=state.snapshot()["agent"]
                    owns_epoch=(run["phase"]=="queued" and run["runner_epoch"]==key[2]) or (run["phase"] in ("planning","generating","checking","revising") and run["runner_epoch"]==key[2]+1)
                    if run.get("instance_id")==self.instance_id and owns_epoch:
                        state.runner_epoch=run["runner_epoch"];state.mutate("heartbeat")
                except Exception as error:
                    logger.error("Agent scheduling heartbeat failed: %s",type(error).__name__)

    def close(self): self.stopping.set()
