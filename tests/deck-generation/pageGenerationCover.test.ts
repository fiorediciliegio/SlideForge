import assert from "node:assert/strict";
import test from "node:test";
import { authoringDeckFromConfirmedOutline } from "../../src/features/deck-generation/deckGenerationStartArtifacts.ts";
import { runPageGeneration } from "../../src/features/deck-generation/pageGenerationRunner.ts";
import { createHarness } from "./helpers/htmlWorkflowHarness.ts";

for (const refinement of [false, true]) {
  test(`封面${refinement ? "精修" : "生成"}不读取母版，普通页仍读取并传入母版`, async () => {
    const harness = createHarness();
    const deck = authoringDeckFromConfirmedOutline(harness.input.confirmedOutline);
    const [cover, standard] = deck.pages;
    let masterReads = 0;
    harness.runtime.backend.getWorkspaceVisualMasterHtml = async () => {
      masterReads += 1;
      throw new Error("封面不应读取母版");
    };
    if (refinement) {
      harness.runtime.pageRefinementReasons = { [cover!.page_id]: "放大封面标题" };
      harness.runtime.pageRefinementHtmlContexts = {
        [cover!.page_id]: { html: "<html><body>原有封面</body></html>" },
      };
    }
    const result = await runPageGeneration(harness.runtime, deck, cover!);
    assert.equal(result.reason, "accepted");
    assert.equal(masterReads, 0);
    assert.deepEqual(harness.committedPageIds, [cover!.page_id]);
    const prompt = harness.requests[0]!.prompt;
    assert.match(prompt, /Reference aesthetics/);
    if (refinement) {
      assert.match(prompt, /放大封面标题/);
      assert.match(prompt, /原有封面/);
    }

    harness.runtime.backend.getWorkspaceVisualMasterHtml = async () => {
      masterReads += 1;
      return { content: "<html><body>STANDARD_MASTER</body></html>" } as never;
    };
    const standardResult = await runPageGeneration(harness.runtime, deck, standard!);
    assert.equal(standardResult.reason, "accepted");
    assert.equal(masterReads, 1);
    assert.match(harness.requests[1]!.prompt, /STANDARD_MASTER/);
  });
}
