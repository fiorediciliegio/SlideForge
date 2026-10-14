import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { deckResultHarness, deferred } from "../helpers/deckResults";
import { assembleReviewRender } from "../../src/features/deck-workspace/reviewRenderAssembly";

describe("generation completion navigation", () => {
  it("activates the completed Deck from the committed Workspace before optional preview assembly", async () => {
    const h = deckResultHarness();
    const pending = deferred<Awaited<ReturnType<typeof assembleReviewRender>>>();
    h.deps.assemble = async () => pending.promise;
    h.state.stage = "generating";
    const completion = h.workflow.applyDeckGenerationCompletion({
      status: "completed", result: { rendered: h.fixture.metadata, outline: h.fixture.outline, progress: h.fixture.nextProgress },
    }, h.fixture.nextWorkspace);
    assert.equal(h.state.stage, "deck");
    assert.equal(h.state.page, "main");
    assert.equal(h.state.currentSlide, 0, "首次整稿生成保持从第一页开始");
    assert.equal(h.state.reviewRender.status, "ready");
    assert.equal(h.state.deck[8].title, "第 9 页标题");
    assert.deepEqual(h.state.outline, h.state.outlineDraft, "发布不能让大纲产生未保存差异");
    assert.deepEqual(h.calls, [], "已提交结果不再重复读取工作区");
    pending.resolve(await assembleReviewRender({ backend: {} as any, workspaceDir: h.fixture.workspace.workspace_dir, metadata: h.state.reviewRender.result }));
    await completion;
  });

  it("returns to the Outline after the committed image-research-only run", async () => {
    const source = await readFile(
      path.resolve("src/features/deck-workspace/hooks/useDeckWorkspace.ts"),
      "utf8",
    );
    const start = source.indexOf("async function applyDeckGenerationCompletion");
    const end = source.indexOf("async function createOutlineFromConfirmedRequirements", start);
    const completionSource = source.slice(start, end);

    assert.match(
      completionSource,
      /completion\.status === "research-completed"[\s\S]*?applyWorkspace\(workspace\);[\s\S]*?setStage\("outline"\);[\s\S]*?showToast\(t\.generating\.imageResearchTestStopped\);/,
    );
  });
});
