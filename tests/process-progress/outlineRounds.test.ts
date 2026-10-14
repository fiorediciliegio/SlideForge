import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useProcessProgress } from "../../src/features/process-progress/useProcessProgress";
import { ProcessPanel } from "../../src/features/process-progress/ProcessProgress";
import { messages } from "../../src/i18n/messages";

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: rounds retain text, disclosure choices and elapsed time across retries`, async () => {
    const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    const t = messages[locale];
    let progress!: ReturnType<typeof useProcessProgress>;
    function Harness() {
      progress = useProcessProgress();
      return createElement(ProcessPanel, { t, steps: progress.steps });
    }
    let run!: ReturnType<typeof progress.start>;
    const definitions = [{ id: "outline", label: t.processProgress.generating }];
    const headings = () => host.querySelectorAll<HTMLButtonElement>(".process-original-heading");
    const step = () => progress.steps[0]!;
    const originalNow = Date.now;
    let now = 100_000;
    Date.now = () => now;
    try {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => {
        run = progress.start(definitions);
        run.begin("outline");
        run.beginRound("outline", { session: 1, stage: "header", correction: 0 });
        run.stream("outline")({ type: "content", text: '{"title":"Deck","total_pages":40}' });
      });
      assert.equal(host.querySelector("time")?.textContent, "0:00");
      assert.equal(headings()[0]!.getAttribute("aria-expanded"), "true");
      await act(async () => headings()[0]!.click());
      await act(async () => run.stream("outline")({ type: "content", text: "\n" }));
      await act(async () => host.querySelector<HTMLButtonElement>(".process-step-heading")!.click());
      await act(async () => host.querySelector<HTMLButtonElement>(".process-step-heading")!.click());
      assert.equal(headings()[0]!.getAttribute("aria-expanded"), "false");
      await act(async () => {
        run.endRound("outline", { status: "success" });
        run.beginRound("outline", { session: 1, stage: "items", correction: 0, pageRange: { start: 1, end: 20 } });
        run.stream("outline")({ type: "content", text: "pages-1-20" });
        run.endRound("outline", { status: "success" });
        run.beginRound("outline", { session: 1, stage: "items", correction: 0, pageRange: { start: 21, end: 40 } });
        run.stream("outline")({ type: "content", text: "partial-21-40" });
        run.endRound("outline", { status: "retry", text: "" });
        run.beginRound("outline", { session: 1, stage: "items", correction: 1, pageRange: { start: 21, end: 40 } });
        run.stream("outline")({ type: "content", text: "repair" });
      });
      // Live text is batched for 80 ms; inspect after the scheduled paint.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 90)); });
      assert.equal(headings().length, 4);
      assert.equal(headings()[1]!.getAttribute("aria-expanded"), "false");
      assert.equal(headings()[3]!.getAttribute("aria-expanded"), "true");
      assert.deepEqual(step().rounds?.map((round) => round.text), ['{"title":"Deck","total_pages":40}\n', "pages-1-20", "partial-21-40", "repair"]);
      await act(async () => { now += 65_000; run.fail(); });
      assert.equal(host.querySelector("time")?.textContent, "1:05");
      assert.equal(step().rounds?.at(-1)?.state, "failed");
      const staleRun = run;
      await act(async () => {
        run = progress.start(definitions, () => true, true);
        run.begin("outline");
        run.beginRound("outline", { session: 1, stage: "header", correction: 0 });
        run.endRound("outline", { status: "success", text: "returned-without-stream" });
        run.complete("outline");
      });
      assert.equal(step().startedAt, 100_000);
      assert.equal(host.querySelector("time")?.textContent, "1:05");
      assert.equal(step().rounds?.length, 5);
      assert.equal(step().rounds?.at(-1)?.session, 2);
      assert.equal(step().rounds?.at(-1)?.text, "returned-without-stream");
      await act(async () => staleRun.stream("outline")({ type: "content", text: "STALE" }));
      assert.ok(!JSON.stringify(step()).includes("STALE"));
      await act(async () => { run = progress.start(definitions); run.begin("outline"); });
      assert.equal(step().startedAt, now);
      assert.equal(step().rounds, undefined);
    } finally {
      await act(async () => root.unmount());
      Date.now = originalNow;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
