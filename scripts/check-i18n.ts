/**
 * i18n 结构校验（check-i18n）：
 *   1. key 对齐：各语言 key 集合与英文基准 diff（缺失/多余）
 *   2. 占位符对齐：同一 key 的 {var} 集合与英文一致
 *   3. 禁二元分支（v1.3 启用）：src 下禁止新增 locale === "zh" 等二元判断；
 *      R 类（OutputLanguage 域，方案 §4.4）须打 // output-language: 标记豁免
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/check-i18n.ts
 * 退出码：0 = 全绿；1 = 存在结构性错误（CI 可接入）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh-CN";
import { ja } from "../src/i18n/ja-JP";
import { de } from "../src/i18n/de-DE";

type FlatMap = Map<string, string>;

function flatten(value: unknown, prefix: string, out: FlatMap): FlatMap {
  if (typeof value === "string") {
    out.set(prefix, value);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const base = flatten(en, "", new Map());
const targets: Array<[string, FlatMap]> = [
  ["zh", flatten(zh, "", new Map())],
  ["ja", flatten(ja, "", new Map())],
  ["de", flatten(de, "", new Map())],
];

let failures = 0;

for (const [name, pack] of targets) {
  const missing = [...base.keys()].filter((k) => !pack.has(k));
  const extra = [...pack.keys()].filter((k) => !base.has(k));
  const placeholderMismatch: string[] = [];
  for (const [key, template] of base) {
    const translated = pack.get(key);
    if (!translated) continue;
    if (String(placeholders(template)) !== String(placeholders(translated))) {
      placeholderMismatch.push(
        `${key}: en{${placeholders(template)}} vs ${name}{${placeholders(translated)}}`
      );
    }
  }

  console.log(`\n[${name}] key 总数 ${pack.size} / 基准 ${base.size}`);
  if (missing.length) {
    failures += missing.length;
    console.log(`  ✗ 缺失 key ${missing.length} 个（回退英文）:`);
    missing.slice(0, 10).forEach((k) => console.log(`    - ${k}`));
    if (missing.length > 10) console.log(`    ... 共 ${missing.length} 个`);
  }
  if (extra.length) {
    failures += extra.length;
    console.log(`  ✗ 多余 key ${extra.length} 个:`);
    extra.slice(0, 10).forEach((k) => console.log(`    + ${k}`));
  }
  if (placeholderMismatch.length) {
    failures += placeholderMismatch.length;
    console.log(`  ✗ 占位符不一致 ${placeholderMismatch.length} 个:`);
    placeholderMismatch.forEach((line) => console.log(`    ! ${line}`));
  }
  if (!missing.length && !extra.length && !placeholderMismatch.length) {
    console.log("  ✓ key 对齐 / 占位符对齐");
  }
}

console.log(failures ? `\n✗ check-i18n 未通过：${failures} 处结构问题` : "\n✓ check-i18n 全部通过");

// ---- 3. 禁二元分支（v1.3）：locale === "zh" 及变体禁止新增 ----
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const BINARY_PATTERN = /locale\s*(?:===|!==)\s*"(?:zh|en)"/;
const binaryHits: string[] = [];

function scan(dir: string) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scan(full);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!BINARY_PATTERN.test(line)) return;
      if (line.includes("// output-language:")) return; // R 类豁免（方案 §4.4）
      binaryHits.push(`${relative(SRC_DIR, full)}:${index + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
}
scan(SRC_DIR);

if (binaryHits.length) {
  failures += binaryHits.length;
  console.log(`\n✗ 禁二元分支：发现 ${binaryHits.length} 处未豁免的 locale 二元判断:`);
  binaryHits.slice(0, 15).forEach((line) => console.log(`    - ${line}`));
  if (binaryHits.length > 15) console.log(`    ... 共 ${binaryHits.length} 处`);
  console.log("    处置：界面文案迁 t key / pickLocale 四语表；R 类（OutputLanguage 域）加 // output-language: 标记");
} else {
  console.log("\n✓ 禁二元分支：无未豁免的 locale 二元判断");
}

process.exit(failures ? 1 : 0);
