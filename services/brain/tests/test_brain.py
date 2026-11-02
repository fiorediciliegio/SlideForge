import json
import threading
import unittest
import urllib.error
import urllib.request

from brain.app import create_server
from brain.config import BrainConfig
from brain.documents import chunk_document
from brain.prompts import build_outline_messages, build_page_messages


class BrainUnitTests(unittest.TestCase):
    def test_outline_prompt_preserves_constraints_and_source(self):
        messages = build_outline_messages("季度营收 1200 万，不得改数字", 8, "中文", "原始资料")
        self.assertEqual(len(messages), 2)
        self.assertIn("恰好 8 页", messages[1]["content"])
        self.assertIn("1200 万", messages[1]["content"])
        self.assertIn("原始资料", messages[1]["content"])
        self.assertIn("不得编造", messages[1]["content"])

    def test_page_prompt_preserves_html_and_visual_constraints(self):
        messages = build_page_messages(
            deck_title="季度复盘",
            brief="保留原始数字",
            outline_json='{"title":"季度复盘","pages":[]}',
            page_index=0,
            page_count=2,
            page_title="封面",
            bullets=["营收 1200 万"],
            visual_spec="使用品牌蓝",
            reference_html="<main>参考</main>",
        )
        self.assertEqual(len(messages), 2)
        self.assertIn("1920×1080", messages[0]["content"])
        self.assertIn("使用品牌蓝", messages[1]["content"])
        self.assertIn("禁止复制其中的文字内容", messages[1]["content"])
        self.assertIn("1 / 2", messages[1]["content"])

    def test_document_chunks_are_stable_and_overlapped(self):
        first = chunk_document("甲" * 1_000, chunk_size=500, overlap=100)
        second = chunk_document("甲" * 1_000, chunk_size=500, overlap=100)
        self.assertEqual(first, second)
        self.assertEqual(len(first["chunks"]), 3)
        self.assertEqual(first["chunks"][1]["start"], 400)
        self.assertEqual(first["chunks"][-1]["end"], 1_000)


class BrainHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server(BrainConfig("127.0.0.1", 0, "brain-secret"))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def test_health_and_internal_auth(self):
        with urllib.request.urlopen(f"{self.base}/healthz") as response:
            self.assertEqual(response.status, 200)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post("/internal/brain/outline-prompt", {}, token=None)
        self.assertEqual(caught.exception.code, 404)

    def test_prompt_and_document_endpoints(self):
        prompt = self._post("/internal/brain/outline-prompt", {"brief": "产品复盘", "page_count": 6})
        self.assertEqual(len(prompt["messages"]), 2)
        page = self._post("/internal/brain/page-prompt", {
            "deck_title": "产品复盘",
            "brief": "保留数字",
            "outline_json": "{}",
            "page_index": 0,
            "page_count": 2,
            "page_title": "封面",
            "bullets": ["要点"],
        })
        self.assertEqual(len(page["messages"]), 2)
        self.assertIn("完整 HTML 文档", page["messages"][0]["content"])
        document = self._post("/internal/brain/document-chunks", {"text": "abc", "chunk_size": 500})
        self.assertEqual(document["chars"], 3)
        self.assertEqual(document["chunks"][0]["text"], "abc")

    def test_image_drift_and_evals_endpoints(self):
        png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        drift = self._post("/internal/brain/image-drift", {
            "before_base64": png,
            "after_base64": png,
        })
        self.assertEqual(drift["changed_pixels"], 0)
        self.assertEqual(drift["rms_difference"], 0)
        result = self._post("/internal/brain/evals/run", {
            "cases": [{
                "id": "image-http",
                "type": "image_drift",
                "input": {"before_base64": png, "after_base64": png},
                "expect": {"changed_pixel_ratio_max": 0},
            }],
        })
        self.assertEqual(result["summary"], {"total": 1, "passed": 1, "failed": 0})
        self.assertTrue(result["results"][0]["passed"])

    def _post(self, path, body, token="brain-secret"):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Internal-Token"] = token
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
