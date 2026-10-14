import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { messages } from "../../src/i18n/messages.ts";
import {
  adjacentEnabledStage,
  ProgressLine,
  shouldShowProgressLine,
} from "../../src/features/deck-workspace/components/ProgressLine.tsx";
import { stageOrder } from "../../src/features/deck-workspace/utils.ts";

describe("ProgressLine", () => {
  it("hides the rail on a fresh Brief page", () => {
    assert.equal(shouldShowProgressLine({
      page: "main",
      stage: "brief",
      requirementsStatus: "empty",
      hasGenerationProgress: false,
      hasGeneratedDeck: false,
      pageProgressCount: 0,
    }), false);
  });

  it("keeps the rail when Brief is revisited after downstream state exists", () => {
    assert.equal(shouldShowProgressLine({
      page: "main",
      stage: "brief",
      requirementsStatus: "draft",
      hasGenerationProgress: false,
      hasGeneratedDeck: false,
      pageProgressCount: 0,
    }), true);
  });

  it("shows the rail for every other main workflow stage only", () => {
    assert.equal(shouldShowProgressLine({
      page: "main",
      stage: "requirements",
      requirementsStatus: "empty",
      hasGenerationProgress: false,
      hasGeneratedDeck: false,
      pageProgressCount: 0,
    }), true);
    assert.equal(shouldShowProgressLine({
      page: "settings",
      stage: "requirements",
      requirementsStatus: "draft",
      hasGenerationProgress: true,
      hasGeneratedDeck: true,
      pageProgressCount: 1,
    }), false);
  });

  it("orders Web research between requirements and outline", () => {
    assert.equal(stageOrder("brief"), 1);
    assert.equal(stageOrder("requirements"), 2);
    assert.equal(stageOrder("web-research"), 2.5);
    assert.equal(stageOrder("outline"), 3);
    assert.equal(stageOrder("generating"), 4);
    assert.equal(stageOrder("deck"), 5);
  });

  it("renders the six active main stages", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressLine, {
        stage: "outline",
        t: messages.zh,
        requirementsEnabled: true,
        webResearchEnabled: true,
        outlineEnabled: true,
        generatingEnabled: false,
        generationInFlight: false,
        deckEnabled: false,
        onNavigate: () => undefined,
      }),
    );

    assert.match(html, />创建</);
    assert.match(html, />需求</);
    assert.match(html, />研究</);
    assert.doesNotMatch(html, /title="上传资料分析"/);
    assert.match(html, />大纲</);
    assert.match(html, />生成</);
    assert.match(html, />结果</);
    assert.equal((html.match(/class="progress-node /g) ?? []).length, 6);
    assert.doesNotMatch(html, /title=/);
  });

  it("disables inaccessible stages without exposing a disabled reason", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressLine, {
        stage: "requirements",
        t: messages.zh,
        requirementsEnabled: true,
        webResearchEnabled: true,
        outlineEnabled: false,
        generatingEnabled: false,
        generationInFlight: false,
        deckEnabled: false,
        onNavigate: () => undefined,
      }),
    );

    assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
    assert.doesNotMatch(html, /演示需求已修改，请先重新确认演示需求/);
    assert.doesNotMatch(html, /title=/);
  });

  it("disables the complete stage rail while a deck is generating", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressLine, {
        stage: "generating",
        t: messages.zh,
        requirementsEnabled: true,
        webResearchEnabled: true,
        outlineEnabled: true,
        generatingEnabled: true,
        generationInFlight: true,
        deckEnabled: false,
        onNavigate: () => undefined,
      }),
    );

    assert.equal((html.match(/disabled=""/g) ?? []).length, 6);
  });

  it("keeps a completed generation view navigable", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressLine, {
        stage: "generating",
        t: messages.zh,
        requirementsEnabled: true,
        webResearchEnabled: true,
        outlineEnabled: true,
        generatingEnabled: true,
        generationInFlight: false,
        deckEnabled: true,
        onNavigate: () => undefined,
      }),
    );

    assert.equal((html.match(/disabled=""/g) ?? []).length, 0);
  });

  it("moves only to the nearest existing stage and skips unavailable stages", () => {
    const enabled = {
      brief: true,
      requirements: true,
      "web-research": true,
      outline: false,
      generating: true,
      deck: true,
    };

    assert.equal(adjacentEnabledStage("requirements", enabled, 1), "web-research");
    assert.equal(adjacentEnabledStage("generating", enabled, -1), "web-research");
    assert.equal(adjacentEnabledStage("brief", enabled, -1), null);
    assert.equal(adjacentEnabledStage("deck", enabled, 1), null);
  });
});
