import { DEFAULT_TIMEOUT_MS, PREVIEW_QUALITY } from "./constants.mjs";

const VALUE_OPTIONS = new Set([
  "source-root",
  "output-root",
  "presets-root",
  "browser-executable",
  "quality",
  "timeout-ms",
  "report",
]);

function fail(message) {
  throw new Error(`Argument error: ${message}`);
}

export function usage() {
  return [
    "Usage:",
    "  npm run render -- --source-root <preset-source-root> --output-root <output-presets-root> --browser-executable <chromium-path> [--quality 90] [--timeout-ms 30000] [--report <report.json>]",
    "  npm run convert-images -- --source-root <preset-source-root> --output-root <output-presets-root> [--quality 90] [--report <report.json>]",
    "  npm run check -- --presets-root <presets-root> --browser-executable <chromium-path> [--timeout-ms 30000] [--report <report.json>]",
  ].join("\n");
}

export function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (command !== "render" && command !== "convert-images" && command !== "check") {
    fail(`expected "render", "convert-images", or "check".\n${usage()}`);
  }

  const options = { command, quality: PREVIEW_QUALITY, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) fail(`unexpected value "${token}".`);
    const key = token.slice(2);
    if (!VALUE_OPTIONS.has(key)) fail(`unknown option "${token}".`);
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) fail(`"${token}" requires a value.`);
    index += 1;
    if (key === "timeout-ms") options.timeoutMs = Number(value);
    else if (key === "quality") options.quality = Number(value);
    else options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    fail("--timeout-ms must be a positive integer.");
  }
  if (!Number.isInteger(options.quality) || options.quality < 0 || options.quality > 100) {
    fail("--quality must be an integer from 0 to 100.");
  }
  if (command !== "convert-images" && !options.browserExecutable) {
    fail("--browser-executable is required; the tool does not hard-code a local browser path.");
  }
  if ((command === "render" || command === "convert-images") && (!options.sourceRoot || !options.outputRoot)) {
    fail(`${command} requires --source-root and --output-root.`);
  }
  if (command === "check" && !options.presetsRoot) fail("check requires --presets-root.");
  return options;
}
