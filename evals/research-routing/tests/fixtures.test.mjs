import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fixturesFromWorkbook, sha256, v11PromptFromV7 } from "../src/fixtures.mjs";

test("research-routing workbook exposes the expected 50 labelled cases and 10 prompts", async () => {
  const workbook = await readFile(resolve("evals/research-routing/cases/research-routing-v1.xlsx"));
  const fixtures = fixturesFromWorkbook(workbook);
  assert.equal(fixtures.cases.length, 50);
  assert.equal(fixtures.prompts.length, 10);
  assert.deepEqual(fixtures.cases[0].expected, { web: false, images: false });
  assert.equal(fixtures.prompts[0].prompt_version, "v1");
  assert.match(fixtures.prompts[0].prompt_hash, /^[a-f0-9]{64}$/u);
});

test("fixture synchronization regenerates and preserves v11 across repeated syncs", async (t) => {
  const temp = await mkdtemp(resolve(tmpdir(), "ppt-routing-sync-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = resolve("evals/research-routing");
  await mkdir(resolve(temp, "scripts"));
  await cp(resolve(root, "src"), resolve(temp, "src"), { recursive: true });
  await cp(resolve(root, "scripts/sync-fixtures.mjs"), resolve(temp, "scripts/sync-fixtures.mjs"));
  const expectedPrompt = await readFile(resolve(root, "prompts/router-v11.txt"), "utf8");
  const expectedManifest = JSON.parse(await readFile(resolve(root, "prompts/manifest.json"), "utf8"));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const source = resolve(attempt === 0 ? root : temp, "cases/research-routing-v1.xlsx");
    execFileSync(process.execPath, [resolve(temp, "scripts/sync-fixtures.mjs"), "--source", source]);
    const prompt = await readFile(resolve(temp, "prompts/router-v11.txt"), "utf8");
    const manifest = JSON.parse(await readFile(resolve(temp, "prompts/manifest.json"), "utf8"));
    assert.equal(prompt, expectedPrompt);
    assert.deepEqual(manifest, expectedManifest);
    assert.equal(manifest.prompts.find((item) => item.prompt_version === "v11").prompt_hash, sha256(prompt.trimEnd()));
  }
});

test("v11 derivation rejects a changed or missing v7 JSON constraint", () => {
  assert.throws(() => v11PromptFromV7(undefined), /Cannot derive v11/);
  assert.throws(() => v11PromptFromV7({ prompt: "Different output contract" }), /Cannot derive v11/);
});
