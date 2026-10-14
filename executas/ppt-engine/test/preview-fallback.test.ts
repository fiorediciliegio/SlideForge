import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { test } from "node:test";
import { readPagePreviewFallbacks } from "../src/page-html-preview/fallback.js";
import { appendPreviewRecoveryLog } from "../src/page-html-preview/recovery-log.js";

const pageId = "page-11111111-1111-4111-8111-111111111111";
const html = (text: string) => `<!doctype html><html><body>${text}</body></html>`;
async function collect(input: Parameters<typeof readPagePreviewFallbacks>[0]) {
  const values = []; for await (const value of readPagePreviewFallbacks(input)) values.push(value); return values;
}
test("备用只读取同页静态产物，并按快照、编辑起点、缩略图顺序尝试", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-fallback-"));
  try {
    const output = path.join(workspaceDir, "output", "page-preview-html");
    const manual = path.join(workspaceDir, "manual-edits", pageId);
    await mkdir(output, { recursive: true }); await mkdir(manual, { recursive: true });
    await writeFile(path.join(output, `01-deck-${pageId}.html`), html("same page snapshot"));
    await writeFile(path.join(output, "02-deck-page-22222222-2222-4222-8222-222222222222.html"), html("another page"));
    await writeFile(path.join(manual, "base.html"), html("manual baseline"));
    const values = await collect({ workspaceDir, pageId });
    assert.deepEqual(values.map((value) => value.fallback.source), ["saved_snapshot", "manual_base"]);
    assert.ok(values.every((value) => value.page_id === pageId && !value.html.includes("another page")));
    assert.equal(await readFile(path.join(manual, "base.html"), "utf8"), html("manual baseline"));
    const thumbnail = path.join(workspaceDir, "output", "page-thumbnails", createHash("sha256").update(pageId).digest("hex"));
    await mkdir(thumbnail, { recursive: true });
    const fingerprint = "f".repeat(64);
    await writeFile(path.join(thumbnail, "current.json"), JSON.stringify({ preview_source_fingerprint: fingerprint }));
    await sharp({ create: { width: 16, height: 9, channels: 3, background: "white" } }).webp().toFile(path.join(thumbnail, `${fingerprint}.webp`));
    const withImage = await collect({ workspaceDir, pageId, aspectRatio: "9:16" });
    assert.equal(withImage.at(-1)?.fallback.source, "thumbnail");
    assert.match(withImage.at(-1)!.html, /data-ppt-aspect-ratio="9:16"/);
    assert.match(withImage.at(-1)!.html, /data:image\/webp;base64/);
  } finally { await rm(workspaceDir, { recursive: true, force: true }); }
});

test("不能通过越界符号链接读取备用，也不把源码当成静态快照", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-boundary-"));
  try {
    const workspaceDir = path.join(root, "workspace");
    await mkdir(path.join(workspaceDir, "slides"), { recursive: true });
    await writeFile(path.join(workspaceDir, "slides", `${pageId}.html`), html("source must not be used"));
    await writeFile(path.join(root, "outside.html"), html("outside"));
    await symlink(path.join(root, "outside.html"), path.join(workspaceDir, "link.html"));
    assert.deepEqual(await collect({ workspaceDir, pageId, snapshotPath: path.join(workspaceDir, "link.html") }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("告警字段白名单、并发去重和容量轮换", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-preview-logging-"));
  try {
    const entry = { event: "preview.fallback", error_kind: "missing_snapshot", source: "manual_base", page_id: pageId,
      requested_fingerprint: "a".repeat(64), actual_fingerprint: "b".repeat(64),
      html: "PRIVATE_HTML", error: "https://example.test?signature=PRIVATE", timestamp: "untrusted" };
    const results = await Promise.all(Array.from({ length: 5 }, () => appendPreviewRecoveryLog(root, entry)));
    assert.equal(results.filter((result) => result.appended).length, 1);
    const text = await readFile(results[0].log_file, "utf8");
    assert.doesNotMatch(text, /PRIVATE|untrusted/);
    assert.equal(JSON.parse(text).requested_fingerprint, "a".repeat(64));
    await writeFile(results[0].log_file, "x".repeat(2 * 1024 * 1024));
    await appendPreviewRecoveryLog(root, { ...entry, event: "preview.recovered", source: "current" });
    assert.equal((await readFile(`${results[0].log_file}.previous`)).length, 2 * 1024 * 1024);
    assert.equal(JSON.parse(await readFile(results[0].log_file, "utf8")).event, "preview.recovered");
  } finally { await rm(root, { recursive: true, force: true }); }
});
