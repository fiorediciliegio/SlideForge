#!/usr/bin/env python3
"""Export selected legacy-large-screenshot presets as PPTX+PDF via app_run_export_only.

Reuses run_visual_style_preset_batch's audit/prepare/export pipeline but reads
the legacy-large-screenshot-templates corpus instead of src/features/templates/presets.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import run_visual_style_preset_batch as batch
from run_export_batch import RESULTS_ROOT, collect_versions, run_build

LEGACY_ROOT = batch.PPT_APP_ROOT / "legacy-large-screenshot-templates"


def audit_by_number(number: int) -> dict[str, Any]:
    matches = [
        path for path in LEGACY_ROOT.iterdir()
        if path.is_dir() and path.name.startswith(f"{number}-")
    ]
    if len(matches) != 1:
        raise RuntimeError(f"legacy preset for number {number} not unique: {[m.name for m in matches]}")
    audit = batch.audit_preset(matches[0])
    if audit.get("ppt_number") != number:
        raise RuntimeError(f"preset.json ppt_number mismatch in {matches[0].name}")
    return audit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--numbers", default="18,25,33,80,111,125", help="Comma-separated ppt_number list.")
    parser.add_argument("--formats", default="pptx,pdf")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--timeout-ms", type=int, default=600_000)
    args = parser.parse_args()

    numbers = sorted({int(item) for item in args.numbers.split(",") if item.strip()})
    formats = [item.strip().lower() for item in args.formats.split(",") if item.strip()]

    audits = [audit_by_number(number) for number in numbers]
    for audit in audits:
        if not audit["eligible"]:
            print(f"WARN {audit['id']}: missing={audit['missing_resources'][:5]} outside={audit['outside_resources'][:5]}", flush=True)

    if not args.skip_build:
        run_build()

    run_id = f"legacy-presets-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    run_root = RESULTS_ROOT / run_id
    run_root.mkdir(parents=True, exist_ok=False)
    started_at = datetime.now(timezone.utc).isoformat()
    print(f"Results: {run_root}", flush=True)

    preparations: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    request_id = 1
    for audit in audits:
        key = batch.safe_key(audit)
        print(f"[{key}] {audit['id']} | preparing {audit['page_count']} pages ...", flush=True)
        try:
            prepared = batch.prepare_preset_workspace(audit, run_root, request_id)
            preparations.append({"preset_key": key, "passed": True, "build_ms": prepared["build_ms"]})
            print(f"  PREPARED | {prepared['build_ms']} ms", flush=True)
        except Exception as error:
            preparations.append({"preset_key": key, "passed": False, "error": str(error)})
            print(f"  PREPARE FAIL | {error}", flush=True)
            request_id += 1
            continue
        request_id += 1
        for export_format in formats:
            attempt = batch.run_export(audit, prepared, run_root, export_format, 1, args.timeout_ms, request_id, False)
            attempts.append(attempt)
            request_id += 1
            print(
                f"  {export_format.upper()} {'PASS' if attempt['passed'] else 'FAIL'} | "
                f"{attempt.get('total_ms') or '?'} ms | {attempt.get('size_bytes') or '?'} bytes | "
                f"font_embed_warnings={len(attempt.get('font_embed_warnings') or [])} | {attempt.get('output_path')}",
                flush=True,
            )

    report = {
        "schema_version": 1,
        "run_id": run_id,
        "mode": "export-only-legacy-presets",
        "corpus": str(LEGACY_ROOT),
        "started_at": started_at,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "formats": formats,
        "versions": collect_versions(),
        "selected": [
            {"id": audit["id"], "ppt_number": audit["ppt_number"], "pages": audit["page_count"], "eligible": audit["eligible"]}
            for audit in audits
        ],
        "preparations": preparations,
        "attempts": attempts,
        "summary": {
            "passed": sum(1 for attempt in attempts if attempt["passed"]),
            "total": len(attempts),
            "preparation_failed": sum(1 for preparation in preparations if not preparation["passed"]),
        },
    }
    (run_root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Completed: {report['summary']}", flush=True)
    ok = (
        report["summary"]["passed"] == report["summary"]["total"]
        and report["summary"]["preparation_failed"] == 0
    )
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
