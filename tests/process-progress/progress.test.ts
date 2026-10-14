import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { attachmentPreparationInsight, attachmentPreparationLabel } from "../../src/features/requirements/attachmentPreparationProgress";
import type { AttachmentPreparationState } from "../../src/features/deck-workspace/types";
import { ProcessEmpty, ProcessPanel, ReportText, LiveText } from "../../src/features/process-progress/ProcessProgress";
import { safeExternalUrl, streamedResearchReport } from "../../src/features/process-progress/model";
import { researchProgressForPersistence } from "../../src/api/researchProgress";
import { formatMessage, messages } from "../../src/i18n/messages";
import type { ResearchDiscoveryProgress, ResearchDiscoveryProgressPhaseRecord } from "../../src/api/types";
import type { DeckGenerationProgress } from "../../src/features/deck-generation";
import { ResearchDetails } from "../../src/features/process-progress/ResearchDetails";
import { buildResearchDiscoveryStageRecords } from "../../src/features/deck-workspace/researchDiscoveryStageRecords";
import { ResearchDiscoveryStageGroupView } from "../../src/features/deck-workspace/components/ResearchDiscoveryStageView";

it("renders untrusted report text without executing HTML or unsafe links", () => {
  const html = renderToStaticMarkup(createElement(ReportText, {
    text: '# Report\n\n<script>alert(1)</script>\n\n[Source](https://example.com/report)\n\n[Unsafe](javascript:alert(1))',
  }));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /href="https:\/\/example.com\/report" target="_blank" rel="noopener noreferrer"/);
  assert.ok(!html.includes('href="javascript:'));
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/a', 'https://user:password@example.com']) assert.equal(safeExternalUrl(url), undefined);
});

it("recognizes a streamed finish header without exposing control data in the report", () => {
  assert.equal(streamedResearchReport('{"action":"fin'), undefined);
  assert.equal(streamedResearchReport('{"action":"search","queries":["market"]}'), undefined);
  assert.equal(streamedResearchReport('```json\n{"action":"finish"}\n```\n# Report\n\n  exact spacing'), '# Report\n\n  exact spacing');
});

it("keeps large view-only material and temporary image URLs out of saved progress", () => {
  const progress: ResearchDiscoveryProgress = {
    status: 'running', summary: { facts: 0, derivedInsights: 0, visualAssets: 1, gaps: 0, rejectedMaterial: 0 },
    records: [{ phase: 'web-collection', state: 'running', report: 'report-body', fetchedPages: [{ url: 'https://example.com', ok: true, content: 'fetched-body' }],
      liveRounds: [{ id: '1', text: 'stream-body', state: 'running', startedAt: 1 }],
      queries: [{ kind: 'visual', query: 'city transit', status: 'collected', resultCount: 1,
        sources: [{ title: 'Source', url: 'https://example.com', snippet: 'snippet-body' }],
        images: [{ id: '1', imageUrl: 'https://files.example.com/a?signature=temporary' }],
      }],
    }],
  };
  const saved = JSON.stringify(researchProgressForPersistence(progress));
  for (const detail of ['report-body', 'fetched-body', 'stream-body', 'snippet-body', 'signature=temporary']) assert.ok(!saved.includes(detail));
  assert.ok(saved.includes('city transit'));
  assert.ok(saved.includes('https://example.com'));
  assert.equal(progress.records[0].queries?.[0].images?.length, 1, 'sanitization cannot mutate the live view');
});

it("uses bilingual step labels and keeps the full original text only inside the active disclosure", () => {
  for (const locale of ['zh', 'en'] as const) {
    const t = messages[locale];
    const html = renderToStaticMarkup(createElement(ProcessPanel, { t, steps: [
      { id: 'language', label: t.processProgress.language, state: 'completed', summary: '简体中文', fields: [{ label: 'Language', value: '简体中文' }] },
      { id: 'outline', label: t.processProgress.generating, state: 'running', text: '{\n  "title": "draft"' },
    ] }));
    assert.ok(html.includes(t.processProgress.generating));
    assert.ok(html.includes(t.processProgress.pendingValidation));
    assert.ok(html.includes('{\n  &quot;title&quot;: &quot;draft&quot;'));
    assert.match(html, /is-completed[\s\S]*?aria-expanded="false"/);
    assert.match(html, /is-running[\s\S]*?aria-expanded="true"/);
  }
});

it("shows research actions and the live report without rounds or diagnostic failures in both languages", () => {
  for (const locale of ['zh', 'en'] as const) {
    const t = messages[locale];
    const record: ResearchDiscoveryProgressPhaseRecord = {
      phase: 'web-collection', state: 'running',
      rationale: 'INTERNAL_RATIONALE', gaps: ['INTERNAL_GAP'], lines: ['LEGACY_RAW_OUTPUT'],
      queries: [{ kind: 'web', query: 'market trends', status: 'error', message: 'SEARCH_ERROR',
        sources: [{ title: 'Official report', url: 'https://example.com', snippet: 'Public source summary' }] }],
      fetchedPages: [
        { url: 'https://example.com/report', title: 'Official report', ok: true, content: '<script>UNTRUSTED_PAGE</script>', truncated: true },
        { url: 'https://example.com/missing', ok: false, error: 'FETCH_ERROR' },
      ],
      liveRounds: [
        { id: '1', state: 'completed', text: 'INTERNAL_MODEL_OUTPUT', startedAt: 1 },
        { id: '2', state: 'running', text: '{"action":"finish"}\n# Market research\n\nStreaming report body', startedAt: 2 },
      ],
    };
    const html = renderToStaticMarkup(createElement(ResearchDetails, { t, record }));
    for (const hidden of ['INTERNAL_RATIONALE', 'INTERNAL_GAP', 'LEGACY_RAW_OUTPUT', 'SEARCH_ERROR', 'FETCH_ERROR', 'INTERNAL_MODEL_OUTPUT', '&quot;action&quot;', t.processProgress.rounds, t.processProgress.pendingValidation]) {
      assert.ok(!html.includes(hidden), `${locale}: ${hidden} must not leak into research UI`);
    }
    assert.ok(html.includes(formatMessage(t.processProgress.searchQuery, { query: 'market trends' })));
    assert.ok(html.includes(formatMessage(t.processProgress.fetchPage, { page: 'Official report' })));
    assert.ok(html.includes('&lt;script&gt;UNTRUSTED_PAGE&lt;/script&gt;'));
    assert.ok(html.includes('href="https://example.com/"'));
    assert.ok(html.includes(t.processProgress.truncated));
    assert.ok(html.includes('Streaming report body'));
    assert.ok(html.includes(t.processProgress.reportWriting));
    assert.ok(html.indexOf('Streaming report body') > html.lastIndexOf('</details>'), 'report stays outside action disclosures at the bottom');
    assert.ok(!html.includes('class="process-research-activity" open='), 'actions start collapsed');

    const completed = renderToStaticMarkup(createElement(ResearchDetails, { t, record: { ...record, state: 'completed', report: '# Saved report\n\nFinal research' } }));
    assert.ok(completed.includes('Final research'));
    assert.ok(!completed.includes('Streaming report body'));
    assert.ok(!completed.includes(t.processProgress.reportWriting));
  }
});

it("renders image-only search results, leaving descriptions and issues for the preview dialog", () => {
  for (const locale of ['zh', 'en'] as const) {
    const t = messages[locale];
    const html = renderToStaticMarkup(createElement(ResearchDetails, { t, record: {
      phase: 'visual-collection', state: 'running',
      queries: [{ kind: 'visual', query: 'tennis stadium', status: 'collected', resultCount: 2, images: [
        { id: 'ready', title: 'Stadium at night', imageUrl: 'https://example.com/image.jpg', state: 'available', visualSummary: 'PRIVATE_DESCRIPTION', reason: 'PRIVATE_SELECTION_REASON' },
        { id: 'missing', state: 'unavailable', reason: 'PRIVATE_IMAGE_FAILURE' },
      ] }],
      liveRounds: [{ id: '1', state: 'running', startedAt: 1, text: 'PRIVATE_IMAGE_MODEL_OUTPUT' }],
    } }));
    assert.ok(html.includes('src="https://example.com/image.jpg"'));
    assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 2, 'even a missing preview can open its details');
    for (const hidden of ['PRIVATE_DESCRIPTION', 'PRIVATE_SELECTION_REASON', 'PRIVATE_IMAGE_FAILURE', 'PRIVATE_IMAGE_MODEL_OUTPUT', t.processProgress.available, t.processProgress.unavailable, t.processProgress.expand]) assert.ok(!html.includes(hidden));
    assert.ok(!html.includes('disabled=""'));
  }
});

it("projects research warnings as completed while preserving diagnostic data and actual failures", () => {
  const progress: DeckGenerationProgress = {
    step: 'prepare', message: 'Researching', currentPageIndex: null, totalPages: 1, pages: [],
    researchDiscovery: { status: 'warning', summary: { facts: 0, derivedInsights: 0, visualAssets: 0, gaps: 1, rejectedMaterial: 0 },
      records: [{ phase: 'web-collection', state: 'warning', gaps: ['PRIVATE_GAP'] }],
    },
  };
  for (const locale of ['zh', 'en'] as const) {
    const t = messages[locale];
    const group = buildResearchDiscoveryStageRecords({ t, progress })!;
    const render = () => renderToStaticMarkup(createElement(ResearchDiscoveryStageGroupView, {
      t, group, disclosure: { isOpen: () => true, toggle: () => undefined },
    }));
    const html = render();
    assert.ok(html.includes('process-step is-completed'));
    assert.ok(html.includes(t.processProgress.completed));
    assert.ok(!html.includes(t.processProgress.warning));
    assert.ok(!html.includes('PRIVATE_GAP'));
    assert.equal(group.records[0].detail?.state, 'warning');
    assert.deepEqual(group.records[0].detail?.gaps, ['PRIVATE_GAP']);
    group.records[0].state = 'failed';
    assert.ok(render().includes('process-step is-failed'), 'blocking failures must remain visible');
  }
});

it("uses waiting copy only for running steps, including empty live output", () => {
  for (const locale of ["zh", "en"] as const) {
    const t = messages[locale];
    for (const state of ["running", "waiting", "completed", "failed", "warning", "skipped"] as const) {
      const html = renderToStaticMarkup(createElement(ProcessEmpty, { t, state }));
      assert.equal(html.includes(t.processProgress.waitingOutput), state === "running", `${locale}: ${state}`);
      if (state === "completed") assert.equal(html, "");
      else if (state !== "running") assert.ok(html.includes(t.processProgress[state]));
    }
    const done = renderToStaticMarkup(createElement(LiveText, { t, text: "", running: false }));
    assert.ok(!done.includes(t.processProgress.waitingOutput));
    const running = renderToStaticMarkup(createElement(LiveText, { t, text: "", running: true }));
    assert.ok(running.includes(t.processProgress.waitingOutput));
  }
});

it("keeps attachment names separate from their statuses and does not duplicate summaries", () => {
  const t = messages.zh;
  const name = "Northstar_Adventure_Park_Operating_Data_EN.xlsx";
  const html = renderToStaticMarkup(createElement(ProcessPanel, { t, steps: [{
    id: "attachments", label: t.processProgress.attachments, state: "running", summary: "OCR 2 / 10",
    files: [{ name, state: "running" }, { name: "i2.PNG", state: "completed" }],
  }] }));
  assert.ok(html.includes(`class="process-file-name">${name}</span>`));
  assert.ok(html.includes(`class="process-file-state">${t.processProgress.completed}</span>`));
  assert.equal(html.split("OCR 2 / 10").length - 1, 1);
  assert.ok(!html.includes('class="process-fields"'));
});

it("retains OCR and batch progress without leaking stale OCR into later stages", () => {
  for (const locale of ["zh", "en"] as const) {
    const t = messages[locale];
    const state: AttachmentPreparationState = { phase: "preflight", filename: "scan.pdf", sourceIndex: 1, sourceCount: 1,
      insight: "Reading", ocrProgress: { processed: 2, total: 10, currentPage: 3 } };
    const ocr = attachmentPreparationInsight(t, state);
    for (const number of ["2", "10", "3"]) assert.ok(ocr.includes(number));
    assert.equal(attachmentPreparationInsight(t, { ...state, phase: "analyzing", insight: "Summary" }), "Summary");
    const batch = attachmentPreparationLabel(t, { ...state, phase: "analyzing", chunkIndex: 2, chunkCount: 4 });
    assert.ok(batch.includes("2"));
    assert.ok(batch.includes("4"));
  }
});
