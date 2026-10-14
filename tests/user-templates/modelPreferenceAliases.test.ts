import assert from "node:assert/strict";
import test from "node:test";

const MODEL_PREFERENCE_ALIASES: Record<string, string> = {
  gemini: "google/gemini-3.8-flash",
  kimi: "moonshotai/kimi-k2.6",
};

function resolve(input?: string | null): string {
  const name = input?.trim();
  if (!name) return "google/gemini-3.8-flash";
  return MODEL_PREFERENCE_ALIASES[name.toLowerCase()] ?? name;
}

test("model preference aliases resolve gemini and kimi", () => {
  assert.equal(resolve("gemini"), "google/gemini-3.8-flash");
  assert.equal(resolve("Gemini"), "google/gemini-3.8-flash");
  assert.equal(resolve("kimi"), "moonshotai/kimi-k2.6");
  assert.equal(resolve("moonshotai/kimi-k2.6"), "moonshotai/kimi-k2.6");
  assert.equal(resolve(""), "google/gemini-3.8-flash");
  assert.equal(resolve(null), "google/gemini-3.8-flash");
  assert.equal(resolve("google/gemini-3-flash-preview"), "google/gemini-3-flash-preview");
});
