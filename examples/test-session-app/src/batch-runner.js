/**
 * batch-runner.js — pure logic for the batch test tab: input validation,
 * output filename construction and concurrent scheduling.
 *
 * Nothing here touches the DOM, the Anna runtime or IndexedDB, so every rule
 * below is unit-testable without a backend. app.js owns the orchestration.
 */

export const MAX_BATCH_CONCURRENCY = 64;

// `dir` is handed straight to the batch-writer Executa, which resolves it in
// its own process. A relative path would land somewhere the UI cannot show, so
// the absolute check happens here too — before any session is created.
export function normalizeOutputDir(value) {
  const dir = typeof value === "string" ? value.trim() : "";
  if (!dir) throw new Error("输出目录不能为空");
  const isPosixAbsolute = dir.startsWith("/");
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\");
  if (!isPosixAbsolute && !isWindowsAbsolute) {
    throw new Error(`输出目录必须是绝对路径，例如 /Users/you/tmp/batch-out；当前输入：${dir}`);
  }
  return dir;
}

/**
 * The prefix and suffix are concatenated into a bare filename, so anything that
 * could climb out of the output directory or split into a subpath is rejected
 * rather than silently sanitized — a typo should stop the run, not redirect it.
 */
function normalizeFilenamePart(value, label, { required }) {
  const part = typeof value === "string" ? value.trim() : "";
  if (!part) {
    if (required) throw new Error(`${label}不能为空`);
    return "";
  }
  if (/[\\/]/.test(part)) throw new Error(`${label}不能包含路径分隔符：${part}`);
  if (part.includes("\0")) throw new Error(`${label}不能包含 NUL 字符`);
  if (part.includes("..")) throw new Error(`${label}不能包含 ..：${part}`);
  return part;
}

export function normalizeOutputPrefix(value) {
  return normalizeFilenamePart(value, "输出文件前缀", { required: true });
}

// A suffix is optional (an extension-less file is a legitimate choice) and a
// leading dot is accepted so both `txt` and `.txt` mean the same thing.
export function normalizeOutputSuffix(value) {
  const suffix = normalizeFilenamePart(value, "输出文件后缀", { required: false });
  return suffix.replace(/^\.+/, "");
}

export function parseConcurrency(value) {
  let count;
  if (typeof value === "number") {
    count = value;
  } else {
    const text = String(value ?? "").trim();
    // `Number("")` is 0, which would otherwise be reported as "至少为 1" — a
    // misleading message for a field the user simply left blank.
    if (!text) throw new Error("并发数不能为空");
    count = Number(text);
  }
  if (!Number.isFinite(count) || !Number.isInteger(count)) throw new Error("并发数必须是整数");
  if (count < 1) throw new Error("并发数至少为 1");
  if (count > MAX_BATCH_CONCURRENCY) {
    throw new Error(`并发数最多为 ${MAX_BATCH_CONCURRENCY}，避免一次性打满平台配额`);
  }
  return count;
}

/**
 * `前缀_<第几次>.<后缀>` for a successful run, with `.error` inserted before the
 * suffix when the run failed — so a directory listing separates results from
 * failures without opening anything, and the index stays contiguous.
 */
export function buildOutputFilename({ prefix, suffix, index, failed = false }) {
  const stem = `${prefix}_${index}${failed ? ".error" : ""}`;
  return suffix ? `${stem}.${suffix}` : stem;
}

export function normalizeBatchConfig({ concurrency, outputDir, outputPrefix, outputSuffix }) {
  return {
    concurrency: parseConcurrency(concurrency),
    outputDir: normalizeOutputDir(outputDir),
    outputPrefix: normalizeOutputPrefix(outputPrefix),
    outputSuffix: normalizeOutputSuffix(outputSuffix),
  };
}

/**
 * Runs `task(index)` for indices 1..total concurrently and always resolves.
 *
 * A batch test is only useful if one bad run does not hide the other results,
 * so a rejected task is captured as `{ index, ok: false, error }` instead of
 * short-circuiting the way `Promise.all` would.
 */
export async function runBatch({ total, task }) {
  const settled = await Promise.all(
    Array.from({ length: total }, (_unused, offset) => {
      const index = offset + 1;
      return Promise.resolve()
        .then(() => task(index))
        .then((value) => ({ index, ok: true, value }))
        .catch((error) => ({ index, ok: false, error }));
    }),
  );
  return settled;
}

export function summarizeBatch(results) {
  const succeeded = results.filter((result) => result.ok).length;
  return { total: results.length, succeeded, failed: results.length - succeeded };
}
