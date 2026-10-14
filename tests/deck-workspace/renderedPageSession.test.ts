import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyRenderedPageSession, reduceRenderedPageSession, type RenderedPageSession } from "../../src/features/deck-workspace/renderedPageSession";

function select(state: RenderedPageSession, key: string, pageId = key) {
  return reduceRenderedPageSession(state, { type: "select", entry: { key, pageId, title: key } });
}
function ready(state: RenderedPageSession, key: string) {
  return reduceRenderedPageSession(reduceRenderedPageSession(state, { type: "prepared", key, html: `<html>${key}</html>` }), { type: "ready", key });
}

test("all visited frames remain ready and switching back reuses the same entry", () => {
  let state = emptyRenderedPageSession;
  for (let i = 0; i < 30; i++) state = ready(select(state, `page-${i}`), `page-${i}`);
  assert.equal(state.entries.length, 30);
  const first = state.entries[0];
  state = select(state, "page-0");
  assert.equal(state.visibleKey, "page-0");
  assert.equal(state.entries[0], first);
  assert.equal(state.entries.length, 30);
});

test("new page is visible before load; late background loads cannot steal selection", () => {
  let state = ready(select(emptyRenderedPageSession, "a"), "a");
  state = select(state, "b");
  assert.equal(state.visibleKey, "a");
  state = reduceRenderedPageSession(state, { type: "prepared", key: "b", html: "<html>b</html>" });
  assert.equal(state.visibleKey, "b");
  state = select(state, "c");
  state = reduceRenderedPageSession(state, { type: "ready", key: "b" });
  assert.equal(state.visibleKey, "b");
  assert.equal(state.selectedKey, "c");
  state = ready(state, "c");
  assert.equal(state.visibleKey, "c");
  state = select(state, "b");
  assert.equal(state.visibleKey, "b");
});

test("selecting an unfinished background frame exposes it without marking it loaded", () => {
  let state = ready(select(emptyRenderedPageSession, "a"), "a");
  state = select(state, "b");
  state = select(state, "a");
  state = reduceRenderedPageSession(state, { type: "prepared", key: "b", html: "<html>b</html>" });
  assert.equal(state.visibleKey, "a");
  state = select(state, "b");
  assert.equal(state.visibleKey, "b");
  assert.equal(state.entries.find((entry) => entry.key === "b")?.status, "prepared");
  state = reduceRenderedPageSession(state, { type: "error", key: "b" });
  assert.equal(state.visibleKey, "", "never show a different page as a fallback");
});

test("updating one page replaces its frame only after load and preserves other pages", () => {
  let state = ready(select(emptyRenderedPageSession, "a-v1", "a"), "a-v1");
  state = ready(select(state, "b"), "b");
  state = select(state, "a-v1", "a");
  state = select(state, "a-v2", "a");
  assert.equal(state.visibleKey, "a-v1");
  state = ready(state, "a-v2");
  assert.deepEqual(state.entries.map((entry) => entry.key), ["b", "a-v2"]);
  assert.equal(state.visibleKey, "a-v2");
  assert.equal(reduceRenderedPageSession(state, { type: "ready", key: "a-v1" }), state);
});

test("failed target keeps the current frame and can be retried", () => {
  let state = ready(select(emptyRenderedPageSession, "a"), "a");
  state = select(state, "b");
  state = reduceRenderedPageSession(state, { type: "error", key: "b" });
  assert.equal(state.visibleKey, "");
  state = reduceRenderedPageSession(state, { type: "select", entry: { key: "b", pageId: "b", title: "b" }, retry: true });
  assert.equal(state.entries.find((entry) => entry.key === "b")?.status, "queued");
  state = ready(state, "b");
  assert.equal(state.visibleKey, "b");
});
