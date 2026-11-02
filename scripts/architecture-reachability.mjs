import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, ".scratch", "p4-reachability-audit.json");
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const coreTestDirectories = new Set(["capabilities", "contracts", "server"]);

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

async function collect(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(absolute));
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function candidates(importer, specifier) {
  const base = path.resolve(path.dirname(importer), specifier);
  const parsed = path.parse(base);
  const withoutExtension = path.join(parsed.dir, parsed.name);
  const bases = extensions.has(parsed.ext) ? [withoutExtension, base] : [base];
  const result = [];
  for (const candidate of bases) {
    for (const extension of extensions) result.push(`${candidate}${extension}`);
    for (const extension of extensions) result.push(path.join(candidate, `index${extension}`));
  }
  if (extensions.has(parsed.ext)) result.push(base);
  return result;
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  return candidates(importer, specifier).find((candidate) => existsSync(candidate)) ?? null;
}

async function reachable(entries) {
  const seen = new Set();
  const unresolved = [];
  const queue = entries.filter((entry) => existsSync(entry));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    const specifiers = new Set();
    for (const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g)) {
      specifiers.add(match[1]);
    }
    for (const match of source.matchAll(/import\s+["']([^"']+)["']/g)) specifiers.add(match[1]);
    for (const match of source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1]);
    for (const match of source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(match[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveImport(file, specifier);
      if (resolved) queue.push(resolved);
      else unresolved.push({ importer: relative(file), specifier });
    }
  }
  return { seen, unresolved };
}

const testFiles = await collect(path.join(root, "tests"));
const coreTests = testFiles.filter((file) => coreTestDirectories.has(relative(file).split("/")[1]));
const legacyTests = testFiles.filter((file) => !coreTestDirectories.has(relative(file).split("/")[1]));
const activeEntries = [
  "src/http/capabilityServer.ts",
  "src/mcp/server.ts",
  "scripts/m0-generate.ts",
  "scripts/keys.ts",
  "scripts/ci-fidelity.ts",
  "scripts/mcp-smoke.ts",
  "scripts/m0-spike-export.ts",
].map((file) => path.join(root, file));
const legacyEntries = [
  "src/main.tsx",
  "scripts/run-ppt-pipeline.mjs",
  ...legacyTests.map((file) => relative(file)),
].map((file) => path.join(root, file));

const active = await reachable(activeEntries);
const core = await reachable(coreTests);
const legacy = await reachable(legacyEntries);
const appFiles = [
  ...await collect(path.join(root, "src")),
  ...testFiles,
];
const all = new Set(appFiles.map(relative));
const activeRelative = new Set([...active.seen].map(relative));
const coreRelative = new Set([...core.seen].map(relative));
const legacyRelative = new Set([...legacy.seen].map(relative));
const protectedPrefixes = ["src/features/templates/presets/"];
const protectedFiles = new Set(["src/http/editor-dnd.js"]);
const isProtected = (file) => protectedFiles.has(file) || protectedPrefixes.some((prefix) => file.startsWith(prefix));

function difference(source, ...excluded) {
  return [...source].filter((file) => all.has(file) && !isProtected(file)
    && excluded.every((set) => !set.has(file))).sort();
}

function intersection(left, right) {
  return [...left].filter((file) => right.has(file) && !isProtected(file)).sort();
}

function group(files) {
  const groups = {};
  for (const file of files) {
    const parts = file.split("/");
    const key = parts.length === 1 ? "(root)"
      : parts[0] === "src" && parts[1] === "features"
        ? parts.slice(0, 3).join("/")
        : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
    (groups[key] ??= []).push(file);
  }
  return Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, {
    count: values.length,
    files: values,
  }]));
}

const legacyOnly = difference(legacyRelative, activeRelative, coreRelative);
const unreferenced = difference(all, activeRelative, coreRelative, legacyRelative);
const shared = intersection(activeRelative, legacyRelative);
const coreOnly = difference(coreRelative, activeRelative, legacyRelative);
const audit = {
  generatedAt: new Date().toISOString(),
  method: "Static relative-import reachability; runtime asset references require manual whitelist review.",
  entries: {
    active: activeEntries.map(relative),
    coreTests: coreTests.map(relative),
    legacy: legacyEntries.map(relative),
  },
  protected: {
    prefixes: protectedPrefixes,
    files: [...protectedFiles],
    directories: ["contracts/", "services/", "executas/", "third_party/"],
  },
  counts: {
    appModules: all.size,
    activeReachable: activeRelative.size,
    coreReachable: coreRelative.size,
    legacyReachable: legacyRelative.size,
    sharedActiveAndLegacy: shared.length,
    legacyOnlyCandidates: legacyOnly.length,
    unreferencedCandidates: unreferenced.length,
    coreOnlyProtected: coreOnly.length,
  },
  groups: {
    legacyOnlyCandidates: group(legacyOnly),
    unreferencedCandidates: group(unreferenced),
    sharedActiveAndLegacy: group(shared),
    coreOnlyProtected: group(coreOnly),
  },
  files: {
    legacyOnlyCandidates: legacyOnly,
    unreferencedCandidates: unreferenced,
    sharedActiveAndLegacy: shared,
    coreOnlyProtected: coreOnly,
  },
  unresolvedImports: {
    active: active.unresolved,
    core: core.unresolved,
    legacy: legacy.unresolved,
  },
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: relative(output),
  counts: audit.counts,
  legacyGroups: Object.fromEntries(Object.entries(audit.groups.legacyOnlyCandidates).map(([key, value]) => [key, value.count])),
  unreferencedGroups: Object.fromEntries(Object.entries(audit.groups.unreferencedCandidates).map(([key, value]) => [key, value.count])),
  unresolved: Object.fromEntries(Object.entries(audit.unresolvedImports).map(([key, value]) => [key, value.length])),
}, null, 2));
