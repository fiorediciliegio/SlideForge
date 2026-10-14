from __future__ import annotations

import posixpath
import re
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from typing import Any
from zipfile import BadZipFile, ZipFile


REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
SLIDE_PATTERN = re.compile(r"^ppt/slides/slide\d+\.xml$")


def _relationship_source(rel_path: str) -> PurePosixPath:
    if rel_path == "_rels/.rels":
        return PurePosixPath("")
    rel = PurePosixPath(rel_path)
    if rel.parent.name != "_rels" or not rel.name.endswith(".rels"):
        raise ValueError(f"Invalid OOXML relationship path: {rel_path}")
    return rel.parent.parent / rel.name.removesuffix(".rels")


def validate_pptx(path: Path, expected_slide_count: int) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    errors: list[str] = []

    def check(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": passed, "detail": detail})
        if not passed:
            errors.append(f"{name}: {detail}")

    if not path.is_file():
        check("file_exists", False, f"Missing file: {path}")
        return {"valid": False, "validator": "python-zipfile-ooxml", "checks": checks, "errors": errors}

    size_bytes = path.stat().st_size
    check("file_non_empty", size_bytes > 0, f"size={size_bytes}")
    try:
        with ZipFile(path) as archive:
            names = set(archive.namelist())
            bad_member = archive.testzip()
            check("zip_crc", bad_member is None, "all members readable" if bad_member is None else f"bad member={bad_member}")

            required = {"[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"}
            missing = sorted(required - names)
            check("required_ooxml_parts", not missing, "complete" if not missing else f"missing={missing}")

            xml_names = sorted(name for name in names if name.endswith((".xml", ".rels")))
            malformed: list[str] = []
            for name in xml_names:
                try:
                    ET.fromstring(archive.read(name))
                except ET.ParseError as error:
                    malformed.append(f"{name}: {error}")
            check("xml_parse", not malformed, f"parsed={len(xml_names)}" if not malformed else "; ".join(malformed[:5]))

            slide_names = sorted(name for name in names if SLIDE_PATTERN.fullmatch(name))
            check(
                "slide_part_count",
                len(slide_names) == expected_slide_count,
                f"expected={expected_slide_count}, actual={len(slide_names)}",
            )

            presentation_count = -1
            if "ppt/presentation.xml" in names:
                root = ET.fromstring(archive.read("ppt/presentation.xml"))
                slide_list = root.find(f"{{{PRESENTATION_NS}}}sldIdLst")
                presentation_count = len(list(slide_list)) if slide_list is not None else 0
            check(
                "presentation_slide_count",
                presentation_count == expected_slide_count,
                f"expected={expected_slide_count}, actual={presentation_count}",
            )

            broken_relationships: list[str] = []
            relationship_count = 0
            for rel_name in sorted(name for name in names if name.endswith(".rels")):
                source = _relationship_source(rel_name)
                root = ET.fromstring(archive.read(rel_name))
                for rel in root.findall(f"{{{REL_NS}}}Relationship"):
                    relationship_count += 1
                    if rel.attrib.get("TargetMode") == "External":
                        continue
                    target = rel.attrib.get("Target", "").split("#", 1)[0]
                    if not target:
                        broken_relationships.append(f"{rel_name}: empty Target")
                        continue
                    if target.startswith("/"):
                        resolved = target.lstrip("/")
                    else:
                        resolved = posixpath.normpath(str(source.parent / target))
                    if resolved not in names:
                        broken_relationships.append(f"{rel_name}: {target} -> {resolved}")
            check(
                "internal_relationships",
                not broken_relationships,
                f"resolved={relationship_count}" if not broken_relationships else "; ".join(broken_relationships[:8]),
            )

            media = [name for name in names if name.startswith("ppt/media/") and not name.endswith("/")]
            empty_media = [name for name in media if archive.getinfo(name).file_size == 0]
            check("media_non_empty", not empty_media, f"media_parts={len(media)}" if not empty_media else f"empty={empty_media}")
    except (BadZipFile, OSError, ET.ParseError, ValueError) as error:
        check("package_parse", False, str(error))

    return {
        "valid": not errors,
        "validator": "python-zipfile-ooxml",
        "size_bytes": size_bytes,
        "slide_count": expected_slide_count if not errors else None,
        "checks": checks,
        "errors": errors,
    }

