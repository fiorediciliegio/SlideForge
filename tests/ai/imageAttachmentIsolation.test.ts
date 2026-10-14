import assert from "node:assert/strict";
import test from "node:test";
import type { AttachmentBrief, AttachmentContext, UploadedSourceMaterial, WorkspaceResult } from "../../src/api/types";
import type { PptBackend } from "../../src/api/pptBackend";
import type { AnnaRuntime } from "../../src/runtime/annaRuntime";
import { buildPresentationRequirementsRequest } from "../../src/ai/requirementsPrompt";
import { formatAttachmentSourcesForPrompt } from "../../src/ai/attachmentSourceText";
import { formatUserProvidedAttachmentContextForPrompt } from "../../src/ai/attachmentContextPrompt";
import { ensureAttachmentBriefs } from "../../src/features/deck-generation/attachmentBriefWorkflow";
import { createImageAttachmentBriefClient } from "../../src/ai/imageAttachmentBriefTest";

const imageBrief = {
  version: 1, source_id: "image-source", filename: "avatar.png", content_strategy: "full_context",
  original_reading_method: "image_multimodal_read", use_in_ppt: true, image_usage_reason: "用户提供的头像",
  content: "IMAGE_FACT_MUST_NOT_LEAK", main_message: "IMAGE_SUMMARY_MUST_NOT_LEAK",
  key_facts: [], must_include: [], must_avoid: [], recommended_storyline: [], gaps: [], unread_content: [], updated_at: "2026-09-12",
} satisfies AttachmentBrief;
const documentBrief: AttachmentBrief = { ...imageBrief, source_id: "doc-source", filename: "report.txt", original_reading_method: "document_read", main_message: "文档摘要", content: "DOCUMENT_FACT_MUST_REMAIN" };
function context(briefs: AttachmentBrief[]): AttachmentContext {
  return { version: 1, user_brief: "演示需求", attachment_context: briefs, updated_at: "2026-09-12" };
}

test("混合附件的已分析图片和文档资料均可进入需求和大纲", () => {
  const mixed = context([imageBrief, documentBrief]);
  const prompts = [
    JSON.stringify(buildPresentationRequirementsRequest("演示需求", "中文", mixed)),
    formatAttachmentSourcesForPrompt(mixed),
    formatUserProvidedAttachmentContextForPrompt(mixed, "zh"),
    formatUserProvidedAttachmentContextForPrompt(mixed, "en"),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /DOCUMENT_FACT_MUST_REMAIN/);
    assert.match(prompt, /IMAGE_FACT_MUST_NOT_LEAK/);
  }
  assert.notDeepEqual(
    buildPresentationRequirementsRequest("演示需求", "中文", context([imageBrief])),
    buildPresentationRequirementsRequest("演示需求", "中文", null),
  );
  assert.equal(mixed.attachment_context.length, 2, "过滤不能改写已保存的原始摘要");
});

test("纯图片附件生成描述，只有 use_in_ppt 图片进入素材目录", async () => {
  for (const useInPpt of [true, false]) {
    let imports = 0;
    const source = { uploaded_source_id: "image-source", original_filename: "avatar.png", extension: ".png", mime_type: "image/png" } as UploadedSourceMaterial;
    const backend = {
      listUploadedSources: async () => ({ active: [source] }),
      uploadUploadedSourceForAgent: async () => ({ host_upload: { url: "https://example.test/avatar.png", mime_type: "image/png" } }),
      copyUploadedSourceImageToAsset: async () => { imports++; },
      recordAttachmentBrief: async ({ brief }: any) => brief,
      writeAttachmentContext: async () => undefined,
      appendWorkspaceLog: async () => undefined,
    } as unknown as PptBackend;
    const briefs = await ensureAttachmentBriefs({
      backend, workspace: { workspace_dir: "/test" } as WorkspaceResult, userBrief: "需求",
      completionClient: { complete: async () => { throw new Error("文档模型不应被调用"); } },
      imageBriefClient: { complete: async () => ({ brief: { ...imageBrief, use_in_ppt: useInPpt }, actual_model: "test" }) } as any,
    });
    assert.equal(briefs[0]?.use_in_ppt, useInPpt);
    assert.equal(imports, useInPpt ? 1 : 0);
  }
});

test("独立图片分析支持无文字图片，并沿用同会话格式修复", async () => {
  let sessions = 0;
  let runs = 0;
  let closed = 0;
  const runtime = { agent: { session: async () => {
    sessions++;
    return {
      run: async function* (input: { content: string; attachments: unknown[] }) {
        assert.equal(input.attachments.length, 1);
        runs++;
        yield { text: runs === 1 ? "invalid JSON" : JSON.stringify({ ...imageBrief, content: "", key_facts: [] }) };
      },
      delete: async () => { closed++; },
    };
  } } } as unknown as AnnaRuntime;
  const result = await createImageAttachmentBriefClient(runtime).complete({
    filename: "avatar.png", userBrief: "使用原图",
    attachment: { type: "image/png", url: "https://example.test/avatar.png", filename: "avatar.png" },
  });
  assert.equal(result.brief.content, "");
  assert.equal(sessions, 1);
  assert.equal(runs, 2);
  assert.equal(closed, 1);
});
