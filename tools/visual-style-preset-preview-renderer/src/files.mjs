import { access, cp, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export async function assertDirectory(path, label) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isDirectory()) throw new Error(`${label} is not a readable directory: ${path}`);
}

export async function assertFile(path, label) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`${label} is not a readable file: ${path}`);
  return metadata;
}

export function resolveInside(root, relativePath, label) {
  if (isAbsolute(relativePath)) throw new Error(`${label} must be relative: ${relativePath}`);
  const resolved = resolve(root, relativePath);
  const relativeToRoot = relative(root, resolved);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`${label} must stay within ${root}: ${relativePath}`);
  }
  return resolved;
}

export async function listDirectories(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function readJson(path, label) {
  const source = await readFile(path, "utf8");
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function exists(path) {
  await access(path).catch(() => null);
  return Boolean(await stat(path).catch(() => null));
}

export function pathsMatch(left, right) {
  return relative(resolve(left), resolve(right)) === "";
}

function isSameOrNested(parent, candidate) {
  const difference = relative(parent, candidate);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

export async function assertDisjointDirectories(source, output) {
  await assertDirectory(source, "--source-root");
  await assertDirectory(output, "--output-root");
  const [resolvedSource, resolvedOutput] = await Promise.all([realpath(source), realpath(output)]);
  if (isSameOrNested(resolvedSource, resolvedOutput) || isSameOrNested(resolvedOutput, resolvedSource)) {
    throw new Error(
      `--source-root and --output-root must be separate directories and must not contain one another: ${resolvedSource} <> ${resolvedOutput}`,
    );
  }
  return { sourceRoot: resolvedSource, outputRoot: resolvedOutput };
}

export async function copyDirectory(source, destination, options = {}) {
  if (pathsMatch(source, destination)) return false;
  await cp(source, destination, { recursive: true, force: true, ...options });
  return true;
}

const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function renameWithRetry(source, destination, { attempts = 10, delayMs = 500 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const retryable = error && typeof error === "object" && RETRYABLE_RENAME_CODES.has(error.code);
      if (!retryable || attempt === attempts) throw error;
      await wait(delayMs * attempt);
    }
  }
}
