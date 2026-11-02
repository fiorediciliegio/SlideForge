import base64
import io
import unittest
from unittest import mock

from PIL import Image

from brain.config import BrainConfig
from brain.evals import run_evals
from brain.images import analyze_image_drift


def png(color, size=(10, 10), changed_pixel=None):
    image = Image.new("RGB", size, color)
    if changed_pixel:
        image.putpixel(changed_pixel, (255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class ImageTests(unittest.TestCase):
    def test_identical_images_have_zero_drift(self):
        result = analyze_image_drift(png("black"), png("black"))
        self.assertEqual(result["changed_pixels"], 0)
        self.assertEqual(result["rms_difference"], 0)
        self.assertIsNone(result["difference_bbox"])

    def test_changed_pixel_and_resize_are_deterministic(self):
        result = analyze_image_drift(png("black"), png("black", changed_pixel=(2, 3)))
        self.assertEqual(result["changed_pixels"], 1)
        self.assertEqual(result["changed_pixel_ratio"], 0.01)
        self.assertEqual(result["difference_bbox"], [2, 3, 3, 4])
        resized = analyze_image_drift(png("black"), png("white", size=(5, 5)))
        self.assertTrue(resized["resized"])
        self.assertEqual(resized["changed_pixel_ratio"], 1)

    def test_image_pixel_limit_is_enforced(self):
        with mock.patch("brain.images.MAX_IMAGE_PIXELS", 99):
            with self.assertRaisesRegex(ValueError, "像素超过"):
                analyze_image_drift(png("black"), png("black"))


class EvalTests(unittest.TestCase):
    def test_evals_run_document_and_image_cases(self):
        before = base64.b64encode(png("black")).decode()
        after = base64.b64encode(png("black")).decode()
        result = run_evals(BrainConfig("127.0.0.1", 0, "secret"), [
            {
                "id": "doc-1",
                "type": "document_extraction",
                "input": {"filename": "a.txt", "content_base64": base64.b64encode("营收 1200 万".encode()).decode()},
                "expect": {"kind": "txt", "text_contains": ["1200 万"]},
            },
            {
                "id": "image-1",
                "type": "image_drift",
                "input": {"before_base64": before, "after_base64": after},
                "expect": {"changed_pixel_ratio_max": 0, "resized": False},
            },
        ])
        self.assertEqual(result["summary"], {"total": 2, "passed": 2, "failed": 0})
        self.assertTrue(all(case["passed"] for case in result["results"]))

    def test_evals_reject_duplicate_case_ids(self):
        with self.assertRaisesRegex(ValueError, "id 重复"):
            run_evals(BrainConfig("127.0.0.1", 0, "secret"), [
                {"id": "same", "type": "document_extraction", "input": {}},
                {"id": "same", "type": "document_extraction", "input": {}},
            ])


if __name__ == "__main__":
    unittest.main()
