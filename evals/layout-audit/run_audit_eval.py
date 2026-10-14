# -*- coding: utf-8 -*-
"""
layout-audit eval runner — dual-track overflow detection (v7)

Derived from the v7 prototype (run_audit_v7.py). Two-layer strategy:
  - Geometry candidate layer (v5): slide out-of-bounds / container overflow /
    absolute-position hangout
  - Text adjudication layer (v6): Range line-rect text out-of-slide / clipped /
    overlapped
Severity split: ERROR (text hurt / structural) vs WARNING (pure shape).

GT criterion: has_error = errors.length > 0 (WARNING does not count).

Usage:
  pip install playwright pandas
  playwright install chromium
  python run_audit_eval.py                       # audit all samples in cases/
  python run_audit_eval.py --output results/my.json
  python run_audit_eval.py --compare results/audit-results-v5.json
"""

import argparse
import asyncio
import json
import time
from pathlib import Path

from playwright.async_api import async_playwright

CANVAS_WIDTH = 1920
CANVAS_HEIGHT = 1080
TOL_GEO = 4      # geometry candidate tolerance (px)
TOL_TEXT = 2     # text adjudication tolerance (px)

# ============ Browser-side: geometry candidates + text adjudication ============
DUAL_AUDIT_JS = r"""
() => {
  const TOL_GEO = 4, TOL_TEXT = 2, OVERLAP_RATIO = 0.05;
  const slide = document.querySelector('.slide');
  if (!slide) return { error: 'No .slide element found' };
  const rootRect = slide.getBoundingClientRect();
  const W = rootRect.width, H = rootRect.height;

  // ================= utils =================
  function isVisible(el) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
  }
  function isVisibleChain(el) {
    let cur = el;
    while (cur) {
      const s = getComputedStyle(cur);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      if (cur === slide) break;
      cur = cur.parentElement;
    }
    return true;
  }
  function hasMeaningfulContent(el) {
    const t = el.textContent?.trim() || '';
    return t.length > 0 || el.querySelector('img') !== null || el instanceof HTMLImageElement;
  }
  function isDecorativeStrict(el) {
    const ct = (el.className + ' ' + el.tagName).toLowerCase();
    const r = el.getBoundingClientRect();
    if (r.width <= 3 || r.height <= 3) return true;
    return /divider|separator|decoration|background|timeline-node|dot|icon|frame|line/.test(ct);
  }
  function isTableInternal(el) {
    return ['tbody','thead','tfoot','tr','td','th','col','colgroup','caption'].includes(el.tagName.toLowerCase());
  }
  function findPositioningContext(el) {
    let a = el.parentElement;
    while (a) {
      if (getComputedStyle(a).position !== 'static') return a;
      if (a === slide) return slide;
      a = a.parentElement;
    }
    return slide;
  }
  function isFooterHeader(el) {
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    return tag === 'footer' || cls.includes('footer') || tag === 'header' || cls.includes('header');
  }
  function isVerticalOrRotated(el) {
    const s = getComputedStyle(el);
    if (s.writingMode && s.writingMode !== 'horizontal-tb') return true;
    const t = s.transform;
    if (t && t !== 'none') {
      const m = t.match(/matrix\(([^)]+)\)/);
      if (m) {
        const v = m[1].split(',').map(Number);
        return Math.abs(v[1]) > 0.1 || Math.abs(v[2]) > 0.1;
      }
      return true; // matrix3d / rotate(...) treated as rotated
    }
    return false;
  }
  function textOf(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50); }

  const elements = [slide, ...Array.from(slide.querySelectorAll('*'))].filter((el, i) => i === 0 || isVisible(el));

  // ================= Stage 1: geometry candidates (v5 logic) =================
  // --- Candidate A: slide out-of-bounds ---
  const candSlide = [];
  for (let i = 1; i < elements.length; i++) {
    const el = elements[i];
    const r = el.getBoundingClientRect();
    const relL = r.left - rootRect.left, relT = r.top - rootRect.top;
    const relR = r.right - rootRect.left, relB = r.bottom - rootRect.top;
    const o = { left: Math.max(0, -relL), top: Math.max(0, -relT), right: Math.max(0, relR - W), bottom: Math.max(0, relB - H) };
    const max = Math.max(o.left, o.top, o.right, o.bottom);
    if (max <= TOL_GEO) continue;
    const tag = el.tagName.toLowerCase();
    const cls = (el.className || '').toLowerCase();
    if ((tag === 'footer' || cls.includes('footer')) && o.bottom < 10 && o.left < 1 && o.right < 1 && o.top < 1) continue;
    if (!hasMeaningfulContent(el) && max < 10) continue;
    let isTableChild = false, p = el.parentElement;
    while (p && p !== slide) { if (p.tagName.toLowerCase() === 'table') { isTableChild = true; break; } p = p.parentElement; }
    if (isTableChild && tag !== 'table') continue;
    candSlide.push({ el, tag, cls: el.className || '', overflow: o, max });
  }

  // --- Candidate B: container overflow ---
  const candContainer = [];
  for (let i = 1; i < elements.length; i++) {
    const el = elements[i];
    if (isDecorativeStrict(el) || !hasMeaningfulContent(el) || isTableInternal(el)) continue;
    const r = el.getBoundingClientRect();
    const relL = r.left - rootRect.left, relT = r.top - rootRect.top;
    const relR = r.right - rootRect.left, relB = r.bottom - rootRect.top;
    let anc = el.parentElement, clip = null;
    while (anc) {
      const st = getComputedStyle(anc);
      if (st.overflowX !== 'visible' || st.overflowY !== 'visible') { clip = anc; break; }
      if (anc === slide) break;
      anc = anc.parentElement;
    }
    if (!clip || clip === slide || clip.tagName.toLowerCase() === 'table') continue;
    const cr = clip.getBoundingClientRect();
    const o = {
      left: Math.max(0, cr.left - r.left), top: Math.max(0, cr.top - r.top),
      right: Math.max(0, r.right - cr.right), bottom: Math.max(0, r.bottom - cr.bottom),
    };
    const max = Math.max(o.left, o.top, o.right, o.bottom);
    const ancCls = (clip.className || '').toLowerCase();
    if (ancCls.includes('content-area') && max < 40) continue;
    if (el.tagName.toLowerCase() === 'table' && max < 10) continue;
    if (max > TOL_GEO) candContainer.push({ el, clip, cls: el.className || '', clipCls: clip.className || '', overflow: o, max });
  }

  // --- Candidate C: absolute-position hangout ---
  const candAbsolute = [];
  for (let i = 1; i < elements.length; i++) {
    const el = elements[i];
    const st = getComputedStyle(el);
    if (st.position !== 'absolute' && st.position !== 'fixed') continue;
    if (isDecorativeStrict(el) || !hasMeaningfulContent(el)) continue;
    const r = el.getBoundingClientRect();
    const ctx = findPositioningContext(el);
    if (ctx === el) continue;
    const cst = getComputedStyle(ctx);
    const cb = parseFloat(cst.borderBottomWidth) || 0, ct2 = parseFloat(cst.borderTopWidth) || 0;
    const cbl = parseFloat(cst.borderLeftWidth) || 0, cbr = parseFloat(cst.borderRightWidth) || 0;
    const cr = ctx.getBoundingClientRect();
    const o = {
      left: Math.max(0, (cr.left + cbl) - r.left), top: Math.max(0, (cr.top + ct2) - r.top),
      right: Math.max(0, r.right - (cr.right - cbr)), bottom: Math.max(0, r.bottom - (cr.bottom - cb)),
    };
    const max = Math.max(o.left, o.top, o.right, o.bottom);
    const cls = el.className || '';
    if (max < 30 && /card-badge|featured-badge|badge|tag|stamp|source-note|time-stamp/.test((cls + ' ' + el.tagName).toLowerCase())) continue;
    const area = r.width * r.height;
    if (!cls && area < 500 && max < 20) continue;
    if (max > TOL_GEO) candAbsolute.push({ el, ctx, cls, ctxCls: ctx.className || '', overflow: o, max });
  }

  // ================= Stage 2: text collection (v6 logic) =================
  const textItems = [];
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const parent = node.parentElement;
    if (!parent || !isVisibleChain(parent)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5);
    range.detach();
    if (!rects.length) continue;
    const pst = getComputedStyle(parent);
    const fs = parseFloat(pst.fontSize) || 16;
    const lh = pst.lineHeight === 'normal' ? fs * 1.2 : (parseFloat(pst.lineHeight) || fs * 1.2);
    textItems.push({ text, parent, rects, fontSize: fs, lineHeight: lh });
  }

  // ================= Stage 3: Layer-1 independent text scan (always ERROR) =================
  const errors = [], warnings = [];
  const errorParents = new Set();   // parents already reported as ERROR, for Layer-2 dedup

  // ---- Rule 1': text line rect out of slide (independent of geometry candidates) ----
  for (const it of textItems) {
    let maxPx = 0, dir = '';
    for (const r of it.rects) {
      const relL = r.left - rootRect.left, relT = r.top - rootRect.top;
      const relR = r.right - rootRect.left, relB = r.bottom - rootRect.top;
      const o = {
        bottom: relB > H + TOL_TEXT ? relB - H : 0,
        right: relR > W + TOL_TEXT ? relR - W : 0,
        top: relT < -TOL_TEXT ? -relT : 0,
        left: relL < -TOL_TEXT ? -relL : 0,
      };
      const m = Math.max(o.bottom, o.right, o.top, o.left);
      if (m > maxPx) { maxPx = m; dir = o.bottom === m ? 'bottom' : (o.right === m ? 'right' : (o.top === m ? 'top' : 'left')); }
    }
    if (maxPx > 0) {
      errors.push({ rule: 'TEXT_OUT_OF_SLIDE', text: it.text.slice(0, 40), parentCls: (it.parent.className || it.parent.tagName).slice(0, 40), dir, px: Math.round(maxPx * 10) / 10 });
      errorParents.add(it.parent);
    }
  }

  // ---- Rule 2': text genuinely clipped by a clipping ancestor ----
  for (const it of textItems) {
    if (errorParents.has(it.parent)) continue;
    let clip = it.parent.parentElement;
    while (clip && clip !== slide) {
      const st = getComputedStyle(clip);
      if (st.overflowX !== 'visible' || st.overflowY !== 'visible') break;
      clip = clip.parentElement;
    }
    if (!clip || clip === slide) continue;
    const cs = getComputedStyle(clip);
    const cr = clip.getBoundingClientRect();
    const vT = cr.top + (parseFloat(cs.borderTopWidth) || 0);
    const vB = cr.bottom - (parseFloat(cs.borderBottomWidth) || 0);
    const vL = cr.left + (parseFloat(cs.borderLeftWidth) || 0);
    const vR = cr.right - (parseFloat(cs.borderRightWidth) || 0);
    let maxPx = 0, dir = '';
    for (const r of it.rects) {
      if (cs.overflowY !== 'visible') {
        if (r.bottom > vB + TOL_TEXT) { const px = r.bottom - vB; if (px > maxPx) { maxPx = px; dir = 'bottom'; } }
        if (r.top < vT - TOL_TEXT) { const px = vT - r.top; if (px > maxPx) { maxPx = px; dir = 'top'; } }
      }
      if (cs.overflowX !== 'visible') {
        if (r.right > vR + TOL_TEXT) { const px = r.right - vR; if (px > maxPx) { maxPx = px; dir = 'right'; } }
        if (r.left < vL - TOL_TEXT) { const px = vL - r.left; if (px > maxPx) { maxPx = px; dir = 'left'; } }
      }
    }
    if (maxPx > 0) {
      errors.push({ rule: 'TEXT_CLIPPED', text: it.text.slice(0, 40), parentCls: (it.parent.className || it.parent.tagName).slice(0, 40), clipCls: (clip.className || clip.tagName).slice(0, 40), dir, px: Math.round(maxPx * 10) / 10 });
      errorParents.add(it.parent);
    }
  }

  // ---- Rule 3': unrelated text overlap (line boxes shrunk to approx glyph bounds) ----
  function rectsOverlap(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return (w > 0 && h > 0) ? { area: w * h, h: h } : null;
  }
  function glyphRect(r, fontSize, lineHeight) {
    const ratio = Math.min(1, fontSize / lineHeight);
    const newH = r.height * ratio, dy = (r.height - newH) / 2;
    return { left: r.left, right: r.right, top: r.top + dy, bottom: r.bottom - dy };
  }
  const tolReported = new Set();
  for (let i = 0; i < textItems.length; i++) {
    for (let j = i + 1; j < textItems.length; j++) {
      const A = textItems[i], B = textItems[j];
      if (A.parent.contains(B.parent) || B.parent.contains(A.parent)) continue;
      if (isVerticalOrRotated(A.parent) || isVerticalOrRotated(B.parent)) continue;
      const minFS = Math.min(A.fontSize, B.fontSize);
      let maxArea = 0, maxH = 0;
      for (const ra of A.rects) for (const rb of B.rects) {
        const ov = rectsOverlap(
          glyphRect(ra, A.fontSize, A.lineHeight),
          glyphRect(rb, B.fontSize, B.lineHeight)
        );
        if (ov && ov.h > maxH) { maxH = ov.h; maxArea = ov.area; }
      }
      if (maxH <= 0) continue;
      // height filter: overlap height must reach 35% of smaller font size
      if (maxH < minFS * 0.35) continue;
      const key = (A.parent.className || '') + '|' + (B.parent.className || '');
      if (tolReported.has(key)) continue;
      tolReported.add(key);
      errors.push({ rule: 'TEXT_OVERLAP', clsA: (A.parent.className || A.parent.tagName).slice(0, 30), clsB: (B.parent.className || B.parent.tagName).slice(0, 30), textA: A.text.slice(0, 30), textB: B.text.slice(0, 30), px: Math.round(maxArea * 10) / 10 });
      errorParents.add(A.parent); errorParents.add(B.parent);
    }
  }

  // ================= Stage 4: Layer-2 geometry candidates as WARNING =================
  function hasErroredText(el) {
    for (const p of errorParents) { if (p === el || el.contains(p)) return true; }
    return false;
  }

  for (const c of candSlide) {
    if (isFooterHeader(c.el)) {
      errors.push({ rule: 'FOOTER_HEADER_OUT', tag: c.tag, cls: c.cls, text: textOf(c.el), max: Math.round(c.max * 10) / 10 });
      continue;
    }
    if (hasErroredText(c.el)) continue;   // text already ERROR, skip WARNING
    warnings.push({ rule: 'SHAPE_OUT_OF_SLIDE', tag: c.tag, cls: c.cls, max: Math.round(c.max * 10) / 10 });
  }

  for (const c of candContainer) {
    if (hasErroredText(c.el)) continue;
    warnings.push({ rule: 'SHAPE_CONTAINER_OVERFLOW', tag: c.el.tagName.toLowerCase(), cls: c.cls, clipCls: c.clipCls, max: Math.round(c.max * 10) / 10 });
  }

  for (const c of candAbsolute) {
    if (hasErroredText(c.el)) continue;
    const elItems = textItems.filter(it => c.el === it.parent || c.el.contains(it.parent));
    if (elItems.length && !elItems.some(it => isVerticalOrRotated(it.parent))) {
      warnings.push({ rule: 'TEXT_HANGOUT_DESIGN', cls: c.cls, ctxCls: c.ctxCls, text: elItems[0].text.slice(0, 40), max: Math.round(c.max * 10) / 10 });
    } else {
      warnings.push({ rule: 'SHAPE_HANGOUT', cls: c.cls, ctxCls: c.ctxCls, max: Math.round(c.max * 10) / 10 });
    }
  }

  return {
    rootFound: true,
    canvas: { width: W, height: H },
    textNodeCount: textItems.length,
    errorCount: errors.length, errors,
    warningCount: warnings.length, warnings,
  };
}
"""


async def audit_one_file(page, html_path: Path):
    start = time.perf_counter()
    file_url = html_path.resolve().as_uri()
    font_timeout = False
    try:
        await page.goto(file_url, wait_until="networkidle", timeout=30000)
    except Exception:
        # remote fonts etc. blocking networkidle — degrade gracefully
        font_timeout = True
        try:
            await page.goto(file_url, wait_until="load", timeout=15000)
        except Exception:
            pass
        await page.wait_for_timeout(1500)
    result = await page.evaluate(DUAL_AUDIT_JS)
    elapsed_ms = (time.perf_counter() - start) * 1000
    if font_timeout:
        result["font_timeout"] = True
    return {
        "has_error": result.get("errorCount", 0) > 0,
        "has_warning": result.get("warningCount", 0) > 0,
        "text_node_count": result.get("textNodeCount", 0),
        "error_count": result.get("errorCount", 0),
        "warning_count": result.get("warningCount", 0),
        "errors": result.get("errors", []),
        "warnings": result.get("warnings", []),
        "error": result.get("error", None),
        "font_timeout": result.get("font_timeout", False),
        "elapsed_ms": round(elapsed_ms, 2),
    }


def load_gt_records(gt_json: Path, base_dir: Path):
    with open(gt_json, encoding="utf-8") as f:
        gt = json.load(f)
    records = []
    for row in gt["samples"]:
        html_path = base_dir / row["html_path"]
        records.append({
            "sample": row["sample"],
            "case_id": row["case_id"],
            "version": row["version"],
            "repeat": row["repeat"],
            "html_path": str(html_path),
            "gt_overflow_raw": row.get("gt_overflow_raw"),
            "gt_has_overflow": row.get("gt_has_overflow"),
            "html_exists": html_path.exists(),
            "sample_type": row.get("sample_type", "original"),
        })
    return [r for r in records if r["html_exists"]]


def compute_metrics(results):
    valid = [r for r in results if r["sample_type"] == "original" and r.get("has_error") is not None and r.get("gt_has_overflow") is not None]
    tp = sum(1 for r in valid if r["gt_has_overflow"] and r["has_error"])
    fp = sum(1 for r in valid if not r["gt_has_overflow"] and r["has_error"])
    fn = sum(1 for r in valid if r["gt_has_overflow"] and not r["has_error"])
    tn = sum(1 for r in valid if not r["gt_has_overflow"] and not r["has_error"])
    acc = (tp + tn) / len(valid) if valid else 0
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0
    rec = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0
    return {"n": len(valid), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "accuracy": acc, "precision": prec, "recall": rec, "f1": f1}


async def main():
    parser = argparse.ArgumentParser(description="layout-audit dual-track eval runner (v7)")
    parser.add_argument("--cases-dir", default="cases", help="directory containing case HTML files (default: cases/)")
    parser.add_argument("--gt", default="ground-truth.json", help="ground-truth JSON (default: ground-truth.json)")
    parser.add_argument("--output", default="results/audit-results-latest.json", help="output JSON path")
    parser.add_argument("--compare", default=None, help="optional prior result JSON for FN/FP attribution diff")
    args = parser.parse_args()

    base_dir = Path(__file__).parent
    records = load_gt_records(base_dir / args.gt, base_dir)

    compare_map = {}
    if args.compare:
        compare_path = base_dir / args.compare
        if compare_path.exists():
            with open(compare_path, encoding="utf-8") as f:
                for r in json.load(f):
                    key = r.get("sample") or (r["case_id"] + "-" + r["version"] + f"-{r['repeat']:02d}")
                    compare_map[key] = r

    results = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT})
        for i, rec in enumerate(records):
            html_path = Path(rec["html_path"])
            gt_info = ("GT=是" if rec["gt_has_overflow"] else "GT=否") if rec["gt_has_overflow"] is not None else "GT=未知"
            print(f"[{i+1}/{len(records)}] {rec['sample']} {gt_info} ...", end=" ", flush=True)
            try:
                audit = await audit_one_file(page, html_path)
                rec.update(audit)
                results.append(rec)
                status = "ERROR" if audit["has_error"] else ("WARN" if audit["has_warning"] else "OK")
                print(f"{status} | E={audit['error_count']} W={audit['warning_count']} | {audit['elapsed_ms']}ms")
            except Exception as e:
                rec["error"] = str(e); rec["has_error"] = None; results.append(rec)
                print(f"ERROR: {e}")
        await browser.close()

    output_path = base_dir / args.output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    m = compute_metrics(results)
    print("\n========== dual-track stats (ERROR criterion vs GT) ==========")
    print(f"n={m['n']} TP={m['tp']} FP={m['fp']} FN={m['fn']} TN={m['tn']}")
    print(f"Accuracy={m['accuracy']:.2%} Precision={m['precision']:.2%} Recall={m['recall']:.2%} F1={m['f1']:.2%}")

    print("\n========== FN detail (GT=yes but ERROR=0) ==========")
    for r in results:
        if r["sample_type"] == "original" and r.get("gt_has_overflow") and not r.get("has_error"):
            warn_rules = [w["rule"] for w in r.get("warnings", [])]
            print(f"  {r['sample']}: downgraded to WARNING: {warn_rules}")

    print("\n========== FP detail (GT=no but ERROR>0) ==========")
    for r in results:
        if r["sample_type"] == "original" and r.get("gt_has_overflow") is False and r.get("has_error"):
            print(f"\n  {r['sample']}:")
            for e in r.get("errors", [])[:8]:
                msg = e.get("text") or ""
                print(f"    [{e['rule']}] {e.get('tag','')} '{e.get('cls','')[:40]}' max={e.get('max', e.get('px',''))} | {str(msg)[:120]}")

    print("\n========== new samples (no GT) ==========")
    for r in results:
        if r["sample_type"] == "new":
            status = "ERROR" if r.get("has_error") else ("WARN" if r.get("has_warning") else "OK")
            print(f"  {r['sample']}: {status} | E={r.get('error_count',0)} W={r.get('warning_count',0)}")
            for e in r.get("errors", [])[:5]:
                print(f"    [{e['rule']}] {str(e.get('text') or '')[:100]}")

    print(f"\nResults saved: {output_path}")


if __name__ == "__main__":
    asyncio.run(main())
