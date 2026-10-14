// src/__tests__/font-detection.test.js
//
// Tests for the font-detection helpers in src/utils.js — extracted from
// the exportToPptx pipeline so they can be exercised in isolation:
//
//   - getFontsFromStyleSheets: scans an array of CSSStyleSheet-like
//     objects (including @import chains) for @font-face declarations
//     matching the requested families.
//   - classifyFontVariant: maps CSS font-weight / font-style into one of
//     PowerPoint's four embedded-font slots.
//   - detectVariantSlotCollisions: flags when multiple weights of the
//     same family collapse into the same slot (e.g. weight 700 + 900
//     both landing in `bold`).
//
// The @import traversal test in particular covers a real user-hit
// footgun: `@import url('./fonts.css')` in a theme file used to escape
// auto-embed discovery and silently produce a fonts-less PPTX.

import { describe, it, expect } from 'vitest';
import {
  getFontsFromStyleSheets,
  classifyFontVariant,
  detectVariantSlotCollisions,
  hasVariableFontTables,
  backfillRegularFontSlot,
  getUsedFontFamilies,
  splitFontFamilyStack,
  resolveEastAsianFamily,
} from '../utils.js';

// -- Helpers to build CSSStyleSheet-like fixtures without a real DOM ----------

function fontFaceRule({ family, src, weight = '400', style = 'normal' }) {
  return {
    constructor: { name: 'CSSFontFaceRule' },
    style: {
      getPropertyValue: (prop) => {
        if (prop === 'font-family') return `"${family}"`;
        if (prop === 'src') return src;
        if (prop === 'font-weight') return String(weight);
        if (prop === 'font-style') return style;
        return '';
      },
    },
  };
}

function importRule(importedSheet) {
  return {
    constructor: { name: 'CSSImportRule' },
    styleSheet: importedSheet,
  };
}

function makeSheet(rules) {
  return { cssRules: rules };
}

// -----------------------------------------------------------------------------

describe('getFontsFromStyleSheets', () => {
  it('discovers @font-face rules for families in usedFamilies', () => {
    const sheet = makeSheet([
      fontFaceRule({ family: 'Inter', src: "url('fonts/Inter-Regular.ttf')", weight: '400' }),
      fontFaceRule({ family: 'Merriweather', src: "url('fonts/Merri.ttf')", weight: '400' }),
    ]);

    const used = new Set(['Inter']);
    const found = getFontsFromStyleSheets(used, [sheet]);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('Inter');
    expect(found[0].url).toBe('fonts/Inter-Regular.ttf');
  });

  it('recurses into @import chains — the common `theme.css imports fonts.css` pattern', () => {
    // Fixture: `fonts.css` (imported) declares @font-face for Inter Regular + Bold.
    // `theme.css` (top-level) contains only an @import pointing at fonts.css.
    // Before this fix, top-level scanning of `theme.css` found zero @font-face
    // rules and auto-embed produced a fonts-less PPTX (~15 KB instead of ~300 KB).
    const importedSheet = makeSheet([
      fontFaceRule({ family: 'Inter', src: "url('fonts/Inter-Regular.ttf')", weight: '400' }),
      fontFaceRule({ family: 'Inter', src: "url('fonts/Inter-Bold.ttf')", weight: '700' }),
    ]);
    const topSheet = makeSheet([importRule(importedSheet)]);

    const used = new Set(['Inter']);
    const found = getFontsFromStyleSheets(used, [topSheet]);
    expect(found).toHaveLength(2);
    const weights = found.map((f) => f.weight).sort();
    expect(weights).toEqual(['400', '700']);
  });

  it('recurses through multiple levels of @import', () => {
    // A imports B, B imports C, C declares the actual @font-face.
    const level3 = makeSheet([
      fontFaceRule({ family: 'Inter', src: "url('a.ttf')", weight: '400' }),
    ]);
    const level2 = makeSheet([importRule(level3)]);
    const level1 = makeSheet([importRule(level2)]);

    const found = getFontsFromStyleSheets(new Set(['Inter']), [level1]);
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe('a.ttf');
  });

  it('does not loop forever on cyclic @import graphs', () => {
    // Pathological but survivable: sheet A imports sheet B; sheet B
    // imports sheet A back. Should terminate rather than stack-overflow.
    const a = makeSheet([]);
    const b = makeSheet([importRule(a)]);
    a.cssRules = [
      importRule(b),
      fontFaceRule({ family: 'Inter', src: "url('cyclic.ttf')" }),
    ];

    const found = getFontsFromStyleSheets(new Set(['Inter']), [a]);
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe('cyclic.ttf');
  });

  it('deduplicates by URL across multiple sheets', () => {
    const sheetA = makeSheet([
      fontFaceRule({ family: 'Inter', src: "url('inter.ttf')", weight: '400' }),
    ]);
    const sheetB = makeSheet([
      fontFaceRule({ family: 'Inter', src: "url('inter.ttf')", weight: '400' }),
    ]);
    const found = getFontsFromStyleSheets(new Set(['Inter']), [sheetA, sheetB]);
    expect(found).toHaveLength(1);
  });

  it('preserves font-weight and font-style on each detected entry', () => {
    const sheet = makeSheet([
      fontFaceRule({ family: 'Inter', src: "url('a.ttf')", weight: '400', style: 'normal' }),
      fontFaceRule({ family: 'Inter', src: "url('b.ttf')", weight: '700', style: 'italic' }),
    ]);
    const found = getFontsFromStyleSheets(new Set(['Inter']), [sheet]);
    expect(found).toHaveLength(2);
    const regular = found.find((f) => f.url === 'a.ttf');
    const boldItalic = found.find((f) => f.url === 'b.ttf');
    expect(regular).toMatchObject({ weight: '400', style: 'normal' });
    expect(boldItalic).toMatchObject({ weight: '700', style: 'italic' });
  });

  it('survives a stylesheet that throws on cssRules access (cross-origin)', () => {
    // Simulates the SecurityError thrown by cross-origin sheets (e.g.
    // Google Fonts CSS without CORS headers). The scan should continue
    // on to other sheets rather than propagating the exception.
    const hostileSheet = {
      href: 'https://example.com/blocked.css',
      get cssRules() {
        throw new Error('SecurityError: cross-origin');
      },
    };
    const okSheet = makeSheet([
      fontFaceRule({ family: 'Inter', src: "url('local.ttf')", weight: '400' }),
    ]);

    expect(() =>
      getFontsFromStyleSheets(new Set(['Inter']), [hostileSheet, okSheet])
    ).not.toThrow();
    const found = getFontsFromStyleSheets(new Set(['Inter']), [hostileSheet, okSheet]);
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe('local.ttf');
  });
});

describe('classifyFontVariant', () => {
  it('maps numeric weights to bold/regular based on the 600 threshold', () => {
    expect(classifyFontVariant(400, 'normal')).toBe('regular');
    expect(classifyFontVariant(500, 'normal')).toBe('regular'); // Medium is not bold
    expect(classifyFontVariant(600, 'normal')).toBe('bold'); // SemiBold rounds up
    expect(classifyFontVariant(700, 'normal')).toBe('bold');
    expect(classifyFontVariant(900, 'normal')).toBe('bold'); // Black collapses into bold slot
  });

  it('handles the keyword weights (bold, bolder, lighter, normal)', () => {
    expect(classifyFontVariant('bold', 'normal')).toBe('bold');
    expect(classifyFontVariant('bolder', 'normal')).toBe('bold');
    expect(classifyFontVariant('lighter', 'normal')).toBe('regular');
    expect(classifyFontVariant('normal', 'normal')).toBe('regular');
  });

  it('classifies italic and oblique into italic slots', () => {
    expect(classifyFontVariant(400, 'italic')).toBe('italic');
    expect(classifyFontVariant(400, 'oblique')).toBe('italic');
    expect(classifyFontVariant(700, 'italic')).toBe('boldItalic');
  });

  it('defaults to regular for missing / undefined inputs', () => {
    expect(classifyFontVariant(undefined, undefined)).toBe('regular');
    expect(classifyFontVariant(null, null)).toBe('regular');
    expect(classifyFontVariant('', '')).toBe('regular');
  });

  it('handles nonsense weights by falling back to 400', () => {
    expect(classifyFontVariant('mystery', 'normal')).toBe('regular');
  });
});

describe('detectVariantSlotCollisions', () => {
  it('reports weight 700 + weight 900 for same family as a bold-slot collision', () => {
    // The workflow-relevant case: Inter Bold + Inter Black both classify
    // as `bold`. Black glyphs silently get merged into Bold's slot.
    const entries = [
      { name: 'Inter', weight: 400, style: 'normal' },
      { name: 'Inter', weight: 700, style: 'normal' },
      { name: 'Inter', weight: 900, style: 'normal' },
    ];
    const collisions = detectVariantSlotCollisions(entries);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].family).toBe('Inter');
    expect(collisions[0].variant).toBe('bold');
    expect(collisions[0].weights).toEqual(['700', '900']);
  });

  it('does not report a collision when weights land in different slots', () => {
    const entries = [
      { name: 'Inter', weight: 400, style: 'normal' },
      { name: 'Inter', weight: 700, style: 'normal' },
    ];
    expect(detectVariantSlotCollisions(entries)).toEqual([]);
  });

  it('separates collisions per family', () => {
    const entries = [
      { name: 'Inter', weight: 700, style: 'normal' },
      { name: 'Inter', weight: 900, style: 'normal' },
      { name: 'Merriweather', weight: 800, style: 'italic' },
      { name: 'Merriweather', weight: 900, style: 'italic' },
    ];
    const collisions = detectVariantSlotCollisions(entries);
    expect(collisions).toHaveLength(2);
    const families = collisions.map((c) => c.family).sort();
    expect(families).toEqual(['Inter', 'Merriweather']);
  });

  it('does not report a spurious collision when the same weight appears twice', () => {
    // Two @font-face rules at weight 400 for the same family (e.g.
    // pointing at Latin vs Cyrillic subsets) should NOT trigger the
    // collision warning — same weight, no distinct face is being lost.
    const entries = [
      { name: 'Inter', weight: 400, style: 'normal' },
      { name: 'Inter', weight: 400, style: 'normal' },
    ];
    expect(detectVariantSlotCollisions(entries)).toEqual([]);
  });
});

function syntheticSfnt(tags) {
  const bytes = new Uint8Array(12 + tags.length * 16);
  bytes.set([0, 1, 0, 0], 0);
  bytes[4] = (tags.length >>> 8) & 0xff;
  bytes[5] = tags.length & 0xff;
  tags.forEach((tag, index) => {
    for (let offset = 0; offset < 4; offset++) {
      bytes[12 + index * 16 + offset] = tag.charCodeAt(offset);
    }
  });
  return bytes.buffer;
}

describe('hasVariableFontTables', () => {
  it('recognises variation tables in an sfnt directory', () => {
    expect(hasVariableFontTables(syntheticSfnt(['cmap', 'fvar', 'gvar']))).toBe(true);
    expect(hasVariableFontTables(syntheticSfnt(['STAT', 'name']))).toBe(true);
  });

  it('does not flag a static sfnt or malformed input', () => {
    expect(hasVariableFontTables(syntheticSfnt(['cmap', 'glyf', 'name']))).toBe(false);
    expect(hasVariableFontTables(new Uint8Array([0, 1, 2]))).toBe(false);
  });
});

describe('getFontsFromStyleSheets slot-aware deduplication', () => {
  it('keeps one file that several weights of a family share', () => {
    // Google Fonts serves a single variable-font file for `Caveat` at
    // weight 600 and weight 700 — the two @font-face rules carry the same
    // URL. Deduplicating by URL alone let weight 600 claim the file and
    // dropped every weight-700 rule, so the family ended up with a `bold`
    // slot and no `regular` slot, and every non-bold Caveat run fell back
    // to a viewer substitute.
    const sheet = makeSheet([
      fontFaceRule({ family: 'Caveat', src: "url('caveat-var.woff2')", weight: '600' }),
      fontFaceRule({ family: 'Caveat', src: "url('caveat-var.woff2')", weight: '700' }),
    ]);

    const found = getFontsFromStyleSheets(new Set(['Caveat']), [sheet]);
    // Weight 600 and 700 both classify as `bold`, so they still collapse —
    // but into one entry by slot, not by URL.
    expect(found).toHaveLength(1);
    expect(found[0].weight).toBe('600');
  });

  it('keeps the same file once per distinct slot', () => {
    // Same file declared at weight 400 and weight 700: two different
    // PowerPoint slots, so both must survive.
    const sheet = makeSheet([
      fontFaceRule({ family: 'Caveat', src: "url('caveat-var.woff2')", weight: '400' }),
      fontFaceRule({ family: 'Caveat', src: "url('caveat-var.woff2')", weight: '700' }),
    ]);

    const found = getFontsFromStyleSheets(new Set(['Caveat']), [sheet]);
    expect(found).toHaveLength(2);
    expect(found.map((f) => classifyFontVariant(f.weight, f.style)).sort()).toEqual([
      'bold',
      'regular',
    ]);
  });

  it('keeps the same file for two different families', () => {
    const sheet = makeSheet([
      fontFaceRule({ family: 'Caveat', src: "url('shared.woff2')", weight: '400' }),
      fontFaceRule({ family: 'Caveat Alt', src: "url('shared.woff2')", weight: '400' }),
    ]);

    const found = getFontsFromStyleSheets(new Set(['Caveat', 'Caveat Alt']), [sheet]);
    expect(found).toHaveLength(2);
  });
});

describe('backfillRegularFontSlot', () => {
  it('fills an empty regular slot from a bold-italic-only family', () => {
    // Real case: a page requesting `Playfair+Display:ital,wght@1,700`
    // declares only a 700 italic face. The browser happily renders an
    // upright bold request with it; PowerPoint looks up the family's
    // regular slot, finds nothing, and substitutes a system font for the
    // whole family.
    const { fonts, backfilled } = backfillRegularFontSlot([
      { name: 'Playfair Display', variant: 'boldItalic', urls: ['pd-700i.woff2'] },
    ]);

    expect(backfilled).toEqual([{ family: 'Playfair Display', from: 'boldItalic' }]);
    const regular = fonts.find((f) => f.variant === 'regular');
    expect(regular).toMatchObject({
      name: 'Playfair Display',
      urls: ['pd-700i.woff2'],
      backfilledFrom: 'boldItalic',
    });
  });

  it('prefers bold over italic as the donor face', () => {
    const { fonts } = backfillRegularFontSlot([
      { name: 'Caveat', variant: 'italic', urls: ['caveat-i.woff2'] },
      { name: 'Caveat', variant: 'bold', urls: ['caveat-b.woff2'] },
    ]);

    const regular = fonts.find((f) => f.variant === 'regular');
    expect(regular.urls).toEqual(['caveat-b.woff2']);
    expect(regular.backfilledFrom).toBe('bold');
  });

  it('leaves a family alone when it already declares a regular face', () => {
    const input = [
      { name: 'Kalam', variant: 'regular', urls: ['kalam-400.woff2'] },
      { name: 'Kalam', variant: 'bold', urls: ['kalam-700.woff2'] },
    ];
    const { fonts, backfilled } = backfillRegularFontSlot(input);
    expect(backfilled).toEqual([]);
    expect(fonts).toHaveLength(2);
  });

  it('does not invent a bold slot for a regular-only family', () => {
    // PowerPoint synthesises bold from the embedded regular, the same way
    // the browser does. Registering the regular file under `bold` would
    // instead render bold runs at regular weight.
    const { fonts } = backfillRegularFontSlot([
      { name: 'Special Elite', variant: 'regular', urls: ['se-400.woff2'] },
    ]);
    expect(fonts.map((f) => f.variant)).toEqual(['regular']);
  });

  it('does not copy the donor url array by reference', () => {
    const donor = { name: 'Playfair Display', variant: 'bold', urls: ['pd.woff2'] };
    const { fonts } = backfillRegularFontSlot([donor]);
    const regular = fonts.find((f) => f.variant === 'regular');
    regular.urls.push('mutated.woff2');
    expect(donor.urls).toEqual(['pd.woff2']);
  });

  it('skips a donor with no urls', () => {
    const { fonts, backfilled } = backfillRegularFontSlot([
      { name: 'Ghost', variant: 'bold', urls: [] },
    ]);
    expect(backfilled).toEqual([]);
    expect(fonts).toHaveLength(1);
  });
});

describe('splitFontFamilyStack', () => {
  it('splits and unquotes a CSS font stack', () => {
    expect(splitFontFamilyStack('Kalam, "PingFang SC", \'Microsoft YaHei\', sans-serif')).toEqual([
      'Kalam',
      'PingFang SC',
      'Microsoft YaHei',
      'sans-serif',
    ]);
  });

  it('returns an empty list for missing input', () => {
    expect(splitFontFamilyStack('')).toEqual([]);
    expect(splitFontFamilyStack(undefined)).toEqual([]);
  });
});

describe('getUsedFontFamilies', () => {
  it('collects every family in the stack, not just the primary', () => {
    // The deck-authoring pattern that used to defeat auto-embed: the CJK
    // system font leads the stack and the web font that actually needs
    // embedding sits behind it.
    const root = document.createElement('div');
    root.innerHTML =
      '<p style="font-family: \'PingFang SC\', \'Playfair Display\', serif">x</p>';
    document.body.append(root);

    try {
      const families = getUsedFontFamilies(root);
      expect(families.has('PingFang SC')).toBe(true);
      expect(families.has('Playfair Display')).toBe(true);
    } finally {
      root.remove();
    }
  });
});

describe('resolveEastAsianFamily', () => {
  const cjk = (family) => family === 'PingFang SC' || family === 'Microsoft YaHei';

  it('picks the first CJK family behind a Latin primary', () => {
    expect(
      resolveEastAsianFamily('Kalam, "PingFang SC", "Microsoft YaHei", sans-serif', cjk)
    ).toBe('PingFang SC');
  });

  it('returns null when the primary family already covers CJK', () => {
    // Nothing to split: <a:latin> and <a:ea> would name the same family.
    expect(
      resolveEastAsianFamily('"PingFang SC", "Playfair Display", serif', cjk)
    ).toBeNull();
  });

  it('returns null when the stack names no CJK family', () => {
    // The browser resolved Han through an OS default outside the declared
    // stack; naming a typeface here would be a guess, not a translation.
    expect(resolveEastAsianFamily('Caveat, cursive', cjk)).toBeNull();
  });

  it('returns null for a single-family stack', () => {
    expect(resolveEastAsianFamily('"PingFang SC"', cjk)).toBeNull();
  });
});
