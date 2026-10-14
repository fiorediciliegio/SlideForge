// src/__tests__/line-spacing.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { collectTextParts, resolveLineSpacing, unifyParagraphLineSpacing } from '../utils.js';

// The export maps a 1920px-wide page onto a 13.33in slide.
const SCALE = 2 / 3;

const spacings = (parts) => parts.map((part) => part.options?.lineSpacing);

const run = (lineSpacing, extra = {}) => ({
  text: 'x',
  options: { ...(lineSpacing === null ? {} : { lineSpacing }), ...extra },
});

describe('resolveLineSpacing', () => {
  it('converts a pixel line-height to scaled points', () => {
    // 79.2px -> 59.4pt, then two thirds of that for the slide scale.
    expect(resolveLineSpacing({ lineHeight: '79.2px', fontSize: '88px' }, SCALE)).toBeCloseTo(39.6, 5);
  });

  it('resolves a unitless line-height against the element font size', () => {
    expect(resolveLineSpacing({ lineHeight: '0.9', fontSize: '88px' }, 1)).toBeCloseTo(59.4, 5);
  });

  it('leaves normal, missing and degenerate line-heights to the viewer', () => {
    expect(resolveLineSpacing({ lineHeight: 'normal', fontSize: '16px' }, 1)).toBeNull();
    expect(resolveLineSpacing({ lineHeight: '', fontSize: '16px' }, 1)).toBeNull();
    expect(resolveLineSpacing({ lineHeight: '0px', fontSize: '16px' }, 1)).toBeNull();
  });
});

describe('unifyParagraphLineSpacing', () => {
  it('raises every run of a paragraph to the tallest line spacing', () => {
    // The order that used to matter: PptxGenJS keeps one <a:pPr> per paragraph,
    // so a trailing unit span was sizing the line for the number before it.
    const parts = [run(39.6), run(14.4)];
    unifyParagraphLineSpacing(parts);
    expect(spacings(parts)).toEqual([39.6, 39.6]);
  });

  it('is independent of run order', () => {
    const parts = [run(14.4), run(39.6), run(21.6)];
    unifyParagraphLineSpacing(parts);
    expect(spacings(parts)).toEqual([39.6, 39.6, 39.6]);
  });

  it('keeps paragraphs independent of each other', () => {
    const parts = [
      run(39.6),
      run(14.4, { breakLine: true }),
      run(12),
      run(18, { breakLine: true }),
      run(9),
    ];
    unifyParagraphLineSpacing(parts);
    expect(spacings(parts)).toEqual([39.6, 39.6, 18, 18, 9]);
  });

  it('carries the paragraph spacing onto its bare line break', () => {
    const parts = [run(39.6), { text: '', options: { breakLine: true } }, run(12)];
    unifyParagraphLineSpacing(parts);
    expect(spacings(parts)).toEqual([39.6, 39.6, 12]);
  });

  it('leaves runs alone when no run declares line spacing', () => {
    const parts = [run(null), run(null)];
    unifyParagraphLineSpacing(parts);
    expect(spacings(parts)).toEqual([undefined, undefined]);
  });
});

describe('collectTextParts line spacing', () => {
  beforeAll(() => {
    // jsdom has no 2D rasterizer, and text styles run every colour through one.
    let fillStyle = '';
    HTMLCanvasElement.prototype.getContext = () => ({
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value) {
        fillStyle = value;
      },
      clearRect: () => {},
      fillRect: () => {},
      getImageData: () => ({ data: [0, 0, 0, 0] }),
    });
  });

  const mount = (element) => {
    document.body.appendChild(element);
    return () => document.body.removeChild(element);
  };

  const styled = (tag, styles, text) => {
    const element = document.createElement(tag);
    Object.assign(element.style, styles);
    if (text) element.appendChild(document.createTextNode(text));
    return element;
  };

  it('sizes a big-number-plus-unit paragraph from the number, not the unit', () => {
    // `1860万`: an 88px number with `line-height: 0.9` and a 32px unit span.
    // Chrome resolves the inherited multiplier per element, so the unit run
    // arrives with a 28.8px line box — a third of the number's 79.2px. Exact
    // line spacing is laid out from the line bottom, so letting the unit win
    // shoved the digits up over the label above them.
    const number = styled('span', { fontSize: '88px', lineHeight: '79.2px' }, '1860');
    number.appendChild(styled('span', { fontSize: '32px', lineHeight: '28.8px' }, '万'));
    const unmount = mount(number);

    const parts = collectTextParts(number, window.getComputedStyle(number), SCALE);

    expect(parts.map((part) => part.text)).toEqual(['1860', '万']);
    expect(spacings(parts)).toEqual([39.6, 39.6]);

    unmount();
  });

  it('holds the line open with the block strut when every run is smaller', () => {
    const block = styled('div', { fontSize: '60px', lineHeight: '90px' });
    block.appendChild(styled('span', { fontSize: '12px', lineHeight: '18px' }, 'x'));
    const unmount = mount(block);

    const parts = collectTextParts(block, window.getComputedStyle(block), 1);

    expect(spacings(parts)).toEqual([67.5]);

    unmount();
  });

  it('gives a nested block its own strut instead of the ancestor line height', () => {
    const outer = styled('div', { fontSize: '60px', lineHeight: '90px' });
    outer.appendChild(styled('div', { fontSize: '12px', lineHeight: '18px' }, 'x'));
    const unmount = mount(outer);

    const parts = collectTextParts(outer, window.getComputedStyle(outer), 1);

    expect(spacings(parts)).toEqual([13.5]);

    unmount();
  });

  it('leaves a paragraph without any declared line-height to the viewer', () => {
    const paragraph = styled('p', {}, 'plain');
    const unmount = mount(paragraph);

    const parts = collectTextParts(paragraph, window.getComputedStyle(paragraph), SCALE);

    expect(spacings(parts)).toEqual([undefined]);

    unmount();
  });
});
