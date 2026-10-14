import assert from "node:assert/strict";
import test from "node:test";
import { stripInlineAssetData, restoreInlineAssetData, reinsertMissingAssets } from "../../src/features/user-templates/masterAssetRefs";

const LOGO_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const BIG_URI = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

test("strip swaps inline data URIs for x-asset-ref placeholders keyed by data-asset", () => {
  const html = `<div class="slide"><img data-composed-asset data-asset="logo-1.png" src="${LOGO_URI}" alt="" style="position:absolute"/><h1>{{PAGE_TITLE}}</h1></div>`;
  const { html: stripped, assets } = stripInlineAssetData(html);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, "logo-1.png");
  assert.equal(assets[0].dataUri, LOGO_URI);
  assert.match(stripped, /src="x-asset-ref:logo-1\.png"/);
  assert.doesNotMatch(stripped, /base64/);
  // Untouched markup stays intact.
  assert.match(stripped, /<h1>\{\{PAGE_TITLE\}\}<\/h1>/);
});

test("strip names anonymous inline images and keeps non-inline img tags alone", () => {
  const html = `<img src="${LOGO_URI}"><img src="https://example.com/x.png"><img src="${BIG_URI}" data-asset="hero.jpg">`;
  const { html: stripped, assets } = stripInlineAssetData(html);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].name, "asset-1.png");
  assert.equal(assets[1].name, "hero.jpg");
  assert.match(stripped, /src="x-asset-ref:asset-1\.png"/);
  assert.match(stripped, /src="x-asset-ref:hero\.jpg"/);
  assert.match(stripped, /src="https:\/\/example\.com\/x\.png"/);
});

test("restore puts the original data URI back verbatim", () => {
  const html = `<img data-asset="logo-1.png" src="${LOGO_URI}">`;
  const { html: stripped, assets } = stripInlineAssetData(html);
  const modelOutput = stripped.replace("<img ", '<img alt="logo" ');
  const restored = restoreInlineAssetData(modelOutput, assets);
  assert.match(restored, new RegExp(`src="${LOGO_URI.replace(/[/.+]/g, "\\$&")}"`));
  assert.match(restored, /alt="logo"/);
});

test("restore is a no-op for unknown or mangled refs and for empty asset lists", () => {
  const broken = `<img src="x-asset-ref:logo-9.png">`;
  assert.equal(restoreInlineAssetData(broken, [{ name: "logo-1.png", dataUri: LOGO_URI }]), broken);
  const plain = "<h1>hello</h1>";
  assert.equal(restoreInlineAssetData(plain, []), plain);
});

test("strip/restore round-trips a document with no inline assets unchanged", () => {
  const html = "<!doctype html><html><body><h1>{{PAGE_TITLE}}</h1></body></html>";
  const { html: stripped, assets } = stripInlineAssetData(html);
  assert.equal(assets.length, 0);
  assert.equal(stripped, html);
  assert.equal(restoreInlineAssetData(stripped, assets), html);
});

test("reinsertMissingAssets puts a dropped asset back before </body> and reports it", () => {
  const original = `<!doctype html><html><body><div class="slide"><img data-asset="logo-1.png" src="${LOGO_URI}" style="position:absolute;left:96px;top:72px"></div></body></html>`;
  const { assets } = stripInlineAssetData(original);
  // Model output: logo element vanished, everything else fine.
  const modelOutput = `<!doctype html><html><body><div class="slide"><h1>{{PAGE_TITLE}}</h1><div>{{PAGE_CONTENT}}</div></div></body></html>`;
  const { html, reinserted } = reinsertMissingAssets(modelOutput, assets);
  assert.deepEqual(reinserted, ["logo-1.png"]);
  assert.match(html, /data:image\/png;base64,iVBOR/);
  assert.ok(html.indexOf("base64") < html.toLowerCase().indexOf("</body>"), "re-inserted before </body>");
  assert.match(html, /\{\{PAGE_CONTENT\}\}/);
});

test("reinsertMissingAssets leaves present assets and empty lists untouched", () => {
  const withRef = `<img src="x-asset-ref:logo-1.png">`;
  assert.deepEqual(reinsertMissingAssets(withRef, [{ name: "logo-1.png", dataUri: LOGO_URI, tag: "<img>" }]).reinserted, []);
  const withAttr = `<div class="asset-slot" data-asset="logo-1.png" data-region="top-left"></div>`;
  assert.deepEqual(reinsertMissingAssets(withAttr, [{ name: "logo-1.png", dataUri: LOGO_URI, tag: "<img>" }]).reinserted, []);
  const plain = "<html><body></body></html>";
  const result = reinsertMissingAssets(plain, []);
  assert.equal(result.html, plain);
  assert.deepEqual(result.reinserted, []);
});
