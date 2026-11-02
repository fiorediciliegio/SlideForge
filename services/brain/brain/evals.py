import base64
import time

from .config import BrainConfig
from .documents import extract_document
from .images import analyze_image_drift
from .models import generate_outline


def run_evals(config: BrainConfig, cases: list) -> dict:
    if not cases or len(cases) > 50:
        raise ValueError("cases 必须包含 1–50 个夹具")
    results = []
    seen_ids = set()
    for case in cases:
        started = time.perf_counter()
        case_id = str(case.get("id", "")).strip()
        if not case_id:
            raise ValueError("每个 Eval case 都需要非空 id")
        if case_id in seen_ids:
            raise ValueError(f"Eval case id 重复：{case_id}")
        seen_ids.add(case_id)
        try:
            metrics = _run_case(config, case)
            results.append({
                "id": case_id,
                "passed": True,
                "metrics": metrics,
                "duration_ms": round((time.perf_counter() - started) * 1000, 3),
            })
        except Exception as error:
            results.append({
                "id": case_id,
                "passed": False,
                "error": str(error),
                "duration_ms": round((time.perf_counter() - started) * 1000, 3),
            })
    passed = sum(1 for result in results if result["passed"])
    return {
        "summary": {"total": len(results), "passed": passed, "failed": len(results) - passed},
        "results": results,
    }


def _run_case(config: BrainConfig, case: dict) -> dict:
    case_type = case.get("type")
    inputs = case.get("input") or {}
    expected = case.get("expect") or {}
    if case_type == "document_extraction":
        result = extract_document(
            str(inputs.get("filename", "")),
            base64.b64decode(inputs.get("content_base64", ""), validate=True),
        )
        if expected.get("kind") and result["kind"] != expected["kind"]:
            raise ValueError(f"kind 不符：{result['kind']}")
        for text in expected.get("text_contains", []):
            if text not in result["text"]:
                raise ValueError(f"文档缺少预期文本：{text}")
        return {"kind": result["kind"], "chars": result["chars"], "document_id": result["document_id"]}
    if case_type == "image_drift":
        result = analyze_image_drift(
            base64.b64decode(inputs.get("before_base64", ""), validate=True),
            base64.b64decode(inputs.get("after_base64", ""), validate=True),
            int(inputs.get("threshold", 16)),
        )
        if "changed_pixel_ratio_max" in expected and result["changed_pixel_ratio"] > expected["changed_pixel_ratio_max"]:
            raise ValueError("changed_pixel_ratio 超过阈值")
        if "rms_difference_max" in expected and result["rms_difference"] > expected["rms_difference_max"]:
            raise ValueError("rms_difference 超过阈值")
        if "resized" in expected and result["resized"] != expected["resized"]:
            raise ValueError("resized 不符")
        return result
    if case_type == "outline":
        result = generate_outline(
            config,
            brief=str(inputs.get("brief", "")),
            page_count=int(inputs.get("page_count", 0)),
            language=str(inputs.get("language", "中文")),
            source_text=str(inputs.get("source_text", "")),
        )
        if expected.get("title") and result["title"] != expected["title"]:
            raise ValueError("大纲 title 不符")
        if expected.get("page_count") and len(result["pages"]) != expected["page_count"]:
            raise ValueError("大纲页数不符")
        return {"title": result["title"], "page_count": len(result["pages"])}
    raise ValueError(f"不支持的 Eval 类型：{case_type}")
