import assert from "node:assert/strict";
import { test } from "node:test";
import { pagePreviewKey, planPagePreviewWork, prioritizePagePreviews } from "../../src/features/deck-workspace/pagePreviewWork";
import { emptyRenderedPageSession, reduceRenderedPageSession as reduce, type RenderedPageSession } from "../../src/features/deck-workspace/renderedPageSession";

const pages = Array.from({ length: 20 }, (_, index) => ({ key: `p${index}`, pageId: `p${index}`, title: `第 ${index + 1} 页` }));
const keys = pages.map((page) => page.key);
const initial = () => reduce(emptyRenderedPageSession, { type: "sync", entries: pages, selectedKey: "p0", complete: true });
const download = (state: RenderedPageSession, key: string, expiresAt = 1000) => reduce(
  reduce(state, { type: "loading", key }), { type: "downloaded", key, html: `<html>${key}</html>`, expiresAt });
const ready = (state: RenderedPageSession, key: string) => reduce(
  reduce(state, { type: "prepared", key, html: `<html>${key}</html>` }), { type: "ready", key });

test("all pages are prepared without selection, with at most ten fetches and four frames at a time", () => {
  let state = initial();
  assert.equal(planPagePreviewWork(state, keys, 0, 0).fetch.length, 10);
  const pending: string[] = [];
  let completed = 0;
  for (let round = 0; completed < pages.length && round < 100; round++) {
    const work = planPagePreviewWork(state, keys, pending.length, 0);
    for (const entry of work.fetch) {
      pending.push(entry.key);
      state = reduce(state, { type: "loading", key: entry.key });
    }
    for (const entry of work.render) state = reduce(state, { type: "prepared", key: entry.key, html: entry.html! });
    assert.ok(pending.length <= 10);
    const preparing = state.entries.filter((entry) => entry.status === "prepared");
    assert.ok(preparing.length <= 4);
    if (preparing[0]) {
      state = reduce(state, { type: "ready", key: preparing[0].key });
      completed++;
    }
    const response = pending.shift();
    if (response) state = reduce(state, { type: "downloaded", key: response, html: response, expiresAt: 1000 });
  }
  assert.equal(completed, 20);
  assert.equal(state.selectedKey, "p0");
  assert.equal(state.visibleKey, "p0");
  const lastFrame = state.entries.find((entry) => entry.key === "p19");
  state = reduce(state, { type: "sync", entries: pages, selectedKey: "p19", complete: true });
  assert.equal(state.visibleKey, "p19");
  assert.equal(state.entries.find((entry) => entry.key === "p19"), lastFrame);
  assert.deepEqual(planPagePreviewWork(state, keys, 0, 2000), { fetch: [], defer: [], render: [] });
});

test("jumping pages reprioritizes fetching and rendering without exceeding occupied slots", () => {
  let state = initial();
  state = reduce(state, { type: "sync", entries: pages, selectedKey: "p12", complete: true });
  const ordered = prioritizePagePreviews(pages, "p12").map((page) => page.key);
  assert.deepEqual(ordered.slice(0, 5), ["p12", "p13", "p11", "p14", "p10"]);
  assert.deepEqual(planPagePreviewWork(state, ordered, 9, 0).fetch.map((entry) => entry.key), ["p12"]);
  assert.equal(planPagePreviewWork(state, ordered, 10, 0).fetch.length, 0);
  for (const key of ["p0", "p1", "p2", "p3", "p12", "p13"]) state = download(state, key);
  assert.deepEqual(planPagePreviewWork(state, ordered, 0, 0).render.map((entry) => entry.key), ["p12", "p13", "p3", "p2"]);
  for (const key of ["p0", "p1", "p2"]) state = reduce(state, { type: "prepared", key, html: key });
  assert.deepEqual(planPagePreviewWork(state, ordered, 0, 0).render.map((entry) => entry.key), ["p12"]);
  state = reduce(state, { type: "prepared", key: "p3", html: "p3" });
  const work = planPagePreviewWork(state, ordered, 0, 0);
  assert.deepEqual(work.render.map((entry) => entry.key), ["p12"]);
  assert.deepEqual(work.defer.map((entry) => entry.key), ["p0"]);
});

test("background preparation reserves a foreground slot and rapid jumps stay within four frames", () => {
  let state = initial();
  for (const key of keys.slice(1)) state = download(state, key);
  let work = planPagePreviewWork(state, keys, 0, 0);
  assert.equal(work.render.length, 3, "slow foreground HTML must not give its slot to background pages");
  for (const entry of work.render) state = reduce(state, { type: "prepared", key: entry.key, html: entry.html! });
  state = download(state, "p0");
  work = planPagePreviewWork(state, keys, 0, 0);
  assert.deepEqual(work.render.map((entry) => entry.key), ["p0"]);
  state = reduce(state, { type: "prepared", key: "p0", html: "p0" });

  for (const selectedKey of ["p19", "p10", "p8", "p4"]) {
    state = reduce(state, { type: "sync", entries: pages, selectedKey, complete: true });
    const ordered = prioritizePagePreviews(pages, selectedKey).map((page) => page.key);
    work = planPagePreviewWork(state, ordered, 0, 0);
    assert.equal(work.render[0]?.key, selectedKey);
    for (const entry of work.defer) {
      state = reduce(state, { type: "deferred", key: entry.key });
      assert.equal(reduce(state, { type: "ready", key: entry.key }), state, "late load cannot revive a deferred frame");
    }
    for (const entry of work.render) state = reduce(state, { type: "prepared", key: entry.key, html: entry.html! });
    assert.equal(state.visibleKey, selectedKey);
    assert.ok(state.entries.filter((entry) => entry.status === "prepared").length <= 4);
  }
});

test("expired queued HTML is fetched again before mounting, while ready frames survive URL expiry", () => {
  let state = download(initial(), "p0", 100);
  state = download(state, "p1", 101);
  state = ready(download(state, "p2", 1), "p2");
  const work = planPagePreviewWork(state, keys, 0, 100);
  assert.equal(work.fetch[0].key, "p0");
  assert.deepEqual(work.render.map((entry) => entry.key), ["p1"]);
  assert.ok(!work.fetch.some((entry) => entry.key === "p2"));
});

test("version changes reject late results and keep the visible frame until its replacement is ready", () => {
  let state = ready(download(initial(), "p0"), "p0");
  state = reduce(state, { type: "loading", key: "p1" });
  const updated = pages.map((page) => page.key === "p0" || page.key === "p1" ? { ...page, key: `${page.key}-v2` } : page);
  state = reduce(state, { type: "sync", entries: updated, selectedKey: "p0-v2", complete: true });
  assert.equal(state.visibleKey, "p0");
  assert.ok(!state.entries.some((entry) => entry.key === "p1"));
  assert.equal(reduce(state, { type: "downloaded", key: "p1", html: "old", expiresAt: 1000 }), state);
  assert.equal(planPagePreviewWork(state, updated.map((page) => page.key), 10, 0).fetch.length, 0);
  state = ready(download(state, "p1-v2"), "p1-v2");
  assert.equal(state.visibleKey, "p0");
  state = ready(download(state, "p0-v2"), "p0-v2");
  assert.equal(state.visibleKey, "p0-v2");
  assert.ok(!state.entries.some((entry) => entry.key === "p0"));
  assert.equal(reduce(state, { type: "ready", key: "p0" }), state);
  state = reduce(state, { type: "sync", entries: updated.slice(1), selectedKey: "p1-v2", complete: true });
  assert.ok(!state.entries.some((entry) => entry.pageId === "p0"));
});

test("one failed frame releases its slot, retains the visible page and can be retried", () => {
  let state = ready(download(initial(), "p0"), "p0");
  for (const key of ["p1", "p2", "p3", "p4", "p5"]) state = download(state, key);
  state = reduce(state, { type: "sync", entries: pages, selectedKey: "p1", complete: true });
  for (const key of ["p1", "p2", "p3", "p4"]) state = reduce(state, { type: "prepared", key, html: key });
  state = reduce(state, { type: "error", key: "p1" });
  assert.equal(state.visibleKey, "", "a failed page cannot display an unrelated page");
  assert.equal(state.entries.find((entry) => entry.key === "p1")?.html, undefined);
  assert.deepEqual(planPagePreviewWork(state, keys, 0, 0).render, [], "the released foreground slot remains available for retry");
  state = reduce(state, { type: "select", entry: pages[1], retry: true });
  assert.equal(planPagePreviewWork(state, keys, 0, 0).fetch[0].key, "p1");
  state = download(state, "p1");
  assert.deepEqual(planPagePreviewWork(state, keys, 0, 0).render.map((entry) => entry.key), ["p1"]);
  state = ready(state, "p1");
  assert.equal(state.visibleKey, "p1");
});

test("workspace and page fingerprints isolate preview identities", () => {
  const source = { pageId: "p0", title: "首页", version: "v1", expectedFingerprint: "f1" };
  assert.notEqual(pagePreviewKey("a", source), pagePreviewKey("b", source));
  assert.notEqual(pagePreviewKey("a", source), pagePreviewKey("a", { ...source, expectedFingerprint: "f2" }));
});

test("updating an offscreen page retains its loaded version until the replacement is ready", () => {
  let state = ready(download(initial(), "p0"), "p0");
  state = ready(download(state, "p1"), "p1");
  const updated = pages.map((page) => page.key === "p1" ? { ...page, key: "p1-v2" } : page);
  state = reduce(state, { type: "sync", entries: updated, selectedKey: "p0", complete: true });
  assert.equal(state.entries.find((entry) => entry.key === "p1")?.status, "ready");
  state = ready(download(state, "p1-v2"), "p1-v2");
  assert.equal(state.visibleKey, "p0");
  assert.ok(!state.entries.some((entry) => entry.key === "p1"));
  assert.equal(state.entries.find((entry) => entry.key === "p1-v2")?.status, "ready");
});
