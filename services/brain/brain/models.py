import json
import copy
import hashlib
import math
import queue
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

from .config import BrainConfig
from .agent_state import AgentAPIError
from .prompts import build_outline_messages


def _saved_message(result):
    message = copy.deepcopy(result["choices"][0]["message"])
    message["_read_revision_id"] = result.get("_project_revision_id")
    return message


def agent_complete(config: BrainConfig, state, call_id: str, messages: list, tools: list) -> dict:
    """One provider request; calls and usage share the durable execution budget."""
    run = state.snapshot()["agent"]
    decision_revision = (run.get("project_ref") or {}).get("revision_id", "")
    if any(call["status"]=="unknown" for call in run.get("calls",{}).values()):
        raise RuntimeError("存在结果未知的模型调用，需要用户明确处理后继续")
    pricing = run.get("pricing")
    if not pricing or not isinstance(pricing.get("input_cny_per_million"),(int,float)) or not isinstance(pricing.get("output_cny_per_million"),(int,float)) or not math.isfinite(pricing["input_cny_per_million"]) or not math.isfinite(pricing["output_cny_per_million"]) or pricing["input_cny_per_million"]<0 or pricing["output_cny_per_million"]<=0:
        raise ValueError("Agent 缺少有效模型价格配置")
    if (pricing.get("model") and pricing["model"]!=config.openai_model) or (pricing.get("base_url") and pricing["base_url"]!=config.openai_base_url):
        raise ValueError("恢复任务的模型或端点与原报价不一致，请恢复原配置或开始新的执行")
    if not config.openai_api_key:
        raise ValueError("Python 大脑层未配置 OPENAI_API_KEY")
    payload = {"model": config.openai_model, "messages": messages, "tools": tools, "temperature": 0.4, "max_tokens": 8192}
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    input_hash = hashlib.sha256(encoded).hexdigest()
    calls = run.get("calls", {})
    base_id = call_id
    related = [key for key in calls if key == base_id or key.startswith(base_id + ":retry:")]
    if related:
        call_id = max(related, key=lambda key: 0 if key == base_id else int(key.rsplit(":",1)[1]))
    existing = calls.get(call_id)
    if existing and existing["status"] in ("retry_approved", "rejected"):
        call_id = base_id + ":retry:" + str(len(related))
        existing = None
    if existing and existing["status"] == "completed":
        return _saved_message(state.read_response(existing["response_ref"]))
    if existing and existing["status"] not in ("reserved", "rejected"):
        raise RuntimeError(f"调用 {call_id} 结果未知，禁止自动重发")
    estimated_input_tokens = len(encoded)
    if urlparse(config.openai_base_url).hostname == "api.deepseek.com":
        estimate = copy.deepcopy(payload)
        image_tokens = 0
        for message in estimate["messages"]:
            if isinstance(message.get("content"), list):
                for part in message["content"]:
                    if part.get("type") == "image_url":
                        # DeepSeek caps each image at 1024 tokens; Base64 bytes are transport, not text tokens.
                        # https://api-docs.deepseek.com/zh-cn/guides/vision/#token-用量
                        image_tokens += 1024
                        part["image_url"] = {}
        estimated_input_tokens = len(json.dumps(estimate, ensure_ascii=False).encode("utf-8")) + image_tokens
    cost = (estimated_input_tokens * pricing["input_cny_per_million"] + payload["max_tokens"] * pricing["output_cny_per_million"]) / 1_000_000
    waiting = False
    try:
        while True:
            try:
                state.mutate("reserve_call", call_id=call_id, input_hash=input_hash, cost=cost)
                break
            except AgentAPIError as error:
                if error.code != "budget_inflight":
                    raise
                if not waiting:
                    state.mutate("work_state", operation_id="model:"+call_id, work_state="budget")
                    waiting = True
                run = state.snapshot(include_messages=False)["agent"]
                budget = run["budget"]
                if budget["spent_cny"] + budget["reserved_cny"] + cost <= budget["limit_cny"] + 0.0000001:
                    continue
                if not any(call["status"] in ("sent","reserved") for call in run.get("calls",{}).values()):
                    raise AgentAPIError(409,{"error":"费用预留没有可推进的调用，请恢复执行状态","error_code":"conflict"})
                time.sleep(0.25)
    finally:
        if waiting:
            try:
                state.mutate("work_state", operation_id="model:"+call_id, work_state="done")
            except AgentAPIError as error:
                if error.status != 409:
                    raise
    try:
        state.mutate("send_call", call_id=call_id)
    except Exception:
        # Provider I/O has not started, so this reservation is known to be unsent.
        state.mutate("reject_call", call_id=call_id)
        raise
    request = urllib.request.Request(f"{config.openai_base_url}/chat/completions", data=encoded,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {config.openai_api_key}"}, method="POST")
    replies = queue.Queue(maxsize=1)
    def request_and_settle():
        try:
            try:
                timeout = max(1, min(240, run["budget"]["limit_seconds"] - run["budget"]["active_seconds"]))
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    result = json.loads(response.read().decode("utf-8"))
                result["_project_revision_id"] = decision_revision
                response_ref = state.save_response(call_id, result)
                usage = result["usage"]
                actual = (usage["prompt_tokens"] * pricing["input_cny_per_million"] + usage["completion_tokens"] * pricing["output_cny_per_million"]) / 1_000_000
                state.mutate("settle_call", call_id=call_id, cost=actual, response_ref=response_ref, usage=usage)
                replies.put((True,_saved_message(result)))
            except urllib.error.HTTPError as error:
                state.mutate("reject_call" if 400 <= error.code < 500 else "mark_unknown", call_id=call_id)
                raise
            except Exception:
                state.mutate("mark_unknown", call_id=call_id)
                raise
        except Exception as error:
            replies.put((False,error))
    threading.Thread(target=request_and_settle,daemon=True).start()
    while True:
        try:
            ok, result = replies.get(timeout=0.25)
            if ok: return result
            raise result
        except queue.Empty:
            current = state.snapshot(include_messages=False)["agent"]
            if (current["run_seq"],current["runner_epoch"]) != (run["run_seq"],run["runner_epoch"]) or current["phase"] not in ("planning","generating","checking","revising"):
                raise AgentAPIError(409,{"error":"执行已取消或改变，等待中的总控请求仅保留结算","error_code":"conflict"})
            if any(call["status"]=="unknown" for call in current.get("calls",{}).values()):
                raise AgentAPIError(409,{"error":"存在结果未知的模型调用，需要用户明确处理后继续","error_code":"unknown_calls"})


def generate_outline(
    config: BrainConfig,
    brief: str,
    page_count: int,
    language: str = "中文",
    source_text: str = "",
) -> dict:
    if not config.openai_api_key:
        raise RuntimeError("Python 大脑层未配置 OPENAI_API_KEY")
    messages = build_outline_messages(brief, page_count, language, source_text)
    payload = json.dumps({
        "model": config.openai_model,
        "messages": messages,
        "temperature": 0.4,
    }, ensure_ascii=False).encode("utf-8")
    last_error = None
    for attempt in range(3):
        request = urllib.request.Request(
            f"{config.openai_base_url}/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.openai_api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=240) as response:
                result = json.loads(response.read().decode("utf-8"))
            text = result["choices"][0]["message"]["content"]
            outline = _parse_outline(text, page_count)
            usage = result.get("usage")
            if isinstance(usage, dict):
                outline["usage"] = usage
            return outline
        except (urllib.error.URLError, KeyError, IndexError, TypeError, ValueError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(attempt + 1)
    raise RuntimeError(f"大纲模型调用失败：{last_error}")


def _parse_outline(text: str, page_count: int) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```JSON").removeprefix("```")
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    begin = cleaned.find("{")
    end = cleaned.rfind("}")
    if begin < 0 or end <= begin:
        raise ValueError("模型未返回 JSON 大纲")
    value = json.loads(cleaned[begin:end + 1])
    if not isinstance(value, dict) or not isinstance(value.get("title"), str) or not value["title"].strip():
        raise ValueError("大纲 title 无效")
    pages = value.get("pages")
    if not isinstance(pages, list) or len(pages) != page_count:
        raise ValueError(f"大纲页数不符：期望 {page_count}")
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get("title"), str) or not page["title"].strip():
            raise ValueError("大纲页面 title 无效")
        bullets = page.get("bullets")
        if not isinstance(bullets, list) or not all(isinstance(item, str) for item in bullets):
            raise ValueError("大纲页面 bullets 无效")
    return value
