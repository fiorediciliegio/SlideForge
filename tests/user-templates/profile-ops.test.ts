import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DesignProfile } from "../../src/features/user-templates/types";
import { applyProfileOps, parseProfileOps } from "../../src/features/user-templates/profile-ops";
import { templateProfileChatPrompt } from "../../src/features/user-templates/prompts";

const baseProfile: DesignProfile = {
  colors: [
    { token: "primary", hex: "#1B4F9C", role: "主色" },
    { token: "accent", hex: "#E8622C", role: "强调色" },
  ],
  typography: { heading_font: "Aptos Display", body_font: "Aptos" },
  layout_rules: ["左文右图", "每页一个焦点"],
  fixed_assets: [{ kind: "logo", label: "星澜 Logo", position_rule: "左上角" }],
  voice: "庄重的科技风",
  do: ["留白充足"],
  dont: ["不要渐变"],
};

describe("parseProfileOps", () => {
  it("accepts a well-formed ops payload", () => {
    const ops = parseProfileOps({ ops: [
      { op: "update", section: "colors", index: 0, value: { hex: "#0B2A4A" } },
      { op: "remove", section: "layout_rules", index: 1 },
      { op: "set", section: "voice", value: "轻快" },
    ] });
    assert.equal(ops.length, 3);
    assert.equal(ops[1].op, "remove");
  });
  it("rejects malformed payloads", () => {
    assert.throws(() => parseProfileOps({ ops: "nope" }));
    assert.throws(() => parseProfileOps({ ops: [{ op: "explode", section: "colors" }] }));
    assert.throws(() => parseProfileOps({ ops: [{ op: "set", section: "nonsense", value: 1 }] }));
    assert.throws(() => parseProfileOps({ ops: [{ op: "set", section: "colors" }] }));
    assert.throws(() => parseProfileOps({ ops: [{ op: "remove", section: "colors", index: -1 }] }));
  });
});

describe("applyProfileOps", () => {
  it("updates a single color field without touching siblings", () => {
    const { profile, applied, skipped } = applyProfileOps(baseProfile, [
      { op: "update", section: "colors", index: 0, value: { hex: "#0b2a4a" } },
    ]);
    assert.equal(applied, 1);
    assert.deepEqual(skipped, []);
    assert.equal(profile.colors[0].hex, "#0b2a4a");
    assert.equal(profile.colors[0].token, "primary");
    assert.equal(profile.colors[1].hex, "#E8622C");
    assert.equal(baseProfile.colors[0].hex, "#1B4F9C", "immutable");
  });
  it("removes layout rules by index", () => {
    const { profile, applied } = applyProfileOps(baseProfile, [{ op: "remove", section: "layout_rules", index: 1 }]);
    assert.equal(applied, 1);
    assert.deepEqual(profile.layout_rules, ["左文右图"]);
  });
  it("adds a color at the end and validates it", () => {
    const { profile, applied } = applyProfileOps(baseProfile, [
      { op: "add", section: "colors", value: { token: "background", hex: "#FFFFFF", role: "背景" } },
    ]);
    assert.equal(applied, 1);
    assert.equal(profile.colors.length, 3);
    assert.equal(profile.colors[2].token, "background");
  });
  it("adds a fixed asset with kind logo defaulting", () => {
    const { profile, applied } = applyProfileOps(baseProfile, [
      { op: "add", section: "fixed_assets", value: { kind: "logo", label: "备用标识" } },
    ]);
    assert.equal(applied, 1);
    assert.equal(profile.fixed_assets?.length, 2);
  });
  it("sets voice and typography wholesale", () => {
    const { profile } = applyProfileOps(baseProfile, [
      { op: "set", section: "voice", value: " 轻快的科技风 " },
      { op: "set", section: "typography", value: { body_font: "Inter" } },
    ]);
    assert.equal(profile.voice, "轻快的科技风");
    assert.equal(profile.typography?.body_font, "Inter");
    assert.equal(profile.typography?.heading_font, "Aptos Display");
  });
  it("skips invalid ops with reasons instead of throwing", () => {
    const { profile, applied, skipped } = applyProfileOps(baseProfile, [
      { op: "remove", section: "colors", index: 99 },
      { op: "add", section: "colors", value: { token: "bad", hex: "blue", role: "x" } },
      { op: "update", section: "voice", index: 0, value: "nope" },
      { op: "remove", section: "colors", index: 0 },
    ]);
    assert.equal(applied, 1);
    assert.equal(skipped.length, 3);
    assert.equal(profile.colors.length, 1, "the valid remove still applied");
  });
  it("enforces the 6-color limit on add", () => {
    const full: DesignProfile = { ...baseProfile, colors: Array.from({ length: 6 }, (_, i) => ({ token: `c${i}`, hex: "#123456", role: "r" })) };
    const { applied, skipped } = applyProfileOps(full, [{ op: "add", section: "colors", value: { token: "x", hex: "#111111", role: "r" } }]);
    assert.equal(applied, 0);
    assert.equal(skipped.length, 1);
  });
});

describe("templateProfileChatPrompt", () => {
  it("embeds the current profile and instruction", () => {
    const prompt = templateProfileChatPrompt(baseProfile, "把主色改深一点", "zh-CN");
    assert.match(prompt, /#1B4F9C/);
    assert.match(prompt, /把主色改深一点/);
    assert.match(prompt, /"ops"/);
  });
});
