import base64
import hmac
import json
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import BrainConfig, load_config
from .documents import chunk_document, extract_document
from .evals import run_evals
from .images import analyze_image_drift
from .models import generate_outline
from .prompts import build_outline_messages, build_page_messages

MAX_BODY_BYTES = 2 * 1024 * 1024


def create_server(config: BrainConfig) -> ThreadingHTTPServer:
    class BrainHandler(BaseHTTPRequestHandler):
        server_version = "SlideForgeBrain/0.1"

        def do_GET(self) -> None:
            if self.path == "/healthz":
                self._json(200, {"ok": True, "service": "slideforge-brain"})
                return
            self._json(404, self._error("not found", "not_found"))

        def do_POST(self) -> None:
            if not self.path.startswith("/internal/brain/"):
                self._json(404, self._error("not found", "not_found"))
                return
            if config.internal_token and not hmac.compare_digest(
                self.headers.get("X-Internal-Token", ""), config.internal_token
            ):
                self._json(404, self._error("not found", "not_found"))
                return
            try:
                large_payload = self.path in {"/internal/brain/image-drift", "/internal/brain/evals/run"}
                body = self._read_body(64 * 1024 * 1024 if large_payload else MAX_BODY_BYTES)
                if self.path == "/internal/brain/outline-prompt":
                    result = {
                        "messages": build_outline_messages(
                            brief=str(body.get("brief", "")),
                            page_count=int(body.get("page_count", 0)),
                            language=str(body.get("language", "中文")),
                            source_text=str(body.get("source_text", "")),
                        )
                    }
                elif self.path == "/internal/brain/page-prompt":
                    result = {
                        "messages": build_page_messages(
                            deck_title=str(body.get("deck_title", "")),
                            brief=str(body.get("brief", "")),
                            outline_json=str(body.get("outline_json", "")),
                            page_index=int(body.get("page_index", -1)),
                            page_count=int(body.get("page_count", 0)),
                            page_title=str(body.get("page_title", "")),
                            bullets=[str(item) for item in body.get("bullets", [])],
                            visual_spec=str(body.get("visual_spec", "")),
                            reference_html=str(body.get("reference_html", "")),
                        )
                    }
                elif self.path == "/internal/brain/outline":
                    result = generate_outline(
                        config,
                        brief=str(body.get("brief", "")),
                        page_count=int(body.get("page_count", 0)),
                        language=str(body.get("language", "中文")),
                        source_text=str(body.get("source_text", "")),
                    )
                elif self.path == "/internal/brain/document-extract":
                    content = base64.b64decode(str(body.get("content_base64", "")), validate=True)
                    result = extract_document(str(body.get("filename", "attachment")), content)
                elif self.path == "/internal/brain/image-drift":
                    result = analyze_image_drift(
                        base64.b64decode(str(body.get("before_base64", "")), validate=True),
                        base64.b64decode(str(body.get("after_base64", "")), validate=True),
                        int(body.get("threshold", 16)),
                    )
                elif self.path == "/internal/brain/evals/run":
                    result = run_evals(config, body.get("cases") or [])
                elif self.path == "/internal/brain/document-chunks":
                    result = chunk_document(
                        text=str(body.get("text", "")),
                        max_chars=int(body.get("max_chars", 12_000)),
                        chunk_size=int(body.get("chunk_size", 4_000)),
                        overlap=int(body.get("overlap", 200)),
                    )
                else:
                    self._json(404, self._error("not found", "not_found"))
                    return
                self._json(200, result)
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self._json(400, self._error(str(error), "bad_request"))
            except Exception as error:  # pragma: no cover - final process boundary
                self._json(500, self._error(str(error), "internal_error", True))

        def _read_body(self, max_bytes: int) -> dict:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > max_bytes:
                raise ValueError("请求体为空或超过大小上限")
            value = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("JSON 请求体必须是对象")
            return value

        def _json(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        @staticmethod
        def _error(message: str, code: str, retryable: bool = False) -> dict:
            return {"error": message, "error_code": code, "retryable": retryable}

        def log_message(self, format: str, *args) -> None:
            return

    return ThreadingHTTPServer((config.host, config.port), BrainHandler)


def main() -> None:
    config = load_config()
    server = create_server(config)
    stopping = threading.Event()

    def shutdown(*_args) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown)
    print(f"[slideforge-brain] listening on http://{config.host}:{config.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
