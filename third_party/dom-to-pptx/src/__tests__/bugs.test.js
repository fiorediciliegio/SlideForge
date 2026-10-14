import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { collectTextParts } from '../utils.js';
import { exportToPptx } from '../index.js';
import { getProcessedImage } from '../image-processor.js';

// Mock pptxgenjs
const mockAddText = vi.fn();
const mockAddImage = vi.fn();
const mockAddShape = vi.fn();
const mockAddSlide = vi.fn(() => ({
  addText: mockAddText,
  addShape: mockAddShape,
  addImage: mockAddImage,
  addTable: vi.fn(),
}));

vi.mock('../image-processor.js', () => ({
  getProcessedImage: vi.fn(() => Promise.resolve('data:image/png;base64,mock')),
  resolveRasterScale: vi.fn(({ requestedScale = 2, pptxScale = 1, maxDpi = 150 } = {}) =>
    Math.min(Math.max(Number(requestedScale) || 2, 0.01), Math.max(((Number(pptxScale) || 1) * maxDpi) / 96, 0.01))),
}));

// jsdom has no 2D rasterizer, so stand in for the browser paint that produces
// background tiles and element captures. The reported canvas size mirrors
// html2canvas (capture window x supersample), because <a:tile> sx is derived
// from the dimensions the raster actually came back with.
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

vi.mock('pptxgenjs', () => {
  const mockShapeType = { rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse' };
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        defineLayout: vi.fn(),
        addSlide: mockAddSlide,
        write: vi.fn(() => Promise.resolve('')),
        ShapeType: mockShapeType,
      };
    }),
  };
});

describe('Bug 2: Only nested inline badges carry a run highlight', () => {
  beforeAll(() => {
    // Mock HTMLCanvasElement.prototype.getContext for JSDOM env
    let fillStyle = '';
    HTMLCanvasElement.prototype.getContext = () => ({
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(val) {
        fillStyle = val;
      },
      clearRect: () => {},
      fillRect: () => {},
      getImageData: () => ({ data: [0, 0, 0, 0] }),
    });
  });

  const badge = (backgroundColor) => {
    const span = document.createElement('span');
    span.style.backgroundColor = backgroundColor;
    span.style.display = 'inline-block';
    span.appendChild(document.createTextNode('LABEL'));
    return span;
  };

  it('drops the highlight on the shape root, whose background is already the shape fill', () => {
    // An inline-block badge exported on its own gets a shape of its own, and
    // that shape's fill already carries the background with its alpha and its
    // border radius. A highlight would paint the same colour a second time at
    // full opacity and bury same-coloured text under an opaque slab.
    const span = badge('blue');
    document.body.appendChild(span);

    const parts = collectTextParts(span, window.getComputedStyle(span), 1);
    expect(parts[0].options.highlight).toBeUndefined();

    document.body.removeChild(span);
  });

  it('keeps the highlight on an inline badge nested inside a text container', () => {
    // Here the shape belongs to the paragraph, so the badge's own background has
    // no fill to live in and the run highlight is the only carrier left.
    const paragraph = document.createElement('p');
    paragraph.appendChild(badge('blue'));
    document.body.appendChild(paragraph);

    const parts = collectTextParts(paragraph, window.getComputedStyle(paragraph), 1);
    expect(parts[0].options.highlight).toBe('0000FF');

    document.body.removeChild(paragraph);
  });

  it('flattens a translucent nested badge background against its ancestors', () => {
    // `highlight` has no alpha channel, so an 8% tint would otherwise ship as a
    // fully opaque slab. Composited over white, rgba(10, 69, 149, 0.08) is EBF0F7.
    const paragraph = document.createElement('p');
    paragraph.appendChild(badge('rgba(10, 69, 149, 0.08)'));
    document.body.appendChild(paragraph);

    const parts = collectTextParts(paragraph, window.getComputedStyle(paragraph), 1);
    expect(parts[0].options.highlight).toBe('EBF0F7');

    document.body.removeChild(paragraph);
  });

  it('drops the highlight on a block element', () => {
    const div = document.createElement('div');
    div.style.backgroundColor = 'blue';
    div.style.display = 'block';
    div.appendChild(document.createTextNode('LABEL'));
    document.body.appendChild(div);

    const parts = collectTextParts(div, window.getComputedStyle(div), 1);
    expect(parts[0].options.highlight).toBeUndefined();

    document.body.removeChild(div);
  });
});

describe('Bug: descendant content inherits an ancestor rotation', () => {
  it('rotates an editable text box inside a tilted container', async () => {
    mockAddText.mockClear();

    const slide = document.createElement('div');
    slide.style.width = '960px';
    slide.style.height = '540px';
    const tiltedCard = document.createElement('div');
    tiltedCard.style.transform = 'rotate(-7deg)';
    const text = document.createElement('div');
    text.textContent = 'Tilted child text';
    tiltedCard.appendChild(text);
    slide.appendChild(tiltedCard);
    document.body.appendChild(slide);

    const setRect = (node, { width, height, left, top }) => {
      node.getBoundingClientRect = () => ({ x: left, y: top, width, height, left, top, right: left + width, bottom: top + height });
      Object.defineProperty(node, 'offsetWidth', { configurable: true, value: width });
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: height });
    };
    setRect(slide, { width: 960, height: 540, left: 0, top: 0 });
    setRect(tiltedCard, { width: 240, height: 140, left: 100, top: 100 });
    setRect(text, { width: 180, height: 30, left: 125, top: 135 });

    await exportToPptx(slide, { skipDownload: true, skipNormalize: true });

    const call = mockAddText.mock.calls.find(([parts]) =>
      Array.isArray(parts) && parts.map((part) => part.text).join('').includes('Tilted child text')
    );
    expect(call).toBeDefined();
    expect(call[1].rotate).toBe(-7);

    document.body.removeChild(slide);
  });
});

describe('Bug: page canvas backgrounds survive nested slide-shell export', () => {
  it('keeps full-page canvas fills when the authored slide is nested in a shell', async () => {
    mockAddShape.mockClear();

    const shell = document.createElement('div');
    shell.style.width = '960px';
    shell.style.height = '540px';
    shell.style.backgroundColor = '#121110';
    const authoredSlide = document.createElement('div');
    authoredSlide.className = 'slide';
    authoredSlide.style.width = '960px';
    authoredSlide.style.height = '540px';
    authoredSlide.style.backgroundColor = '#F5EEDF';
    authoredSlide.style.backgroundImage = 'linear-gradient(to right, rgba(184, 93, 53, 0.07), transparent)';
    shell.appendChild(authoredSlide);
    document.body.appendChild(shell);

    const setRect = (node) => {
      node.getBoundingClientRect = () => ({ x: 0, y: 0, width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 });
      Object.defineProperty(node, 'offsetWidth', { configurable: true, value: 960 });
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 540 });
    };
    setRect(shell);
    setRect(authoredSlide);

    await exportToPptx(shell, { skipDownload: true, skipNormalize: true });

    const pageFills = mockAddShape.mock.calls.filter(([, options]) =>
      options.w === 10 && options.h === 5.625 && ['121110', 'F5EEDF'].includes(options.fill?.color)
    );
    expect(pageFills.some(([, options]) => options.fill.color === '121110')).toBe(true);
    expect(pageFills.some(([, options]) => options.fill.color === 'F5EEDF')).toBe(true);

    document.body.removeChild(shell);
  });
});

describe('Bug: native table cells retain simple visual components', () => {
  it('exports a CSS status dot as a slide-level editable shape above the table', async () => {
    mockAddShape.mockClear();

    const slide = document.createElement('div');
    slide.style.width = '960px';
    slide.style.height = '540px';
    const table = document.createElement('table');
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    const dot = document.createElement('span');
    dot.style.display = 'inline-block';
    dot.style.width = '20px';
    dot.style.height = '20px';
    dot.style.borderRadius = '50%';
    dot.style.backgroundColor = '#1D4ED8';
    cell.appendChild(dot);
    row.appendChild(cell);
    table.appendChild(row);
    slide.appendChild(table);
    document.body.appendChild(slide);

    const setRect = (node, { width, height, left, top }) => {
      node.getBoundingClientRect = () => ({ x: left, y: top, width, height, left, top, right: left + width, bottom: top + height });
      Object.defineProperty(node, 'offsetWidth', { configurable: true, value: width });
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: height });
    };
    setRect(slide, { width: 960, height: 540, left: 0, top: 0 });
    setRect(table, { width: 240, height: 50, left: 100, top: 100 });
    setRect(row, { width: 240, height: 50, left: 100, top: 100 });
    setRect(cell, { width: 240, height: 50, left: 100, top: 100 });
    setRect(dot, { width: 20, height: 20, left: 210, top: 115 });

    await exportToPptx(slide, { skipDownload: true, skipNormalize: true });

    const dotCall = mockAddShape.mock.calls.find(([, options]) => options.fill?.color === '1D4ED8');
    expect(dotCall).toBeDefined();
    expect(dotCall[0]).toBe('ellipse');
    expect(dotCall[1].x).toBeCloseTo(2.1875, 8);
    expect(dotCall[1].y).toBeCloseTo(1.1979166666666667, 8);
    expect(dotCall[1].w).toBeCloseTo(0.20833333333333334, 8);
    expect(dotCall[1].h).toBeCloseTo(0.20833333333333334, 8);

    document.body.removeChild(slide);
  });
});

describe('Bug 2b: A badge shape carries its background as a fill, not as a run highlight', () => {
  it('exports a translucent inline-block badge as a translucent fill with no highlight', async () => {
    mockAddText.mockClear();

    const container = document.createElement('div');
    container.className = 'slide';
    container.style.width = '960px';
    container.style.height = '540px';

    // A wrapper with a block sibling is not a text container, so the badge is
    // walked as an element of its own and becomes its own shape — the shape that
    // used to receive both a translucent fill and an opaque same-colour highlight.
    const wrapper = document.createElement('div');
    const badge = document.createElement('span');
    badge.style.display = 'inline-block';
    badge.style.backgroundColor = 'rgba(10, 69, 149, 0.08)';
    badge.style.color = 'rgb(10, 69, 149)';
    badge.textContent = 'ACT I';
    const title = document.createElement('p');
    title.textContent = 'Heading';
    wrapper.appendChild(badge);
    wrapper.appendChild(title);
    container.appendChild(wrapper);
    document.body.appendChild(container);

    // Mock layout measurements
    container.getBoundingClientRect = () => ({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 });
    wrapper.getBoundingClientRect = () => ({ width: 400, height: 100, left: 30, top: 30, right: 430, bottom: 130 });
    badge.getBoundingClientRect = () => ({ width: 80, height: 20, left: 30, top: 30, right: 110, bottom: 50 });
    title.getBoundingClientRect = () => ({ width: 400, height: 30, left: 30, top: 60, right: 430, bottom: 90 });

    await exportToPptx(container, { skipDownload: true, skipNormalize: true });

    const badgeCall = mockAddText.mock.calls.find(([textParts]) => {
      if (!Array.isArray(textParts)) return false;
      return textParts
        .map((part) => part.text)
        .join('')
        .trim() === 'ACT I';
    });

    expect(badgeCall).toBeDefined();

    const [textParts, options] = badgeCall;
    expect(options.fill.color).toBe('0A4595');
    expect(options.fill.transparency).toBeCloseTo(92, 5);
    expect(textParts.every((part) => part.options?.highlight === undefined)).toBe(true);

    document.body.removeChild(container);
  });
});

describe('Bug 3: No duplicate rendering of inline elements', () => {
  it('should not render independent shape+text for span child inside text container', async () => {
    mockAddText.mockClear();

    const container = document.createElement('div');
    container.className = 'slide';
    container.style.width = '960px';
    container.style.height = '540px';

    const div = document.createElement('div');
    div.innerHTML = 'Some text <span>PMA</span> other text';
    container.appendChild(div);
    document.body.appendChild(container);

    // Mock layout measurements
    container.getBoundingClientRect = () => ({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 });
    div.getBoundingClientRect = () => ({ width: 900, height: 100, left: 30, top: 30, right: 930, bottom: 130 });
    const span = div.querySelector('span');
    span.getBoundingClientRect = () => ({ width: 50, height: 20, left: 150, top: 35, right: 200, bottom: 55 });

    await exportToPptx(container, { skipDownload: true, skipNormalize: true });

    // Assert that we don't have separate text box for 'PMA'
    // The text 'PMA' should only be present inside the main text box containing the full parts list.
    const pmaCalls = mockAddText.mock.calls.filter((call) => {
      const [textParts] = call;
      if (Array.isArray(textParts)) {
        const textStr = textParts
          .map((p) => p.text)
          .join('')
          .trim();
        return textStr === 'PMA';
      }
      return false;
    });

    expect(pmaCalls.length).toBe(0);

    document.body.removeChild(container);
  });
});

describe('Bug 4: Image opacity is preserved in PPTX', () => {
  // Every source handed to an <img>, so a test can read back the markup the
  // <foreignObject> painter was asked to draw.
  const paintedImageSources = [];

  beforeAll(() => {
    // jsdom decodes no images, and never fires load or error for an SVG data
    // URL, so fail the <foreignObject> painter immediately and let the tests
    // exercise the html2canvas fallback instead of waiting out its timeout.
    class UndecodableImage {
      set src(value) {
        paintedImageSources.push(String(value));
        Promise.resolve().then(() => this.onerror?.(new Error('jsdom decodes no images')));
      }
    }
    vi.stubGlobal('Image', UndecodableImage);

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
      getImageData: () => ({ data: [0, 0, 0, 255] }),
    });
  });

  function setRect(element, { width = 960, height = 540, left = 0, top = 0 } = {}) {
    element.getBoundingClientRect = () => ({
      width,
      height,
      left,
      top,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    });
  }

  async function exportElement(element, options = {}) {
    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);
    setRect(element);
    container.appendChild(element);
    document.body.appendChild(container);

    mockAddImage.mockClear();
    mockAddShape.mockClear();
    await exportToPptx(container, { skipDownload: true, skipNormalize: true, ...options });
    document.body.removeChild(container);

    return mockAddImage.mock.calls.map(([options]) => options);
  }

  it('applies an img element opacity as image transparency', async () => {
    const image = document.createElement('img');
    image.src = 'https://example.com/background.png';
    image.style.opacity = '0.15';

    const imageOptions = await exportElement(image);

    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0].transparency).toBeCloseTo(85);
  });

  it('combines parent and img opacity as image transparency', async () => {
    const wrapper = document.createElement('div');
    wrapper.style.opacity = '0.5';
    setRect(wrapper);

    const image = document.createElement('img');
    image.src = 'https://example.com/background.png';
    image.style.opacity = '0.5';
    setRect(image);
    wrapper.appendChild(image);

    const imageOptions = await exportElement(wrapper);

    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0].transparency).toBeCloseTo(75);
  });

  it('applies element opacity to a CSS background image', async () => {
    const background = document.createElement('div');
    background.style.backgroundImage = 'url("https://example.com/background.png")';
    background.style.backgroundSize = 'cover';
    background.style.opacity = '0.05';

    const imageOptions = await exportElement(background);

    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0].transparency).toBeCloseTo(95);
  });

  it('does not add transparency to an opaque image', async () => {
    const image = document.createElement('img');
    image.src = 'https://example.com/background.png';

    const imageOptions = await exportElement(image);

    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0]).not.toHaveProperty('transparency');
  });

  it('passes a complete SVG data URL with an internal fragment to image processing', async () => {
    const background = document.createElement('div');
    const dataUrl =
      'data:image/svg+xml,%3Csvg viewBox="0 0 200 200"%3E%3Cfilter id="noiseFilter"/%3E%3Crect filter="url(%23noiseFilter)"/%3E%3C/svg%3E';
    background.style.backgroundImage = `url('${dataUrl}')`;
    vi.mocked(getProcessedImage).mockClear();

    await exportElement(background);

    expect(getProcessedImage).toHaveBeenCalledOnce();
    expect(vi.mocked(getProcessedImage).mock.calls[0][0]).toBe(dataUrl);
  });

  it('rasterizes SVG noise textures at their intrinsic tile size', async () => {
    const background = document.createElement('div');
    const dataUrl =
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise"/></filter><rect width="200" height="200" filter="url(%23n)"/></svg>';
    background.style.backgroundImage = `url('${dataUrl}')`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getProcessedImage).mockClear();

    const imageOptions = await exportElement(background);

    expect(imageOptions).toHaveLength(1);
    expect(getProcessedImage).toHaveBeenCalledOnce();
    expect(vi.mocked(getProcessedImage).mock.calls[0][1]).toBe(200);
    expect(vi.mocked(getProcessedImage).mock.calls[0][2]).toBe(200);
    expect(imageOptions[0]._pptxTile).toMatchObject({
      tileWidthPx: 200,
      tileHeightPx: 200,
      shapeWidthPx: 960,
      shapeHeightPx: 540,
      sx: 64000,
      sy: 64000,
      tx: 0,
      ty: 0,
    });
    expect(warning).toHaveBeenCalledWith(
      '[dom-to-pptx] Rasterizing an SVG noise texture at its tile size instead of the full element size.'
    );
    warning.mockRestore();
  });

  it('recognizes base64-encoded SVG noise textures', async () => {
    const background = document.createElement('div');
    const svg = '<svg width="32" height="32"><filter><feTurbulence type="fractalNoise"/></filter></svg>';
    const dataUrl = `data:image/svg+xml;base64,${btoa(svg)}`;
    background.style.backgroundImage = `url('${dataUrl}')`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getProcessedImage).mockClear();

    const imageOptions = await exportElement(background);

    expect(imageOptions).toHaveLength(1);
    expect(vi.mocked(getProcessedImage).mock.calls[0][1]).toBe(32);
    expect(vi.mocked(getProcessedImage).mock.calls[0][2]).toBe(32);
    expect(warning).toHaveBeenCalledWith(
      '[dom-to-pptx] Rasterizing an SVG noise texture at its tile size instead of the full element size.'
    );
    warning.mockRestore();
  });

  it('keeps a solid background below a transparent gradient background', async () => {
    const background = document.createElement('div');
    background.style.backgroundColor = 'rgb(245, 241, 227)';
    background.style.backgroundImage = 'radial-gradient(rgba(0, 0, 0, 0.02) 2%, transparent 2%)';

    const imageOptions = await exportElement(background);

    expect(mockAddShape).toHaveBeenCalledOnce();
    expect(mockAddShape.mock.calls[0][1].fill).toMatchObject({ color: 'F5F1E3', transparency: 0 });
    expect(imageOptions).toHaveLength(1);
    expect(mockAddShape.mock.invocationCallOrder[0]).toBeLessThan(mockAddImage.mock.invocationCallOrder[0]);
  });

  it('keeps a solid background below a URL background image', async () => {
    const background = document.createElement('div');
    background.style.backgroundColor = 'rgb(245, 241, 227)';
    background.style.backgroundImage = 'url("https://example.com/transparent-background.png")';

    const imageOptions = await exportElement(background);

    expect(mockAddShape).toHaveBeenCalledOnce();
    expect(mockAddShape.mock.calls[0][1].fill).toMatchObject({ color: 'F5F1E3', transparency: 0 });
    expect(imageOptions).toHaveLength(1);
    expect(mockAddShape.mock.invocationCallOrder[0]).toBeLessThan(mockAddImage.mock.invocationCallOrder[0]);
  });

  it('renders a background border and shadow only once around layered backgrounds', async () => {
    const background = document.createElement('div');
    background.style.backgroundColor = 'rgb(245, 241, 227)';
    background.style.backgroundImage = 'linear-gradient(rgba(0, 0, 0, 0.1), transparent)';
    background.style.border = '2px solid rgb(30, 40, 50)';
    background.style.borderRadius = '12px';
    background.style.boxShadow = 'rgb(0, 0, 0) 2px 3px 4px';

    await exportElement(background);

    const shapeOptions = mockAddShape.mock.calls.map(([, options]) => options);
    expect(shapeOptions.filter((options) => options.fill?.color === 'F5F1E3')).toHaveLength(1);
    expect(shapeOptions.filter((options) => options.line)).toHaveLength(1);
    expect(shapeOptions.filter((options) => options.shadow)).toHaveLength(1);

    const borderCallIndex = shapeOptions.findIndex((options) => options.line);
    expect(mockAddImage.mock.invocationCallOrder[0]).toBeLessThan(
      mockAddShape.mock.invocationCallOrder[borderCallIndex]
    );
  });

  it('keeps the solid background and tiles explicitly sized repeating gradients', async () => {
    const background = document.createElement('div');
    background.style.backgroundColor = 'rgb(245, 241, 227)';
    background.style.backgroundImage = 'radial-gradient(rgb(0, 0, 0) 1px, transparent 0px)';
    background.style.backgroundSize = '40px 40px';
    background.style.backgroundRepeat = 'repeat';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const imageOptions = await exportElement(background);

    expect(imageOptions).toHaveLength(1);
    expect(mockAddShape).toHaveBeenCalledOnce();
    expect(mockAddShape.mock.calls[0][1].fill).toMatchObject({ color: 'F5F1E3', transparency: 0 });
    expect(imageOptions[0]._pptxTile).toMatchObject({ tileWidthPx: 40, tileHeightPx: 40 });
    // The pattern is painted, not translated into an SVG gradient: px-based
    // colour stops have no SVG <stop offset> equivalent.
    expect(imageOptions[0].data).toBe('data:image/png;base64,tile');
    // pptxScale 1, tile 40px supersampled to a 63px raster -> 40/63 of native.
    expect(imageOptions[0]._pptxTile).toMatchObject({ sx: 63492, sy: 63492, tx: 0, ty: 0 });
    expect(warning).toHaveBeenCalledWith(
      '[dom-to-pptx] skipNormalize=true disables OOXML tile fills; repeating backgrounds will be stretched.'
    );
    warning.mockRestore();
  });

  it('uses the managed screenshot callback for unsupported visual effects', async () => {
    const background = document.createElement('div');
    background.style.mixBlendMode = 'multiply';
    const capture = vi.fn(async () => 'data:image/png;base64,captured');

    const imageOptions = await exportElement(background, { _captureElement: capture });

    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0][0]).toMatchObject({ captureBelow: true, captureMimeType: 'image/jpeg' });
    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0].data).toBe('data:image/png;base64,captured');
  });

  it('keeps a leaf blend texture as a separate transparent image', async () => {
    const texture = document.createElement('div');
    texture.style.mixBlendMode = 'overlay';
    texture.style.opacity = '0.55';
    texture.style.backgroundImage =
      'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'><rect width=\'8\' height=\'8\'/></svg>")';
    const capture = vi.fn(async () => 'data:image/png;base64,captured');

    const imageOptions = await exportElement(texture, { _captureElement: capture });

    expect(capture).not.toHaveBeenCalled();
    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0].data).toBe('data:image/png;base64,mock');
    expect(imageOptions[0].transparency).toBeCloseTo(45);
  });

  it('places a full-slide blend texture below editable foreground content', async () => {
    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);

    const texture = document.createElement('div');
    texture.style.mixBlendMode = 'overlay';
    texture.style.zIndex = '30';
    texture.style.backgroundImage =
      'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'><rect width=\'8\' height=\'8\'/></svg>")';
    setRect(texture);

    const heading = document.createElement('div');
    heading.textContent = 'Editable heading';
    heading.style.zIndex = '10';
    setRect(heading, { width: 320, height: 40, left: 40, top: 40 });

    container.append(texture, heading);
    document.body.appendChild(container);
    mockAddImage.mockClear();
    mockAddText.mockClear();

    await exportToPptx(container, { skipDownload: true, skipNormalize: true });

    expect(mockAddImage).toHaveBeenCalled();
    expect(mockAddText).toHaveBeenCalled();
    expect(mockAddImage.mock.invocationCallOrder[0]).toBeLessThan(mockAddText.mock.invocationCallOrder[0]);

    document.body.removeChild(container);
  });

  it('keeps editable text above an unsupported card instead of absorbing the page', async () => {
    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);

    const card = document.createElement('div');
    card.textContent = '玻璃卡片';
    card.style.backdropFilter = 'blur(10px)';
    card.style.zIndex = '10';
    setRect(card, { width: 420, height: 180, left: 260, top: 180 });

    const heading = document.createElement('div');
    heading.textContent = '正文标题';
    heading.style.zIndex = '1';
    setRect(heading, { width: 320, height: 40, left: 40, top: 40 });

    container.append(card, heading);
    document.body.appendChild(container);
    mockAddText.mockClear();
    const capture = vi.fn(async () => 'data:image/png;base64,captured');

    await exportToPptx(container, { skipDownload: true, skipNormalize: true, _captureElement: capture });

    const textValues = mockAddText.mock.calls
      .map(([parts]) => (Array.isArray(parts) ? parts.map((part) => part.text).join('') : String(parts)))
      .join('\n');
    expect(textValues).toContain('正文标题');
    expect(textValues).toContain('玻璃卡片');
    expect(mockAddText).toHaveBeenCalled();

    document.body.removeChild(container);
  });

  it('keeps non-overlapping lower layers when a clipped chart segment captures its backdrop', async () => {
    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);

    const header = document.createElement('div');
    header.textContent = 'Page title';
    header.style.zIndex = '10';
    setRect(header, { width: 500, height: 48, left: 60, top: 30 });

    const chart = document.createElement('div');
    chart.style.zIndex = '10';
    setRect(chart, { width: 380, height: 220, left: 60, top: 150 });
    const clippedSegment = document.createElement('div');
    clippedSegment.style.clipPath = 'polygon(20% 0, 80% 0, 100% 100%, 0 100%)';
    clippedSegment.style.backgroundColor = 'rgb(122, 38, 58)';
    setRect(clippedSegment, { width: 380, height: 64, left: 60, top: 150 });
    chart.appendChild(clippedSegment);

    const footer = document.createElement('div');
    footer.style.zIndex = '1';
    footer.style.backgroundColor = 'rgb(122, 38, 58)';
    setRect(footer, { width: 960, height: 116, left: 0, top: 424 });

    const footerCopy = document.createElement('div');
    footerCopy.textContent = 'Positioning statement';
    footerCopy.style.zIndex = '10';
    footerCopy.style.color = 'white';
    setRect(footerCopy, { width: 500, height: 36, left: 220, top: 458 });

    container.append(header, chart, footer, footerCopy);
    document.body.appendChild(container);
    mockAddShape.mockClear();
    mockAddText.mockClear();

    await exportToPptx(container, {
      skipDownload: true,
      skipNormalize: true,
      _captureElement: vi.fn(async () => 'data:image/jpeg;base64,captured'),
    });

    const textValues = mockAddText.mock.calls
      .map(([parts]) => (Array.isArray(parts) ? parts.map((part) => part.text).join('') : String(parts)))
      .join('\n');
    const fillColors = mockAddShape.mock.calls.map(([, options]) => options.fill?.color);
    expect(textValues).toContain('Page title');
    expect(textValues).toContain('Positioning statement');
    expect(fillColors).toContain('7A263A');

    document.body.removeChild(container);
  });

  it('isolates unsupported foreground captures from document and body backgrounds', async () => {
    const background = document.createElement('div');
    // A non-rectangular clip path is unsupported but does not depend on the
    // lower pixels, unlike a mix-blend-mode layer.
    background.style.clipPath = 'polygon(0 0, 100% 0, 50% 100%)';
    background.style.zIndex = '10';
    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);
    setRect(background, { width: 240, height: 120, left: 240, top: 120 });
    const heading = document.createElement('div');
    heading.textContent = '下层正文';
    heading.style.zIndex = '1';
    setRect(heading, { width: 200, height: 40, left: 20, top: 20 });
    container.append(background, heading);
    document.body.appendChild(container);

    document.documentElement.style.background = 'rgb(1, 2, 3)';
    document.body.style.background = 'rgb(4, 5, 6)';
    let observedBackgrounds;
    const capture = vi.fn(async () => {
      observedBackgrounds = [document.documentElement.style.background, document.body.style.background];
      return 'data:image/png;base64,captured';
    });

    await exportToPptx(container, { skipDownload: true, skipNormalize: true, _captureElement: capture });

    expect(observedBackgrounds).toEqual(['none', 'none']);
    expect(document.documentElement.style.background).toBe('rgb(1, 2, 3)');
    expect(document.body.style.background).toBe('rgb(4, 5, 6)');
    document.body.removeChild(container);
    document.documentElement.style.removeProperty('background');
    document.body.style.removeProperty('background');
  });

  it('falls back to html2canvas when managed screenshot capture fails', async () => {
    const background = document.createElement('div');
    background.style.mixBlendMode = 'multiply';
    const capture = vi.fn(async () => {
      throw new Error('clip outside viewport');
    });

    await expect(exportElement(background, { _captureElement: capture })).resolves.toEqual([]);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('does not tile a uniformly rounded background', async () => {
    const background = document.createElement('div');
    background.style.backgroundImage = 'radial-gradient(rgb(0, 0, 0) 1px, transparent 0px)';
    background.style.backgroundSize = '40px 40px';
    background.style.backgroundRepeat = 'repeat';
    background.style.borderRadius = '16px';

    const imageOptions = await exportElement(background);

    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0]).not.toHaveProperty('_pptxTile');
    // A rounded element cannot carry a tile fill, but the dot pattern still has
    // px colour stops, so it is painted at element size rather than flattened
    // into a solid SVG gradient.
    expect(imageOptions[0].data).toBe('data:image/png;base64,tile');
  });

  it('paints a conic gradient instead of dropping the background layer', async () => {
    const dial = document.createElement('div');
    dial.style.backgroundImage = 'conic-gradient(from 45deg, rgb(238, 17, 17), rgb(17, 17, 238))';

    const imageOptions = await exportElement(dial);

    // conic has no SVG gradient element, so it used to fall through every
    // branch and emit nothing at all.
    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0].data).toBe('data:image/png;base64,tile');
  });

  it('paints a stack of url layers instead of keeping only the first', async () => {
    const stacked = document.createElement('div');
    stacked.style.backgroundImage =
      'url("data:image/svg+xml;utf8,<svg/>"), url("data:image/svg+xml;utf8,<svg/>")';
    stacked.style.backgroundRepeat = 'repeat';
    vi.mocked(getProcessedImage).mockClear();

    const imageOptions = await exportElement(stacked);

    expect(imageOptions).toHaveLength(1);
    // One blipFill cannot hold two layers, so the browser composites them and
    // the single-image path is bypassed entirely.
    expect(getProcessedImage).not.toHaveBeenCalled();
    expect(imageOptions[0]).not.toHaveProperty('_pptxTile');
    expect(imageOptions[0].data).toBe('data:image/png;base64,tile');
  });

  it('inlines a url() layer stacked under a gradient before painting it', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }),
    }));
    globalThis.fetch = fetchMock;
    paintedImageSources.length = 0;

    const card = document.createElement('div');
    card.style.backgroundImage =
      'linear-gradient(to top, rgba(7, 8, 11, 0.95) 30%, rgba(7, 8, 11, 0.1) 100%), '
      + 'url("https://example.com/hero.webp")';

    try {
      await exportElement(card);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/hero.webp');
    const painted = paintedImageSources.find((source) => source.startsWith('data:image/svg+xml'));
    const svg = decodeURIComponent(painted.slice(painted.indexOf(',') + 1));
    // An SVG drawn through <img> loads no external resource, so a layer left as
    // a URL paints nothing while the gradient above it paints normally — a
    // gradient-only card that still reads as a successful raster.
    expect(svg).toContain('data:image/webp;base64,');
    expect(svg).not.toContain('https://example.com/hero.webp');
    expect(svg).toContain('linear-gradient(to top');
  });

  it('leaves the painter to html2canvas when a url() layer cannot be inlined', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    globalThis.fetch = fetchMock;
    paintedImageSources.length = 0;

    const card = document.createElement('div');
    card.style.backgroundImage =
      'linear-gradient(rgba(0, 0, 0, 0.4), transparent), url("https://example.com/unreachable.png")';

    let imageOptions;
    try {
      imageOptions = await exportElement(card);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Painting a background with a hole in it is worse than not painting it
    // here: html2canvas loads the image through the normal loader.
    expect(paintedImageSources.some((source) => source.startsWith('data:image/svg+xml'))).toBe(false);
    expect(imageOptions).toHaveLength(1);
    expect(imageOptions[0].data).toBe('data:image/png;base64,tile');
  });

  it('paints repeating gradients that have no rectangular tile period', async () => {
    const speedlines = document.createElement('div');
    speedlines.style.background =
      'repeating-linear-gradient(-25deg, rgb(0, 0, 0) 0 3px, transparent 3px 30px)';
    speedlines.style.opacity = '0.05';

    const imageOptions = await exportElement(speedlines);

    expect(imageOptions).toHaveLength(1);
    // No background-size means no known period, so it is painted whole.
    expect(imageOptions[0]).not.toHaveProperty('_pptxTile');
    expect(imageOptions[0].data).toBe('data:image/png;base64,tile');
    // The element's own opacity must ride on the picture, not be baked in.
    expect(imageOptions[0].transparency).toBe(95);
  });

  it('rasterizes identical soft-edge SVGs once per export and reuses the PNG', async () => {
    const originalImage = globalThis.Image;
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const toDataURL = vi.fn(() => 'data:image/png;base64,soft-edge-preview');
    let imageLoads = 0;

    class FakeImage {
      naturalWidth = 780;
      naturalHeight = 780;
      width = 780;
      height = 780;
      onload = null;
      onerror = null;

      set src(value) {
        if (!value) return;
        imageLoads += 1;
        queueMicrotask(() => this.onload?.());
      }
    }

    globalThis.Image = FakeImage;
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage: vi.fn() });
    HTMLCanvasElement.prototype.toDataURL = toDataURL;

    const decoration = () => {
      const element = document.createElement('div');
      element.style.width = '600px';
      element.style.height = '600px';
      element.style.backgroundColor = 'rgb(255, 220, 230)';
      element.style.borderRadius = '50%';
      element.style.filter = 'blur(60px)';
      setRect(element, { width: 600, height: 600 });
      return element;
    };

    const first = decoration();
    const second = decoration();
    document.body.append(first, second);
    mockAddImage.mockClear();

    try {
      await exportToPptx([first, second], { skipDownload: true, skipNormalize: true, autoEmbedFonts: false });
    } finally {
      first.remove();
      second.remove();
      globalThis.Image = originalImage;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    }

    expect(imageLoads).toBe(1);
    expect(toDataURL).toHaveBeenCalledTimes(1);
    expect(mockAddImage.mock.calls.map(([options]) => options.data)).toEqual([
      'data:image/png;base64,soft-edge-preview',
      'data:image/png;base64,soft-edge-preview',
    ]);
  });
});

describe('Bug 5: Preserve single-line objects without freezing browser wraps', () => {
  let rangeSpy;

  function setRect(element, { width = 960, height = 540, left = 0, top = 0 } = {}) {
    element.getBoundingClientRect = () => ({
      width,
      height,
      left,
      top,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    });
  }

  function mockTextClientRects(rects) {
    rangeSpy = vi.spyOn(document, 'createRange').mockImplementation(() => ({
      selectNode: vi.fn(),
      selectNodeContents: vi.fn(),
      getClientRects: () => rects,
      getBoundingClientRect: () => rects[0] || { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 },
      detach: vi.fn(),
    }));
  }

  async function exportTextElement(element) {
    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);
    setRect(element, { width: 380, height: 40, left: 20, top: 20 });
    container.appendChild(element);
    document.body.appendChild(container);

    mockAddText.mockClear();
    await exportToPptx(container, { skipDownload: true, skipNormalize: true });
    document.body.removeChild(container);

    const call = mockAddText.mock.calls.find(([parts]) =>
      Array.isArray(parts) && parts.map((part) => part.text).join('').includes(element.textContent.trim())
    );
    expect(call).toBeDefined();
    return { parts: call[0], options: call[1] };
  }

  afterEach(() => {
    rangeSpy?.mockRestore();
    rangeSpy = undefined;
  });

  it('keeps wrapping disabled when inline fragments share one visual line', async () => {
    const element = document.createElement('div');
    element.innerHTML = '<strong>世界地图：</strong><span>红土大陆、伟大航路与四大海域</span>';
    mockTextClientRects([
      { width: 80, height: 20, left: 20, top: 20, right: 100, bottom: 40 },
      { width: 300, height: 20, left: 100, top: 20.25, right: 400, bottom: 40.25 },
    ]);

    const { options } = await exportTextElement(element);

    expect(options.wrap).toBe(false);
  });

  it('keeps wrapping enabled when browser layout contains multiple visual lines', async () => {
    const element = document.createElement('div');
    element.textContent = '第一行文字 第二行文字';
    mockTextClientRects([
      { width: 180, height: 20, left: 20, top: 20, right: 200, bottom: 40 },
      { width: 120, height: 20, left: 20, top: 42, right: 140, bottom: 62 },
    ]);

    const { parts, options } = await exportTextElement(element);

    expect(options.wrap).toBe(true);
    expect(parts).toHaveLength(1);
    expect(parts[0].options.breakLine).toBeUndefined();
  });

  it('keeps an automatically wrapped list item as one bullet paragraph', async () => {
    const container = document.createElement('div');
    const list = document.createElement('ul');
    const item = document.createElement('li');
    item.textContent = 'A list item that Chromium happened to lay out across multiple visual lines';
    list.appendChild(item);
    container.appendChild(list);
    setRect(container);
    setRect(list, { width: 380, height: 80, left: 20, top: 20 });
    setRect(item, { width: 340, height: 60, left: 40, top: 20 });
    document.body.appendChild(container);
    mockTextClientRects([
      { width: 160, height: 20, left: 40, top: 20, right: 200, bottom: 40 },
      { width: 160, height: 20, left: 40, top: 42, right: 200, bottom: 62 },
    ]);

    mockAddText.mockClear();
    try {
      await exportToPptx(container, { skipDownload: true, skipNormalize: true });
    } finally {
      document.body.removeChild(container);
    }

    const call = mockAddText.mock.calls.find(([parts]) =>
      Array.isArray(parts) && parts.map((part) => part.text).join('').includes(item.textContent)
    );
    expect(call).toBeDefined();
    const [parts, options] = call;
    expect(parts).toHaveLength(1);
    expect(parts[0].options.bullet).toBeTruthy();
    expect(parts[0].options.breakLine).toBeUndefined();
    expect(options.wrap).toBe(true);
  });

  it('keeps wrapping disabled for a standalone text node on one line', async () => {
    const element = document.createElement('div');
    element.appendChild(document.createTextNode('作品概况'));
    const emptyBlock = document.createElement('div');
    emptyBlock.style.display = 'block';
    element.appendChild(emptyBlock);
    mockTextClientRects([{ width: 56, height: 20, left: 20, top: 20, right: 76, bottom: 40 }]);

    const { options } = await exportTextElement(element);

    expect(options.wrap).toBe(false);
  });
});

describe('Bug 6: background-clip: text never paints a box fill', () => {
  function setRect(element, { width = 960, height = 540, left = 0, top = 0 } = {}) {
    element.getBoundingClientRect = () => ({
      width,
      height,
      left,
      top,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    });
  }

  async function exportElement(element) {
    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);
    setRect(element, { width: 120, height: 60, left: 20, top: 20 });
    container.appendChild(element);
    document.body.appendChild(container);

    mockAddText.mockClear();
    mockAddShape.mockClear();
    await exportToPptx(container, { skipDownload: true, skipNormalize: true });
    document.body.removeChild(container);

    const needle = element.textContent.trim();
    const call = needle
      ? mockAddText.mock.calls.find(([parts]) =>
          Array.isArray(parts) && parts.map((part) => part.text).join('').includes(needle)
        )
      : undefined;
    return { options: call?.[1] };
  }

  it('keeps a solid-colour knockout as a plain text box — the paint belongs to the glyphs, not the box', async () => {
    // PPTX has no background-clip, so the converter's scheme-1 fallback moves
    // the clipped background into the run colour. The box fill must disappear
    // together with that background, otherwise the glyph colour leaks into a
    // solid slab behind the same-coloured text.
    const element = document.createElement('div');
    element.textContent = '04';
    element.style.color = 'rgb(255, 255, 255)';
    element.style.backgroundColor = 'rgb(227, 6, 19)';
    element.style.webkitBackgroundClip = 'text';

    const { options } = await exportElement(element);

    expect(options).toBeDefined();
    expect(options.fill).toBeUndefined();
    expect(
      mockAddShape.mock.calls.some(([, opts]) => opts.fill?.color === 'E30613')
    ).toBe(false);
  });

  it('keeps the box fill when the same background is not clipped to text', async () => {
    const element = document.createElement('div');
    element.textContent = '04';
    element.style.color = 'rgb(255, 255, 255)';
    element.style.backgroundColor = 'rgb(227, 6, 19)';

    const { options } = await exportElement(element);

    expect(options).toBeDefined();
    expect(options.fill).toMatchObject({ color: 'E30613' });
  });

  it('drops the whole shape for a text-less knockout element', async () => {
    // A clipped background on an empty box paints nothing in the browser (no
    // glyphs to clip against), so no PPTX shape may carry that fill either.
    const element = document.createElement('div');
    element.style.backgroundColor = 'rgb(227, 6, 19)';
    element.style.webkitBackgroundClip = 'text';

    await exportElement(element);

    expect(mockAddText).not.toHaveBeenCalled();
    expect(
      mockAddShape.mock.calls.some(([, opts]) => opts.fill?.color === 'E30613')
    ).toBe(false);
  });
});

describe('Bug 7: a bare text node outside a text container must not repaint its block background as a highlight', () => {
  // jsdom's Range has no getBoundingClientRect; the text-node branch measures
  // runs with one, so give it a plausible rect for the duration of this suite.
  const originalRangeRect = Range.prototype.getBoundingClientRect;
  beforeAll(() => {
    Range.prototype.getBoundingClientRect = function () {
      const left = 100;
      const top = 410;
      const width = 700;
      const height = 40;
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
    };
  });
  afterAll(() => {
    Range.prototype.getBoundingClientRect = originalRangeRect;
  });

  function setRect(element, { width = 960, height = 540, left = 0, top = 0 } = {}) {
    element.getBoundingClientRect = () => ({
      width,
      height,
      left,
      top,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
    });
  }

  async function exportStandaloneText(text) {
    // A flex bar with an inline label plus a trailing text node is not a text
    // container (the label is a flex item), so the bare text reaches
    // prepareRenderItem's text-node branch and ships as its own text box.
    const bar = document.createElement('div');
    bar.style.display = 'flex';
    bar.style.backgroundColor = 'rgba(234, 244, 248, 0.03)';
    bar.style.border = '1px solid rgba(159, 185, 203, 0.15)';
    const label = document.createElement('strong');
    label.textContent = 'LABEL:';
    bar.appendChild(label);
    bar.appendChild(document.createTextNode(text));

    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    setRect(container);
    setRect(bar, { width: 900, height: 60, left: 40, top: 400 });
    container.appendChild(bar);
    document.body.appendChild(container);

    mockAddText.mockClear();
    mockAddShape.mockClear();
    await exportToPptx(container, { skipDownload: true, skipNormalize: true });
    document.body.removeChild(container);

    const call = mockAddText.mock.calls.find(
      ([parts]) => Array.isArray(parts) && parts.map((part) => part.text).join('').includes(text)
    );
    return { parts: call?.[0] };
  }

  it('strips the highlight from the standalone run; the bar fill keeps the translucent paint', async () => {
    // PptxGenJS writes a highlight as an opaque <a:highlight> with no alpha, so
    // the bar's 3% background travelling onto the run would render as a solid
    // slab behind same-coloured text. The block's shape fill (which keeps the
    // alpha) is already painted separately and is the right carrier.
    const text = 'a bare statement following an inline label';
    const { parts } = await exportStandaloneText(text);

    expect(parts).toBeDefined();
    const run = parts.find((part) => part.text.includes('bare statement'));
    expect(run).toBeDefined();
    expect(run.options.highlight).toBeUndefined();
    expect(
      mockAddShape.mock.calls.some(
        ([, opts]) => opts.fill?.color === 'EAF4F8' && (opts.fill?.transparency ?? 0) >= 90
      )
    ).toBe(true);
  });

  it('strips the highlight from an inline-flex badge whose background is already a shape', async () => {
    // An inline-flex badge with an icon child is not a text container. The
    // exporter therefore emits its translucent rounded fill as a shape and its
    // trailing text node separately. That text must not receive an opaque run
    // highlight as well.
    const badge = document.createElement('div');
    badge.style.display = 'inline-flex';
    badge.style.backgroundColor = 'rgba(255, 190, 83, 0.15)';
    badge.style.borderRadius = '20px';
    const icon = document.createElement('span');
    icon.textContent = '◆';
    badge.appendChild(icon);
    badge.appendChild(document.createTextNode(' THE INTERNATIONAL'));

    const container = document.createElement('div');
    container.style.width = '960px';
    container.style.height = '540px';
    const panel = document.createElement('div');
    const heading = document.createElement('div');
    heading.textContent = 'CARD HEADING';
    panel.appendChild(badge);
    panel.appendChild(heading);
    setRect(container);
    setRect(panel, { width: 480, height: 260, left: 60, top: 80 });
    setRect(badge, { width: 240, height: 42, left: 80, top: 120 });
    setRect(icon, { width: 18, height: 18, left: 96, top: 132 });
    setRect(heading, { width: 180, height: 30, left: 80, top: 190 });
    container.appendChild(panel);
    document.body.appendChild(container);

    mockAddText.mockClear();
    mockAddShape.mockClear();
    await exportToPptx(container, { skipDownload: true, skipNormalize: true });
    document.body.removeChild(container);

    const call = mockAddText.mock.calls.find(
      ([parts]) => Array.isArray(parts) && parts.map((part) => part.text).join('').includes('THE INTERNATIONAL')
    );
    const run = call?.[0]?.find((part) => part.text.includes('THE INTERNATIONAL'));
    expect(run).toBeDefined();
    expect(run.options.highlight).toBeUndefined();
    expect(
      mockAddShape.mock.calls.some(
        ([, opts]) => opts.fill?.color === 'FFBE53' && (opts.fill?.transparency ?? 0) >= 80
      )
    ).toBe(true);
  });
});
