import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BATCH_CONCURRENCY,
  buildOutputFilename,
  normalizeBatchConfig,
  normalizeOutputDir,
  normalizeOutputPrefix,
  normalizeOutputSuffix,
  parseConcurrency,
  runBatch,
  summarizeBatch,
} from "../src/batch-runner.js";

test("normalizeOutputDir keeps absolute paths and trims surrounding whitespace", () => {
  assert.equal(normalizeOutputDir("  /Users/dev/tmp/batch-out  "), "/Users/dev/tmp/batch-out");
  assert.equal(normalizeOutputDir("C:\\Users\\dev\\out"), "C:\\Users\\dev\\out");
  assert.equal(normalizeOutputDir("\\\\server\\share\\out"), "\\\\server\\share\\out");
});

test("normalizeOutputDir rejects empty and relative paths", () => {
  assert.throws(() => normalizeOutputDir("   "), /不能为空/);
  assert.throws(() => normalizeOutputDir("tmp/batch-out"), /必须是绝对路径/);
  assert.throws(() => normalizeOutputDir("./out"), /必须是绝对路径/);
  assert.throws(() => normalizeOutputDir("~/out"), /必须是绝对路径/);
});

test("normalizeOutputPrefix rejects anything that could redirect the write", () => {
  assert.equal(normalizeOutputPrefix(" run "), "run");
  assert.throws(() => normalizeOutputPrefix(""), /不能为空/);
  assert.throws(() => normalizeOutputPrefix("sub/run"), /路径分隔符/);
  assert.throws(() => normalizeOutputPrefix("sub\\run"), /路径分隔符/);
  assert.throws(() => normalizeOutputPrefix("..run"), /不能包含 \.\./);
});

test("normalizeOutputSuffix is optional and tolerates a leading dot", () => {
  assert.equal(normalizeOutputSuffix("txt"), "txt");
  assert.equal(normalizeOutputSuffix(".md"), "md");
  assert.equal(normalizeOutputSuffix("  "), "");
  assert.equal(normalizeOutputSuffix(undefined), "");
  assert.throws(() => normalizeOutputSuffix("a/b"), /路径分隔符/);
});

test("parseConcurrency accepts 1..MAX and rejects everything else", () => {
  assert.equal(parseConcurrency("3"), 3);
  assert.equal(parseConcurrency(1), 1);
  assert.equal(parseConcurrency(MAX_BATCH_CONCURRENCY), MAX_BATCH_CONCURRENCY);
  assert.throws(() => parseConcurrency("0"), /至少为 1/);
  assert.throws(() => parseConcurrency(MAX_BATCH_CONCURRENCY + 1), /最多为/);
  assert.throws(() => parseConcurrency("2.5"), /必须是整数/);
  assert.throws(() => parseConcurrency("abc"), /必须是整数/);
  assert.throws(() => parseConcurrency(""), /不能为空/);
  assert.throws(() => parseConcurrency("   "), /不能为空/);
});

test("buildOutputFilename follows 前缀_<第几次>.后缀 and marks failures", () => {
  assert.equal(buildOutputFilename({ prefix: "run", suffix: "txt", index: 1 }), "run_1.txt");
  assert.equal(buildOutputFilename({ prefix: "run", suffix: "txt", index: 12 }), "run_12.txt");
  assert.equal(
    buildOutputFilename({ prefix: "run", suffix: "txt", index: 3, failed: true }),
    "run_3.error.txt",
  );
});

test("buildOutputFilename omits the dot when no suffix is given", () => {
  assert.equal(buildOutputFilename({ prefix: "run", suffix: "", index: 2 }), "run_2");
  assert.equal(buildOutputFilename({ prefix: "run", suffix: "", index: 2, failed: true }), "run_2.error");
});

test("normalizeBatchConfig validates every field together", () => {
  assert.deepEqual(
    normalizeBatchConfig({
      concurrency: "4",
      outputDir: "/tmp/out",
      outputPrefix: "deck",
      outputSuffix: ".md",
    }),
    { concurrency: 4, outputDir: "/tmp/out", outputPrefix: "deck", outputSuffix: "md" },
  );
  assert.throws(
    () => normalizeBatchConfig({ concurrency: "4", outputDir: "out", outputPrefix: "deck", outputSuffix: "md" }),
    /必须是绝对路径/,
  );
});

test("runBatch runs indices 1..total concurrently", async () => {
  let peak = 0;
  let active = 0;
  const seen = [];
  const results = await runBatch({
    total: 5,
    async task(index) {
      active += 1;
      peak = Math.max(peak, active);
      seen.push(index);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return index * 2;
    },
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(peak, 5, "all pipelines should be in flight at once");
  assert.deepEqual(results.map((result) => result.value), [2, 4, 6, 8, 10]);
  assert.ok(results.every((result) => result.ok));
});

test("runBatch captures a rejection instead of losing the other results", async () => {
  const results = await runBatch({
    total: 3,
    async task(index) {
      if (index === 2) throw new Error("boom");
      return index;
    },
  });
  assert.deepEqual(results.map((result) => result.ok), [true, false, true]);
  assert.equal(results[1].error.message, "boom");
  assert.deepEqual(summarizeBatch(results), { total: 3, succeeded: 2, failed: 1 });
});

test("runBatch captures a synchronous throw", async () => {
  const results = await runBatch({
    total: 2,
    task(index) {
      if (index === 1) throw new Error("sync boom");
      return index;
    },
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error.message, "sync boom");
  assert.equal(results[1].ok, true);
});
