/** Deterministic drift report between the current master and an AI-proposed
 *  one — the "restore or better?" question answered with numbers instead of
 *  gut feel. Pure functions, no DOM: regex-level comparison is exactly the
 *  right fidelity here (the master is generated HTML with stable shapes).
 *
 *  Dimensions: color palette, font-size scale, logo placement (data-asset
 *  elements incl. absolute-position movement), page markers, fixed-region
 *  skeleton (data-fixed count). */

export interface CountDelta { added: number; removed: number; changed: number }

export interface LogoDrift { kept: number; moved: number; lost: number; added: number }

export interface MasterDriftReport {
  colors: CountDelta;
  fontSizes: CountDelta;
  logos: LogoDrift;
  markers: { title: boolean; content: boolean };
  /** true when the count of data-fixed regions changed. */
  skeletonChanged: boolean;
}

const HEX_RE = /#[0-9a-fA-F]{6}\b/g;
const RGB_RE = /rgba?\([^)]+\)/g;
const FONT_SIZE_RE = /font-size\s*:\s*([0-9.]+px)/gi;
const ASSET_TAG_RE = /<img\b[^>]*data-asset="([^"]+)"[^>]*>/gi;
const POSITION_RE = /\b(left|top)\s*:\s*(-?[0-9.]+)px/g;
const LOGO_MOVE_TOLERANCE_PX = 8;

function colorMultiset(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(HEX_RE)) {
    const key = match[0].toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const match of html.matchAll(RGB_RE)) {
    const key = match[0].replace(/\s+/g, "").toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function fontSizeMultiset(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(FONT_SIZE_RE)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return counts;
}

function multisetDelta(current: Map<string, number>, proposed: Map<string, number>): CountDelta {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [key, count] of proposed) {
    const before = current.get(key) ?? 0;
    if (before === 0) added += 1;
    else if (count !== before) changed += 1;
  }
  for (const [key, count] of current) {
    if (!(proposed.has(key))) removed += 1;
    void count;
  }
  return { added, removed, changed };
}

function logoPositions(html: string): Map<string, { left: number; top: number }> {
  const positions = new Map<string, { left: number; top: number }>();
  for (const match of html.matchAll(ASSET_TAG_RE)) {
    const name = match[1];
    const tag = match[0];
    let left = 0;
    let top = 0;
    for (const pos of tag.matchAll(POSITION_RE)) {
      if (pos[1] === "left") left = Number(pos[2]);
      if (pos[1] === "top") top = Number(pos[2]);
    }
    positions.set(name, { left, top });
  }
  return positions;
}

export function compareMasters(currentHtml: string, proposedHtml: string): MasterDriftReport {
  return {
    colors: multisetDelta(colorMultiset(currentHtml), colorMultiset(proposedHtml)),
    fontSizes: multisetDelta(fontSizeMultiset(currentHtml), fontSizeMultiset(proposedHtml)),
    logos: compareLogos(logoPositions(currentHtml), logoPositions(proposedHtml)),
    markers: { title: proposedHtml.includes("{{PAGE_TITLE}}"), content: proposedHtml.includes("{{PAGE_CONTENT}}") },
    skeletonChanged: countMatches(currentHtml, /data-fixed="true"/g) !== countMatches(proposedHtml, /data-fixed="true"/g),
  };
}

function countMatches(html: string, re: RegExp): number {
  return (html.match(re) ?? []).length;
}

function compareLogos(current: Map<string, { left: number; top: number }>, proposed: Map<string, { left: number; top: number }>): LogoDrift {
  let kept = 0;
  let moved = 0;
  let lost = 0;
  let added = 0;
  for (const [name, before] of current) {
    const after = proposed.get(name);
    if (!after) { lost += 1; continue; }
    const delta = Math.abs(after.left - before.left) + Math.abs(after.top - before.top);
    if (delta > LOGO_MOVE_TOLERANCE_PX) moved += 1;
    else kept += 1;
  }
  for (const name of proposed.keys()) {
    if (!current.has(name)) added += 1;
  }
  return { kept, moved, lost, added };
}
