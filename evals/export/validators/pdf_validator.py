from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


def _pdfinfo(path: Path) -> tuple[int | None, str | None, str]:
    executable = shutil.which("pdfinfo")
    if not executable:
        return None, None, "pdfinfo unavailable; structural parser used"
    completed = subprocess.run(
        [executable, str(path)],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return None, None, completed.stderr.strip() or "pdfinfo failed"
    pages_match = re.search(r"^Pages:\s+(\d+)\s*$", completed.stdout, re.MULTILINE)
    size_match = re.search(r"^Page size:\s+(.+)$", completed.stdout, re.MULTILINE)
    pages = int(pages_match.group(1)) if pages_match else None
    page_size = size_match.group(1).strip() if size_match else None
    return pages, page_size, "pdfinfo parsed document"


def validate_pdf(path: Path, expected_page_count: int) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    errors: list[str] = []

    def check(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": passed, "detail": detail})
        if not passed:
            errors.append(f"{name}: {detail}")

    if not path.is_file():
        check("file_exists", False, f"Missing file: {path}")
        return {"valid": False, "validator": "pdfinfo+structural", "checks": checks, "errors": errors}

    size_bytes = path.stat().st_size
    check("file_non_empty", size_bytes > 1024, f"size={size_bytes}")
    check("file_size_sanity", size_bytes < 100 * 1024 * 1024, f"size={size_bytes}")
    data = path.read_bytes()
    check("pdf_signature", data.startswith(b"%PDF-"), data[:8].decode("latin-1", errors="replace"))
    check("eof_marker", b"%%EOF" in data[-2048:], "EOF marker present" if b"%%EOF" in data[-2048:] else "EOF marker missing")

    page_objects = len(re.findall(rb"/Type\s*/Page\b", data))
    check("structural_page_count", page_objects == expected_page_count, f"expected={expected_page_count}, actual={page_objects}")
    image_objects = len(re.findall(rb"/Subtype\s*/Image\b", data))
    check("non_blank_image_content", image_objects >= expected_page_count, f"image_objects={image_objects}")
    check("page_content_stream", b"/Contents" in data, "page content reference present" if b"/Contents" in data else "missing /Contents")

    pages, page_size, parser_detail = _pdfinfo(path)
    if pages is None:
        check("pdf_parser", page_objects == expected_page_count, parser_detail)
    else:
        check("pdf_parser", True, parser_detail)
        check("parsed_page_count", pages == expected_page_count, f"expected={expected_page_count}, actual={pages}")

    return {
        "valid": not errors,
        "validator": "pdfinfo+structural",
        "size_bytes": size_bytes,
        "page_count": pages if pages is not None else page_objects,
        "page_size": page_size,
        "image_object_count": image_objects,
        "checks": checks,
        "errors": errors,
    }

