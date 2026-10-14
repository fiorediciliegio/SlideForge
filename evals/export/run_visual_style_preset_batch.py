#!/usr/bin/env python3
"""Export the 61 resource-complete Visual Style Presets as PPTX and PDF."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html as html_module
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from run_export_batch import (
    PPT_APP_ROOT,
    RESULTS_ROOT,
    collect_versions,
    invoke_tool,
    read_json,
    render_pdf_preview,
    run_build,
)
from validators.pdf_validator import validate_pdf
from validators.pptx_validator import validate_pptx


PRESETS_ROOT = PPT_APP_ROOT / "src" / "features" / "templates" / "presets"
EXPECTED_PRESET_COUNT = 88
EXPECTED_COMPLETE_PRESET_COUNT = 61
EXTERNAL_SCHEME = re.compile(r"^(?:[a-z][a-z\d+.-]*:|//)", re.IGNORECASE)
CSS_URL = re.compile(r"\burl\(\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s)'\"=<>`]+))\s*\)", re.IGNORECASE)
FONT_FACE = re.compile(r"@font-face\s*\{.*?\}", re.IGNORECASE | re.DOTALL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build and export the 61 resource-complete Visual Style Presets."
    )
    parser.add_argument("--skip-build", action="store_true", help="Use the current ppt-engine dist build.")
    parser.add_argument("--formats", help="Comma-separated formats (default: pptx,pdf; reuse the saved value with --resume-run-dir).")
    parser.add_argument("--repeat", type=int, help="Exports per format (default: 1; reuse the saved value with --resume-run-dir).")
    parser.add_argument("--timeout-ms", type=int, default=600_000)
    parser.add_argument("--presets", help="Comma-separated preset ids for a targeted run.")
    parser.add_argument("--limit", type=int, help="Run only the first N eligible presets, useful for smoke tests.")
    parser.add_argument("--dry-run", action="store_true", help="Audit and list the 61/27 split without exporting.")
    parser.add_argument(
        "--resume-run-dir",
        type=Path,
        help="Continue an interrupted run in this existing .eval-results directory.",
    )
    parser.add_argument(
        "--rasterize-pptx",
        action="store_true",
        help="Re-open every PPTX and render all slides to PNG. Thorough but substantially slower.",
    )
    return parser.parse_args()


def _clean_reference(value: str) -> str:
    return re.sub(r"[?#].*$", "", value.strip())


def _classify_reference(value: str) -> tuple[str, str] | None:
    cleaned = _clean_reference(value)
    if not cleaned or cleaned.startswith("#") or cleaned.startswith("data:"):
        return None
    if EXTERNAL_SCHEME.match(cleaned):
        return ("external", cleaned)
    return ("local", cleaned)


class ResourceReferenceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[tuple[str, str]] = []
        self.slide_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value or "" for name, value in attrs}
        classes = values.get("class", "").split()
        if "slide" in classes:
            self.slide_count += 1
        source = values.get("src")
        if source:
            classified = _classify_reference(source)
            if classified:
                self.references.append(classified)
        if tag.lower() == "link" and "stylesheet" in values.get("rel", "").lower().split():
            href = values.get("href")
            if href:
                classified = _classify_reference(href)
                if classified:
                    self.references.append(classified)


def page_references(source: str) -> tuple[list[tuple[str, str]], int]:
    parser = ResourceReferenceParser()
    parser.feed(source)
    references = list(parser.references)
    for match in CSS_URL.finditer(source):
        value = next((group for group in match.groups() if group is not None), "")
        classified = _classify_reference(value)
        if classified:
            references.append(classified)
    return references, parser.slide_count


def audit_preset(preset_dir: Path) -> dict[str, Any]:
    config_path = preset_dir / "preset.json"
    preset = read_json(config_path)
    pages = preset.get("reference_html_pages")
    if not isinstance(pages, list) or not pages:
        raise RuntimeError(f"Invalid reference_html_pages: {config_path}")

    missing: set[str] = set()
    outside: set[str] = set()
    external: set[str] = set()
    local_copies: dict[tuple[str, str], Path] = {}
    page_records: list[dict[str, Any]] = []
    font_face_count = 0
    font_urls: set[str] = set()
    preset_root = preset_dir.resolve()

    for index, page in enumerate(pages, start=1):
        relative = page.get("path") if isinstance(page, dict) else None
        if not isinstance(relative, str):
            raise RuntimeError(f"Invalid page path in {config_path}: index={index}")
        source_path = (preset_dir / relative).resolve()
        try:
            source_path.relative_to(preset_root)
        except ValueError:
            raise RuntimeError(f"Page escapes preset directory: {source_path}")
        if not source_path.is_file():
            raise RuntimeError(f"Missing preset page: {source_path}")
        source = source_path.read_text(encoding="utf-8")
        references, slide_count = page_references(source)
        if slide_count != 1:
            raise RuntimeError(f"Expected exactly one .slide root in {source_path}; found {slide_count}")

        font_blocks = FONT_FACE.findall(source)
        font_face_count += len(font_blocks)
        for block in font_blocks:
            for match in CSS_URL.finditer(block):
                value = next((group for group in match.groups() if group is not None), "")
                if value:
                    font_urls.add(value.strip())

        local_resources: list[dict[str, str]] = []
        for kind, reference in references:
            if kind == "external":
                external.add(reference)
                continue
            decoded = unquote(reference)
            resource_path = (source_path.parent / decoded).resolve()
            try:
                resource_path.relative_to(preset_root)
            except ValueError:
                outside.add(f"{relative}: {reference}")
                continue
            if not resource_path.is_file():
                missing.add(f"{relative}: {reference}")
                continue
            # The HTML moves from html/<name> to slides/<uuid>. Its relative
            # reference is resolved from slides/ and copied to that exact target.
            target_key = (relative, reference)
            local_copies[target_key] = resource_path
            local_resources.append({"reference": reference, "source_path": str(resource_path)})

        page_records.append({
            "index": index,
            "relative_path": relative,
            "source_path": str(source_path),
            "description": page.get("description", "") if isinstance(page, dict) else "",
            "local_resources": local_resources,
        })

    return {
        "id": preset.get("id", preset_dir.name),
        "name": preset.get("name", preset_dir.name),
        "ppt_number": preset.get("ppt_number"),
        "preset_dir": str(preset_dir.resolve()),
        "page_count": len(page_records),
        "pages": page_records,
        "preview_images": preset.get("preview_images", []),
        "missing_resources": sorted(missing),
        "outside_resources": sorted(outside),
        "external_resources": sorted(external),
        "font_face_rule_count": font_face_count,
        "unique_font_url_count": len(font_urls),
        "eligible": not missing and not outside,
    }


def discover_corpus() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    directories = sorted(
        (path for path in PRESETS_ROOT.iterdir() if path.is_dir() and (path / "preset.json").is_file()),
        key=lambda path: path.name.casefold(),
    )
    if len(directories) != EXPECTED_PRESET_COUNT:
        raise RuntimeError(f"Expected {EXPECTED_PRESET_COUNT} presets; found {len(directories)}")
    audits = [audit_preset(path) for path in directories]
    eligible = [audit for audit in audits if audit["eligible"]]
    excluded = [audit for audit in audits if not audit["eligible"]]
    if len(eligible) != EXPECTED_COMPLETE_PRESET_COUNT:
        raise RuntimeError(
            f"Expected {EXPECTED_COMPLETE_PRESET_COUNT} resource-complete presets; found {len(eligible)}. "
            "The corpus changed; review its resources before exporting."
        )
    return eligible, excluded


def safe_key(audit: dict[str, Any]) -> str:
    number = audit.get("ppt_number")
    if isinstance(number, int):
        return f"preset-{number:03d}"
    digest = hashlib.sha256(str(audit["id"]).encode("utf-8")).hexdigest()[:8]
    return f"preset-{digest}"


def page_id(preset_id: str, index: int) -> str:
    digest = hashlib.sha256(f"{preset_id}:{index}".encode("utf-8")).digest()[:16]
    return f"page-{uuid.UUID(bytes=digest, version=4)}"


def prepare_preset_workspace(audit: dict[str, Any], run_root: Path, request_id: int) -> dict[str, Any]:
    key = safe_key(audit)
    workspace = run_root / "prepared" / key
    slides_dir = workspace / "slides"
    rendered_dir = workspace / "rendered"
    slides_dir.mkdir(parents=True, exist_ok=False)
    manifest_slides: list[dict[str, str]] = []

    for page in audit["pages"]:
        identifier = page_id(str(audit["id"]), int(page["index"]))
        destination = slides_dir / f"{identifier}.html"
        shutil.copy2(page["source_path"], destination)
        for resource in page["local_resources"]:
            reference = unquote(resource["reference"])
            target = (destination.parent / reference).resolve()
            try:
                target.relative_to(workspace.resolve())
            except ValueError:
                raise RuntimeError(f"Resource target escapes prepared workspace: {target}")
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copy2(resource["source_path"], target)
        manifest_slides.append({"id": identifier, "source": f"./slides/{identifier}.html"})

    manifest_path = workspace / "manifest.json"
    manifest_path.write_text(
        json.dumps({"title": audit["name"], "slides": manifest_slides}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    started = time.perf_counter()
    result, peak_memory, stderr = invoke_tool("buildDeckHtmlFromManifest", {
        "manifest_path": str(manifest_path.resolve()),
        "output_dir": str(rendered_dir.resolve()),
        "name": key,
    }, request_id)
    build_ms = round((time.perf_counter() - started) * 1000)
    deck_path_value = result.get("deck_output_path") or result.get("deckOutputPath")
    if not deck_path_value:
        raise RuntimeError("buildDeckHtmlFromManifest did not return deck_output_path")
    deck_path = Path(str(deck_path_value)).resolve()
    slide_paths = sorted(path.resolve() for path in rendered_dir.glob("*.html") if path.resolve() != deck_path)
    if not deck_path.is_file() or len(slide_paths) != audit["page_count"]:
        raise RuntimeError(
            f"Prepared output mismatch for {audit['id']}: deck={deck_path.is_file()}, "
            f"expected_pages={audit['page_count']}, actual_pages={len(slide_paths)}"
        )
    return {
        "workspace": str(workspace),
        "rendered_dir": str(rendered_dir),
        "deck_path": str(deck_path),
        "slide_paths": [str(path) for path in slide_paths],
        "build_ms": build_ms,
        "build_peak_memory_bytes": peak_memory,
        "build_stderr": stderr,
        "build_result": result,
    }


def run_export(
    audit: dict[str, Any],
    prepared: dict[str, Any],
    run_root: Path,
    export_format: str,
    repetition: int,
    timeout_ms: int,
    request_id: int,
    rasterize_pptx: bool,
    resume: bool = False,
) -> dict[str, Any]:
    key = safe_key(audit)
    output_dir = run_root / "artifacts" / key / export_format / f"r{repetition:02d}"
    if resume and output_dir.exists():
        artifacts_root = (run_root / "artifacts").resolve()
        try:
            output_dir.resolve().relative_to(artifacts_root)
        except ValueError as error:
            raise RuntimeError(f"Refusing to remove artifact outside the resumed run: {output_dir}") from error
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=False)
    source_root = Path(prepared["rendered_dir"])
    deck_path = Path(prepared["deck_path"])
    slide_paths = [Path(path) for path in prepared["slide_paths"]]
    endpoint: dict[str, Any] = {}
    validator: dict[str, Any] = {"valid": False, "errors": ["export did not complete"]}
    peak_memory: int | None = None
    stderr = ""
    preview_path: Path | None = None
    exception_message = None

    try:
        arguments: dict[str, Any] = {
            "request_id": f"{key}-{export_format}-r{repetition}",
            "format": export_format,
            "source_root": str(source_root.resolve()),
            "deck_html_file": str(deck_path.relative_to(source_root)),
            "expected_slide_count": audit["page_count"],
            "title": audit["name"],
            "output_dir": str(output_dir.resolve()),
            "timeout_ms": timeout_ms,
        }
        if export_format == "pdf":
            arguments["slide_html_files"] = [str(path.relative_to(source_root)) for path in slide_paths]
        endpoint, peak_memory, stderr = invoke_tool("app_run_export_only", arguments, request_id)
        output_path = Path(endpoint["output_path"]) if endpoint.get("output_path") else None
        if endpoint.get("status") == "completed" and output_path:
            if export_format == "pptx":
                validator = validate_pptx(output_path, audit["page_count"])
                if validator.get("valid") and rasterize_pptx:
                    raster_dir = run_root / "review-previews" / "pptx" / f"{key}-r{repetition:02d}"
                    raster, _, _ = invoke_tool("app_rasterize_pptx_to_images", {
                        "pptx_path": str(output_path.resolve()),
                        "output_dir": str(raster_dir.resolve()),
                        "target_height": 720,
                        "overwrite": True,
                    }, 100_000 + request_id)
                    raster_count = int(raster.get("slide_count", 0))
                    raster_ok = raster_count == audit["page_count"]
                    validator["checks"].append({
                        "name": "pptx_rasterization",
                        "passed": raster_ok,
                        "detail": f"expected={audit['page_count']}, actual={raster_count}",
                    })
                    if not raster_ok:
                        validator["valid"] = False
                        validator["errors"].append("pptx_rasterization: page count mismatch")
                    elif raster.get("slides"):
                        preview_path = Path(raster["slides"][0]["image_path"])
            else:
                validator = validate_pdf(output_path, audit["page_count"])
                preview_path = render_pdf_preview(
                    output_path,
                    run_root / "review-previews" / "pdf" / f"{key}-r{repetition:02d}.png",
                )
    except Exception as error:
        exception_message = str(error)

    timings = endpoint.get("timings_ms", {})
    error_message = exception_message or (endpoint.get("error") or {}).get("message")
    passed = endpoint.get("status") == "completed" and validator.get("valid") is True
    return {
        "preset_id": audit["id"],
        "preset_name": audit["name"],
        "preset_key": key,
        "page_count": audit["page_count"],
        "format": export_format,
        "repeat": repetition,
        "passed": passed,
        "endpoint_status": endpoint.get("status", "exception"),
        "validator_valid": validator.get("valid", False),
        "phase": endpoint.get("phase"),
        "total_ms": timings.get("total"),
        "convert_ms": timings.get("convert"),
        "size_bytes": endpoint.get("size_bytes"),
        "peak_memory_bytes": peak_memory,
        "font_face_rule_count": audit["font_face_rule_count"],
        "unique_font_url_count": audit["unique_font_url_count"],
        "external_resource_count": len(audit["external_resources"]),
        "warning_count": endpoint.get("warning_count", 0),
        "warnings": endpoint.get("warnings", []),
        "font_embed_warnings": endpoint.get("font_embed_warnings", []),
        "output_path": endpoint.get("output_path"),
        "preview_path": str(preview_path) if preview_path else None,
        "error_message": error_message,
        "endpoint": endpoint,
        "validator": validator,
        "plugin_stderr": stderr,
        "manual_review": "pending",
    }


def write_reports(run_root: Path, report: dict[str, Any], selected: list[dict[str, Any]]) -> None:
    (run_root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    columns = [
        "preset_id", "preset_name", "page_count", "format", "repeat", "passed", "endpoint_status",
        "validator_valid", "phase", "total_ms", "convert_ms", "size_bytes", "peak_memory_bytes",
        "font_face_rule_count", "unique_font_url_count", "external_resource_count", "warning_count",
        "output_path", "error_message",
    ]
    with (run_root / "report.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        for attempt in report["attempts"]:
            writer.writerow({name: attempt.get(name) for name in columns})

    attempts_by_preset: dict[str, list[dict[str, Any]]] = {}
    for attempt in report["attempts"]:
        attempts_by_preset.setdefault(attempt["preset_id"], []).append(attempt)
    rows: list[str] = []
    for audit in selected:
        attempts = attempts_by_preset.get(audit["id"], [])
        statuses = []
        for attempt in attempts:
            output = Path(attempt["output_path"]) if attempt.get("output_path") else None
            link = f'<a href="{html_module.escape(output.as_uri())}">打开</a>' if output and output.is_file() else "—"
            css = "pass" if attempt["passed"] else "fail"
            statuses.append(
                f'<span class="{css}">{attempt["format"].upper()}: '
                f'{"PASS" if attempt["passed"] else "FAIL"}</span> {link}'
            )
        preview = None
        previews = audit.get("preview_images") or []
        if previews and isinstance(previews[0], dict):
            candidate = Path(audit["preset_dir"]) / str(previews[0].get("path", ""))
            if candidate.is_file():
                preview = candidate
        preview_html = (
            f'<a href="{html_module.escape(preview.as_uri())}"><img src="{html_module.escape(preview.as_uri())}"></a>'
            if preview else "—"
        )
        rows.append(
            "<tr>"
            f"<td>{preview_html}</td><td>{html_module.escape(str(audit['id']))}</td>"
            f"<td>{audit['page_count']}</td><td>{'<br>'.join(statuses) or '准备失败'}</td>"
            f"<td>{len(audit['external_resources'])}</td></tr>"
        )
    summary = report["summary"]
    document = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>61 Visual Style Preset Export Eval</title>
<style>body{{font:14px/1.5 Arial,'Microsoft YaHei',sans-serif;margin:0;background:#f4f6fa;color:#182033}}main{{max-width:1500px;margin:auto;padding:32px}}.cards{{display:flex;gap:16px;margin:22px 0}}.metric{{background:#fff;padding:16px 22px;border-radius:12px}}.metric strong{{display:block;font-size:28px}}table{{width:100%;border-collapse:collapse;background:#fff}}th,td{{border:1px solid #dce2ec;padding:9px;text-align:left}}th{{background:#eaf0f8}}td img{{width:160px;aspect-ratio:16/9;object-fit:cover}}.pass{{color:#087443;font-weight:bold}}.fail{{color:#b42318;font-weight:bold}}a{{color:#315ac7}}</style></head><body><main>
<h1>61 个资源完整 Visual Style Preset · Export-only Eval</h1>
<p>每个模板先通过生产 Deck 构建，再各导出一次 PPTX/PDF。技术通过不等于视觉验收完成。</p>
<div class="cards"><div class="metric"><span>模板</span><strong>{summary['selected_presets']}</strong></div><div class="metric"><span>页面</span><strong>{summary['selected_pages']}</strong></div><div class="metric"><span>通过/总导出</span><strong>{summary['passed']}/{summary['total_attempts']}</strong></div><div class="metric"><span>准备失败</span><strong>{summary['preparation_failed']}</strong></div></div>
<table><thead><tr><th>源预览</th><th>Preset</th><th>页数</th><th>导出</th><th>外部资源</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
</main></body></html>"""
    (run_root / "report.html").write_text(document, encoding="utf-8")


def checkpoint(
    run_root: Path,
    run_id: str,
    started_at: str,
    selected: list[dict[str, Any]],
    excluded: list[dict[str, Any]],
    versions: dict[str, Any],
    preparations: list[dict[str, Any]],
    attempts: list[dict[str, Any]],
    formats: list[str],
    repeat: int,
) -> dict[str, Any]:
    passed = sum(1 for attempt in attempts if attempt["passed"])
    preparation_failed = sum(1 for preparation in preparations if not preparation["passed"])
    report = {
        "schema_version": 1,
        "run_id": run_id,
        "mode": "export-only-visual-style-presets",
        "started_at": started_at,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "formats": formats,
        "repeat": repeat,
        "versions": versions,
        "summary": {
            "discovered_presets": EXPECTED_PRESET_COUNT,
            "eligible_presets": EXPECTED_COMPLETE_PRESET_COUNT,
            "excluded_presets": len(excluded),
            "selected_presets": len(selected),
            "selected_pages": sum(int(audit["page_count"]) for audit in selected),
            "preparation_failed": preparation_failed,
            "total_attempts": len(attempts),
            "passed": passed,
            "failed": len(attempts) - passed,
            "success_rate": passed / len(attempts) if attempts else 0,
            "expected_attempts": len(selected) * len(formats) * repeat,
        },
        "excluded": [{
            "id": audit["id"],
            "page_count": audit["page_count"],
            "missing_resources": audit["missing_resources"],
            "outside_resources": audit["outside_resources"],
        } for audit in excluded],
        "preparations": preparations,
        "attempts": attempts,
    }
    write_reports(run_root, report, selected)
    return report


def existing_prepared_workspace(audit: dict[str, Any], run_root: Path) -> dict[str, Any] | None:
    """Return a valid prepared artifact from a previous interrupted run."""
    key = safe_key(audit)
    workspace = run_root / "prepared" / key
    rendered_dir = workspace / "rendered"
    if not rendered_dir.is_dir():
        return None
    deck_candidates = sorted(rendered_dir.glob("*-deck.html"))
    if len(deck_candidates) != 1:
        return None
    deck_path = deck_candidates[0]
    slide_paths = sorted(path.resolve() for path in rendered_dir.glob("*.html") if path.resolve() != deck_path.resolve())
    if len(slide_paths) != audit["page_count"]:
        return None
    return {
        "workspace": str(workspace),
        "rendered_dir": str(rendered_dir),
        "deck_path": str(deck_path),
        "slide_paths": [str(path) for path in slide_paths],
        "build_ms": None,
        "build_peak_memory_bytes": None,
        "build_stderr": "",
        "build_result": {},
    }


def discard_incomplete_prepared_workspace(audit: dict[str, Any], run_root: Path) -> None:
    """Remove only a malformed per-preset preparation left by an interrupted run."""
    workspace = run_root / "prepared" / safe_key(audit)
    prepared_root = (run_root / "prepared").resolve()
    resolved_workspace = workspace.resolve()
    try:
        resolved_workspace.relative_to(prepared_root)
    except ValueError as error:
        raise RuntimeError(f"Refusing to remove preparation outside the resumed run: {workspace}") from error
    if workspace.exists():
        shutil.rmtree(workspace)


def attempt_key(item: dict[str, Any]) -> tuple[str, str, int]:
    return (str(item.get("preset_id", "")), str(item.get("format", "")), int(item.get("repeat", 0)))


def replace_by_key(items: list[dict[str, Any]], value: dict[str, Any], key: Any) -> None:
    for index, item in enumerate(items):
        if key(item) == key(value):
            items[index] = value
            return
    items.append(value)


def record_reused_preparation(
    audit: dict[str, Any],
    preparations: list[dict[str, Any]],
) -> None:
    previous = next(
        (item for item in preparations if str(item.get("preset_id", "")) == audit["id"]),
        {},
    )
    replace_by_key(preparations, {
        "preset_id": audit["id"],
        "preset_key": safe_key(audit),
        "page_count": audit["page_count"],
        "passed": True,
        "build_ms": previous.get("build_ms"),
        "build_peak_memory_bytes": previous.get("build_peak_memory_bytes"),
        "error_message": None,
    }, lambda item: str(item.get("preset_id", "")))


def resume_run_state(
    run_root: Path,
    formats: list[str] | None,
    repeat: int | None,
) -> tuple[str, str, dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[str], int]:
    report_path = run_root / "report.json"
    if not run_root.is_dir() or not report_path.is_file():
        raise RuntimeError(f"--resume-run-dir must contain report.json: {run_root}")
    report = read_json(report_path)
    if report.get("mode") != "export-only-visual-style-presets":
        raise RuntimeError(f"Not a Visual Style Preset export run: {run_root}")
    saved_formats = report.get("formats")
    saved_repeat = report.get("repeat")
    if not isinstance(saved_formats, list) or not all(isinstance(item, str) for item in saved_formats):
        raise RuntimeError(f"Resume report has invalid formats: {report_path}")
    if not isinstance(saved_repeat, int) or saved_repeat < 1:
        raise RuntimeError(f"Resume report has invalid repeat: {report_path}")
    resolved_formats = formats if formats is not None else saved_formats
    resolved_repeat = repeat if repeat is not None else saved_repeat
    if resolved_formats != saved_formats or resolved_repeat != saved_repeat:
        raise RuntimeError("--formats and --repeat must match the interrupted run when resuming")
    preparations = report.get("preparations")
    attempts = report.get("attempts")
    if not isinstance(preparations, list) or not isinstance(attempts, list):
        raise RuntimeError(f"Resume report has invalid checkpoints: {report_path}")
    run_id = report.get("run_id")
    started_at = report.get("started_at")
    versions = report.get("versions")
    if not isinstance(run_id, str) or not isinstance(started_at, str) or not isinstance(versions, dict):
        raise RuntimeError(f"Resume report lacks run metadata: {report_path}")
    return run_id, started_at, versions, preparations, attempts, resolved_formats, resolved_repeat


def main() -> int:
    args = parse_args()
    requested_formats = [item.strip().lower() for item in args.formats.split(",") if item.strip()] if args.formats else None
    formats = requested_formats if requested_formats is not None else ["pptx", "pdf"]
    repeat = args.repeat if args.repeat is not None else 1
    if not formats or any(item not in {"pptx", "pdf"} for item in formats):
        raise RuntimeError("--formats must contain pptx and/or pdf")
    if repeat < 1:
        raise RuntimeError("--repeat must be positive")
    if not 1_000 <= args.timeout_ms <= 600_000:
        raise RuntimeError("--timeout-ms must be between 1000 and 600000")
    if args.limit is not None and args.limit < 1:
        raise RuntimeError("--limit must be positive")

    eligible, excluded = discover_corpus()
    selected = eligible
    if args.presets:
        requested = {item.strip() for item in args.presets.split(",") if item.strip()}
        selected = [audit for audit in eligible if audit["id"] in requested]
        missing_ids = requested - {audit["id"] for audit in selected}
        if missing_ids:
            raise RuntimeError(f"Requested preset ids are missing or resource-incomplete: {sorted(missing_ids)}")
    if args.limit is not None:
        selected = selected[:args.limit]
    if args.resume_run_dir and (args.presets or args.limit is not None):
        raise RuntimeError("--resume-run-dir only resumes the original full preset selection")

    print(f"Discovered: {EXPECTED_PRESET_COUNT} presets / {sum(a['page_count'] for a in eligible + excluded)} pages")
    print(f"Eligible:   {len(eligible)} presets / {sum(a['page_count'] for a in eligible)} pages")
    print(f"Excluded:   {len(excluded)} presets / {sum(a['page_count'] for a in excluded)} pages")
    print(f"Selected:   {len(selected)} presets / {sum(a['page_count'] for a in selected)} pages")
    if args.dry_run:
        print("\nExcluded presets:")
        for audit in excluded:
            print(f"  {audit['id']} | missing={len(audit['missing_resources'])} | pages={audit['page_count']}")
        return 0

    if args.skip_build:
        print("Using current ppt-engine dist (--skip-build).", flush=True)
    else:
        run_build()

    if args.resume_run_dir:
        run_root = args.resume_run_dir.resolve()
        run_id, started_at, versions, preparations, attempts, formats, repeat = resume_run_state(
            run_root, requested_formats, args.repeat,
        )
        if int((read_json(run_root / "report.json").get("summary") or {}).get("selected_presets", 0)) != len(selected):
            raise RuntimeError("Resume report selection does not match the current preset corpus")
        print(
            f"Resuming: {run_root} | completed attempts="
            f"{sum(1 for attempt in attempts if attempt.get('passed') is True)}/{len(selected) * len(formats) * repeat}",
            flush=True,
        )
        for audit in selected:
            if existing_prepared_workspace(audit, run_root):
                record_reused_preparation(audit, preparations)
    else:
        run_id = f"visual-style-presets-61x2-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        run_root = RESULTS_ROOT / run_id
        run_root.mkdir(parents=True, exist_ok=False)
        started_at = datetime.now(timezone.utc).isoformat()
        versions = collect_versions()
        preparations = []
        attempts = []
    request_id = len(preparations) + len(attempts) + 1
    print(f"Results: {run_root}", flush=True)

    for index, audit in enumerate(selected, start=1):
        key = safe_key(audit)
        missing_attempts = [
            (export_format, repetition)
            for export_format in formats
            for repetition in range(1, repeat + 1)
            if not any(
                attempt_key(attempt) == (audit["id"], export_format, repetition)
                and attempt.get("passed") is True
                for attempt in attempts
            )
        ]
        if not missing_attempts:
            print(f"[{index}/{len(selected)}] {audit['id']} | already complete; skipping", flush=True)
            continue

        print(f"[{index}/{len(selected)}] {audit['id']} | preparing {audit['page_count']} pages ...", flush=True)
        prepared = existing_prepared_workspace(audit, run_root) if args.resume_run_dir else None
        if prepared:
            record_reused_preparation(audit, preparations)
            print("  REUSING PREPARED HTML", flush=True)
        else:
            try:
                if args.resume_run_dir:
                    discard_incomplete_prepared_workspace(audit, run_root)
                prepared = prepare_preset_workspace(audit, run_root, request_id)
                preparation = {
                    "preset_id": audit["id"],
                    "preset_key": key,
                    "page_count": audit["page_count"],
                    "passed": True,
                    "build_ms": prepared["build_ms"],
                    "build_peak_memory_bytes": prepared["build_peak_memory_bytes"],
                    "error_message": None,
                }
                replace_by_key(preparations, preparation, lambda item: str(item.get("preset_id", "")))
                print(f"  PREPARED | {prepared['build_ms']} ms", flush=True)
            except Exception as error:
                preparation = {
                    "preset_id": audit["id"],
                    "preset_key": key,
                    "page_count": audit["page_count"],
                    "passed": False,
                    "build_ms": None,
                    "build_peak_memory_bytes": None,
                    "error_message": str(error),
                }
                replace_by_key(preparations, preparation, lambda item: str(item.get("preset_id", "")))
                print(f"  PREPARE FAIL | {error}", flush=True)
            request_id += 1

        if prepared:
            for export_format, repetition in missing_attempts:
                print(f"  {export_format.upper()} r{repetition} ...", flush=True)
                attempt = run_export(
                    audit,
                    prepared,
                    run_root,
                    export_format,
                    repetition,
                    args.timeout_ms,
                    request_id,
                    args.rasterize_pptx,
                    resume=bool(args.resume_run_dir),
                )
                replace_by_key(attempts, attempt, attempt_key)
                request_id += 1
                print(
                    f"    {'PASS' if attempt['passed'] else 'FAIL'} | "
                    f"{attempt.get('total_ms') or '?'} ms | {attempt.get('size_bytes') or '?'} bytes",
                    flush=True,
                )

        checkpoint(
            run_root, run_id, started_at, selected, excluded, versions,
            preparations, attempts, formats, repeat,
        )

    report = checkpoint(
        run_root, run_id, started_at, selected, excluded, versions,
        preparations, attempts, formats, repeat,
    )
    summary = report["summary"]
    print(
        f"Completed: exports={summary['passed']}/{summary['total_attempts']}, "
        f"preparation_failed={summary['preparation_failed']}",
        flush=True,
    )
    print(f"HTML report: {run_root / 'report.html'}", flush=True)
    complete = (
        summary["preparation_failed"] == 0
        and summary["total_attempts"] == summary["expected_attempts"]
        and summary["failed"] == 0
    )
    return 0 if complete else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
