import { describe, expect, it } from 'vitest';

import { extractCssImageUrls, replaceCssImageUrls } from '../css-image-url.js';

const nestedSvgDataUrl = String.raw`data:image/svg+xml,%3Csvg viewBox=\"0 0 200 200\" xmlns=\"http://www.w3.org/2000/svg\"%3E%3Cfilter id=\"noiseFilter\"%3E%3CfeTurbulence type=\"fractalNoise\"/%3E%3C/filter%3E%3Crect filter=\"url(%23noiseFilter)\"/%3E%3C/svg%3E`;

describe('CSS image URL parsing', () => {
  it('treats a quoted SVG data URL as one image', () => {
    expect(extractCssImageUrls(`url("${nestedSvgDataUrl}")`)).toEqual([nestedSvgDataUrl.replaceAll('\\"', '"')]);
  });

  it('extracts top-level URLs from multiple layers', () => {
    expect(
      extractCssImageUrls('url("https://example.com/a.png"), linear-gradient(red, blue), url(https://example.com/b.png)')
    ).toEqual(['https://example.com/a.png', 'https://example.com/b.png']);
  });

  it('ignores non-URL image layers', () => {
    expect(extractCssImageUrls('none')).toEqual([]);
    expect(extractCssImageUrls('linear-gradient(red, blue)')).toEqual([]);
  });
});

describe('CSS image URL rewriting', () => {
  it('replaces a URL layer and leaves the gradient stacked above it untouched', () => {
    const value =
      "linear-gradient(to top, rgba(7, 8, 11, 0.95) 30%, rgba(7, 8, 11, 0.1) 100%), url('/workspace/hero.webp')";

    expect(replaceCssImageUrls(value, () => 'data:image/webp;base64,AA==')).toBe(
      'linear-gradient(to top, rgba(7, 8, 11, 0.95) 30%, rgba(7, 8, 11, 0.1) 100%), '
      + 'url("data:image/webp;base64,AA==")'
    );
  });

  it('keeps a layer whose replacement is not a string', () => {
    const value = 'url("https://example.com/a.png"), url("https://example.com/b.png")';

    expect(replaceCssImageUrls(value, (url) => (url.endsWith('b.png') ? 'data:image/png;base64,BB==' : undefined))).toBe(
      'url("https://example.com/a.png"), url("data:image/png;base64,BB==")'
    );
  });

  it('escapes quotes and backslashes in a replacement', () => {
    expect(replaceCssImageUrls('url(a.png)', () => 'https://example.com/a".png')).toBe(
      'url("https://example.com/a\\".png")'
    );
  });

  it('returns values with no URL layer unchanged', () => {
    expect(replaceCssImageUrls('linear-gradient(red, blue)', () => 'data:image/png;base64,AA==')).toBe(
      'linear-gradient(red, blue)'
    );
    expect(replaceCssImageUrls('none', () => 'data:image/png;base64,AA==')).toBe('none');
  });
});
