import { describe, it, expect, afterEach, vi } from 'vitest';
import { svgToPng, svgToSvg } from '../utils.js';

// Regression: an SVG root positioned with inline CSS (`position:absolute;
// left/top; z-index`) serialized straight into a standalone document paints
// its content outside the image viewport, so the rasterized PNG is fully
// transparent and the element silently disappears from the deck (preset-111
// line chart). The converters must strip layout props from the clone root.

function mount(layoutStyle) {
  document.body.innerHTML = `
    <svg id="chart" style="${layoutStyle}" viewBox="0 0 1600 260" preserveAspectRatio="none">
      <path d="M0 10 L100 10" stroke="#7c3aed" stroke-width="3" fill="none"></path>
      <circle cx="50" cy="10" r="4" fill="#7c3aed"></circle>
    </svg>`;
  return document.getElementById('chart');
}

const LAYOUT_STYLE =
  'position:absolute;left:220px;top:250px;width:1600px;height:260px;z-index:4;';

function rootStyleAttr(xml) {
  const m = xml.match(/<svg[^>]*>/);
  const tag = m ? m[0] : '';
  const s = tag.match(/style="([^"]*)"/);
  return s ? s[1] : '';
}

const savedImage = global.Image;
const savedGetContext = HTMLCanvasElement.prototype.getContext;
const savedToDataURL = HTMLCanvasElement.prototype.toDataURL;

function stubRasterizer(capture) {
  global.Image = class {
    set src(value) {
      capture.svgUrl = value;
      Promise.resolve().then(() => this.onload && this.onload());
    }
  };
  HTMLCanvasElement.prototype.getContext = () => ({
    scale() {},
    drawImage() {},
    getImageData: () => ({ data: [] }),
  });
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,OK';
}

afterEach(() => {
  global.Image = savedImage;
  HTMLCanvasElement.prototype.getContext = savedGetContext;
  HTMLCanvasElement.prototype.toDataURL = savedToDataURL;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('SVG root layout-style stripping (blank chart regression)', () => {
  it('svgToPng serializes a root free of layout CSS', async () => {
    const capture = {};
    stubRasterizer(capture);
    const node = mount(LAYOUT_STYLE);

    const png = await svgToPng(node);
    expect(png).toBe('data:image/png;base64,OK');

    const xml = decodeURIComponent(capture.svgUrl.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    const style = rootStyleAttr(xml);
    expect(style).not.toMatch(/position/i);
    expect(style).not.toMatch(/(^|;)\s*(left|right|top|bottom)\s*:/i);
    expect(style).not.toMatch(/z-index/i);
    expect(style).not.toMatch(/(^|;)\s*display\s*:/i);
    expect(style).not.toMatch(/(^|;)\s*margin/i);
    // box sizing stays untouched
    expect(style).toMatch(/width\s*:\s*1600px/i);
    expect(style).toMatch(/height\s*:\s*260px/i);
    // explicit attributes still present
    expect(xml).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('svgToSvg serializes a root free of layout CSS', async () => {
    const node = mount(LAYOUT_STYLE);

    const url = await svgToSvg(node);
    const xml = Buffer.from(url.split(',')[1], 'base64').toString('utf-8');
    const style = rootStyleAttr(xml);
    expect(style).not.toMatch(/position/i);
    expect(style).not.toMatch(/(^|;)\s*(left|right|top|bottom)\s*:/i);
    expect(style).not.toMatch(/z-index/i);
    expect(style).toMatch(/width\s*:\s*1600px/i);
    expect(xml).toMatch(/<svg[^>]*width="300"/);
  });

  it('keeps non-layout root styles (transform, overflow, opacity)', async () => {
    const node = mount('position:absolute;left:10px;transform:rotate(0deg);overflow:visible;');
    const capture = {};
    stubRasterizer(capture);

    await svgToPng(node);
    const xml = decodeURIComponent(capture.svgUrl.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
    const style = rootStyleAttr(xml);
    expect(style).toMatch(/transform/i);
    expect(style).toMatch(/overflow/i);
  });

  it('materializes a simple root background and uniform solid border behind SVG content', async () => {
    const node = mount('width:1600px;height:260px;background:#ffffff;border:2px solid #111111;');

    const url = await svgToSvg(node);
    const xml = Buffer.from(url.split(',')[1], 'base64').toString('utf-8');

    const boxRect = xml.match(/<rect[^>]*data-dom-to-pptx-root-box="true"[^>]*\/>/)?.[0] || '';
    expect(boxRect).toContain('fill="#ffffff"');
    expect(boxRect).toContain('stroke="#111111"');
    expect(xml.indexOf('data-dom-to-pptx-root-box')).toBeLessThan(xml.indexOf('<path'));
  });

  it('does not add a root box for transparent SVGs or unsupported non-uniform rounded borders', async () => {
    const transparent = mount('width:1600px;height:260px;');
    const transparentUrl = await svgToSvg(transparent);
    expect(Buffer.from(transparentUrl.split(',')[1], 'base64').toString('utf-8')).not.toContain('data-dom-to-pptx-root-box');

    const rounded = mount('width:1600px;height:260px;background:#ffffff;border:2px solid #111111;border-radius:4px 8px;');
    const roundedUrl = await svgToSvg(rounded);
    expect(Buffer.from(roundedUrl.split(',')[1], 'base64').toString('utf-8')).not.toContain('data-dom-to-pptx-root-box');
  });

  it('preserves a uniform pixel root radius as SVG rect geometry', async () => {
    const node = mount('width:1600px;height:260px;background:#ffffff;border:2px solid #111111;border-radius:4px;');
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ width: 1600, height: 260 });
    const url = await svgToSvg(node);
    const xml = Buffer.from(url.split(',')[1], 'base64').toString('utf-8');

    expect(xml).toMatch(/<rect[^>]*rx="4"[^>]*ry="4"[^>]*data-dom-to-pptx-root-box="true"/);
  });
});
