import assert from "node:assert/strict";
import test from "node:test";

import { assertDeckId, newDeckId } from "../../src/contracts/ids.ts";

test("newDeckId creates valid unique deck ids", () => {
  const first = newDeckId();
  const second = newDeckId();
  assert.match(first, /^deck-[A-Za-z0-9-]+$/);
  assert.notEqual(first, second);
  assert.equal(assertDeckId(first), first);
});

test("deck ids reject traversal, separators, dots and non-ascii input", () => {
  for (const value of ["", "other-a", "deck-a/b", "deck-a\\b", "deck-a.b", "deck-中文", "deck-a b"]) {
    assert.throws(() => assertDeckId(value));
  }
});
