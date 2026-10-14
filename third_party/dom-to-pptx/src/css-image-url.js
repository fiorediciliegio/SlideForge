function isCssWhitespace(value) {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t' || value === '\f';
}

function isCssIdentifierCharacter(value) {
  return value !== undefined && /[a-zA-Z0-9_-]/.test(value);
}

function decodeCssEscapes(value) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) continue;
    if (next === '\n' || next === '\f') {
      index += 1;
      continue;
    }
    if (next === '\r') {
      index += value[index + 2] === '\n' ? 2 : 1;
      continue;
    }

    if (/[0-9a-fA-F]/.test(next)) {
      let end = index + 1;
      while (end < value.length && end < index + 7 && /[0-9a-fA-F]/.test(value[end])) end += 1;
      const codePoint = Number.parseInt(value.slice(index + 1, end), 16);
      decoded += codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
      if (isCssWhitespace(value[end])) end += 1;
      index = end - 1;
      continue;
    }

    decoded += next;
    index += 1;
  }
  return decoded;
}

/**
 * Walks a CSS image value once and reports every top-level `url()` token with
 * the span it occupies.
 *
 * Reading the URLs and rewriting them share this walk so they can never
 * disagree: a rewriter that searched for the decoded URL would miss a token
 * written with CSS escapes, and a second parser would be one more place for
 * a nested data URL's own `url(...)` to be mistaken for a layer.
 */
function findCssImageUrlTokens(value) {
  if (!value) return [];

  const tokens = [];
  let index = 0;
  while (index < value.length) {
    if (value.slice(index, index + 3).toLowerCase() !== 'url' || isCssIdentifierCharacter(value[index - 1])) {
      index += 1;
      continue;
    }

    const tokenStart = index;
    let cursor = index + 3;
    while (isCssWhitespace(value[cursor])) cursor += 1;
    if (value[cursor] !== '(') {
      index += 3;
      continue;
    }
    cursor += 1;
    while (isCssWhitespace(value[cursor])) cursor += 1;

    const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor] : null;
    if (quote) cursor += 1;
    const start = cursor;

    if (quote) {
      while (cursor < value.length) {
        if (value[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (value[cursor] === quote) break;
        cursor += 1;
      }
      if (value[cursor] !== quote) break;
      const rawUrl = value.slice(start, cursor);
      cursor += 1;
      while (isCssWhitespace(value[cursor])) cursor += 1;
      if (value[cursor] !== ')') break;
      const url = decodeCssEscapes(rawUrl);
      if (url) tokens.push({ start: tokenStart, end: cursor + 1, url });
      index = cursor + 1;
      continue;
    }

    while (cursor < value.length && value[cursor] !== ')') {
      if (value[cursor] === '\\' && cursor + 1 < value.length) cursor += 2;
      else cursor += 1;
    }
    if (value[cursor] !== ')') break;
    const url = decodeCssEscapes(value.slice(start, cursor).trim());
    if (url) tokens.push({ start: tokenStart, end: cursor + 1, url });
    index = cursor + 1;
  }

  return tokens;
}

export function extractCssImageUrls(value) {
  return findCssImageUrlTokens(value).map((token) => token.url);
}

function serializeCssUrl(url) {
  // Newlines are invalid inside a CSS string and a data URL never needs one.
  const escaped = String(url)
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\n\r\f]/g, '');
  return `url("${escaped}")`;
}

/**
 * Rewrites every `url()` token through `replace`, leaving the gradients,
 * separators and every other layer around them byte-for-byte intact.
 *
 * `replace` receives the decoded URL and returns its replacement, or anything
 * that is not a string to leave that token as it was written.
 */
export function replaceCssImageUrls(value, replace) {
  const raw = String(value ?? '');
  const tokens = findCssImageUrlTokens(raw);
  if (tokens.length === 0) return raw;

  let rewritten = '';
  let cursor = 0;
  for (const token of tokens) {
    const replacement = replace(token.url);
    if (typeof replacement !== 'string') continue;
    rewritten += raw.slice(cursor, token.start) + serializeCssUrl(replacement);
    cursor = token.end;
  }
  return rewritten + raw.slice(cursor);
}
