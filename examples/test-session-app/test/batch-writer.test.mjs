import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ensureOutputDir, writeOutputFile } from "../src/batch-writer-client.js";

const plugin = fileURLToPath(new URL("../executas/batch-writer/plugin.js", import.meta.url));

function invoke(tool, args) {
  const child = spawnSync(process.execPath, [plugin], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "invoke", params: { tool, arguments: args } })}\n`,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const reply = JSON.parse(child.stdout.trim());
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.id, 1);
  return reply;
}

for (const unwrapped of [false, true]) {
  test(`batch writer creates directories and writes files through ${unwrapped ? "unwrapped" : "wrapped"} Host replies`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "batch-writer-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = path.join(root, "批量输出", "page 1");
    const runtime = {
      tools: {
        async invoke({ method, args }) {
          const reply = invoke(method, args);
          assert.equal(reply.error, undefined);
          // The Host checks this before passing anything to the frontend.
          assert.equal(reply.result.success, true, "Executa invoke must declare protocol success");
          assert.equal(reply.result.tool, method);
          return unwrapped ? reply.result.data : reply.result;
        },
      },
    };

    const prepared = await ensureOutputDir(runtime, dir);
    assert.equal(prepared.dir, dir);
    assert.equal(prepared.existed, false);
    assert.equal((await stat(dir)).isDirectory(), true);
    assert.equal((await ensureOutputDir(runtime, dir)).existed, true);

    for (const content of ["<html>批量结果</html>", "覆盖结果"]) {
      const written = await writeOutputFile(runtime, { dir, filename: "run_1.html", content });
      assert.equal(written.path, path.join(dir, "run_1.html"));
      assert.equal(written.bytes, Buffer.byteLength(content, "utf8"));
      assert.equal(await readFile(written.path, "utf8"), content);
    }
  });
}

test("invalid output directories remain JSON-RPC errors for both tools", () => {
  for (const tool of ["ensure_output_dir", "write_text_file"]) {
    const reply = invoke(tool, { dir: "relative-output", filename: "run_1.html" });
    assert.equal(reply.result, undefined);
    assert.equal(reply.error.code, -32602);
    assert.match(reply.error.message, /absolute path/);
  }
});
