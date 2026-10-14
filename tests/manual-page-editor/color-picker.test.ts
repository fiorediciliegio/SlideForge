import assert from "node:assert/strict";
import { test } from "node:test";
import { editorHexToHsv, editorHsvToHex, normalizeEditorHex } from "../../src/features/manual-page-editor/manualEditorColor";

test("色值支持三位和六位输入，拒绝不完整或非法值", () => {
  assert.equal(normalizeEditorHex(" #AbC "), "#aabbcc");
  assert.equal(normalizeEditorHex("0B2B6B"), "#0b2b6b");
  for (const value of ["", "12", "#12345", "ffggff", "#12345678"]) assert.equal(normalizeEditorHex(value), null);
});

test("常见色相与色板灰阶使用正确的十六进制颜色", () => {
  const hues = ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ff0000"];
  hues.forEach((hex, index) => assert.equal(editorHsvToHex({ hue: index * 60, saturation: 1, brightness: 1 }), hex));
  assert.equal(editorHsvToHex({ hue: 240, saturation: 0, brightness: 0.5 }), "#808080");
  assert.equal(editorHsvToHex({ hue: 120, saturation: 0.8, brightness: 0 }), "#000000");
});

test("从页面颜色打开配色面板并确认，不改变原来的颜色", () => {
  for (const red of [0, 1, 43, 127, 192, 255]) {
    for (const green of [0, 11, 85, 128, 255]) {
      for (const blue of [0, 37, 107, 199, 255]) {
        const hex = `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
        assert.equal(editorHsvToHex(editorHexToHsv(hex)), hex);
      }
    }
  }
});
