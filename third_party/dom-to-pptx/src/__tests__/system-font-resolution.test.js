// src/__tests__/system-font-resolution.test.js
//
// Tests for the "write what the browser actually rendered" machinery in
// src/utils.js (Layer 1) and the host-callback wiring in exportToPptx
// (Layer 2):
//
//   - familyIsAvailable: Latin-sentinel canvas probe with generic-keyword
//     short-circuit and caching; graceful degradation without canvas.
//   - familySupportsCjk: known-CJK families answered by availability (the
//     width probe cannot see the machine's own CJK fallback), everything
//     else still measured.
//   - resolveRenderedFontFamily / resolveStyleFontFamilies / getTextStyle:
//     the names the typeface attributes get.
//   - collectRenderedFonts: family -> rendered code points, shared with
//     getTextStyle so registered embed names match written ones.
//   - exportToPptx + resolveFontSource: called per rendered family with a
//     sorted unicodes array; null answers land in the embed report.
//
// The canvas stand-in resolves a font stack token-by-token against a width
// table: an "installed" family has its own widths, a missing one has none
// and falls through to the same width as the generic fallback behind it —
// exactly the real browser's behavior that the probe measures.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  EA_TYPEFACE_MARKER,
  familyIsAvailable,
  familySupportsCjk,
  resolveRenderedFontFamily,
  resolveStyleFontFamilies,
  getTextStyle,
  parseLinearGradientForText,
  GRADIENT_TYPEFACE_MARKER,
  collectRenderedFonts,
} from '../utils.js';

const GENERIC_WIDTHS = [
  ['monospace|MWil qB', 100], ['monospace|BESbswy', 90], ['monospace|永', 120],
  ['serif|MWil qB', 110], ['serif|BESbswy', 80], ['serif|永', 125],
];
const WIDTHS = new Map([
  ...GENERIC_WIDTHS,
  // Real Latin metrics, no Han (not a known CJK family -> probe decides).
  // Deliberately NO 永 entry: an unknown family falls through to whichever
  // generic the probe happens to be pairing it with, so it must measure
  // like monospace AND like serif.
  ['impact|MWil qB', 140], ['impact|BESbswy', 70],
  // Known CJK family; availability answers, so no Han entry needed.
  ['microsoft yahei|MWil qB', 105], ['microsoft yahei|BESbswy', 75],
  // Known CJK and present.
  ['hiragino sans gb|MWil qB', 120], ['hiragino sans gb|BESbswy', 60],
  // Unknown family that does carry Han: 永 measures its own width.
  ['webfoothic|MWil qB', 95], ['webfoothic|BESbswy', 77], ['webfoothic|永', 131],
  // Unknown family without Han: 永 absent -> falls through -> equals both
  // generic baselines.
  ['webfolatin|MWil qB', 99], ['webfolatin|BESbswy', 78],
]);

function makeFakeContext() {
  return {
    font: '',
    measureText(text) {
      const spec = this.font.replace(/^100px\s*/, '');
      for (const token of spec.split(',')) {
        const family = token.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
        const width = WIDTHS.get(`${family}|${text}`);
        if (width !== undefined) return { width };
      }
      /* c8 ignore next */
      return { width: 0 };
    },
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => makeFakeContext();
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe('familyIsAvailable', () => {
  it('recognizes an installed family by its Latin widths', () => {
    expect(familyIsAvailable('Impact')).toBe(true);
  });

  it('rejects a family whose text measures like the generic fallback', () => {
    expect(familyIsAvailable('No Such Font')).toBe(false);
  });

  it('rejects generic keywords without measuring', () => {
    expect(familyIsAvailable('sans-serif')).toBe(false);
    expect(familyIsAvailable('-apple-system')).toBe(false);
    expect(familyIsAvailable('')).toBe(false);
    expect(familyIsAvailable(null)).toBe(false);
  });

  it('normalizes quotes and whitespace before caching', () => {
    expect(familyIsAvailable(' "Impact" ')).toBe(true);
  });
});

describe('familySupportsCjk', () => {
  it('answers known CJK families from availability, not measurement', () => {
    // 'Microsoft YaHei' has no 永 entry in the table: only the known-list
    // path can return true here. This is the false negative that used to
    // silence the East Asian split on the machine's own CJK fallback.
    expect(familySupportsCjk('Microsoft YaHei')).toBe(true);
    // Known CJK, not installed on this (Windows-like) probe box.
    expect(familySupportsCjk('PingFang SC')).toBe(false);
  });

  it('measures unknown families against two different fallbacks', () => {
    expect(familySupportsCjk('WebFoothic')).toBe(true);
    expect(familySupportsCjk('WebFoLatin')).toBe(false);
  });

  it('rejects generic keywords', () => {
    expect(familySupportsCjk('serif')).toBe(false);
  });
});

describe('resolveRenderedFontFamily', () => {
  it('returns the first available family, skipping generics', () => {
    const isAvailable = (f) => f === 'Impact';
    expect(resolveRenderedFontFamily('Ghost, sans-serif, Impact, serif', isAvailable)).toBe('Impact');
  });

  it('returns null when nothing in the stack is installed', () => {
    expect(resolveRenderedFontFamily('Ghost Font, serif', () => false)).toBeNull();
  });

  it('defaults to the real probe', () => {
    expect(resolveRenderedFontFamily('"No Such Font", Impact, sans-serif')).toBe('Impact');
  });
});

describe('resolveStyleFontFamilies', () => {
  it('splits Latin from a CJK fallback family', () => {
    const { primaryFamily, eastAsianFamily } = resolveStyleFontFamilies(
      'Impact, "Microsoft YaHei", sans-serif'
    );
    expect(primaryFamily).toBe('Impact');
    expect(eastAsianFamily).toBe('Microsoft YaHei');
  });

  it('resolves the primary past a missing first entry', () => {
    const { primaryFamily, eastAsianFamily } = resolveStyleFontFamilies(
      '"PingFang SC", "Microsoft YaHei", sans-serif'
    );
    expect(primaryFamily).toBe('Microsoft YaHei');
    // Same name in both slots is not a split — writing it once is enough.
    expect(eastAsianFamily).toBeNull();
  });

  it('keeps the declared first family when nothing is installed', () => {
    const { primaryFamily, eastAsianFamily } = resolveStyleFontFamilies('Ghost Font, serif');
    expect(primaryFamily).toBe('Ghost Font');
    expect(eastAsianFamily).toBeNull();
  });
});

describe('getTextStyle', () => {
  const baseStyle = {
    color: 'rgb(0, 0, 0)',
    fontSize: '16px',
    fontWeight: '400',
    fontStyle: 'normal',
    textDecoration: 'none',
    letterSpacing: 'normal',
    lineHeight: 'normal',
    opacity: '1',
    marginTop: '0px',
    marginBottom: '0px',
    backgroundColor: 'transparent',
  };

  it('writes the primary__ea__eastAsian transport when both exist', () => {
    const textStyle = getTextStyle(
      { ...baseStyle, fontFamily: 'Impact, "Microsoft YaHei", sans-serif' },
      1
    );
    expect(textStyle.fontFace).toBe(`Impact${EA_TYPEFACE_MARKER}Microsoft YaHei`);
  });

  it('writes the resolved (installed) family, not the missing first entry', () => {
    const textStyle = getTextStyle(
      { ...baseStyle, fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif' },
      1
    );
    expect(textStyle.fontFace).toBe('Microsoft YaHei');
  });

  it('falls back to the declared first family when nothing is available', () => {
    const textStyle = getTextStyle({ ...baseStyle, fontFamily: '"No Such Font", serif' }, 1);
    expect(textStyle.fontFace).toBe('No Such Font');
  });
});

describe('getTextStyle gradient text flattening (background-clip: text)', () => {
  const clipStyle = {
    color: 'rgb(255, 255, 255)',
    fontSize: '56px',
    fontWeight: '900',
    fontStyle: 'normal',
    textDecoration: 'none',
    letterSpacing: 'normal',
    lineHeight: 'normal',
    opacity: '1',
    marginTop: '0px',
    marginBottom: '0px',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    fontFamily: 'Impact, sans-serif',
    webkitBackgroundClip: 'text',
    backgroundImage: 'linear-gradient(135deg, rgb(227, 6, 19) 0%, rgb(247, 183, 51) 100%)',
  };

  it('flattens to the first stop when -webkit-text-fill-color hides an opaque inherited color', () => {
    const textStyle = getTextStyle(
      { ...clipStyle, webkitTextFillColor: 'rgba(0, 0, 0, 0)' },
      1
    );
    expect(textStyle.color).toBe('E30613');
    expect(textStyle.transparency).toBeUndefined();
  });

  it('flattens to the first stop when color itself is transparent', () => {
    const textStyle = getTextStyle({ ...clipStyle, color: 'rgba(0, 0, 0, 0)' }, 1);
    // Regression: the stop's alpha used to be lost (opacity predated the
    // fallback swap), exporting the run at 100% transparency.
    expect(textStyle.color).toBe('E30613');
    expect(textStyle.transparency).toBeUndefined();
  });

  it('keeps the stop alpha for translucent watermarks', () => {
    const textStyle = getTextStyle(
      {
        ...clipStyle,
        color: 'rgba(0, 0, 0, 0)',
        backgroundImage:
          'linear-gradient(180deg, rgba(183, 148, 246, 0.55) 0%, rgba(183, 148, 246, 0.1) 100%)',
      },
      1
    );
    expect(textStyle.color).toBe('B794F6');
    expect(textStyle.transparency).toBe(45);
  });

  it('falls back to the solid colour when the clipped background has no gradient', () => {
    const textStyle = getTextStyle(
      {
        ...clipStyle,
        webkitTextFillColor: 'rgba(0, 0, 0, 0)',
        backgroundImage: 'none',
        backgroundColor: 'rgb(227, 6, 19)',
      },
      1
    );
    expect(textStyle.color).toBe('E30613');
    // The clipped background is the fill itself — it must not also become a
    // highlight band behind the glyphs.
    expect(textStyle.highlight).toBeUndefined();
  });

  it('leaves a visible fill untouched', () => {
    const textStyle = getTextStyle(
      { ...clipStyle, webkitTextFillColor: 'rgb(255, 255, 255)' },
      1
    );
    expect(textStyle.color).toBe('FFFFFF');
  });

  it('transports a supported linear gradient while retaining the solid fallback', () => {
    const textStyle = getTextStyle(
      {
        ...clipStyle,
        color: 'rgba(0, 0, 0, 0)',
        opacity: '0.8',
      },
      1
    );
    expect(textStyle.color).toBe('E30613');
    expect(textStyle.fontFace).toContain(
      `${GRADIENT_TYPEFACE_MARKER}lin;135;0:E30613:100,100:F7B733:100;80`
    );
  });
});

describe('parseLinearGradientForText', () => {
  it('normalizes directions, omitted positions, and translucent stops', () => {
    const gradient = parseLinearGradientForText(
      'linear-gradient(to right, rgb(227, 6, 19), rgba(247, 183, 51, 0.5))'
    );
    expect(gradient).toEqual({
      cssAngleDeg: 90,
      stops: [
        { posPct: 0, hex: 'E30613', alpha: 1 },
        { posPct: 100, hex: 'F7B733', alpha: 0.5 },
      ],
    });
  });

  it('rejects layered, radial, and pixel-positioned backgrounds for solid fallback', () => {
    expect(parseLinearGradientForText('linear-gradient(red 0px, blue 20px)')).toBeNull();
    expect(parseLinearGradientForText('radial-gradient(red, blue)')).toBeNull();
    expect(parseLinearGradientForText('linear-gradient(red, blue), url(texture.png)')).toBeNull();
  });
});

describe('collectRenderedFonts', () => {
  it('maps rendered code points per resolved family', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div style="font-family: 'Impact', 'Microsoft YaHei', sans-serif">Hi你</div>
      <div style="font-family: 'WebFoLatin', serif">Latin</div>
      <div style="display: none; font-family: 'Impact'">Hidden</div>
      <div style="font-family: 'Impact'">   </div>
    `;
    const usage = collectRenderedFonts(root);

    const impact = usage.get('Impact');
    expect([...impact].sort((a, b) => a - b)).toEqual([72, 105, 0x4f60]);
    expect(usage.get('Microsoft YaHei').has(0x4f60)).toBe(true);
    expect(usage.get('WebFoLatin').has(76)).toBe(true);
    // Hidden and whitespace-only text never paint and never pull in a font:
    // 'Hidden' shares Impact but adds 'd'(100); the blank div adds nothing.
    expect(impact.has(100)).toBe(false);
    expect(usage.size).toBe(3);
  });

  it('uses exactly the names getTextStyle writes', () => {
    const fontFamily = '"PingFang SC", "Microsoft YaHei", sans-serif';
    const root = document.createElement('div');
    root.style.fontFamily = fontFamily;
    root.textContent = '永';
    const usage = collectRenderedFonts(root);
    const { primaryFamily, eastAsianFamily } = resolveStyleFontFamilies(fontFamily);
    expect([...usage.keys()]).toEqual([primaryFamily]);
    expect(eastAsianFamily).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layer 2: exportToPptx asks the host for system font sources
// ---------------------------------------------------------------------------

vi.mock('pptxgenjs', () => {
  const mockShapeType = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse' };
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        defineLayout: vi.fn(),
        addSlide: vi.fn(() => ({
          addText: vi.fn(),
          addShape: vi.fn(),
          addImage: vi.fn(),
          addTable: vi.fn(),
          addNotes: vi.fn(),
        })),
        write: vi.fn(() => Promise.resolve('')),
        ShapeType: mockShapeType,
      };
    }),
  };
});

vi.mock('html2canvas', () => ({
  default: vi.fn((node, options = {}) => {
    const scale = Number(options.scale) || 1;
    return Promise.resolve({
      width: Math.max(Math.round((Number(options.width) || 1) * scale), 1),
      height: Math.max(Math.round((Number(options.height) || 1) * scale), 1),
      toDataURL: () => 'data:image/png;base64,tile',
    });
  }),
}));

vi.mock('../image-processor.js', () => ({
  getProcessedImage: vi.fn(() => Promise.resolve('data:image/png;base64,mock')),
  resolveRasterScale: vi.fn(() => 2),
}));

const { exportToPptx } = await import('../index.js');

function makeSlide(fontFamily, text = 'Hello 你') {
  const slide = document.createElement('div');
  slide.style.width = '960px';
  slide.style.height = '540px';
  const line = document.createElement('div');
  line.style.fontFamily = fontFamily;
  line.style.fontSize = '24px';
  line.style.color = 'rgb(0, 0, 0)';
  line.textContent = text;
  slide.appendChild(line);
  document.body.appendChild(slide);
  return slide;
}

describe('exportToPptx resolveFontSource wiring', () => {
  it('asks once per rendered system family with sorted unicodes', async () => {
    const calls = [];
    let report = null;
    const slide = makeSlide('"Impact", "Microsoft YaHei", sans-serif');
    try {
      await exportToPptx(slide, {
        skipDownload: true,
        skipNormalize: true,
        autoEmbedFonts: false,
        resolveFontSource: async (family, request) => {
          calls.push({ family, request });
          return null;
        },
        onFontEmbedReport: (r) => { report = r; },
      });
    } finally {
      slide.remove();
    }

    expect(calls.map((c) => c.family)).toEqual(['Impact', 'Microsoft YaHei']);
    const { unicodes } = calls[0].request;
    expect(Array.isArray(unicodes)).toBe(true);
    expect(unicodes).toEqual([...new Set(unicodes)].sort((a, b) => a - b));
    // Deck text ...
    expect(unicodes).toContain(0x4f60);
    expect(unicodes).toContain(72);
    // ... plus the ASCII / CJK-punctuation safety ranges.
    expect(unicodes).toContain(0x20);
    expect(unicodes).toContain(0x7e);
    expect(unicodes).toContain(0x3000);
    expect(unicodes).toContain(0xff00);

    expect(report).not.toBeNull();
    expect(report.embedded).toEqual([]);
    expect(report.failed.map((f) => f.font)).toEqual(['Impact', 'Microsoft YaHei']);
    expect(report.failed.every((f) => f.reason)).toBe(true);
  });

  it('skips system font discovery when embedSystemFonts is false', async () => {
    const resolveFontSource = vi.fn(async () => null);
    const slide = makeSlide('"Impact", sans-serif');
    try {
      await exportToPptx(slide, {
        skipDownload: true,
        skipNormalize: true,
        autoEmbedFonts: false,
        embedSystemFonts: false,
        resolveFontSource,
      });
    } finally {
      slide.remove();
    }
    expect(resolveFontSource).not.toHaveBeenCalled();
  });

  it('reports a throwing host callback without failing the export', async () => {
    let report = null;
    const slide = makeSlide('"Impact", sans-serif');
    try {
      await exportToPptx(slide, {
        skipDownload: true,
        skipNormalize: true,
        autoEmbedFonts: false,
        resolveFontSource: async () => {
          throw new Error('disk exploded');
        },
        onFontEmbedReport: (r) => { report = r; },
      });
    } finally {
      slide.remove();
    }
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].font).toBe('Impact');
    expect(report.failed[0].reason).toContain('disk exploded');
  });
});

describe('probe without canvas (fresh module)', () => {
  it('treats every family as unavailable when getContext returns null', async () => {
    vi.resetModules();
    HTMLCanvasElement.prototype.getContext = () => null;
    try {
      const fresh = await import('../utils.js');
      expect(fresh.familyIsAvailable('Impact')).toBe(false);
      // Known-CJK path funnels into availability, so it also degrades.
      expect(fresh.familySupportsCjk('SimHei')).toBe(false);
      expect(fresh.resolveRenderedFontFamily('Impact, serif')).toBeNull();
    } finally {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      vi.resetModules();
    }
  });
});
