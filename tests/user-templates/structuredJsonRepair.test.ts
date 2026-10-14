import assert from "node:assert/strict";
import test from "node:test";
import { escapeControlCharsInJsonStrings, extractStructuredJsonText, parseStructuredJson } from "../../src/ai/structuredJson";

test("escapeControlCharsInJsonStrings escapes raw newlines only inside strings", () => {
  const input = `{"a": "line1\nline2", "b": 1}`;
  const repaired = escapeControlCharsInJsonStrings(input);
  assert.equal(repaired, `{"a": "line1\\nline2", "b": 1}`);
  // The structural newline-free parts are preserved verbatim.
  assert.match(repaired, /"b": 1/);
});

test("escapeControlCharsInJsonStrings is idempotent on valid text and keeps escapes intact", () => {
  const valid = `{"a": "already\\nescaped", "quote": "she said \\"hi\\""}`;
  assert.equal(escapeControlCharsInJsonStrings(valid), valid);
});

test("parseStructuredJson repairs raw newlines inside an embedded HTML string", () => {
  // The classic master-optimization breakage: HTML with real newlines inside
  // the JSON string value.
  const broken = `{"master_html": "<!doctype html>\n<html>\n<body>{{PAGE_TITLE}}</body>\n</html>", "summary": "深色模式", "changed": ["背景改深色"]}`;
  const parsed = parseStructuredJson<{ master_html: string; summary: string }>(broken);
  assert.match(parsed.master_html, /<html>/);
  assert.match(parsed.master_html, /\n/);
  assert.equal(parsed.summary, "深色模式");
});

test("extractStructuredJsonText keeps its three-stage strategy and repairs fenced blocks too", () => {
  const fenced = `Here you go:\n\`\`\`json\n{"html": "<div>\n<p>x</p>\n</div>"}\n\`\`\`\nDone.`;
  const extracted = extractStructuredJsonText(fenced);
  assert.equal(JSON.parse(extracted).html, "<div>\n<p>x</p>\n</div>");
});

test("extractStructuredJsonText still rejects genuinely unparseable text", () => {
  assert.throws(() => extractStructuredJsonText("no json at all"), /parseable JSON/);
  assert.throws(() => extractStructuredJsonText(""), /JSON text/);
});

test("a CSS block before the real JSON no longer shadows the actual payload", () => {
  // Model ignored the format and emitted bare HTML whose <style> comes first:
  // the first balanced candidate is CSS, the real JSON sits inside a script
  // tag at the end.
  const text = `<style>.a { color: red; }</style><div>hi</div>\n{"master_html": "<p>ok</p>", "summary": "x"}`;
  const parsed = parseStructuredJson<{ master_html: string }>(text);
  assert.equal(parsed.master_html, "<p>ok</p>");
});

test("parse errors carry a raw preview for run-log diagnosis", async () => {
  const { parseJsonObject } = await import("../../src/agent/agentClient");
  assert.throws(
    () => parseJsonObject("totally not json", "template response"),
    /raw: "totally not json"/,
  );
});
