import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPresentationRequirementsRepairRequest,
  buildPresentationRequirementsRequest,
} from "../../src/ai/requirementsPrompt";
import type { AttachmentContext } from "../../src/api/types";

function readText(message: { content: { type: string; text: string } }) {
  return message.content.text;
}

test("uses separate system and user prompts and only places the Brief in user content", () => {
  const brief = "Create a five-slide Chinese launch presentation.";
  const request = buildPresentationRequirementsRequest(brief, "English");
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0].role, "system");
  assert.match(readText(request.messages[0]), /senior presentation strategist/);
  assert.match(
    readText(request.messages[0]),
    /authoritative output language is English/,
  );
  assert.match(
    readText(request.messages[0]),
    /authoritative output language is English/,
  );
  assert.match(
    readText(request.messages[0]),
    /Do not return an output_language field/,
  );
  assert.doesNotMatch(readText(request.messages[0]), /"output_language": \["Chinese"\]/);
  assert.doesNotMatch(readText(request.messages[0]), new RegExp(brief));
  assert.equal(request.messages[1].role, "user");
  assert.match(readText(request.messages[1]), /<brief>/);
  assert.match(readText(request.messages[1]), new RegExp(brief));
});

test("repair request preserves the full conversation and requests only slide count", () => {
  const initial = buildPresentationRequirementsRequest("A brief", "English");
  const repaired = buildPresentationRequirementsRepairRequest(
    initial,
    '{"slide_count":["auto"]}',
    ["slide_count[0] must be a positive integer."],
    "English",
  );
  assert.equal(repaired.messages.length, 4);
  assert.deepEqual(repaired.messages.slice(0, 2), initial.messages);
  assert.equal(repaired.messages[2].role, "assistant");
  assert.match(readText(repaired.messages[3]), /containing only slide_count/);
  assert.doesNotMatch(readText(repaired.messages[3]), /audience|purpose|desired_outcome|visual_tone/);
  assert.match(readText(repaired.messages[3]), /slide_count\[0\]/);
  assert.doesNotMatch(readText(repaired.messages[3]), /output_language.*candidate/);
});

test("generates page-count candidates without inferred content goals", () => {
  const request = buildPresentationRequirementsRequest("A brief", "English");
  const prompt = request.messages.map(readText).join("\n");
  assert.match(prompt, /"slide_count": \[8\]/);
  assert.doesNotMatch(prompt, /audience|purpose|desired_outcome|visual_tone|Visual Tone/);
});

test("injects only the attachment_context array without duplicating user_brief", () => {
  const brief = "Create a launch presentation.";
  const attachmentContext: AttachmentContext = {
    version: 1,
    user_brief: "stale persisted brief",
    attachment_context: [{
      version: 1,
      source_id: "source-1",
      filename: "source.md",
      content_strategy: "summarized_context",
      original_reading_method: "document_retrieval",
      main_message: "核心信息",
      key_facts: [{ evidence_id: "evidence-1", fact: "事实", source_label: "段落 1", excerpt: "原文" }],
      must_include: [{ requirement: "必须包含", evidence_ids: ["evidence-1"] }],
      must_avoid: [],
      recommended_storyline: ["推荐叙事"],
      gaps: [],
      unread_content: ["未读取部分"],
      updated_at: "2026-09-04T00:00:00.000Z",
    }],
    updated_at: "2026-09-04T00:00:00.000Z",
  };
  const prompt = readText(buildPresentationRequirementsRequest(
    brief,
    "English",
    attachmentContext,
  ).messages[1]);
  assert.match(prompt, /## User Attachments/);
  assert.match(prompt, /The following JSON is user-provided reference material/);
  assert.match(prompt, /"source_id": "source-1"/);
  assert.match(prompt, /"recommended_storyline": \[/);
  assert.match(prompt, /<brief>[\s\S]*Create a launch presentation/);
  assert.doesNotMatch(prompt, /stale persisted brief/);
  assert.doesNotMatch(prompt, /<attachment_context>/);
});

test("omits the attachment section when there are no attachments", () => {
  const prompt = readText(buildPresentationRequirementsRequest("A brief", "English").messages[1]);
  assert.doesNotMatch(prompt, /User Attachments|用户附件内容/);
});
