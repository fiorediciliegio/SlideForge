import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { createUserTemplateDraft, getUserTemplate, saveUserTemplateSource, appendUserTemplateLog, prepareUserTemplateDiagnosticBundle, recordUserTemplateOperation } from "../../src/user-templates/index.ts";
import { runWithDiagnosticLogging } from "../../src/diagnostic-logging.ts";

test("drafts own upload failures, append-only diagnostics and a complete scoped ZIP", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ppt-template-diagnostics-test-"));
  const previous = process.env.ANNA_WORKSPACE_DIR;
  process.env.ANNA_WORKSPACE_DIR = temporary;
  let archive = "";
  try {
    const draft = await createUserTemplateDraft({ filename: "source.pptx" });
    assert.equal(draft.source_ready, false);
    const directory = path.join(temporary, "ppt/user-templates", draft.id);
    await runWithDiagnosticLogging(false, () => appendUserTemplateLog({ id: draft.id, channel: "user-template", entry: { event: "disabled" } }));
    assert.deepEqual(await readdir(directory), ["template.json"]);
    await runWithDiagnosticLogging(true, async () => {
      await assert.rejects(recordUserTemplateOperation({ id: draft.id, operation: "save-source", diagnostic_context: { creation_run_id: "run-1" } }, async () => { throw new Error("download failed"); }), /download failed/);
      await appendUserTemplateLog({ id: draft.id, channel: "ai-user-template-stream", entry: { creation_run_id: "run-1", frames: [{ text: "x".repeat(90_000), access_token: "do-not-store", usage: { total_tokens: 42 } }] }, payload_keys: ["frames"] });
    });
    const source = path.join(temporary, "upload.pptx");
    await writeFile(source, "PKsource");
    await saveUserTemplateSource({ id: draft.id, filename: "source.pptx", staging_file_path: source, size_bytes: 8 });
    assert.equal((await getUserTemplate(draft.id)).source_ready, true);
    await assert.rejects(saveUserTemplateSource({ id: draft.id, filename: "source.pptx", staging_file_path: source, size_bytes: 8 }), /already saved/);
    const other = await createUserTemplateDraft({ filename: "other.pptx" });
    // Keep appending while the ZIP is collected; the copy must contain complete
    // lines and must not fail merely because the live log grows.
    const writes: Promise<unknown>[] = [];
    const ticker = setInterval(() => {
      writes.push(runWithDiagnosticLogging(true, () => appendUserTemplateLog({ id: draft.id, channel: "user-template", entry: { event: "live-frame-batch" } })));
    }, 1);
    let bundle: Awaited<ReturnType<typeof prepareUserTemplateDiagnosticBundle>>;
    try { bundle = await prepareUserTemplateDiagnosticBundle({ id: draft.id }); }
    finally { clearInterval(ticker); await Promise.all(writes); }
    archive = bundle.archive_path;
    assert.equal(bundle.aps_path, `user-templates/${draft.id}/diagnostics/current-template.zip`);
    const zip = await JSZip.loadAsync(await readFile(archive));
    assert.equal(await zip.file(`${draft.id}/source.pptx`)!.async("string"), "PKsource");
    assert.ok(zip.file(`${draft.id}/template.json`));
    assert.ok(zip.file(`${draft.id}/diagnostic-bundle.json`));
    assert.ok(Object.keys(zip.files).every((name) => name.startsWith(`${draft.id}/`)));
    assert.ok(!Object.keys(zip.files).some((name) => name.includes(other.id) || /(?:task|requirements|outline)\.json$/.test(name)));
    const logs = await zip.file(`${draft.id}/.log/user-template.jsonl`)!.async("string");
    assert.match(logs, /download failed/); assert.match(logs, /run-1/);
    assert.ok(logs.trim().split("\n").every((line) => JSON.parse(line).event));
    const stream = JSON.parse((await zip.file(`${draft.id}/.log/ai-user-template-stream.jsonl`)!.async("string")).trim());
    const payload = await zip.file(`${draft.id}/${stream.frames.relative_path.replaceAll(path.sep, "/")}`)!.async("string");
    assert.doesNotMatch(payload, /do-not-store/); assert.match(payload, /total_tokens/);
    const sourceInfo = await readdir(directory);
    assert.ok(!sourceInfo.includes("diagnostic-bundle.json"));
    await assert.rejects(prepareUserTemplateDiagnosticBundle({ id: "../../escape" }), /Invalid/);
    if (process.platform !== "win32") {
      await rm(path.join(directory, ".log"), { recursive: true });
      await symlink(temporary, path.join(directory, ".log"));
      await assert.rejects(prepareUserTemplateDiagnosticBundle({ id: draft.id }), /Invalid template log directory/);
    }
  } finally {
    if (previous === undefined) delete process.env.ANNA_WORKSPACE_DIR; else process.env.ANNA_WORKSPACE_DIR = previous;
    await rm(temporary, { recursive: true, force: true });
    if (archive) await rm(archive, { force: true });
  }
});
