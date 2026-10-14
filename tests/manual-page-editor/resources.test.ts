import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "linkedom";
import { EditorResources, bindEditorResources, displayEditorHtml } from "../../src/features/manual-page-editor/manualPageEditorResources";
import { serializeDocument } from "../../src/features/manual-page-editor/manualPageEditorSnapshot";
import { refreshRuntimeFontResources } from "../../src/features/manual-page-editor/manualPageEditorFonts";
import type { ManagedFontRuntimeFamily } from "../../src/api/types";

const local = "file:///workspace/page-assets/image.png";
const oldUrl = "https://assets.example/image?signature=old&part=1";
const newUrl = "https://assets.example/image?signature=new&part=2";
const expired = "2000-01-01T00:00:00Z";
const future = "2099-01-01T00:00:00Z";
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html") as unknown as Document;
}
function snapshot(html: string, resources: EditorResources) {
  const document = parse(html);
  bindEditorResources(document, resources);
  return serializeDocument(document);
}

test("图片、候选图、CSS、SVG、字体和模板资源还原为本地引用，保留正文", () => {
  const resources = new EditorResources();
  resources.merge([{ local_url: local, url: oldUrl, expires_at: expired }]);
  const encoded = oldUrl.replaceAll("&", "&amp;");
  const html = `<html><head><style>@font-face{src:url('${oldUrl}')} .bg{background-image:image-set('${oldUrl}' 1x)}</style></head><body>
    <img src="${encoded}" srcset="${encoded} 1x, ${encoded} 2x">
    <div style="background:url('${encoded}')"></div>
    <svg><image href="${encoded}"/><image xlink:href="${encoded}"/></svg>
    <template><img src="${encoded}"></template><p>${encoded}</p>
    </body></html>`;
  const result = parse(snapshot(html, resources));
  assert.equal(result.querySelector("img")?.getAttribute("src"), local);
  assert.equal(result.querySelector("img")?.getAttribute("srcset"), `${local} 1x, ${local} 2x`);
  assert.ok(result.querySelector("style")?.textContent?.includes(local));
  assert.ok(result.querySelector("div")?.getAttribute("style")?.includes(local));
  assert.equal(result.querySelector("svg image")?.getAttribute("href"), local);
  assert.equal(result.querySelectorAll("svg image")[1]?.getAttribute("xlink:href"), local);
  assert.equal(result.querySelector("template")?.content.querySelector("img")?.getAttribute("src"), local);
  assert.equal(result.querySelector("p")?.textContent, oldUrl);
});

test("过期链接无需网络即可保存；刷新和重建画布不改变快照或撤销内容", (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch expired URL"); });
  const previousParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  Object.defineProperty(globalThis, "DOMParser", { configurable: true, value: DOMParser });
  t.after(() => {
    if (previousParser) Object.defineProperty(globalThis, "DOMParser", previousParser);
    else Reflect.deleteProperty(globalThis, "DOMParser");
  });
  const resources = new EditorResources();
  resources.merge([{ local_url: local, url: oldUrl, expires_at: expired }]);
  const original = `<html><head></head><body><img src="${local}"><p>原文</p></body></html>`;
  const baseline = snapshot(displayEditorHtml(original, resources), resources);
  const edited = baseline.replace("原文", "修改后的文字");
  assert.equal(resources.needsRefresh, true);
  resources.merge([{ local_url: local, url: newUrl, expires_at: future }]);
  assert.equal(resources.needsRefresh, false);
  for (const history of [baseline, edited, baseline, edited]) {
    assert.equal(snapshot(displayEditorHtml(history, resources), resources), history);
  }
  assert.equal(snapshot(`<html><head></head><body><img src="${oldUrl}"><p>原文</p></body></html>`, resources), baseline);
});

test("相同 APS 对象的新增引用和晚到旧响应不改变既有快照", () => {
  const resources = new EditorResources();
  resources.merge([{ local_url: local, url: newUrl, expires_at: future }]);
  const html = `<html><head></head><body><img src="${newUrl}"></body></html>`;
  const before = snapshot(html, resources);
  resources.merge([{ local_url: "file:///workspace/page-assets/duplicate.png", url: newUrl, expires_at: future }]);
  resources.merge([{ local_url: local, url: oldUrl, expires_at: expired }]);
  assert.equal(resources.displayUrl(local), newUrl);
  assert.equal(resources.needsRefresh, false);
  assert.equal(snapshot(html, resources), before);
});

test("刷新字体后一起更新地址和到期时间，再次回填仍保持有效", () => {
  const resources = new EditorResources();
  const font: ManagedFontRuntimeFamily = { family: "Demo", variants: { regular: {
    variant: "regular", format: "woff2", mime_type: "font/woff2", size_bytes: 123,
    local_url: "file:///workspace/fonts/demo.woff2", source_url: oldUrl, expires_at: expired,
  } } };
  resources.merge([{ local_url: font.variants.regular!.local_url, url: newUrl, expires_at: future }]);
  const refreshed = refreshRuntimeFontResources([font], resources)[0].variants.regular!;
  assert.equal(refreshed.expires_at, future);
  assert.equal(refreshed.source_url, newUrl);
  resources.merge([{ local_url: refreshed.local_url, url: refreshed.source_url, expires_at: refreshed.expires_at }]);
  assert.equal(resources.needsRefresh, false);
  assert.equal(font.variants.regular!.expires_at, expired);
});
