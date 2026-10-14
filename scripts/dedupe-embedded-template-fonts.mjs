import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const presetsRoot = resolve("src/features/templates/presets");
const fontFace = /@font-face\s*\{[\s\S]*?\}/gi;
const fontWeight = /\bfont-weight\s*:\s*(\d+)\s*;/i;

function faceKey(face) {
  return face.replace(fontWeight, "").replace(/\s+/g, " ").trim();
}

function mergedFace(face, weights) {
  const sorted = [...new Set(weights)].sort((left, right) => left - right);
  const value = sorted.length === 1 ? String(sorted[0]) : `${sorted[0]} ${sorted.at(-1)}`;
  return face.replace(fontWeight, `font-weight: ${value};`);
}

/**
 * Google Fonts often serves one variable WOFF2 payload for several requested
 * weights.  Keep the HTML self-contained, but express that shared payload as
 * one @font-face range instead of embedding the same Base64 bytes repeatedly.
 */
export function dedupeEmbeddedFontFaces(html) {
  const faces = [...html.matchAll(fontFace)].map((match) => ({
    index: match.index ?? 0,
    value: match[0],
    length: match[0].length,
    weight: Number(fontWeight.exec(match[0])?.[1]),
  }));
  const groups = new Map();
  for (const face of faces) {
    if (!Number.isFinite(face.weight)) continue;
    const key = faceKey(face.value);
    const group = groups.get(key) ?? [];
    group.push(face);
    groups.set(key, group);
  }

  const replacements = new Map();
  let removedFaces = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    replacements.set(group[0].index, mergedFace(group[0].value, group.map((face) => face.weight)));
    for (const duplicate of group.slice(1)) replacements.set(duplicate.index, "");
    removedFaces += group.length - 1;
  }
  if (removedFaces === 0) return { html, removedFaces };

  let cursor = 0;
  let output = "";
  for (const face of faces) {
    output += html.slice(cursor, face.index);
    output += replacements.get(face.index) ?? face.value;
    cursor = face.index + face.length;
  }
  return { html: output + html.slice(cursor), removedFaces };
}

async function main() {
  const targetPresetIds = process.argv.slice(2);
  if (targetPresetIds.length === 0) {
    throw new Error("Usage: node scripts/dedupe-embedded-template-fonts.mjs <preset-id> [...preset-id]");
  }
  for (const presetId of targetPresetIds) {
    const presetDir = resolve(presetsRoot, presetId);
    const preset = JSON.parse(await readFile(resolve(presetDir, "preset.json"), "utf8"));
    for (const page of preset.reference_html_pages ?? []) {
      const htmlPath = resolve(presetDir, page.path);
      const html = await readFile(htmlPath, "utf8");
      const result = dedupeEmbeddedFontFaces(html);
      if (result.removedFaces > 0) {
        await writeFile(htmlPath, result.html);
        console.log(`Deduplicated ${result.removedFaces} embedded font face(s) in ${presetId}/${page.path}`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
