import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("49 张图片时并发上传仅剩一个名额，删除后可补充，文档不占图片名额", async () => {
  const previous = process.env.ANNA_WORKSPACE_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), "ppt-image-limit-"));
  process.env.ANNA_WORKSPACE_DIR = root;
  const engine = await import("../../src/app-workspace/index.ts");
  try {
    const { workspace_dir } = await engine.createAppWorkspace({ title: "图片数量边界" });
    const image = {
      workspace_dir, filename: "image.PNG", mime_type: "image/png",
      content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    };
    const first = await engine.uploadAppUploadedSource(image);
    const materials = Array.from({ length: 49 }, (_, i) => ({ ...first.material, uploaded_source_id: `fixture-${i}` }));
    await writeFile(path.join(workspace_dir, "uploaded-sources", "index.json"), JSON.stringify({
      ...first.index, materials, active_total_size_bytes: first.material.size_bytes * materials.length,
    }));
    const uploads = await Promise.allSettled([
      engine.uploadAppUploadedSource({ ...image, filename: "one.png" }),
      engine.uploadAppUploadedSource({ ...image, filename: "two.png" }),
    ]);
    assert.equal(uploads.filter((result) => result.status === "fulfilled").length, 1);
    const failure = uploads.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.match(String(failure.reason), /limit of 50 images/);
    assert.equal((await engine.listAppUploadedSources({ workspace_dir })).active.length, 50);
    await engine.uploadAppUploadedSource({ workspace_dir, filename: "facts.txt", mime_type: "text/plain", content_base64: Buffer.from("文字资料").toString("base64") });
    await engine.removeAppUploadedSource({ workspace_dir, uploaded_source_id: materials[0].uploaded_source_id });
    await engine.uploadAppUploadedSource({ ...image, filename: "replacement.png" });
    const listed = await engine.listAppUploadedSources({ workspace_dir });
    assert.equal(listed.active.filter((item) => item.extension.toLowerCase() === ".png").length, 50);
    assert.equal(listed.active.length, 51);
  } finally {
    if (previous === undefined) delete process.env.ANNA_WORKSPACE_DIR; else process.env.ANNA_WORKSPACE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
