import io
import json
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer

from brain.config import BrainConfig
from brain.documents import extract_document
from brain.models import generate_outline


class ModelTests(unittest.TestCase):
    def test_model_outline_is_validated_and_keeps_usage(self):
        outline = {
            "title": "测试",
            "pages": [
                {"title": "封面", "bullets": ["A"]},
                {"title": "结论", "bullets": ["B"]},
            ],
        }

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                data = json.dumps({
                    "choices": [{"message": {"content": json.dumps(outline)}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 20},
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                return

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            config = BrainConfig(
                "127.0.0.1", 0, "secret",
                openai_base_url=f"http://127.0.0.1:{server.server_address[1]}",
                openai_api_key="test-key",
                openai_model="test-model",
            )
            result = generate_outline(config, "测试需求", 2)
            self.assertEqual(result["title"], "测试")
            self.assertEqual(result["usage"]["completion_tokens"], 20)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


class DocumentTests(unittest.TestCase):
    def test_docx_text_is_extracted(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                "word/document.xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                "<w:body><w:p><w:r><w:t>第一季度</w:t></w:r></w:p>"
                "<w:p><w:r><w:t>营收 1200 万</w:t></w:r></w:p></w:body></w:document>",
            )
        result = extract_document("report.docx", buffer.getvalue())
        self.assertEqual(result["kind"], "docx")
        self.assertIn("第一季度\n营收 1200 万", result["text"])
        self.assertEqual(result["chars"], len(result["text"]))


if __name__ == "__main__":
    unittest.main()
