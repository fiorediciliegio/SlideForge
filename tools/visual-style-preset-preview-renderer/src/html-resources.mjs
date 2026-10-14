import { readFile } from "node:fs/promises";

const HTML_TAG = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const CSS_REFERENCE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"=<>`]+))\s*\)/gi;
const EXTERNAL_SCHEME = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

function cleanReference(value) {
  return value.trim().replace(/[?#].*$/, "");
}

function collectMatches(html, expression) {
  const references = [];
  let match;
  while ((match = expression.exec(html))) {
    const value = match.slice(1).find((candidate) => candidate !== undefined) ?? "";
    const cleaned = cleanReference(value);
    if (!cleaned || cleaned.startsWith("#") || EXTERNAL_SCHEME.test(cleaned) || cleaned.startsWith("data:")) {
      continue;
    }
    references.push(cleaned);
  }
  return references;
}

function attributeValue(attributes, name) {
  const expression = new RegExp(
    String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))`,
    "i",
  );
  const match = expression.exec(attributes);
  return match?.slice(1).find((candidate) => candidate !== undefined) ?? null;
}

function localCandidate(value) {
  const cleaned = cleanReference(value);
  if (!cleaned || cleaned.startsWith("#") || EXTERNAL_SCHEME.test(cleaned) || cleaned.startsWith("data:")) {
    return null;
  }
  return cleaned;
}

function resourceAttributeReferences(html) {
  const references = [];
  let match;
  while ((match = HTML_TAG.exec(html))) {
    const [, tagName, attributes] = match;
    for (const attribute of ["src", "poster"]) {
      const value = attributeValue(attributes, attribute);
      const localValue = value ? localCandidate(value) : null;
      if (localValue) references.push(localValue);
    }

    if (tagName.toLowerCase() !== "link") continue;
    const rel = attributeValue(attributes, "rel") ?? "";
    if (!rel.toLowerCase().split(/\s+/).includes("stylesheet")) continue;
    const href = attributeValue(attributes, "href");
    const localHref = href ? localCandidate(href) : null;
    if (localHref) references.push(localHref);
  }
  return references;
}

export function localResourceReferences(html) {
  return [...new Set([
    ...resourceAttributeReferences(html),
    ...collectMatches(html, CSS_REFERENCE),
  ])];
}

export async function assertSelfContainedHtml(htmlPath) {
  const html = await readFile(htmlPath, "utf8");
  const resources = localResourceReferences(html);
  if (resources.length > 0) {
    throw new Error(
      `${htmlPath} must be self-contained; local resources are not published: ${resources.join(", ")}`,
    );
  }
  return { html, resources };
}
