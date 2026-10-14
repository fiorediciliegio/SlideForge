#!/usr/bin/env python3
"""Run fixed Final Deck HTML cases through the production export-only tool."""

from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from validators.pdf_validator import validate_pdf
from validators.pptx_validator import validate_pptx


EXPORT_EVAL_ROOT = Path(__file__).resolve().parent
PPT_APP_ROOT = EXPORT_EVAL_ROOT.parent.parent
REPOSITORY_ROOT = PPT_APP_ROOT.parent.parent
ENGINE_ROOT = PPT_APP_ROOT / "executas" / "ppt-engine"
PLUGIN_PATH = ENGINE_ROOT / "example_plugin.js"
CASES_ROOT = EXPORT_EVAL_ROOT / "cases"
DEFAULT_CONFIG = EXPORT_EVAL_ROOT / "batch-configs" / "phase-1-smoke.json"
RESULTS_ROOT = PPT_APP_ROOT / ".eval-results" / "export"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the export-only PPTX/PDF evaluation batch.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--skip-build", action="store_true", help="Use the current ppt-engine dist build.")
    parser.add_argument("--formats", help="Comma-separated override: pptx,pdf")
    parser.add_argument("--cases", help="Comma-separated case id override")
    parser.add_argument("--repeat", type=int, help="Positive repeat override")
    parser.add_argument("--timeout-ms", type=int, help="Export timeout override (1000..600000)")
    return parser.parse_args()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object: {path}")
    return value


def run_build() -> None:
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise RuntimeError("npm was not found in PATH")
    print("Building ppt-engine ...", flush=True)
    subprocess.run([npm, "run", "build"], cwd=ENGINE_ROOT, check=True)


def _monitor_process_tree(process: subprocess.Popen[str], stop: threading.Event, peak: list[int | None]) -> None:
    try:
        import psutil  # type: ignore[import-not-found]
    except ImportError:
        return
    maximum = 0
    while not stop.is_set():
        try:
            root = psutil.Process(process.pid)
            processes = [root, *root.children(recursive=True)]
            total = 0
            for child in processes:
                try:
                    total += int(child.memory_info().rss)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            maximum = max(maximum, total)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        stop.wait(0.05)
    peak[0] = maximum or None


def invoke_json_rpc(request: dict[str, Any]) -> tuple[dict[str, Any], int | None, str]:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node was not found in PATH")
    process = subprocess.Popen(
        [node, str(PLUGIN_PATH)],
        cwd=ENGINE_ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    stop = threading.Event()
    peak: list[int | None] = [None]
    monitor = threading.Thread(target=_monitor_process_tree, args=(process, stop, peak), daemon=True)
    monitor.start()
    stdout, stderr = process.communicate(json.dumps(request, ensure_ascii=False) + "\n")
    stop.set()
    monitor.join(timeout=2)
    if process.returncode != 0:
        raise RuntimeError(f"ppt-engine exited with code {process.returncode}: {stderr.strip() or stdout.strip()}")

    response: dict[str, Any] | None = None
    for line in reversed(stdout.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            response = candidate
            break
    if response is None:
        raise RuntimeError(f"No JSON-RPC response: {stderr.strip() or stdout.strip()}")

    transport = response.get("__file_transport") or response.get("__trans_file__")
    if transport:
        pointer = Path(str(transport))
        response = read_json(pointer)
        pointer.unlink(missing_ok=True)
    return response, peak[0], stderr


def invoke_tool(tool: str, arguments: dict[str, Any], request_id: int) -> tuple[dict[str, Any], int | None, str]:
    response, peak_memory, stderr = invoke_json_rpc({
        "jsonrpc": "2.0",
        "method": "invoke",
        "id": request_id,
        "params": {"tool": tool, "arguments": arguments},
    })
    if response.get("error"):
        raise RuntimeError("JSON-RPC error: " + json.dumps(response["error"], ensure_ascii=False))
    data = response.get("result", {}).get("data")
    if not isinstance(data, dict):
        raise RuntimeError("Missing result.data: " + json.dumps(response, ensure_ascii=False))
    return data, peak_memory, stderr


def collect_versions() -> dict[str, Any]:
    app_package = read_json(PPT_APP_ROOT / "package.json")
    engine_package = read_json(ENGINE_ROOT / "package.json")
    runtime_info: dict[str, Any] = {}
    try:
        runtime_info, _, _ = invoke_tool("app_get_runtime_info", {}, 90_001)
    except Exception as error:  # metadata must not block the batch
        runtime_info = {"error": str(error)}

    def command_output(command: list[str], cwd: Path) -> str | None:
        try:
            result = subprocess.run(
                command,
                cwd=cwd,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                check=False,
                timeout=10,
            )
            return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None
        except (OSError, subprocess.TimeoutExpired):
            return None

    git_commit = command_output(["git", "rev-parse", "HEAD"], REPOSITORY_ROOT)
    node = shutil.which("node")
    node_version = command_output([node, "--version"], ENGINE_ROOT) if node else None
    chrome_path = None
    chrome_version = None
    if node:
        chrome_path = command_output([
            node,
            "--input-type=module",
            "-e",
            "import('puppeteer').then(m=>console.log((m.default??m).executablePath()))",
        ], ENGINE_ROOT)
        if chrome_path and Path(chrome_path).is_file():
            chrome_version = command_output([chrome_path, "--version"], ENGINE_ROOT)
            if not chrome_version:
                cached_version = re.search(r"(?:win64|linux|mac)[-_](\d+(?:\.\d+){2,3})", chrome_path)
                chrome_version = cached_version.group(1) if cached_version else None
    return {
        "app_version": app_package.get("version"),
        "executa_version": engine_package.get("version"),
        "ppt_engine_version": runtime_info.get("ppt_engine_version", engine_package.get("version")),
        "runtime_info": runtime_info,
        "node_version": node_version,
        "chrome_version": chrome_version,
        "chrome_path": chrome_path,
        "git_commit": git_commit,
    }


def case_font_metrics(case: dict[str, Any]) -> dict[str, int]:
    files = [case["deck_html_file"], *case.get("slide_html_files", [])]
    texts = [(CASES_ROOT / path).read_text(encoding="utf-8") for path in dict.fromkeys(files)]
    joined = "\n".join(texts)
    font_blocks = re.findall(r"@font-face\s*\{.*?\}", joined, flags=re.IGNORECASE | re.DOTALL)
    urls: set[str] = set()
    for block in font_blocks:
        urls.update(match.strip(" \t\r\n\"'") for match in re.findall(r"url\(([^)]+)\)", block, flags=re.IGNORECASE))
    return {"font_face_rule_count": len(font_blocks), "unique_font_url_count": len(urls)}


def validate_case(case: dict[str, Any]) -> None:
    required = ("id", "title", "deck_html_file", "slide_html_files", "expected_slide_count")
    missing = [name for name in required if name not in case]
    if missing:
        raise RuntimeError(f"Case is missing fields {missing}: {case}")
    expected = int(case["expected_slide_count"])
    if expected < 1 or len(case["slide_html_files"]) != expected:
        raise RuntimeError(f"Case {case['id']} has inconsistent slide count")
    for relative in [case["deck_html_file"], *case["slide_html_files"]]:
        path = (CASES_ROOT / relative).resolve()
        path.relative_to(CASES_ROOT.resolve())
        if not path.is_file():
            raise RuntimeError(f"Case input is missing: {path}")


def render_pdf_preview(pdf_path: Path, preview_path: Path) -> Path | None:
    executable = shutil.which("pdftoppm")
    if not executable:
        return None
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    output_prefix = preview_path.with_suffix("")
    completed = subprocess.run(
        [executable, "-f", "1", "-singlefile", "-png", "-r", "72", str(pdf_path), str(output_prefix)],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    return preview_path if completed.returncode == 0 and preview_path.is_file() else None


def write_attempt(path: Path, attempt: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(attempt, ensure_ascii=False, indent=2), encoding="utf-8")


def csv_value(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def write_reports(run_root: Path, report: dict[str, Any], cases: dict[str, dict[str, Any]]) -> None:
    json_path = run_root / "report.json"
    csv_path = run_root / "report.csv"
    html_path = run_root / "report.html"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    columns = [
        "case_id", "case_title", "format", "repeat", "passed", "endpoint_status", "validator_valid",
        "phase", "total_ms", "convert_ms", "size_bytes", "slide_count", "peak_memory_bytes",
        "font_face_rule_count", "unique_font_url_count", "warning_count", "output_path", "error_message",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        for attempt in report["attempts"]:
            writer.writerow({name: csv_value(attempt.get(name)) for name in columns})

    rows = []
    for attempt in report["attempts"]:
        output = Path(attempt["output_path"]) if attempt.get("output_path") else None
        output_link = f'<a href="{html.escape(output.as_uri())}">打开文件</a>' if output and output.exists() else "—"
        attempt_json = run_root / "attempts" / f"{attempt['case_id']}-{attempt['format']}-r{attempt['repeat']:02d}.json"
        rows.append(
            "<tr>"
            f"<td>{html.escape(attempt['case_id'])}</td>"
            f"<td>{html.escape(attempt['case_title'])}</td>"
            f"<td>{attempt['format'].upper()}</td>"
            f"<td class={'pass' if attempt['passed'] else 'fail'}>{'PASS' if attempt['passed'] else 'FAIL'}</td>"
            f"<td>{attempt.get('total_ms', '—')}</td>"
            f"<td>{attempt.get('size_bytes', '—')}</td>"
            f"<td>{attempt.get('peak_memory_bytes') or 'unavailable'}</td>"
            f"<td>{output_link} · <a href=\"{html.escape(attempt_json.as_uri())}\">详情</a></td>"
            f"<td>{html.escape(attempt.get('error_message') or '等待人工视觉检查')}</td>"
            "</tr>"
        )

    gallery = []
    for case_id, case in cases.items():
        deck_path = CASES_ROOT / case["deck_html_file"]
        outputs = [attempt for attempt in report["attempts"] if attempt["case_id"] == case_id and attempt["passed"]]
        links = []
        previews = []
        for attempt in outputs:
            output = Path(attempt["output_path"])
            links.append(f'<a href="{html.escape(output.as_uri())}">{attempt["format"].upper()}</a>')
            preview_path = attempt.get("preview_path")
            if preview_path and Path(preview_path).is_file():
                preview = Path(preview_path)
                previews.append(
                    f'<figure><figcaption>{attempt["format"].upper()} 输出检查图</figcaption>'
                    f'<a href="{html.escape(preview.as_uri())}"><img src="{html.escape(preview.as_uri())}" '
                    f'alt="{html.escape(case_id)} {attempt["format"]} preview"></a></figure>'
                )
        checks = "".join(f"<li>{html.escape(item)}</li>" for item in case.get("manual_checks", []))
        gallery.append(
            '<article class="case">'
            f"<h3>{html.escape(case_id)} · {html.escape(case['title'])}</h3>"
            f'<div class="previews">{"".join(previews)}</div>'
            f"<p>输入：<a href=\"{html.escape(deck_path.as_uri())}\">Deck HTML</a> · 输出：{' · '.join(links) or '无'}</p>"
            f"<ul>{checks}</ul></article>"
        )

    summary = report["summary"]
    document = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Export Eval {html.escape(report['run_id'])}</title>
<style>body{{font:15px/1.5 Arial,'Microsoft YaHei',sans-serif;margin:0;background:#f4f6fa;color:#182033}}main{{max-width:1500px;margin:auto;padding:36px}}h1{{margin-bottom:4px}}.meta{{color:#657086}}.cards{{display:flex;gap:18px;margin:26px 0}}.metric{{background:#fff;border-radius:14px;padding:18px 24px;box-shadow:0 5px 20px #1b284018}}.metric strong{{display:block;font-size:30px}}table{{width:100%;border-collapse:collapse;background:#fff}}th,td{{padding:11px;border:1px solid #dce2ec;text-align:left}}th{{background:#eaf0f8}}.pass{{color:#087443;font-weight:bold}}.fail{{color:#b42318;font-weight:bold}}.gallery{{display:grid;grid-template-columns:1fr;gap:20px}}.case{{background:#fff;padding:18px;border-radius:16px}}.previews{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}figure{{margin:0}}figcaption{{font-weight:bold;margin-bottom:6px}}img{{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;border:1px solid #ccd4e0;background:#edf1f7}}code{{background:#eaf0f8;padding:2px 5px}}a{{color:#315ac7}}</style></head><body><main>
<h1>Anna Deck Export Eval</h1><div class="meta">Run: {html.escape(report['run_id'])} · Started: {html.escape(report['started_at'])}<br>技术校验通过不代表视觉验收完成；请按下方检查项人工复核。</div>
<div class="cards"><div class="metric"><span>技术通过率</span><strong>{summary['success_rate']:.1%}</strong></div><div class="metric"><span>通过 / 总数</span><strong>{summary['passed']} / {summary['total']}</strong></div><div class="metric"><span>总导出耗时</span><strong>{summary['total_export_ms']} ms</strong></div><div class="metric"><span>人工视觉状态</span><strong>待检查</strong></div></div>
<h2>自动校验结果</h2><table><thead><tr><th>案例</th><th>标题</th><th>格式</th><th>状态</th><th>耗时 ms</th><th>大小 bytes</th><th>峰值内存 bytes</th><th>产物</th><th>备注</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
<h2>人工视觉检查</h2><div class="gallery">{''.join(gallery)}</div>
<h2>版本</h2><pre>{html.escape(json.dumps(report['versions'], ensure_ascii=False, indent=2))}</pre>
</main></body></html>"""
    html_path.write_text(document, encoding="utf-8")


def main() -> int:
    args = parse_args()
    config_path = args.config.expanduser().resolve()
    config = read_json(config_path)
    if config.get("mode") != "export-only":
        raise RuntimeError('Batch config mode must be "export-only"')

    case_ids = [item.strip() for item in args.cases.split(",") if item.strip()] if args.cases else list(config.get("case_ids", []))
    formats = [item.strip().lower() for item in args.formats.split(",") if item.strip()] if args.formats else list(config.get("formats", []))
    repeat = args.repeat if args.repeat is not None else int(config.get("repeat", 1))
    timeout_ms = args.timeout_ms if args.timeout_ms is not None else int(config.get("timeout_ms", 600_000))
    if not case_ids:
        raise RuntimeError("No cases selected")
    if not formats or any(item not in {"pptx", "pdf"} for item in formats):
        raise RuntimeError("Formats must contain pptx and/or pdf")
    if repeat < 1:
        raise RuntimeError("repeat must be positive")
    if not 1_000 <= timeout_ms <= 600_000:
        raise RuntimeError("timeout_ms must be between 1000 and 600000")

    cases: dict[str, dict[str, Any]] = {}
    for case_id in case_ids:
        case = read_json(CASES_ROOT / case_id / "case.json")
        validate_case(case)
        if case["id"] != case_id:
            raise RuntimeError(f"Case id mismatch: requested {case_id}, loaded {case['id']}")
        cases[case_id] = case

    if args.skip_build:
        print("Using current ppt-engine dist (--skip-build).", flush=True)
    else:
        run_build()

    run_id = f"{config.get('name', 'export-eval')}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    run_root = RESULTS_ROOT / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    started_at = datetime.now(timezone.utc).isoformat()
    versions = collect_versions()
    attempts: list[dict[str, Any]] = []
    request_id = 1
    print(f"Results: {run_root}", flush=True)

    for case_id, case in cases.items():
        font_metrics = case_font_metrics(case)
        for export_format in formats:
            for repetition in range(1, repeat + 1):
                attempt_dir = run_root / "artifacts" / case_id / export_format / f"r{repetition:02d}"
                attempt_dir.mkdir(parents=True, exist_ok=False)
                endpoint: dict[str, Any] = {}
                validator: dict[str, Any] = {"valid": False, "errors": ["export did not complete"]}
                peak_memory: int | None = None
                stderr = ""
                exception_message = None
                preview_path: Path | None = None
                print(f"[{case_id}] {export_format.upper()} r{repetition} ...", flush=True)
                try:
                    arguments: dict[str, Any] = {
                        "request_id": f"{case_id}-{export_format}-r{repetition}",
                        "format": export_format,
                        "source_root": str(CASES_ROOT.resolve()),
                        "deck_html_file": case["deck_html_file"],
                        "expected_slide_count": case["expected_slide_count"],
                        "title": case["title"],
                        "output_dir": str(attempt_dir.resolve()),
                        "timeout_ms": timeout_ms,
                    }
                    if export_format == "pdf":
                        arguments["slide_html_files"] = case["slide_html_files"]
                    endpoint, peak_memory, stderr = invoke_tool("app_run_export_only", arguments, request_id)
                    output_path = Path(endpoint["output_path"]) if endpoint.get("output_path") else None
                    if endpoint.get("status") == "completed" and output_path:
                        if export_format == "pptx":
                            validator = validate_pptx(output_path, case["expected_slide_count"])
                            if validator.get("valid"):
                                raster_dir = run_root / "review-previews" / "pptx" / f"{case_id}-r{repetition:02d}"
                                try:
                                    raster, _, _ = invoke_tool("app_rasterize_pptx_to_images", {
                                        "pptx_path": str(output_path.resolve()),
                                        "output_dir": str(raster_dir.resolve()),
                                        "target_height": 720,
                                        "overwrite": True,
                                    }, 100_000 + request_id)
                                    raster_count = int(raster.get("slide_count", 0))
                                    raster_ok = raster_count == case["expected_slide_count"]
                                    validator["checks"].append({
                                        "name": "pptx_rasterization",
                                        "passed": raster_ok,
                                        "detail": f"expected={case['expected_slide_count']}, actual={raster_count}",
                                    })
                                    if raster_ok and raster.get("slides"):
                                        preview_path = Path(raster["slides"][0]["image_path"])
                                    else:
                                        validator["valid"] = False
                                        validator["errors"].append("pptx_rasterization: page count mismatch")
                                except Exception as raster_error:
                                    validator["valid"] = False
                                    validator["checks"].append({"name": "pptx_rasterization", "passed": False, "detail": str(raster_error)})
                                    validator["errors"].append(f"pptx_rasterization: {raster_error}")
                        else:
                            validator = validate_pdf(output_path, case["expected_slide_count"])
                            preview_path = render_pdf_preview(
                                output_path,
                                run_root / "review-previews" / "pdf" / f"{case_id}-r{repetition:02d}.png",
                            )
                except Exception as error:
                    exception_message = str(error)

                request_id += 1
                timings = endpoint.get("timings_ms", {})
                error_message = exception_message or (endpoint.get("error") or {}).get("message")
                passed = endpoint.get("status") == "completed" and validator.get("valid") is True
                attempt = {
                    "case_id": case_id,
                    "case_title": case["title"],
                    "case_description": case.get("description"),
                    "tags": case.get("tags", []),
                    "format": export_format,
                    "repeat": repetition,
                    "passed": passed,
                    "endpoint_status": endpoint.get("status", "exception"),
                    "validator_valid": validator.get("valid", False),
                    "phase": endpoint.get("phase"),
                    "total_ms": timings.get("total"),
                    "convert_ms": timings.get("convert"),
                    "size_bytes": endpoint.get("size_bytes"),
                    "slide_count": endpoint.get("slide_count"),
                    "peak_memory_bytes": peak_memory,
                    **font_metrics,
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
                    "manual_checks": case.get("manual_checks", []),
                }
                attempts.append(attempt)
                write_attempt(run_root / "attempts" / f"{case_id}-{export_format}-r{repetition:02d}.json", attempt)
                print(f"  {'PASS' if passed else 'FAIL'} | {timings.get('total', '?')} ms | {endpoint.get('size_bytes', '?')} bytes", flush=True)

    passed_count = sum(1 for attempt in attempts if attempt["passed"])
    total_export_ms = sum(int(attempt.get("total_ms") or 0) for attempt in attempts)
    report = {
        "schema_version": 1,
        "run_id": run_id,
        "mode": "export-only",
        "config_path": str(config_path),
        "started_at": started_at,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "versions": versions,
        "summary": {
            "total": len(attempts),
            "passed": passed_count,
            "failed": len(attempts) - passed_count,
            "success_rate": passed_count / len(attempts),
            "total_export_ms": total_export_ms,
            "visual_review": "pending",
        },
        "attempts": attempts,
    }
    write_reports(run_root, report, cases)
    print(f"Technical result: {passed_count}/{len(attempts)} passed", flush=True)
    print(f"HTML report: {run_root / 'report.html'}", flush=True)
    return 0 if passed_count == len(attempts) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
