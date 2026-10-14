import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import { PREVIEW_HTML_MAX_BYTES } from "./limits.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
export interface PreviewResource { bytes: Buffer; mimeType: string; extension: string }
export interface PreviewResourceUrl { url: string; expires_at: string }
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
const ASSET_ROOTS = ["research/evidence/images", "uploaded-sources/asset", "page-assets", "fonts"];
const activeTags = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "base"]);
function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function cssUnescape(value: string) {
  return value.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, escaped: string) =>
    /^[0-9a-f]/i.test(escaped) ? String.fromCodePoint(parseInt(escaped.trim(), 16) || 0xfffd) : escaped);
}
function srcsetCandidates(value: string): Array<{ url: string; descriptor: string }> {
  const result: Array<{ url: string; descriptor: string }> = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && /[\s,]/.test(value[position])) position++;
    const start = position;
    while (position < value.length && !/\s/.test(value[position])) position++;
    const token = value.slice(start, position);
    if (!token) break;
    if (token.endsWith(",")) { result.push({ url: token.replace(/,+$/, ""), descriptor: "" }); continue; }
    const descriptorStart = position;
    let parentheses = 0;
    while (position < value.length) {
      if (value[position] === "(") parentheses++;
      if (value[position] === ")") parentheses--;
      if (value[position] === "," && parentheses === 0) break;
      position++;
    }
    result.push({ url: token, descriptor: value.slice(descriptorStart, position).trim() });
    position++;
  }
  return result;
}

/** A browser-only derivative. Never mutates Page Source or the export snapshot. */
export async function preparePreviewResources(input: {
  workspaceDir: string;
  htmlPath: string;
  html: string;
  onResolved?: (reference: string, result: PreviewResourceUrl) => void;
  resolve: (resource: PreviewResource) => Promise<PreviewResourceUrl>;
}) {
  const root = await realpath(input.workspaceDir);
  const roots = (await Promise.all(ASSET_ROOTS.map(async (relative) => {
    const candidate = await realpath(path.join(root, relative)).catch(() => null);
    return candidate && within(root, candidate) ? candidate : null;
  }))).filter((entry): entry is string => Boolean(entry));
  const resources: Array<{ local_url: string; url: string; expires_at: string }> = [];
  const resolutions = new Map<string, Promise<string>>();
  let expiresAt: string | null = null;
  let totalResourceBytes = 0;
  async function resolveReference(raw: string): Promise<string> {
    const reference = raw.trim();
    if (!reference || reference.startsWith("#")) return reference;
    if (/^https:\/\//i.test(reference)) return reference;
    if (reference.startsWith("//")) return `https:${reference}`;
    if (resolutions.has(reference)) return resolutions.get(reference)!;
    const pending = (async () => {
      let resource: PreviewResource;
      if (/^data:/i.test(reference)) {
        const match = /^data:([^;,]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(reference);
        if (!match) throw new Error("Unsupported embedded preview resource");
        const extension = Object.keys(MIME).find((key) => MIME[key] === match[1].toLowerCase());
        if (!extension) throw new Error("Unsupported embedded preview resource type");
        // Small embedded resources avoid extra network requests.
        if (reference.length < 2048) return reference;
        const bytes = /;base64(?:;|$)/i.test(match[2])
          ? Buffer.from(match[3], "base64")
          : Buffer.from(decodeURIComponent(match[3]), "utf8");
        resource = { bytes, mimeType: MIME[extension], extension };
      } else {
        if (/^[a-z][a-z\d+.-]*:/i.test(reference) && !/^file:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) {
          throw new Error("Preview resource must use HTTPS or an allowed Workspace file");
        }
        const localPath = /^file:/i.test(reference)
          ? fileURLToPath(reference)
          : path.resolve(path.dirname(input.htmlPath), decodeURIComponent(reference.split(/[?#]/, 1)[0]));
        const resolved = await realpath(localPath);
        if (!roots.some((allowed) => within(allowed, resolved))) throw new Error("Preview resource is outside allowed Workspace assets");
        const extension = path.extname(resolved).toLowerCase();
        if (!MIME[extension]) throw new Error("Unsupported local preview resource type");
        const info = await stat(resolved);
        if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("Preview resource exceeds 20 MiB");
        resource = { bytes: await readFile(resolved), mimeType: MIME[extension], extension };
      }
      totalResourceBytes += resource.bytes.length;
      if (resource.bytes.length > 20 * 1024 * 1024 || totalResourceBytes > PREVIEW_HTML_MAX_BYTES) {
        throw new Error("Preview resources exceed the size limit");
      }
      const result = await input.resolve(resource);
      if (!/^https:\/\//i.test(result.url) || !Number.isFinite(Date.parse(result.expires_at))) {
        throw new Error("APS preview resource has no valid HTTPS URL or expiry");
      }
      if (!expiresAt || Date.parse(result.expires_at) < Date.parse(expiresAt)) expiresAt = result.expires_at;
      const fragment = !/^data:/i.test(reference) && reference.includes("#") ? reference.slice(reference.indexOf("#")) : "";
      const url = `${result.url}${fragment}`;
      resources.push({ local_url: reference, url, expires_at: result.expires_at });
      input.onResolved?.(reference, { ...result, url });
      return url;
    })();
    resolutions.set(reference, pending);
    return pending;
  }
  const html = await rewriteHtmlResourceReferences(input.html, resolveReference);
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\' https:; font-src https: data:; media-src \'none\'; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; form-action \'none\'; base-uri \'none\'">';
  return { html: html.replace(/<head>/i, `<head>${csp}`), resources_expires_at: expiresAt, resources };
}

/**
 * Shared HTML/CSS traversal for display URLs and durable local references.
 *
 * `onWarning` receives non-fatal per-node problems (currently: CSS that
 * postcss cannot parse). A single malformed `<style>` block or inline style
 * must never fail the whole page save — the node is left unrewritten and the
 * rest of the document still gets its resource URLs rewritten.
 */
export async function rewriteHtmlResourceReferences(html: string, resolveReference: (reference: string) => Promise<string>, onWarning: (message: string) => void = (message) => console.warn(message)): Promise<string> {
  async function rewriteCss(css: string, inline = false) {
    let sheet: postcss.Root;
    try {
      sheet = postcss.parse(inline ? `x{${css}}` : css);
    } catch (error) {
      // Parse failures are syntactic, not policy violations: the node keeps its
      // original bytes (resource URLs inside just are not rewritten) and the
      // caller gets enough context to find the producer of the bad CSS.
      const detail = error instanceof Error ? error.message : String(error);
      onWarning(`[resource-rewrite] skipping unparseable ${inline ? "inline style attribute" : "stylesheet"}: ${detail}; snippet=${JSON.stringify(css.slice(0, 160))}`);
      return css;
    }
    const values: Array<{ value: string }> = [];
    const imports: postcss.AtRule[] = [];
    sheet.walkAtRules("import", (rule) => { imports.push(rule); });
    for (const rule of imports) {
      const parsed = valueParser(rule.params);
      const first = parsed.nodes.find((node) => node.type !== "space" && node.type !== "comment");
      const location = first?.type === "string" ? first
        : first?.type === "function" && first.value.toLowerCase() === "url" ? first.nodes[0] : null;
      if (!location || !["word", "string"].includes(location.type)) throw new Error("Invalid preview stylesheet import");
      const reference = cssUnescape(location.value);
      if (!/^(?:https:)?\/\//i.test(reference)) throw new Error("Preview stylesheet imports must use HTTPS");
      location.value = await resolveReference(reference);
      rule.params = parsed.toString();
    }
    sheet.walkDecls((decl) => { values.push(decl); });
    for (const declaration of values) {
      const parsed = valueParser(declaration.value);
      const urls: valueParser.FunctionNode[] = [];
      parsed.walk((node) => { if (node.type === "function" && node.value.toLowerCase() === "url") urls.push(node); });
      for (const node of urls) {
        const first = node.nodes[0];
        const original = first?.type === "string" ? first.value : valueParser.stringify(node.nodes).trim();
        const replacement = await resolveReference(cssUnescape(original));
        node.nodes = [{ type: "string", quote: '"', value: replacement, sourceIndex: 0, sourceEndIndex: replacement.length }];
      }
      const imageSetStrings: valueParser.StringNode[] = [];
      parsed.walk((node) => {
        if (node.type === "function" && /^(?:-webkit-)?image-set$/i.test(node.value)) {
          for (const item of node.nodes) if (item.type === "string") imageSetStrings.push(item);
        }
      });
      for (const node of imageSetStrings) node.value = await resolveReference(cssUnescape(node.value));
      declaration.value = parsed.toString();
    }
    const result = sheet.toString();
    return inline ? result.slice(result.indexOf("{") + 1, result.lastIndexOf("}")) : result;
  }
  const document = parse(html);
  async function visit(parent: Node) {
    if (!("childNodes" in parent)) return;
    for (const child of [...parent.childNodes]) {
      if (!("tagName" in child)) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (activeTags.has(tag) || (tag === "meta" && element.attrs.some((attr) => attr.name === "http-equiv"))) {
        parent.childNodes.splice(parent.childNodes.indexOf(child), 1);
        continue;
      }
      element.attrs = element.attrs.filter((attr) => !/^on/i.test(attr.name) && !["srcdoc", "action", "formaction", "ping"].includes(attr.name));
      for (const attr of element.attrs) {
        if (attr.name === "style") attr.value = await rewriteCss(attr.value, true);
        else if (attr.name === "srcset") {
          // HTML's candidate tokenizer: URLs may contain commas (notably data URLs).
          const rewritten: string[] = [];
          for (const candidate of srcsetCandidates(attr.value)) {
            rewritten.push([await resolveReference(candidate.url), candidate.descriptor].filter(Boolean).join(" "));
          }
          attr.value = rewritten.join(", ");
        } else if (attr.name === "src" || attr.name === "poster" || (attr.name === "href" && ["image", "use", "link", "feimage"].includes(tag))) {
          attr.value = await resolveReference(attr.value);
        } else if (attr.name === "href" && !attr.value.startsWith("#")) attr.value = "#";
      }
      if (tag === "style") {
        for (const text of element.childNodes) if (text.nodeName === "#text" && "value" in text) text.value = await rewriteCss(text.value);
      }
      await visit(child);
      if ("content" in element) await visit(element.content as Node);
    }
  }
  await visit(document);
  return serialize(document);
}
