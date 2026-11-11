import json
import os
import urllib.request
import urllib.error


class AgentAPIError(RuntimeError):
    def __init__(self, status, payload):
        super().__init__(payload.get("error", f"内部服务 HTTP {status}"))
        self.status = status
        self.code = payload.get("error_code")


class AgentState:
    def __init__(self, config, deck_id, run_seq, runner_epoch=0):
        self.config, self.deck_id, self.run_seq, self.runner_epoch = config, deck_id, run_seq, runner_epoch
        self.jobs_url = os.environ.get("SLIDEFORGE_JOB_API_URL", "").rstrip("/")
        self.capability_url = os.environ.get("ENGINE_UPSTREAM_URL", "").rstrip("/")
        if not self.jobs_url or not self.capability_url:
            raise ValueError("Agent 需要 SLIDEFORGE_JOB_API_URL 与 ENGINE_UPSTREAM_URL")

    def post(self, url, body, timeout=300):
        request = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json", "X-Internal-Token": self.config.internal_token or ""}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise AgentAPIError(error.code, json.loads(error.read())) from error

    def snapshot(self):
        result = self.post(self.jobs_url, {"action": "get", "deck_id": self.deck_id}, 15)["job"]
        if not result or not result.get("agent"):
            raise ValueError("Agent 执行不存在")
        if result["agent"].get("messages_ref"):
            result["agent"]["messages"] = self.post(self.capability_url + "/internal/agent/model-results", {"deck_id":self.deck_id,"run_seq":self.run_seq,"checkpoint_ref":result["agent"]["messages_ref"]})["messages"]
        return result

    def mutate(self, action, **fields):
        if "messages" in fields:
            fields["messages_ref"] = self.post(self.capability_url + "/internal/agent/model-results", {"deck_id":self.deck_id,"run_seq":self.run_seq,"messages":fields.pop("messages")})["checkpoint_ref"]
        return self.post(self.jobs_url + "/agent", {"action": action, "deck_id": self.deck_id,
            "run_seq": self.run_seq, "runner_epoch": self.runner_epoch, **fields}, 15)["job"]

    def save_response(self, call_id, payload):
        return self.post(self.capability_url + "/internal/agent/model-results", {"deck_id": self.deck_id,
            "run_seq": self.run_seq, "call_id": call_id, "payload": payload})["response_ref"]

    def read_response(self, ref):
        return self.post(self.capability_url + "/internal/agent/model-results", {"deck_id": self.deck_id,
            "run_seq": self.run_seq, "response_ref": ref})["payload"]

    def tool(self, name, args, operation_id):
        return self.post(self.capability_url + "/internal/agent/tools", {"deck_id": self.deck_id,
            "run_seq": self.run_seq, "runner_epoch": self.runner_epoch, "operation_id": operation_id, "name": name, "args": args})
