import assert from "node:assert/strict";
import test from "node:test";
import type { PptBackend } from "../../src/api/pptBackend";
import type { PageImageUploadRequest, PageUploadedImage } from "../../src/api/pageImageUploadTypes";
import { createPageImageUploadService, parsePageImageDescription, parsePageImageDescriptions, validatePageImageFile } from "../../src/features/page-image-upload/service";

const image: PageUploadedImage = { asset_id: "manual-red", file_path: "/workspace/red.png", sha256: "a".repeat(64), mime_type: "image/png",
  bytes_size: 5, aspect_ratio: 1, description: "", reason: "manual", matched_queries: [], source_filename: "red.png", source_url: "manual-upload://red" };

test("上传成功立即返回空描述素材，只提交文件，不准备附件或调用描述模型", async () => {
  const requests: PageImageUploadRequest[] = [];
  let uploads = 0;
  const service = createPageImageUploadService({ workspaceDir: "/workspace",
    upload: { uploadFile: async (_file, options) => {
      uploads++; assert.equal(options.purpose, "image_input");
      return { transport: "host_upload", r2_key: "red", url: "https://test/red.png", mime_type: "image/png", size_bytes: 5 };
    } },
    backend: { pageImageUpload: async (request: PageImageUploadRequest) => { requests.push(request); return { images: [image] }; } } as PptBackend,
  });
  const saved = await service.upload(new File(["image"], "red.png", { type: "image/png" }));
  assert.equal(saved.description, ""); assert.equal(saved.source, "uploaded");
  assert.equal(saved.asset_id, image.asset_id); assert.equal(uploads, 1);
  assert.deepEqual(requests.map((request) => request.action), ["commit"]);
  assert.equal(requests[0].workspace_dir, "/workspace");
  assert.deepEqual(Object.keys(service), ["upload"]);
});

test("重复上传沿用后端返回的既有空描述搜索素材标识", async () => {
  const existing = { ...image, asset_id: "existing-search", source_url: "https://example.test/image.png" };
  const service = createPageImageUploadService({ workspaceDir: "/workspace",
    upload: { uploadFile: async () => ({ transport: "host_upload", r2_key: "red", url: "https://test/red.png", mime_type: "image/png", size_bytes: 5 }) },
    backend: { pageImageUpload: async () => ({ images: [existing] }) } as unknown as PptBackend,
  });
  const saved = await service.upload(new File(["image"], "red.png"));
  assert.equal(saved.asset_id, "existing-search"); assert.equal(saved.description, ""); assert.equal(saved.source, "search");
});

test("文件保存失败可重新上传，格式、大小及描述解析保持严格校验", async () => {
  let commits = 0;
  const service = createPageImageUploadService({ workspaceDir: "/workspace",
    upload: { uploadFile: async () => ({ transport: "host_upload", r2_key: "red", url: "https://test/red.png", mime_type: "image/png", size_bytes: 5 }) },
    backend: { pageImageUpload: async () => { if (++commits === 1) throw new Error("save failed"); return { images: [image] }; } } as unknown as PptBackend,
  });
  const file = new File(["image"], "red.png");
  await assert.rejects(service.upload(file), /save failed/);
  assert.equal((await service.upload(file)).asset_id, image.asset_id);
  for (const value of [null, {}, { description: " " }, { description: "x".repeat(401) }, { error: "IMAGE_NOT_AVAILABLE", description: "guess" }]) assert.throws(() => parsePageImageDescription(value));
  assert.throws(() => parsePageImageDescriptions({ descriptions: [{ attachment_index: 2, description: "x" }] }, 1));
  assert.throws(() => validatePageImageFile({ name: "fake.svg", size: 10 }), /INVALID_FILE/);
  assert.throws(() => validatePageImageFile({ name: "huge.png", size: 26 * 1024 * 1024 }), /TOO_LARGE/);
  assert.equal(validatePageImageFile({ name: "photo.JPG", size: 10 }), "image/jpeg");
});
