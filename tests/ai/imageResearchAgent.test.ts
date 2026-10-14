import { confirmedRequirements } from "../fixtures/imageRequirements";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildImageResearchAgentInitialPrompt,
  buildImageResearchAgentResultPrompt,
  parseImageResearchAgentAction,
} from "../../src/ai/imageResearchAgent.ts";

const selectedCandidate = {
  candidate_id: "image-selected",
  query: "charging station",
  image_url: "https://images.test/selected.jpg",
  source_url: "https://source.test/selected",
  use_in_ppt: true,
  description: "An electric vehicle at a public charging station.",
  reason: "Supports the charging infrastructure section.",
  analysis_status: "completed" as const,
  import_status: "pending" as const,
};

describe("Image research Agent protocol", () => {
  it("parses a search action with stable candidate ids and attachment indexes", () => {
    const action = parseImageResearchAgentAction(JSON.stringify({
      action: "search",
      query: "electric vehicle charging station",
      decisions: [{
        candidate_id: "image-a91f20c4",
        attachment_index: 1,
        use_in_ppt: true,
        description: "An electric vehicle beside a charging station",
        reason: "Directly supports the infrastructure topic",
      }],
      summary: "",
    }));
    assert.equal(action.action, "search");
    assert.equal(action.query, "electric vehicle charging station");
    assert.equal(action.decisions[0]?.candidate_id, "image-a91f20c4");
    assert.equal(action.decisions[0]?.attachment_index, 1);
  });

  it("requires finish actions to carry a non-empty summary and null query", () => {
    const action = parseImageResearchAgentAction(JSON.stringify({
      action: "finish",
      query: null,
      decisions: [],
      summary: "Enough usable images have been collected.",
    }));
    assert.equal(action.action, "finish");
    assert.equal(action.query, null);
  });

  it("allows decisions to contain only the selected subset", () => {
    const action = parseImageResearchAgentAction(JSON.stringify({
      action: "search",
      query: "industrial automation factory workers",
      decisions: [],
      summary: "",
    }));
    assert.deepEqual(action.decisions, []);
  });

  it("省略 decisions 时将搜索和结束动作归一为没有图片入选", () => {
    for (const input of [
      { action: "search", query: "HBO Harry Potter teaser trailer bridge wizard wand Whomping Willow lit scene screenshot", summary: "" },
      { action: "finish", query: null, summary: "未找到合适图片。" },
    ]) {
      assert.deepEqual(parseImageResearchAgentAction(JSON.stringify(input)), { ...input, decisions: [] });
    }
  });

  it("显式提供的 decisions 类型错误或条目非法时仍拒绝", () => {
    for (const decisions of [null, "", {}, false, 0]) {
      assert.throws(() => parseImageResearchAgentAction(JSON.stringify({
        action: "search", query: "bridge", summary: "", decisions,
      })), /decisions 必须是数组/);
    }
    for (const decisions of [[null], [{}]]) {
      assert.throws(() => parseImageResearchAgentAction(JSON.stringify({
        action: "search", query: "bridge", summary: "", decisions,
      })), /decisions\[0\] 必须是对象|字段必须且只能是/);
    }
  });

  it("仅允许省略 decisions，其他必填字段仍须提供", () => {
    for (const field of ["action", "query", "summary"]) {
      const input: Record<string, unknown> = { action: "search", query: "bridge", summary: "" };
      delete input[field];
      assert.throws(() => parseImageResearchAgentAction(JSON.stringify(input)), /字段必须且只能是/);
    }
  });

  it("rejects the removed gaps field", () => {
    assert.throws(() => parseImageResearchAgentAction(JSON.stringify({
      action: "search",
      query: "industrial automation factory workers",
      decisions: [],
      summary: "",
      gaps: [],
    })), /字段必须且只能是/);
  });

  it("rejects a decision that marks an attachment as not selected", () => {
    assert.throws(() => parseImageResearchAgentAction(JSON.stringify({
      action: "finish",
      query: null,
      decisions: [{
        candidate_id: "image-a91f20c4",
        attachment_index: 1,
        use_in_ppt: false,
        description: "A blurry office scene",
        reason: "Not suitable",
      }],
      summary: "Enough images have been collected.",
    })), /use_in_ppt 必须为 true/);
  });

  it("places current attachment mapping in the result prompt", () => {
    const prompt = buildImageResearchAgentResultPrompt({
      query: "charging station",
      candidates: [{
        candidate_id: "image-a91f20c4",
        title: "2025年美网女单决赛前瞻",
        query: "charging station",
        image_url: "https://images.test/a.jpg",
        source_url: "https://source.test/a",
        use_in_ppt: false,
        description: "Not returned by image analysis.",
        reason: "Not returned by image analysis; defaulted to use_in_ppt: false.",
        analysis_status: "pending",
        import_status: "pending",
      }],
    });
    assert.match(prompt, /图片搜索 query“charging station”已完成/);
    assert.match(prompt, /"attachment_index": 1/);
    assert.match(prompt, /2025年美网女单决赛前瞻/);
    assert.match(prompt, /"candidate_id": "image-a91f20c4"/);
    assert.doesNotMatch(prompt, /"query"/);
    assert.doesNotMatch(prompt, /"matched_queries"/);
    assert.doesNotMatch(prompt, /"source_url"/);
    assert.doesNotMatch(prompt, /https:\/\/source\.test\/a/);
    assert.doesNotMatch(prompt, /已选图片摘要/);
  });

  it("does not repeat selected history in a normal initial prompt", () => {
    const prompt = buildImageResearchAgentInitialPrompt({
      requirements: confirmedRequirements(),
      brief: "EV infrastructure",
      imageCatalog: { schema_version: 2, assets: [] },
    });
    assert.doesNotMatch(prompt, /已选图片摘要/);
    assert.match(prompt, /EV infrastructure/);
    assert.match(prompt, /目标页数/);
    assert.doesNotMatch(prompt, /目标受众：|演示用途：|预期效果：|视觉气质：/);
    assert.doesNotMatch(prompt, /完整大纲：|Web 研究资料/);
    assert.doesNotMatch(prompt, /Create a presentation/);
  });

  it("includes selected history once when restoring a new session", () => {
    const prompt = buildImageResearchAgentResultPrompt({
      query: "charging station",
      candidates: [],
      selectedHistory: [selectedCandidate],
    });
    assert.match(prompt, /恢复前已选图片摘要/);
    assert.match(prompt, /"candidate_id": "image-selected"/);
  });
});
