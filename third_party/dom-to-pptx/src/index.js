// src/index.js
import * as PptxGenJSImport from 'pptxgenjs';
import html2canvas from 'html2canvas';
import { PPTXEmbedFonts } from './font-embedder.js';
import { normalizePptxZip } from './pptx-normalizer.js';
import JSZip from 'jszip';

// Normalize import
const PptxGenJS = PptxGenJSImport?.default ?? PptxGenJSImport;

import {
  parseColor,
  getTextStyle,
  isTextContainer,
  getVisibleShadow,
  generateGradientSVG,
  getRotation,
  getWritingModeVert,
  mapVertToTextDirection,
  svgToPng,
  svgToSvg,
  getPadding,
  getSoftEdges,
  generateBlurredSVG,
  getBorderInfo,
  generateCompositeBorderSVG,
  isClippedByParent,
  generateCustomShapeSVG,
  getUsedFontFamilies,
  collectRenderedFonts,
  getAutoDetectedFonts,
  extractSpeakerNotesFromElement,
  classifyFontVariant,
  detectVariantSlotCollisions,
  hasVariableFontTables,
  backfillRegularFontSlot,
  extractTableData,
  collectTextParts,
  resolveRunHighlight,
} from './utils.js';
import { getProcessedImage, resolveRasterScale } from './image-processor.js';
import { extractCssImageUrls, replaceCssImageUrls } from './css-image-url.js';
import { parseAnimation } from './animations/css-parser.js';
import { extractTransitionFromElement } from './animations/transitions.js';

const PPI = 96;
const PX_TO_INCH = 1 / PPI;
const DEFAULT_MAX_RASTER_DPI = 150;
const SVG_PAINT_TIMEOUT_MS = 2000;
const INLINE_IMAGE_TIMEOUT_MS = 15000;
// Base64 costs 4/3 of the source, and the result rides inside another data URL
// that is percent-encoded again. Past this the picture is left to html2canvas,
// which streams it through the normal image loader instead.
const INLINE_IMAGE_MAX_DATA_URL_CHARS = 12 * 1024 * 1024;

function describeRasterizationSource(node, style) {
  const tag = String(node?.tagName || '').toLowerCase() || 'unknown';
  const objectType = String(node?.getAttribute?.('data-object-type') || '').toLowerCase();
  const backgroundImage = String(style?.backgroundImage || '').trim();
  const hasBackgroundImage = backgroundImage && backgroundImage !== 'none';
  const unsupportedVisual = style ? hasUnsupportedVisual(style) : false;

  let reason = 'image_fallback';
  if (tag === 'img') reason = 'image_element';
  else if (tag === 'svg') reason = 'svg_element';
  else if (objectType === 'image') reason = 'composite_image_container';
  else if (unsupportedVisual) reason = 'unsupported_css_visual';
  else if (isIconElement(node)) reason = 'icon_element';
  else if (hasBackgroundImage) reason = 'css_background';

  return { reason, tag, object_type: objectType || null };
}

function estimateDataUrlBytes(value) {
  if (typeof value !== 'string') return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const payloadLength = value.length - comma - 1;
  return /;base64(?:;|,)/i.test(value.slice(0, comma + 1))
    ? Math.max(0, Math.floor((payloadLength * 3) / 4))
    : payloadLength;
}

async function reportRasterizationEvent(options, event) {
  if (typeof options?.onRasterizationEvent !== 'function') return;
  try {
    await options.onRasterizationEvent(event);
  } catch {
    // Diagnostics must never make a visual export fail.
  }
}

// This is deliberately a streaming diagnostic hook.  It is entirely inert in
// ordinary exports: callers do not allocate trace records or read clocks until
// the host has opted in with onRasterizationEvent.
async function traceRasterOperation(options, operation, metadata, work) {
  if (typeof options?.onRasterizationEvent !== 'function') return work();
  const startedAt = performance.now();
  const common = {
    operation,
    slide_number: Number.isFinite(Number(options._slideIndex)) ? Number(options._slideIndex) + 1 : null,
    ...metadata,
  };
  await reportRasterizationEvent(options, { event: 'rasterization_start', ...common });
  try {
    const result = await work();
    await reportRasterizationEvent(options, {
      event: 'rasterization_end',
      ...common,
      duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      // Several successful phases intentionally return void.  A thrown error
      // is the only failure signal here; result_has_value is retained solely
      // to distinguish a no-op phase from one that produced a raster result.
      ok: true,
      result_has_value: result !== undefined && result !== null,
      ...(result?.rasterWidth ? { raster_width: result.rasterWidth, raster_height: result.rasterHeight } : {}),
    });
    return result;
  } catch (error) {
    await reportRasterizationEvent(options, {
      event: 'rasterization_end',
      ...common,
      duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function createRasterOptions(globalOptions, config, reason) {
  return {
    pptxScale: config.scale,
    maxDpi: globalOptions._maxRasterDpi,
    onRasterizationEvent: globalOptions.onRasterizationEvent,
    _slideIndex: globalOptions._slideIndex,
    rasterizationReason: reason,
  };
}

/**
 * Rasterize an SVG once and retain its promise for the lifetime of one PPTX
 * export. PptxGenJS otherwise creates a PNG preview independently for every
 * repeated SVG relationship while writing the package. Filtered SVGs are
 * especially expensive: each preview owns native Chromium raster surfaces
 * even when the final media normalizer later deduplicates their PNG bytes.
 */
function rasterizeSvgPreview(svgData) {
  return new Promise((resolve) => {
    const image = new Image();
    const settle = (value) => {
      image.onload = null;
      image.onerror = null;
      image.src = '';
      resolve(value);
    };
    image.onload = () => {
      let canvas = null;
      try {
        canvas = document.createElement('canvas');
        canvas.width = Math.max(Math.ceil(image.naturalWidth || image.width), 1);
        canvas.height = Math.max(Math.ceil(image.naturalHeight || image.height), 1);
        const context = canvas.getContext('2d');
        if (!context) {
          settle(null);
          return;
        }
        context.drawImage(image, 0, 0);
        const data = canvas.toDataURL('image/png');
        // Shrink the backing store before releasing the local reference. This
        // makes the native bitmap releasable before the rest of the Deck is
        // processed instead of leaving it to the final package write.
        canvas.width = 1;
        canvas.height = 1;
        settle(data && data !== 'data:,' ? data : null);
      } catch {
        settle(null);
      }
    };
    image.onerror = () => settle(null);
    image.src = svgData;
  });
}

function getCachedSvgPreview(svgData, cache) {
  if (!(cache instanceof Map)) return rasterizeSvgPreview(svgData);
  const existing = cache.get(svgData);
  if (existing) return existing;

  const preview = rasterizeSvgPreview(svgData);
  cache.set(svgData, preview);
  // A failed image is not a cache hit: later occurrences may retry after a
  // transient browser decode failure, while successful values are never
  // rasterized twice during the same export.
  preview.then((data) => {
    if (!data && cache.get(svgData) === preview) cache.delete(svgData);
  });
  return preview;
}

function getImageTransparency(opacity) {
  const clampedOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 1));
  const transparency = (1 - clampedOpacity) * 100;
  return transparency > 0 ? transparency : undefined;
}

function hasExplicitRepeatingGradientTexture(style) {
  const backgroundSize = String(style.backgroundSize || '').trim();
  if (!backgroundSize || /^(?:auto)(?:\s+auto)?$/i.test(backgroundSize)) return false;

  const backgroundRepeat = String(style.backgroundRepeat || '')
    .trim()
    .toLowerCase();
  return !!backgroundRepeat && !/^(?:no-repeat)(?:\s+no-repeat)?$/.test(backgroundRepeat);
}

function isNoiseSvgDataUrl(url) {
  const raw = String(url || '').trim();
  const normalized = raw.toLowerCase();
  if (!normalized.startsWith('data:image/svg+xml')) return false;

  const commaIndex = raw.indexOf(',');
  if (commaIndex < 0) return false;

  const metadata = normalized.slice(0, commaIndex);
  const payload = raw.slice(commaIndex + 1);
  let decoded = payload;
  try {
    if (metadata.includes(';base64')) {
      decoded = atob(payload);
    } else {
      decoded = decodeURIComponent(payload);
    }
  } catch {
    // Keep the raw URL for best-effort detection when it contains malformed escapes.
  }

  decoded = decoded.toLowerCase();
  return decoded.includes('<feturbulence') || decoded.includes('fractalnoise');
}

function splitCssLayers(value) {
  const layers = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      layers.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) layers.push(last);
  return layers;
}

function parsePixelPair(value) {
  const firstLayer = splitCssLayers(String(value || ''))[0] || '';
  const match = firstLayer.match(/^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2] ?? match[1]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

function decodeSvgDataUrl(url) {
  const raw = String(url || '').trim();
  if (!raw.toLowerCase().startsWith('data:image/svg+xml')) return '';
  const commaIndex = raw.indexOf(',');
  if (commaIndex < 0) return '';
  const metadata = raw.slice(0, commaIndex).toLowerCase();
  const payload = raw.slice(commaIndex + 1);
  try {
    return metadata.includes(';base64') ? atob(payload) : decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function getSvgIntrinsicSize(url) {
  const svg = decodeSvgDataUrl(url);
  if (!svg) return null;
  const root = svg.match(/<svg\b[^>]*>/i)?.[0] || '';
  const width = Number(root.match(/\bwidth=["']([\d.]+)(?:px)?["']/i)?.[1]);
  const height = Number(root.match(/\bheight=["']([\d.]+)(?:px)?["']/i)?.[1]);
  if (width > 0 && height > 0) return { width, height };
  const viewBox = svg.match(/\bviewBox=["']\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*["']/i);
  if (viewBox) {
    const viewWidth = Number(viewBox[3]);
    const viewHeight = Number(viewBox[4]);
    if (viewWidth > 0 && viewHeight > 0) return { width: viewWidth, height: viewHeight };
  }
  const tileShape = svg.match(/<(?:rect|image|pattern)\b[^>]*>/i)?.[0] || '';
  const shapeWidth = Number(tileShape.match(/\bwidth=["']([\d.]+)(?:px)?["']/i)?.[1]);
  const shapeHeight = Number(tileShape.match(/\bheight=["']([\d.]+)(?:px)?["']/i)?.[1]);
  if (shapeWidth > 0 && shapeHeight > 0) return { width: shapeWidth, height: shapeHeight };
  return null;
}

function getBackgroundTileSize(style, widthPx, heightPx, url = '') {
  // `repeat` is the CSS initial value; some lightweight DOM implementations
  // omit it from computed styles, so preserve the browser default explicitly.
  const repeat = String(style.backgroundRepeat || 'repeat').trim().toLowerCase();
  if (!repeat || /^(?:no-repeat)(?:\s+no-repeat)?$/.test(repeat)) return null;

  const explicitSize = parsePixelPair(style.backgroundSize);
  if (explicitSize) return explicitSize;

  const intrinsicSize = getSvgIntrinsicSize(url);
  if (intrinsicSize) return intrinsicSize;

  // repeat-x/y with an explicit single dimension can still be represented when
  // the other dimension is the element's full height/width.
  const firstLayer = splitCssLayers(String(style.backgroundSize || ''))[0] || '';
  const single = firstLayer.match(/^(-?[\d.]+)px$/i);
  if (single && Number(single[1]) > 0) {
    return repeat.includes('x')
      ? { width: Number(single[1]), height: heightPx }
      : { width: widthPx, height: Number(single[1]) };
  }
  return null;
}

function getBackgroundTileOffset(style, shapeWidthPx, shapeHeightPx, tileWidthPx, tileHeightPx) {
  const position = splitCssLayers(String(style.backgroundPosition || '0% 0%'))[0] || '0% 0%';
  const parts = position.split(/\s+/).filter(Boolean);
  const resolve = (value, shape, tile, axis) => {
    const normalized = String(value || '').toLowerCase();
    if (normalized === 'left' || normalized === 'top') return 0;
    if (normalized === 'right' || normalized === 'bottom') return shape - tile;
    if (normalized === 'center') return (shape - tile) / 2;
    if (normalized.endsWith('%')) return ((shape - tile) * Number.parseFloat(normalized)) / 100;
    const px = Number.parseFloat(normalized);
    return Number.isFinite(px) ? px : axis === 'x' ? 0 : 0;
  };
  return {
    offsetXPx: resolve(parts[0] || '0%', shapeWidthPx, tileWidthPx, 'x'),
    offsetYPx: resolve(parts[1] || '0%', shapeHeightPx, tileHeightPx, 'y'),
  };
}

/**
 * Reports whether a CSS gradient is outside what `generateGradientSVG` can say.
 *
 * Two shapes have no SVG equivalent:
 *   - `repeating-*-gradient`, because SVG gradients have no period; the whole
 *     element would render as one pass of the ramp.
 *   - length-based colour stops (`transparent 1.4px`), because `<stop offset>`
 *     takes only a number or a percentage. An offset carrying `px` is invalid
 *     and collapses to 0, so every stop lands on 0 and the element floods with
 *     the first stop's colour.
 *
 * Both are how CSS spells dot grids and hatch patterns, so they must be painted.
 * A radial prelude sized in px (`ellipse 100px 50px at ...`) also matches; that
 * only costs a raster where an SVG would have done, never correctness.
 *
 * A third case is a stack of two or more paint layers: `generateGradientSVG`
 * emits a single `<radialGradient>`/`<linearGradient>` and matches the gradient
 * body greedily, so it merges every layer's stops into one ramp and turns the
 * second layer's prelude into a bogus `stop-color`. An invalid SVG colour paints
 * black, which is how a pale two-gradient wash became a dark vignette.
 */
function countBackgroundLayers(backgroundImage) {
  return splitCssLayers(String(backgroundImage || '')).filter(
    (layer) => layer && layer.toLowerCase() !== 'none'
  ).length;
}

function needsPaintedBackground(backgroundImage) {
  const layers = splitCssLayers(String(backgroundImage || '')).filter(
    (layer) => layer && layer.toLowerCase() !== 'none'
  );
  // One blipFill holds one image, so a stack of layers has to be flattened by
  // whoever can composite it correctly — the browser.
  if (layers.length > 1) return true;
  return layers.some((layer) => {
    // conic-gradient has no SVG gradient element and no DrawingML fill.
    if (/^(?:repeating-)?conic-gradient\(/i.test(layer)) return true;
    if (!/^(?:repeating-)?(?:linear|radial)-gradient\(/i.test(layer)) return false;
    if (/^repeating-/i.test(layer)) return true;
    return /[\d.]\s*(?:px|r?em|ch|ex|vh|vw|pt|pc|cm|mm|in|q)\b/i.test(layer);
  });
}

function getBackgroundTileTransport(style, tileSize, shapeWidthPx, shapeHeightPx, pptxScale, maxDpi) {
  const rasterScale = resolveRasterScale({ requestedScale: 2, pptxScale, maxDpi });
  const { offsetXPx, offsetYPx } = getBackgroundTileOffset(
    style,
    shapeWidthPx,
    shapeHeightPx,
    tileSize.width,
    tileSize.height
  );
  return {
    tileWidthPx: tileSize.width,
    tileHeightPx: tileSize.height,
    shapeWidthPx,
    shapeHeightPx,
    offsetXPx,
    offsetYPx,
    pptxScale,
    sx: Math.max(1, Math.round((pptxScale / rasterScale) * 100000)),
    sy: Math.max(1, Math.round((pptxScale / rasterScale) * 100000)),
    tx: Math.round((offsetXPx * 914400 * pptxScale) / 96),
    ty: Math.round((offsetYPx * 914400 * pptxScale) / 96),
  };
}

/**
 * Rewrites a tile's DrawingML scale from the raster that was actually produced.
 *
 * `<a:tile sx>` scales the blip relative to its own pixel size at 96 DPI, so the
 * ratio must come from the real canvas dimensions rather than the requested
 * scale — rounding a 40 px tile to a 42 px raster would otherwise drift the
 * pattern period by ~1% across the shape.
 */
function applyTileRasterSize(tile, rasterWidth, rasterHeight) {
  if (!tile || !(rasterWidth > 0) || !(rasterHeight > 0)) return;
  const pptxScale = Number(tile.pptxScale) || 1;
  tile.sx = Math.max(1, Math.round(((pptxScale * tile.tileWidthPx) / rasterWidth) * 100000));
  tile.sy = Math.max(1, Math.round(((pptxScale * tile.tileHeightPx) / rasterHeight) * 100000));
}

/**
 * Paints exactly one background tile with the browser and returns it as a PNG.
 *
 * CSS pattern gradients (dot grids, hatch stripes) place their colour stops in
 * px — `radial-gradient(#c9a99a 1.2px, transparent 1.4px)`. SVG `<stop offset>`
 * accepts no length units, so translating such a gradient collapses every stop
 * to offset 0 and floods the tile with the first stop colour. The pattern has to
 * be painted, not translated.
 *
 * Only one tile is captured, so the raster stays in the low-kilobyte range while
 * `<a:tile>` repeats it across the shape.
 */
async function rasterizeBackgroundTile(node, tile, rasterOptions = {}) {
  const tileWidth = Math.max(Math.round(tile.tileWidthPx), 1);
  const tileHeight = Math.max(Math.round(tile.tileHeightPx), 1);

  // Sample the tile from the pattern's own phase so the captured cell covers a
  // whole period; `<a:tile>` tx/ty re-applies that phase inside PPTX. Fall back
  // to the element origin when the phased window would leave the element.
  const phaseX = ((tile.offsetXPx % tileWidth) + tileWidth) % tileWidth;
  const phaseY = ((tile.offsetYPx % tileHeight) + tileHeight) % tileHeight;
  return paintBackgroundRegion(
    node,
    {
      width: tileWidth,
      height: tileHeight,
      originX: phaseX + tileWidth <= tile.shapeWidthPx ? phaseX : 0,
      originY: phaseY + tileHeight <= tile.shapeHeightPx ? phaseY : 0,
      resetPosition: true,
    },
    rasterOptions
  );
}

function isOpaqueCssColor(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'transparent') return false;
  const alpha = /^rgba?\(([^)]*)\)$/.exec(raw)?.[1]?.split(',').map((part) => part.trim());
  if (alpha) return alpha.length < 4 || Number(alpha[3]) >= 1;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(raw);
}

function escapeXmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

function drawImageToDataUrl(url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), INLINE_IMAGE_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const image = new Image();
    image.crossOrigin = 'Anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(Math.round(image.naturalWidth || image.width || 0), 1);
        canvas.height = Math.max(Math.round(image.naturalHeight || image.height || 0), 1);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          settle(null);
          return;
        }
        ctx.drawImage(image, 0, 0);
        settle(canvas.toDataURL('image/png'));
      } catch {
        // A tainted canvas cannot be read back.
        settle(null);
      }
    };
    image.onerror = () => settle(null);
    image.src = url;
  });
}

/**
 * Reads one image into a data URL so it can be inlined into a CSS declaration.
 *
 * `fetch` is preferred because it keeps the source bytes and media type, which
 * is both smaller and lossless. Browsers refuse `fetch('file://...')` outright,
 * so the canvas re-encode covers the local-workspace sources that headless
 * exports load from disk.
 */
async function readImageAsDataUrl(url) {
  let absoluteUrl;
  try {
    absoluteUrl = new URL(url, document.baseURI).href;
  } catch {
    return null;
  }

  if (!/^file:/i.test(absoluteUrl)) {
    try {
      const response = await fetch(absoluteUrl);
      if (response.ok) {
        const dataUrl = await readBlobAsDataUrl(await response.blob());
        if (dataUrl) return dataUrl.length <= INLINE_IMAGE_MAX_DATA_URL_CHARS ? dataUrl : null;
      }
    } catch {
      // Fall through to the canvas re-encode.
    }
  }

  const dataUrl = await drawImageToDataUrl(absoluteUrl);
  if (!dataUrl || dataUrl === 'data:,') return null;
  return dataUrl.length <= INLINE_IMAGE_MAX_DATA_URL_CHARS ? dataUrl : null;
}

const inlineCssImageCache = new Map();

/**
 * Resolves every `url()` layer of a CSS image value into a data URL.
 *
 * An SVG document drawn through `<img>` renders in secure static mode: it
 * loads no external resource at all. A `url()` layer inside `<foreignObject>`
 * therefore paints nothing while the gradient layers around it paint normally,
 * and the resulting canvas is non-empty — a background with a hole in it that
 * looks exactly like a successful raster. Inlining the bytes first is what
 * makes that painter usable for a stack that mixes a gradient with a photo.
 *
 * Returns `null` when any layer could not be inlined, so the caller can skip
 * the painter instead of shipping the hole.
 */
async function inlineCssImageUrls(value) {
  const raw = String(value || '');
  if (!raw || raw === 'none') return raw;

  const urls = Array.from(new Set(extractCssImageUrls(raw))).filter((url) => !/^data:/i.test(url));
  if (urls.length === 0) return raw;

  const inlined = new Map();
  await Promise.all(
    urls.map(async (url) => {
      if (!inlineCssImageCache.has(url)) inlineCssImageCache.set(url, readImageAsDataUrl(url));
      inlined.set(url, await inlineCssImageCache.get(url));
    })
  );
  if (urls.some((url) => !inlined.get(url))) return null;

  // Layers already written as data URLs are absent from the map, and a
  // non-string replacement leaves their token exactly as the author wrote it.
  return replaceCssImageUrls(raw, (url) => inlined.get(url));
}

/**
 * Wraps an element's background declarations in an SVG `<foreignObject>`.
 *
 * Drawing that SVG through an `<img>` makes the browser itself lay out and paint
 * the CSS, which is the only painter here with complete gradient support —
 * html2canvas reimplements gradients and handles no `repeating-*-gradient` at
 * all, silently painting nothing.
 *
 * Computed values are inlined because the SVG document cannot see the host
 * page's custom properties; `getComputedStyle` has already resolved `var()`.
 * `backgroundImage` arrives separately because its `url()` layers must already
 * carry their bytes — the SVG cannot fetch them once it is drawn.
 */
export function buildBackgroundLayerSvg(style, width, height, isolateTile, includeBackgroundColor, backgroundImage) {
  const declarations = isolateTile
    ? {
        'background-image': backgroundImage,
        'background-size': style.backgroundSize,
        // The captured window already sits on a period boundary.
        'background-repeat': 'no-repeat',
        'background-position': '0 0',
      }
    : {
        // CSS paints the colour below every image layer, and so does this div.
        // Folding it in makes the raster opaque, which lets it ship as a JPEG:
        // a smooth wash costs megabytes as PNG purely for its alpha ramp.
        ...(includeBackgroundColor && { 'background-color': style.backgroundColor }),
        'background-image': backgroundImage,
        'background-size': style.backgroundSize,
        'background-repeat': style.backgroundRepeat,
        'background-position': style.backgroundPosition,
      };

  const css = Object.entries(declarations)
    .filter(([, value]) => value && value !== 'none')
    .map(([property, value]) => `${property}:${value}`)
    .join(';');
  if (!css) return null;

  // A CSS background is clipped by the element's border radii. The temporary
  // XHTML box must carry that geometry too; otherwise a circular conic
  // gradient is rasterized as an opaque square before it ever reaches PPTX.
  const clipCss = isolateTile
    ? ''
    : [
        'box-sizing:border-box',
        'overflow:hidden',
        `border-top-left-radius:${style.borderTopLeftRadius || '0px'}`,
        `border-top-right-radius:${style.borderTopRightRadius || '0px'}`,
        `border-bottom-right-radius:${style.borderBottomRightRadius || '0px'}`,
        `border-bottom-left-radius:${style.borderBottomLeftRadius || '0px'}`,
      ].join(';');
  const boxStyle = escapeXmlAttribute(`width:${width}px;height:${height}px;${clipCss};${css}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="${boxStyle}"></div>` +
    `</foreignObject></svg>`
  );
}

function rasterizeSvgMarkup(svg, rasterWidth, rasterHeight) {
  return new Promise((resolve) => {
    // Decoding a self-contained SVG takes milliseconds, but an environment that
    // fires neither load nor error would otherwise stall the whole export.
    const timer = setTimeout(() => resolve(null), SVG_PAINT_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = rasterWidth;
        canvas.height = rasterHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          settle(null);
          return;
        }
        ctx.drawImage(img, 0, 0, rasterWidth, rasterHeight);
        settle(canvas);
      } catch {
        settle(null);
      }
    };
    img.onerror = () => settle(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/**
 * Answers two questions about a painted canvas in one pass.
 *
 * `hasContent` — a painter that does not understand a gradient returns a fully
 * transparent canvas rather than failing, so an empty result is a miss;
 * otherwise a blank full-slide PNG ships as a media part for every slide.
 *
 * `fullyOpaque` — an opaque result does not need PNG. A conic sweep covers every
 * pixel, and carrying an all-255 alpha channel costs an order of magnitude in
 * bytes for nothing.
 */
function inspectCanvasAlpha(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') return { hasContent: true, fullyOpaque: false };
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hasContent = false;
    let fullyOpaque = true;
    for (let index = 3; index < pixels.length; index += 4) {
      const alpha = pixels[index];
      if (alpha > 0) hasContent = true;
      if (alpha < 255) fullyOpaque = false;
      if (hasContent && !fullyOpaque) break;
    }
    return { hasContent, fullyOpaque };
  } catch {
    // A tainted canvas cannot be inspected; keep the content and stay on PNG.
    return { hasContent: true, fullyOpaque: false };
  }
}

function toRasterResult(canvas, compositedOpaque) {
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) return null;
  const { hasContent, fullyOpaque } = inspectCanvasAlpha(canvas);
  if (!hasContent) return null;
  const data =
    compositedOpaque || fullyOpaque ? canvas.toDataURL('image/jpeg', 0.85) : canvas.toDataURL('image/png');
  if (!data || data === 'data:,') return null;
  return { data, rasterWidth: canvas.width, rasterHeight: canvas.height };
}

/**
 * Paints an element's background layer — and nothing else — into a PNG.
 *
 * Shared by the single-tile capture and by whole-element fallbacks for
 * gradients that DrawingML and SVG gradients cannot express.
 */
async function paintBackgroundRegion(node, region, rasterOptions = {}) {
  const width = Math.max(Math.round(region.width), 1);
  const height = Math.max(Math.round(region.height), 1);
  const scale = resolveRasterScale({ ...rasterOptions, requestedScale: 2 }, 2);
  const rasterWidth = Math.max(Math.round(width * scale), 1);
  const rasterHeight = Math.max(Math.round(height * scale), 1);

  return traceRasterOperation(rasterOptions, 'paint_background_region', {
    reason: rasterOptions.rasterizationReason || 'painted_css_background',
    tag: String(node?.tagName || '').toLowerCase() || 'unknown',
    css_width: width,
    css_height: height,
    requested_raster_width: rasterWidth,
    requested_raster_height: rasterHeight,
    scale,
  }, async () => {

  // Preferred painter: the browser's own CSS engine via <foreignObject>.
  try {
    const style = window.getComputedStyle(node);
    const backgroundImage = await inlineCssImageUrls(style.backgroundImage);
    // A layer whose bytes could not be inlined would paint as a hole rather
    // than as a failure, so give up on this painter and let html2canvas — which
    // loads images through the normal loader — have the element instead.
    const svg =
      backgroundImage === null
        ? null
        : buildBackgroundLayerSvg(
            style,
            width,
            height,
            !!region.resetPosition,
            !!region.includeBackgroundColor,
            backgroundImage
          );
    if (svg) {
      const result = toRasterResult(
        await rasterizeSvgMarkup(svg, rasterWidth, rasterHeight),
        !!region.includeBackgroundColor
      );
      if (result) return result;
    }
  } catch {
    // Fall through to html2canvas.
  }

  const originalId = node.id;
  const tempId = 'pptx-tile-' + Math.random().toString(36).slice(2, 11);
  node.id = tempId;

  try {
    const canvas = await html2canvas(node, {
      backgroundColor: null,
      logging: false,
      scale,
      useCORS: true,
      width,
      height,
      x: region.originX || 0,
      y: region.originY || 0,
      onclone: (clonedDoc) => {
        const clonedNode = clonedDoc.getElementById(tempId);
        if (!clonedNode) return;
        // Only the background layer belongs in the tile. Children, borders and
        // shadows are emitted as their own PPTX objects, and the element's own
        // opacity travels with the picture's transparency option, so baking any
        // of them into the tile would double-apply them.
        for (const child of Array.from(clonedNode.children)) {
          child.style.setProperty('display', 'none', 'important');
        }
        clonedNode.style.setProperty('opacity', '1', 'important');
        clonedNode.style.setProperty('border', 'none', 'important');
        clonedNode.style.setProperty('box-shadow', 'none', 'important');
        // Whole-background captures must retain the element's clipping
        // geometry. A repeated tile has no rounded outer edge of its own, but
        // rounded elements are excluded from the tile path before this point.
        if (region.resetPosition) clonedNode.style.setProperty('border-radius', '0', 'important');
        clonedNode.style.setProperty('filter', 'none', 'important');
        if (region.resetPosition) {
          // The captured window already sits on a period boundary, so the tile
          // must be painted unshifted and unrepeated.
          clonedNode.style.setProperty('background-repeat', 'no-repeat', 'important');
          clonedNode.style.setProperty('background-position', '0 0', 'important');
        }
      },
      ...(region.includeBackgroundColor && { backgroundColor: window.getComputedStyle(node).backgroundColor }),
    });
    return toRasterResult(canvas, !!region.includeBackgroundColor);
  } catch {
    return null;
  } finally {
    if (originalId) node.id = originalId;
    else node.removeAttribute('id');
  }
  });
}

function hasUnsupportedVisual(style) {
  const mixBlendMode = String(style.mixBlendMode || '').trim().toLowerCase();
  if (mixBlendMode && mixBlendMode !== 'normal') return true;
  const maskImage = String(style.maskImage || style.webkitMaskImage || '').trim().toLowerCase();
  if (maskImage && maskImage !== 'none') return true;
  const clipPath = String(style.clipPath || '').trim().toLowerCase();
  if (clipPath && clipPath !== 'none' && !clipPath.startsWith('inset(')) return true;
  const filter = String(style.filter || '').trim().toLowerCase();
  if (filter && filter !== 'none' && !/^blur\([^)]*\)$/.test(filter)) return true;
  return false;
}

// A declared image panel is a single visual unit in HTML: its descendants
// share the parent's clipping and stacking context.
// PPTX has no equivalent of that CSS group, so exporting its nested
// absolute/flex children separately moves them out of the frame. This is
// especially visible in comic cards where browser text metrics, flex sizing
// and transforms interact. Honour the explicit `image` contract while leaving
// ordinary textboxes on the native editable path.
function isCompositeIllustrationContainer(node, style) {
  const objectType = String(node?.getAttribute?.('data-object-type') || '').toLowerCase();
  const childCount = Array.from(node.children || []).length;
  const overflow = String(style.overflow || '').trim().toLowerCase();
  return objectType === 'image' && childCount >= 2 && (overflow === 'hidden' || overflow === 'clip');
}

function isCompositeTextboxContainer(node, style) {
  if (String(node?.getAttribute?.('data-object-type') || '').toLowerCase() !== 'textbox') return false;
  if (Array.from(node.children || []).length === 0) return false;
  const transform = String(style.transform || '').trim().toLowerCase();
  if (!transform || transform === 'none' || getRotation(transform) === 0) return false;

  // A slight rotation alone is representable in PPTX and should leave normal
  // multi-line content editable. Capture only the browser-only glyph paint
  // that PowerPoint cannot reproduce faithfully (for example comic text
  // outlines or CSS text shadows).
  return Array.from(node.querySelectorAll?.('*') || []).some((child) => {
    const childStyle = window.getComputedStyle(child);
    const strokeWidth = String(childStyle.webkitTextStrokeWidth || '').trim();
    const textShadow = String(childStyle.textShadow || '').trim().toLowerCase();
    return (strokeWidth && strokeWidth !== '0px' && strokeWidth !== 'none') ||
      (textShadow && textShadow !== 'none');
  });
}

// A leaf noise/texture layer can remain an independent semi-transparent
// picture. Treating it as a generic blend-mode screenshot would flatten every
// lower object into one page image, even though the only unsupported part is
// the blend formula itself. PowerPoint uses normal alpha compositing here: it
// is a close visual approximation while keeping the actual page editable.
function isIndependentBlendTexture(node, style) {
  const mixBlendMode = String(style.mixBlendMode || '').trim().toLowerCase();
  if (!mixBlendMode || mixBlendMode === 'normal') return false;
  if (Array.from(node.children || []).length > 0 || String(node.textContent || '').trim()) return false;
  if (!style.backgroundImage || style.backgroundImage === 'none') return false;
  const hasMask = String(style.maskImage || style.webkitMaskImage || '').trim().toLowerCase();
  const clipPath = String(style.clipPath || '').trim().toLowerCase();
  const filter = String(style.filter || '').trim().toLowerCase();
  return (!hasMask || hasMask === 'none') &&
    (!clipPath || clipPath === 'none' || clipPath.startsWith('inset(')) &&
    (!filter || filter === 'none');
}

function isFullSlideDecorativeTexture(node, config) {
  const rect = node.getBoundingClientRect();
  const rootRect = config.root.getBoundingClientRect();
  const parentRect = node.parentElement?.getBoundingClientRect();
  const tolerance = 2;
  // The production deck wrapper can contain a slide-sized `.slide` element
  // below the export root. Accept that one extra structural wrapper, while
  // still requiring both the texture and its immediate paint context to cover
  // exactly the exported canvas.
  if (
    !parentRect ||
    Math.abs(parentRect.left - rootRect.left) > tolerance ||
    Math.abs(parentRect.top - rootRect.top) > tolerance ||
    Math.abs(parentRect.width - rootRect.width) > tolerance ||
    Math.abs(parentRect.height - rootRect.height) > tolerance
  ) {
    return false;
  }
  return (
    Math.abs(rect.left - rootRect.left) <= tolerance &&
    Math.abs(rect.top - rootRect.top) <= tolerance &&
    Math.abs(rect.width - rootRect.width) <= tolerance &&
    Math.abs(rect.height - rootRect.height) <= tolerance
  );
}

function hasBackdropFilter(style) {
  const value = String(style.backdropFilter || style.webkitBackdropFilter || '').trim().toLowerCase();
  return value && value !== 'none';
}

function numericZIndex(style) {
  const value = Number.parseInt(String(style?.zIndex || ''), 10);
  return Number.isFinite(value) ? value : 0;
}

function shouldCaptureBelow(node, slide) {
  const candidates = [slide, ...Array.from(slide.querySelectorAll('*'))];
  const targetIndex = candidates.indexOf(node);
  const targetZ = numericZIndex(window.getComputedStyle(node));
  const compareCandidate = (candidate, candidateIndex) => {
    const candidateZ = numericZIndex(window.getComputedStyle(candidate));
    return candidateZ > targetZ || (candidateZ === targetZ && candidateIndex > targetIndex);
  };
  return candidates
    .filter((candidate) => {
      if (candidate === node || node.contains(candidate) || candidate.contains(node)) return false;
      const tag = String(candidate.tagName || '').toLowerCase();
      if (tag === 'img' || tag === 'table') return true;
      return Array.from(candidate.childNodes || []).some(
        (child) => child.nodeType === Node.TEXT_NODE && String(child.textContent || '').trim()
      );
    })
    .every((candidate) => compareCandidate(candidate, candidates.indexOf(candidate)));
}

async function captureUnsupportedElement(
  node,
  config,
  globalOptions,
  paddingPx = 0,
  isolate = false,
  hideDescendants = false
) {
  const capture = globalOptions?._captureElement;
  if (typeof capture !== 'function') return null;

  const slide = config.root;
  const slideRect = slide.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const hidden = [];
  const candidates = [slide, ...Array.from(slide.querySelectorAll('*'))];
  const targetIndex = candidates.indexOf(node);
  const targetZ = numericZIndex(window.getComputedStyle(node));

  // This exporter assumes a flat, absolutely-positioned layer model. CSS
  // stacking contexts are otherwise not comparable by one numeric z-index.
  const compareCandidate = (candidate, candidateIndex) => {
    const candidateZ = numericZIndex(window.getComputedStyle(candidate));
    return candidateZ > targetZ || (candidateZ === targetZ && candidateIndex > targetIndex);
  };
  const mixBlendMode = String(window.getComputedStyle(node).mixBlendMode || '').trim().toLowerCase();
  // A blend mode is defined against the already-painted backdrop. Capturing it
  // in isolation turns transparent browser output into an opaque black image
  // in Chromium's screenshot path, which can then hide the whole slide.
  // Capture the lower stack instead; exportToPptx removes those duplicate
  // objects because their browser-composited pixels now live in this image.
  const captureBelow = !isolate && (
    (mixBlendMode && mixBlendMode !== 'normal') || shouldCaptureBelow(node, slide)
  );
  const isolatedStyles = [];
  if (!captureBelow) {
    // A target's transparent pixels otherwise reveal the authored `.slide`
    // wrapper (or any intermediate section) in the screenshot. Those page
    // colours then become an opaque rectangular halo in the resulting PNG.
    // Clear every paint ancestor, leaving only the target's own pixels.
    const backgroundTargets = [document.documentElement, document.body, slide];
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== slide) {
      backgroundTargets.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    for (const target of backgroundTargets) {
      isolatedStyles.push({ target, cssText: target.style.cssText });
      for (const property of ['background', 'background-color', 'background-image', 'border-color', 'box-shadow']) {
        target.style.setProperty(property, property === 'background-color' || property === 'border-color' ? 'transparent' : 'none', 'important');
      }
    }
  }

  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (candidate === node || candidate.contains(node)) continue;
    const isDescendant = node.contains(candidate);
    if (isDescendant && !hideDescendants) continue;
    const candidateStyle = window.getComputedStyle(candidate);
    if (isDescendant && hideDescendants) {
      // Nested title wrappers often own the coloured frame while their child
      // owns the glyphs. Hiding the wrapper erases that frame as well; hide
      // only text paint so the screenshot remains a transparent visual shell.
      hidden.push({
        candidate,
        color: candidate.style.color,
        textShadow: candidate.style.textShadow,
        webkitTextStrokeColor: candidate.style.webkitTextStrokeColor,
      });
      candidate.style.setProperty('color', 'transparent', 'important');
      candidate.style.setProperty('text-shadow', 'none', 'important');
      candidate.style.setProperty('-webkit-text-stroke-color', 'transparent', 'important');
      continue;
    }
    const shouldHide = isDescendant || (captureBelow ? compareCandidate(candidate, candidateIndex) : candidate !== slide);
    if (shouldHide && candidateStyle.visibility !== 'hidden') {
      hidden.push({ candidate, visibility: candidate.style.visibility });
      candidate.style.visibility = 'hidden';
    }
  }

  try {
    const data = await capture({
      documentX: rect.left - paddingPx + window.scrollX,
      documentY: rect.top - paddingPx + window.scrollY,
      width: rect.width + paddingPx * 2,
      height: rect.height + paddingPx * 2,
      slideTop: slideRect.top + window.scrollY,
      slideLeft: slideRect.left + window.scrollX,
      captureBelow,
      captureMimeType: captureBelow ? 'image/jpeg' : 'image/png',
      rasterScale: resolveRasterScale(
        {
          requestedScale: 3,
          pptxScale: config.scale,
          maxDpi: globalOptions._maxRasterDpi,
        },
        3
      ),
    });
    return data ? { data, captureBelow } : null;
  } finally {
    for (const entry of hidden) {
      if ('visibility' in entry) {
        entry.candidate.style.visibility = entry.visibility;
      } else {
        entry.candidate.style.color = entry.color;
        entry.candidate.style.textShadow = entry.textShadow;
        entry.candidate.style.webkitTextStrokeColor = entry.webkitTextStrokeColor;
      }
    }
    for (const { target, cssText } of isolatedStyles) {
      target.style.cssText = cssText;
    }
  }
}

/**
 * Read one font file for embedding.
 *
 * Defaults to the page's own `fetch`, which is right for a standalone
 * browser build. An embedder can pass `options.fetchFontBuffer` to route
 * reads through its host process instead — required for `file:` sources,
 * because browsers reject `fetch('file://...')` outright, so a workspace
 * font materialised on disk is unreadable from page context.
 *
 * The hook returns a base64 string (structured-clone friendly, so it
 * survives a Puppeteer `exposeFunction` boundary) or an ArrayBuffer.
 */
async function readFontBuffer(url, fetchFontBuffer) {
  if (typeof fetchFontBuffer === 'function') {
    const result = await fetchFontBuffer(url);
    if (!result) throw new Error(`Host returned no font bytes for ${url}`);
    if (typeof result === 'string') {
      const binary = atob(result);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes.buffer;
    }
    return result;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url} (HTTP ${response.status})`);
  return response.arrayBuffer();
}

/**
 * Main export function.
 * @param {HTMLElement | string | Array<HTMLElement | string>} target
 * @param {Object} options
 * @param {string} [options.fileName]
 * @param {boolean} [options.skipDownload=false] - If true, prevents automatic download
 * @param {Object} [options.listConfig] - Config for bullets
 * @param {boolean} [options.svgAsVector=false] - If true, keeps SVG as vector (for Convert to Shape in PowerPoint)
 * @param {boolean} [options.skipNormalize=false] - If true, skips re-zipping with DEFLATE
 *   and stripping dangling [Content_Types].xml Overrides. Leave it false unless you are
 *   debugging the raw PptxGenJS output, otherwise Microsoft PowerPoint may reject the file.
 * @param {(url: string) => Promise<string|ArrayBuffer>} [options.fetchFontBuffer] - Reads a
 *   font file for embedding through the host process instead of the page's `fetch`.
 *   Needed for `file:` font sources, which browsers refuse to `fetch`.
 * @param {(request: {family: string, weight?: string|number, style?: string, url?: string}) => Promise<Array<{url: string}>|null>} [options.resolveStaticFontSource] -
 *   Optionally replaces a Google Fonts variable source with legacy-UA static
 *   instances. A host may return null to preserve the original source.
 * @param {(report: {embedded: string[], failed: Array<{font: string, reason: string}>, backfilled: Array<{family: string, from: string}>}) => void} [options.onFontEmbedReport] -
 *   Receives the font-embedding outcome so a host can surface it as a job warning.
 * @returns {Promise<Blob>} - Returns the generated PPTX Blob
 */
export async function exportToPptx(target, options = {}) {
  const resolvePptxConstructor = (pkg) => {
    if (!pkg) return null;
    if (typeof pkg === 'function') return pkg;
    if (pkg && typeof pkg.default === 'function') return pkg.default;
    if (pkg && typeof pkg.PptxGenJS === 'function') return pkg.PptxGenJS;
    if (pkg && pkg.PptxGenJS && typeof pkg.PptxGenJS.default === 'function') return pkg.PptxGenJS.default;
    return null;
  };

  const PptxConstructor = resolvePptxConstructor(PptxGenJS);
  if (!PptxConstructor) throw new Error('PptxGenJS constructor not found.');
  const pptx = new PptxConstructor();

  // 1. Layout Handling
  let finalWidth = 10; // default 16:9
  let finalHeight = 5.625;

  if (options.width && options.height) {
    pptx.defineLayout({ name: 'CUSTOM', width: options.width, height: options.height });
    pptx.layout = 'CUSTOM';
    finalWidth = options.width;
    finalHeight = options.height;
  } else if (options.layout) {
    pptx.layout = options.layout;
    // Map standard layouts for internal scale calculation if possible,
    // though PptxGenJS defaults to 16:9 if unknown.
    if (options.layout === 'LAYOUT_4x3') {
      finalWidth = 10;
      finalHeight = 7.5;
    } else if (options.layout === 'LAYOUT_16x10') {
      finalWidth = 10;
      finalHeight = 6.25;
    } else if (options.layout === 'LAYOUT_WIDE') {
      finalWidth = 13.3;
      finalHeight = 7.5;
    }
  } else {
    const firstEl = Array.isArray(target) ? target[0] : target;
    const root = typeof firstEl === 'string' ? document.querySelector(firstEl) : firstEl;
    if (root) {
      const rect = root.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const aspect = rect.width / rect.height;
        finalWidth = 10;
        finalHeight = 10 / aspect;
        pptx.defineLayout({ name: 'AUTO_DESIGN', width: finalWidth, height: finalHeight });
        pptx.layout = 'AUTO_DESIGN';
      } else {
        pptx.layout = 'LAYOUT_16x9';
      }
    } else {
      pptx.layout = 'LAYOUT_16x9';
    }
  }

  // Pass these dimensions to options so processSlide can use them
  const extendedOptions = {
    ...options,
    _slideWidth: finalWidth,
    _slideHeight: finalHeight,
    _maxRasterDpi: Math.max(Number(options.maxRasterDpi ?? options._maxRasterDpi) || DEFAULT_MAX_RASTER_DPI, 1),
    // This cache is deliberately export-scoped: a data URL is safe to reuse
    // between slides in one Deck, while retaining it across exports would keep
    // large raster data alive in a long-running browser process.
    _svgPreviewCache: new Map(),
  };

  const elements = Array.isArray(target) ? target : [target];

  let slideIndex = 0;
  const slideAnimations = {};
  const slideTransitions = {};
  for (const el of elements) {
    const root = typeof el === 'string' ? document.querySelector(el) : el;
    if (!root) {
      console.warn('Element not found, skipping slide:', el);
      continue;
    }

    const transition = extractTransitionFromElement(root);
    if (transition) {
      slideTransitions[slideIndex] = transition;
    }

    const slide = pptx.addSlide();
    const slideOptions = {
      ...extendedOptions,
      _slideIndex: slideIndex,
      _animations: [],
    };

    // Extract speaker notes from any element inside the slide root that
    // carries a data-pptx-notes attribute. Recognises <template
    // data-pptx-notes> (inert content), <div data-pptx-notes hidden>,
    // and any other tag with the attribute. Multiple matches concatenate.
    // Notes are attached BEFORE processSlide runs so users can freely
    // place notes wherever they like without worrying about ordering.
    const notesText = extractSpeakerNotesFromElement(root);
    if (notesText) {
      slide.addNotes(notesText);
    }

    await traceRasterOperation(extendedOptions, 'process_slide', { slide_number: slideIndex + 1 }, () =>
      processSlide(root, slide, pptx, slideOptions)
    );
    slideAnimations[slideIndex] = slideOptions._animations;
    slideIndex++;
  }
  extendedOptions._slideAnimations = slideAnimations;
  extendedOptions._slideTransitions = slideTransitions;

  // 3. Font Embedding Logic
  let finalBlob;
  let rawFonts = options.fonts || [];
  let fontsToEmbed;

  // Group by (name, variant) so each PowerPoint slot gets its own font.
  // classifyFontVariant lives in utils.js so it can be unit-tested and
  // reused for collision detection below.
  const uniqueFonts = new Map();
  const addToGroup = (name, variant, url) => {
    const key = name + '::' + variant;
    if (!uniqueFonts.has(key)) {
      uniqueFonts.set(key, { name, variant, urls: new Set() });
    }
    uniqueFonts.get(key).urls.add(url);
  };

  // Track every raw entry so we can detect variant-slot collisions
  // (e.g. Inter@700 and Inter@900 both landing in the `bold` slot).
  const rawFontDescriptors = [];

  for (const f of rawFonts) {
    const variant = classifyFontVariant(f.weight, f.style);
    rawFontDescriptors.push({ name: f.name, weight: f.weight, style: f.style });
    if (f.url) addToGroup(f.name, variant, f.url);
    if (f.urls) {
      for (const url of f.urls) addToGroup(f.name, variant, url);
    }
  }

  if (options.autoEmbedFonts) {
    // A. Scan DOM for used font families
    // Isolated-page export supplies the families used by the whole deck so
    // each one-page PPTX carries the same @font-face catalogue.  Without
    // this, joining page archives can leave a later page referring to a face
    // that only existed in its own archive.
    const usedFamilies = new Set(getUsedFontFamilies(elements));
    for (const family of options.fontFamiliesOverride || []) {
      if (typeof family === 'string' && family.trim()) usedFamilies.add(family.trim());
    }

    // B. Scan CSS for URLs matches (each carries weight+style now)
    const detectedFonts = await getAutoDetectedFonts(usedFamilies);

    // C. Google Fonts css2 commonly gives every requested weight the same
    // variable WOFF2. The WOFF2 -> EOT converter cannot preserve its axes,
    // so allow the host to replace that URL with static legacy-UA slices.
    // The callback is optional and failure is deliberately non-fatal: the
    // original source still follows the pre-existing embedding path.
    const resolvedAutoFonts = await Promise.all(detectedFonts.map(async (autoFont) => {
      const sourceUrl = String(autoFont.url || '');
      if (!/^https:\/\/fonts\.gstatic\.com\//i.test(sourceUrl) ||
          typeof options.resolveStaticFontSource !== 'function') {
        return [autoFont];
      }
      try {
        const staticSources = await options.resolveStaticFontSource({
          family: autoFont.name,
          weight: autoFont.weight,
          style: autoFont.style,
          url: sourceUrl,
        });
        if (!Array.isArray(staticSources) || staticSources.length === 0) return [autoFont];
        const urls = staticSources.map((source) => source && source.url).filter(Boolean);
        return urls.length > 0 ? urls.map((url) => ({ ...autoFont, url })) : [autoFont];
      } catch (e) {
        console.warn(
          `dom-to-pptx: failed to resolve a static Google Fonts source for "${autoFont.name}"; ` +
            'using its original source instead.',
          e
        );
        return [autoFont];
      }
    }));

    // D. Merge, keyed by (name, variant) so Bold does not collapse into Regular
    for (const autoFont of resolvedAutoFonts.flat()) {
      const variant = classifyFontVariant(autoFont.weight, autoFont.style);
      rawFontDescriptors.push({ name: autoFont.name, weight: autoFont.weight, style: autoFont.style });
      addToGroup(autoFont.name, variant, autoFont.url);
    }

    if (detectedFonts.length > 0) {
      console.log(
        'Auto-detected fonts:',
        detectedFonts.map((f) => `${f.name} (${classifyFontVariant(f.weight, f.style)})`)
      );
    }
  }

  // Ask the host for a source for every system font the browser actually
  // rendered with (the names getTextStyle writes into typeface attributes).
  // @font-face detection above cannot see installed fonts — their declarations
  // have no url() — yet PowerPoint only finds them by name on the machine
  // that has them, so an embeddable copy is what makes the deck portable.
  // The host callback receives the family name plus the code points the deck
  // renders with it (plus ASCII and common CJK punctuation as safety margin)
  // so it can ship a subset instead of a multi-megabyte system font. It may
  // answer with one {url, weight, style}, an array of them (e.g. regular +
  // bold, which live in separate files for many families), or null — a null
  // (or throw) lands in the embed report, never silently.
  const systemFontFailures = [];
  if (options.embedSystemFonts !== false && typeof options.resolveFontSource === 'function') {
    const renderedUsage = collectRenderedFonts(elements);
    // Merge (rather than replace) page-local usage: a single-page exporter
    // must still cover text produced dynamically during that page's export.
    for (const entry of options.fontUsageOverride || []) {
      if (!entry || typeof entry.family !== 'string' || !Array.isArray(entry.unicodes)) continue;
      const family = entry.family.trim();
      if (!family) continue;
      let codepoints = renderedUsage.get(family);
      if (!codepoints) {
        codepoints = new Set();
        renderedUsage.set(family, codepoints);
      }
      for (const codepoint of entry.unicodes) {
        if (Number.isInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff) codepoints.add(codepoint);
      }
    }

    const alreadyRegistered = new Set();
    for (const key of uniqueFonts.keys()) {
      alreadyRegistered.add(key.split('::')[0].toLowerCase());
    }

    const unicodesFor = (codepoints) => {
      const all = new Set(codepoints);
      // The subset only needs to cover glyphs the deck uses, but a viewer
      // adding a space or a fullwidth comma mid-edit must not hit a glyph
      // the export "knew about"; these ranges are a few hundred glyphs.
      for (let cp = 0x20; cp <= 0x7e; cp++) all.add(cp);
      for (let cp = 0x3000; cp <= 0x303f; cp++) all.add(cp); // CJK punctuation
      for (let cp = 0xff00; cp <= 0xffef; cp++) all.add(cp); // half/fullwidth forms
      return [...all].sort((a, b) => a - b);
    };

    for (const [family, codepoints] of renderedUsage) {
      if (alreadyRegistered.has(family.toLowerCase())) continue;
      let resolved = null;
      try {
        // Plain array in, plain objects out: an exposeFunction bridge
        // serializes arguments, and a Set would cross as {}.
        resolved = await options.resolveFontSource(family, { unicodes: unicodesFor(codepoints) });
      } catch (e) {
        systemFontFailures.push({
          font: family,
          reason: `resolveFontSource threw: ${e && e.message ? e.message : String(e)}`,
        });
        continue;
      }
      if (!resolved) {
        systemFontFailures.push({
          font: family,
          reason: 'no system font source (not installed, or its license forbids embedding)',
        });
        continue;
      }
      const sources = Array.isArray(resolved) ? resolved : [resolved];
      for (const src of sources) {
        if (!src || !src.url) {
          systemFontFailures.push({ font: family, reason: 'resolveFontSource returned an entry without url' });
          continue;
        }
        const variant = classifyFontVariant(src.weight, src.style);
        rawFontDescriptors.push({ name: family, weight: src.weight, style: src.style });
        addToGroup(family, variant, src.url);
      }
    }
  }

  // Warn when two @font-face declarations with materially different
  // weights land in the same PowerPoint slot. Most common example:
  // declaring Inter at weight 700 alongside weight 900 — both classify as
  // `bold`, so weight 900 glyphs silently get merged into (and mostly
  // overwritten by) weight 700. To render Inter Black distinctly, declare
  // it under a separate CSS family (e.g. `font-family: 'Inter Black'`)
  // rather than a heavier weight of the same family.
  const collisions = detectVariantSlotCollisions(rawFontDescriptors);
  const fontFidelityWarnings = collisions.map((collision) => ({
    font: `${collision.family} (${collision.variant})`,
    reason:
      `variant-slot-collision: CSS weights ${collision.weights.join(', ')} collapse into PowerPoint's ` +
      `${collision.variant} embedded-font slot; only one distinct face can be embedded.`,
  }));
  for (const c of collisions) {
    console.warn(
      `dom-to-pptx: font "${c.family}" declares multiple weights (${c.weights.join(', ')}) ` +
        `that collapse into PowerPoint's "${c.variant}" slot. Only one will render distinctly. ` +
        `Declare the heavier weight under a separate CSS family (e.g. 'Inter Black') if you ` +
        `need it to render as a distinct face.`
    );
  }

  // Fill an empty `regular` slot from the family's other faces before
  // embedding. PowerPoint substitutes the whole family when that slot is
  // missing, so a page declaring only `Playfair Display: 700 italic` used
  // to lose Playfair Display entirely even though the browser rendered it.
  const slotFilled = backfillRegularFontSlot(
    Array.from(uniqueFonts.values()).map((entry) => ({
      name: entry.name,
      variant: entry.variant,
      urls: Array.from(entry.urls),
    }))
  );
  fontsToEmbed = slotFilled.fonts;

  for (const entry of slotFilled.backfilled) {
    console.warn(
      `dom-to-pptx: font "${entry.family}" declares no regular face; reusing its ` +
        `"${entry.from}" face for PowerPoint's regular slot. Declare an upright ` +
        `@font-face for this family if the substitution is visible.`
    );
  }

  if (fontsToEmbed.length > 0) {
    console.log(
      'Fonts to embed after deduplication and subset gathering:',
      fontsToEmbed.map((f) => `${f.name} (${f.variant}, ${f.urls.length} subsets)`)
    );
  }

  // System-font misses are loud even when the @font-face embeds all succeed
  // (and even when there is nothing to embed at all): a missing embed means
  // the deck still looks right here but changes on another machine.
  if (systemFontFailures.length > 0) {
    console.warn(
      `dom-to-pptx: ${systemFontFailures.length} rendered system font family(ies) could not be ` +
        `embedded; PowerPoint will substitute them on machines without those fonts:`
    );
    for (const f of systemFontFailures) {
      console.warn(`  - ${f.font}: ${f.reason}`);
    }
  }

  if (fontsToEmbed.length > 0) {
    // Generate initial PPTX
    const initialBlob = await traceRasterOperation(extendedOptions, 'pptx_write', { fonts_embedded: true }, () =>
      pptx.write({ outputType: 'blob' })
    );

    // Load into Embedder
    const zip = await JSZip.loadAsync(initialBlob);
    const embedder = new PPTXEmbedFonts();
    await embedder.loadZip(zip);

    // Fetch and Embed Concurrently. Track success/failure per (family,variant)
    // so we can print a structured summary at the end — a silent no-op on
    // font embedding is one of the sharpest workflow sharp edges (a 15 KB
    // PPTX with no fonts embedded looks identical to a 15 KB PPTX with
    // fonts intentionally excluded).
    const embedResults = [];
    await Promise.all(
      fontsToEmbed.map(async (fontCfg) => {
        const label = `${fontCfg.name} (${fontCfg.variant || 'regular'})`;
        try {
          if (fontCfg.urls.length === 0) {
            throw new Error(`No URLs found for font family ${fontCfg.name}`);
          }

          // Fetch all subsets in parallel
          const subsets = await Promise.all(
            fontCfg.urls.map(async (url) => {
              const buffer = await readFontBuffer(url, options.fetchFontBuffer);

              // Do this on the original bytes. fontToEot currently converts
              // variable fonts to their default static instance, so checking
              // after addFont() would be too late to diagnose the loss.
              if (hasVariableFontTables(buffer)) {
                const warningKey = `${fontCfg.name}::${fontCfg.variant || 'regular'}`;
                if (!fontFidelityWarnings.some((warning) => warning._key === warningKey &&
                    warning.reason.startsWith('variable-font-flattened'))) {
                  fontFidelityWarnings.push({
                    _key: warningKey,
                    font: label,
                    reason:
                      'variable-font-flattened-to-default-instance: the current WOFF/WOFF2 to EOT path ' +
                      'does not preserve variation axes, so PowerPoint receives the font default instance.',
                  });
                }
              }

              // Infer type
              const ext = url.split('.').pop().split(/[?#]/)[0].toLowerCase();
              let type = 'ttf';
              if (['woff', 'woff2', 'otf'].includes(ext)) type = ext;

              return { buffer, type };
            })
          );

          await embedder.addFont(fontCfg.name, subsets, options.woff2WasmUrl, undefined, fontCfg.variant || 'regular');
          embedResults.push({ label, ok: true });
        } catch (e) {
          const reason = e && e.message ? e.message : String(e);
          embedResults.push({ label, ok: false, reason });
          console.warn(`Failed to embed font family: ${fontCfg.name}`, e);
        }
      })
    );

    // Structured summary. Users routinely miss the per-family console.warn
    // above (especially when fetch() 404s during a headless build), so we
    // always print an explicit summary line — including a highly visible
    // error line if any embed failed. This turns a silent no-op into a
    // loud one.
    const succeeded = embedResults.filter((r) => r.ok);
    const failed = embedResults.filter((r) => !r.ok);
    if (succeeded.length > 0) {
      console.log(
        `dom-to-pptx: embedded ${succeeded.length} font variant(s): ` + succeeded.map((r) => r.label).join(', ')
      );
    }
    if (failed.length > 0) {
      console.error(
        `dom-to-pptx: FAILED to embed ${failed.length} font variant(s). ` +
          `PowerPoint will fall back to a system font, breaking the design. Details:`
      );
      for (const r of failed) {
        console.error(`  - ${r.label}: ${r.reason}`);
      }
    }

    // Hand the outcome to the host as data, not just console output. A
    // headless embedder cannot reasonably scrape console lines to decide
    // whether the export is missing its typography.
    if (typeof options.onFontEmbedReport === 'function') {
      try {
        // Awaited: a host bridging this over an async boundary (Puppeteer
        // exposeFunction) would otherwise race the export's completion and
        // sometimes lose the report entirely.
        await options.onFontEmbedReport({
          embedded: succeeded.map((r) => r.label),
          failed: [
            ...failed.map((r) => ({ font: r.label, reason: r.reason })),
            ...systemFontFailures,
            ...fontFidelityWarnings.map(({ font, reason }) => ({ font, reason })),
          ],
          backfilled: slotFilled.backfilled,
        });
      } catch (e) {
        console.warn('dom-to-pptx: onFontEmbedReport threw; continuing export.', e);
      }
    }

    await traceRasterOperation(extendedOptions, 'font_embedder_update', {}, () => embedder.updateFiles());
    if (options.skipNormalize !== true) {
      await traceRasterOperation(extendedOptions, 'normalize_pptx_zip', {}, () => normalizePptxZip(zip, extendedOptions));
    }
    finalBlob = await traceRasterOperation(extendedOptions, 'font_embedder_generate', {}, () => embedder.generateBlob());
  } else {
    // Nothing embedded, but system-font misses still deserve the data
    // channel — the "zero @font-face in the deck" case is exactly the one
    // where a silent report would hide that other machines will reflow.
    if ((systemFontFailures.length > 0 || fontFidelityWarnings.length > 0) && typeof options.onFontEmbedReport === 'function') {
      try {
        await options.onFontEmbedReport({
          embedded: [],
          failed: [
            ...systemFontFailures,
            ...fontFidelityWarnings.map(({ font, reason }) => ({ font, reason })),
          ],
          backfilled: [],
        });
      } catch (e) {
        console.warn('dom-to-pptx: onFontEmbedReport threw; continuing export.', e);
      }
    }
    // No fonts to embed — still re-zip with DEFLATE and strip dangling Overrides
    // so Microsoft PowerPoint accepts the file (PptxGenJS leaves both issues
    // unresolved on its own; see 错误诊断.md).
    const initialBlob = await traceRasterOperation(extendedOptions, 'pptx_write', { fonts_embedded: false }, () =>
      pptx.write({ outputType: 'blob' })
    );
    if (options.skipNormalize === true) {
      finalBlob = initialBlob;
    } else {
      const zip = await JSZip.loadAsync(initialBlob);
      await traceRasterOperation(extendedOptions, 'normalize_pptx_zip', {}, () => normalizePptxZip(zip, extendedOptions));
      finalBlob = await traceRasterOperation(extendedOptions, 'zip_generate', {}, () => zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      }));
    }
  }

  // 4. Output Handling
  // If skipDownload is NOT true, proceed with browser download
  if (!options.skipDownload) {
    const fileName = options.fileName || 'export.pptx';
    const url = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Always return the blob so the caller can use it (e.g. upload to server)
  return finalBlob;
}

/**
 * Worker function to process a single DOM element into a single PPTX slide.
 * @param {HTMLElement} root - The root element for this slide.
 * @param {PptxGenJS.Slide} slide - The PPTX slide object to add content to.
 * @param {PptxGenJS} pptx - The main PPTX instance.
 */
function compareKeys(keyA, keyB) {
  const len = Math.max(keyA.length, keyB.length);
  for (let i = 0; i < len; i++) {
    const valA = keyA[i] !== undefined ? keyA[i] : 0;
    const valB = keyB[i] !== undefined ? keyB[i] : 0;
    if (valA !== valB) {
      return valA - valB;
    }
  }
  return 0;
}

function getCustomShapeType(customShapeName, pptx) {
  if (!customShapeName) return pptx.ShapeType.rect;
  const name = customShapeName.trim().replace(/['"]/g, '').toLowerCase();
  if (name === 'circle' || name === 'ellipse' || name === 'oval') return pptx.ShapeType.ellipse;
  if (name === 'triangle') return pptx.ShapeType.triangle;
  if (name === 'diamond') return pptx.ShapeType.diamond;
  if (name === 'parallelogram') return pptx.ShapeType.parallelogram;
  if (name === 'hexagon') return pptx.ShapeType.hexagon;
  if (name === 'pentagon') return pptx.ShapeType.pentagon;
  if (name === 'star') return pptx.ShapeType.star5;
  if (name === 'chevron') return pptx.ShapeType.chevron;
  if (name === 'rect' || name === 'rectangle') return pptx.ShapeType.rect;
  if (name === 'roundrect' || name === 'roundedrectangle') return pptx.ShapeType.roundRect;
  for (const key of Object.keys(pptx.ShapeType)) {
    if (key.toLowerCase() === name) return pptx.ShapeType[key];
  }
  return pptx.ShapeType.rect;
}

// Static decks render every authored slide in a fixed-size shell. The canvas
// chain is deliberately limited to that shell and its one full-size child, so
// normal full-bleed content cannot be mistaken for a page background.
function getPageCanvasChain(root) {
  const chain = [root];
  let current = root;
  const rootRect = root.getBoundingClientRect();
  while (current.children?.length === 1) {
    const child = current.firstElementChild;
    const rect = child?.getBoundingClientRect?.();
    if (
      !rect ||
      Math.abs(rect.left - rootRect.left) > 0.5 ||
      Math.abs(rect.top - rootRect.top) > 0.5 ||
      Math.abs(rect.width - rootRect.width) > 0.5 ||
      Math.abs(rect.height - rootRect.height) > 0.5
    ) {
      break;
    }
    chain.push(child);
    current = child;
  }
  return chain;
}

function getCanvasPptxRect(node, config) {
  const rect = node.getBoundingClientRect();
  const pxToIn = PX_TO_INCH * config.scale;
  const left = Number.isFinite(rect.left) ? rect.left : Number(rect.x) || 0;
  const top = Number.isFinite(rect.top) ? rect.top : Number(rect.y) || 0;
  const rootX = Number.isFinite(config.rootX) ? config.rootX : 0;
  const rootY = Number.isFinite(config.rootY) ? config.rootY : 0;
  return {
    x: config.offX + (left - rootX) * pxToIn,
    y: config.offY + (top - rootY) * pxToIn,
    w: rect.width * pxToIn,
    h: rect.height * pxToIn,
  };
}

function hasQueuedPageCanvasPaint(queue, slideWidth, slideHeight) {
  return queue.some(
    (item) =>
      // This check runs after the asynchronous image work.  A failed image
      // background remains in the queue with `skip: true` until the final
      // filter below, so it cannot count as a painted canvas here.
      !item?.skip &&
      (item?.type === 'image' || (item?.type === 'shape' && item?.options?.fill?.color)) &&
      // An image has no visual paint until its job has supplied the data URL.
      // Without this guard a dropped full-page CSS background suppresses the
      // very fallback intended to restore the page shell.
      (item?.type !== 'image' || !!item?.options?.data) &&
      Number(item.options?.w) >= slideWidth - 0.002 &&
      Number(item.options?.h) >= slideHeight - 0.002
  );
}

async function addMissingPageCanvasBackgrounds(root, config, queue, globalOptions) {
  // Normal pages already have a shell fill, the authored slide fill, and often
  // a full-page texture. The fallback is only for the broken zero-canvas case;
  // adding it to a partially successful page would risk changing its layering.
  if (hasQueuedPageCanvasPaint(queue, globalOptions._slideWidth || 10, globalOptions._slideHeight || 5.625)) return;

  const candidates = getPageCanvasChain(root);
  for (let index = 0; index < candidates.length; index += 1) {
    const node = candidates[index];
    const style = window.getComputedStyle(node);
    const backgroundColor = parseColor(style.backgroundColor, style);
    const backgroundImage = String(style.backgroundImage || '').trim();
    const rect = getCanvasPptxRect(node, config);
    // Keep the canvas before regular visual objects.  `domOrder` must remain
    // non-negative because the OOXML normalizer reads it from the transport
    // marker before it reorders the slide tree.
    const zBase = -1000000 + index * 10;

    if (backgroundColor.hex && backgroundColor.opacity > 0) {
      queue.push({
        type: 'shape',
        zIndex: [zBase],
        domOrder: index,
        shapeType: 'rect',
        options: {
          ...rect,
          fill: { color: backgroundColor.hex, transparency: (1 - backgroundColor.opacity) * 100 },
          line: null,
        },
      });
    }

    // Repaint only the CSS background layer when traversal omitted it. Text and
    // foreground objects remain native/exported objects above this fallback.
    if (backgroundImage && backgroundImage !== 'none') {
      const nodeRect = node.getBoundingClientRect();
      const raster = await paintBackgroundRegion(
        node,
        { width: nodeRect.width, height: nodeRect.height, includeBackgroundColor: false },
        createRasterOptions(globalOptions, config, 'page_background_fallback')
      );
      if (raster?.data) {
        queue.push({
          type: 'image',
          zIndex: [zBase + 1],
          domOrder: 1000 + index,
          options: { ...rect, data: raster.data },
        });
      }
    }
  }
}

async function processSlide(root, slide, pptx, globalOptions = {}) {
  const rootRect = root.getBoundingClientRect();
  const PPTX_WIDTH_IN = globalOptions._slideWidth || 10;
  const PPTX_HEIGHT_IN = globalOptions._slideHeight || 5.625;

  const contentWidthIn = rootRect.width * PX_TO_INCH;
  const contentHeightIn = rootRect.height * PX_TO_INCH;
  const scale = Math.min(PPTX_WIDTH_IN / contentWidthIn, PPTX_HEIGHT_IN / contentHeightIn);

  const layoutConfig = {
    rootX: rootRect.x,
    rootY: rootRect.y,
    scale: scale,
    offX: (PPTX_WIDTH_IN - contentWidthIn * scale) / 2,
    offY: (PPTX_HEIGHT_IN - contentHeightIn * scale) / 2,
  };

  const renderQueue = [];
  const asyncTasks = []; // Queue for heavy operations (Images, Canvas)
  let domOrderCounter = 0;

  // Sync Traversal Function
  function collect(node, parentSortKey, parentOpacity = 1, inheritedAnimation = null) {
    const order = domOrderCounter++;

    let currentSortKey = parentSortKey;
    let currentOpacity = parentOpacity;
    let nodeStyle = null;
    const nodeType = node.nodeType;

    if (nodeType === 1) {
      nodeStyle = window.getComputedStyle(node);
      const elOpacity = parseFloat(nodeStyle.opacity);
      if (!isNaN(elOpacity)) {
        currentOpacity *= elOpacity;
      }

      // Optimization: Skip completely hidden elements immediately
      if (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden' || currentOpacity === 0) {
        return;
      }
      let zVal = 0;
      if (nodeStyle.zIndex !== 'auto') {
        const parsedZ = parseInt(nodeStyle.zIndex);
        if (!isNaN(parsedZ)) {
          zVal = parsedZ;
        }
      }
      currentSortKey = parentSortKey.concat([zVal, order]);
    }

    // Prepare the item. If it needs async work, it returns a 'job'
    const result = prepareRenderItem(node, { ...layoutConfig, root }, order, pptx, currentSortKey, nodeStyle, {
      ...globalOptions,
      _inheritedOpacity: parentOpacity,
      _inheritedAnimation: inheritedAnimation,
    });

    if (result) {
      if (result.items) {
        const source =
          typeof globalOptions.onRasterizationEvent === 'function' && nodeType === 1
            ? describeRasterizationSource(node, nodeStyle)
            : null;
        for (const item of result.items) {
          if (item?.type !== 'image' || item._rasterizationSource || !source) continue;
          item._rasterizationSource = source;
        }
        // Push items immediately to queue (data might be missing but filled later)
        renderQueue.push(...result.items);
      }
      if (result.job) {
        // Push the promise-returning function to the task list
        asyncTasks.push(result.job);
      }
      if (result.stopRecursion) return;
    }

    // Recurse children synchronously.
    // Determine what animation to pass down to children:
    // If this element has its own animation, children inherit it (with start='with' applied in prepareRenderItem).
    // Otherwise, continue passing whatever was already inherited from an ancestor.
    const childNodes = node.childNodes;
    let nextInheritedAnimation = inheritedAnimation;
    if (nodeType === 1 && nodeStyle) {
      const ownAnim = parseAnimation(node, nodeStyle);
      if (ownAnim) {
        nextInheritedAnimation = ownAnim;
      }
    }
    for (let i = 0; i < childNodes.length; i++) {
      collect(childNodes[i], currentSortKey, currentOpacity, nextInheritedAnimation);
    }
  }

  // 1. Traverse and build the structure (Fast)
  collect(root, []);

  // 2. Execute heavy tasks sequentially to cap browser CPU/memory pressure.
  // These tasks rasterize images/SVG/Canvas content; starting all of them with
  // Promise.all can overwhelm small cloud-agent instances during export.
  for (const task of asyncTasks) {
    await task();
  }

  // 3. Cleanup and Sort
  // Remove items that failed to generate data (marked with skip)
  let finalQueue = renderQueue.filter((item) => !item.skip && (item.type !== 'image' || item.options.data));

  // A browser screenshot fallback already contains the visual layers beneath
  // the unsupported node. Remove only overlapping editable duplicates while
  // preserving foreground objects above the captured layer. A capture is
  // clipped to its element's bounds, so removing every lower-z item on the
  // slide incorrectly drops unrelated headers, footers, and page backgrounds.
  const captureItems = finalQueue.filter((item) => item.captureBelow);
  if (captureItems.length > 0) {
    const boundsFor = (item) => {
      const options = item.options || {};
      const x = Number(options.x);
      const y = Number(options.y);
      const w = Number(options.w);
      const h = Number(options.h);
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
      return { left: x, top: y, right: x + w, bottom: y + h };
    };
    const overlapsCapture = (item, captureItem) => {
      const itemBounds = boundsFor(item);
      const captureBounds = boundsFor(captureItem);
      if (!itemBounds || !captureBounds) return false;
      return (
        itemBounds.left < captureBounds.right &&
        itemBounds.right > captureBounds.left &&
        itemBounds.top < captureBounds.bottom &&
        itemBounds.bottom > captureBounds.top
      );
    };
    finalQueue = finalQueue.filter(
      (item) =>
        captureItems.includes(item) ||
        !captureItems.some(
          (captureItem) =>
            compareKeys(item.zIndex, captureItem.zIndex) <= 0 && overlapsCapture(item, captureItem)
        )
    );
  }

  // Losing a page shell's background is otherwise silent: its descendants
  // still export normally and the resulting slide merely falls back to white.
  // Do this after capture compositing, because a capture can remove an earlier
  // full-page item from the render queue.  Checking the pre-composite queue
  // made that removed item incorrectly suppress the page-canvas fallback.
  await addMissingPageCanvasBackgrounds(root, layoutConfig, finalQueue, globalOptions);

  finalQueue.sort((a, b) => {
    return compareKeys(a.zIndex, b.zIndex);
  });
  // 4. Add to Slide
  for (let i = 0; i < finalQueue.length; i++) {
    const item = finalQueue[i];
    const tile = item.options?._pptxTile;
    const tileSuffix = tile ? `__tile_${tile.sx}_${tile.sy}_${tile.tx || 0}_${tile.ty || 0}` : '';
    const transportVal = `__z_${i}__dom_${item.domOrder}__type_${item.type}${tileSuffix}`;
    item.options.altText = transportVal;
    item.options.objectName = transportVal;
    if (tile) globalOptions._hasTileFills = true;

    if (item.type === 'image' && item.options?.data && item._rasterizationSource) {
      await reportRasterizationEvent(globalOptions, {
        event: 'pptx_image',
        slide_number: Number(globalOptions._slideIndex) + 1,
        dom_order: item.domOrder,
        ...item._rasterizationSource,
        x_inches: Number(item.options.x) || 0,
        y_inches: Number(item.options.y) || 0,
        width_inches: Number(item.options.w) || 0,
        height_inches: Number(item.options.h) || 0,
        data_url_bytes_estimate: estimateDataUrlBytes(item.options.data),
        media_kind: String(item.options.data).startsWith('data:image/svg+xml') ? 'svg' : 'raster',
      });
    }
    delete item._rasterizationSource;

    if (item.type === 'shape') slide.addShape(item.shapeType, item.options);
    if (item.type === 'image') slide.addImage(item.options);
    if (item.type === 'text') slide.addText(item.textParts, item.options);
    if (item.type === 'table') {
      slide.addTable(item.tableData.rows, {
        x: item.options.x,
        y: item.options.y,
        w: item.options.w,
        h: item.options.h,
        colW: item.tableData.colWidths, // Essential for correct layout
        rowH: item.tableData.rowHeights,
        autoPage: false,
        // Remove default table styles so our extracted CSS applies cleanly
        border: { type: 'none' },
        fill: { color: 'FFFFFF', transparency: 100 },
        altText: item.options.altText,
        objectName: item.options.objectName,
      });
    }
  }

  if (globalOptions.skipNormalize === true && globalOptions._hasTileFills) {
    console.warn('[dom-to-pptx] skipNormalize=true disables OOXML tile fills; repeating backgrounds will be stretched.');
  }
}

/**
 * Optimized html2canvas wrapper
 * Includes fix for cropped icons by adjusting styles in the cloned document.
 */
async function elementToCanvasImage(node, widthPx, heightPx, rasterOptions = {}) {
  const traceEnabled = typeof rasterOptions.onRasterizationEvent === 'function';
  const traceStartedAt = traceEnabled ? performance.now() : 0;
  return new Promise((resolve) => {
    // 1. Assign a temp ID to locate the node inside the cloned document
    const originalId = node.id;
    const tempId = 'pptx-capture-' + Math.random().toString(36).substr(2, 9);
    node.id = tempId;

    const width = Math.max(Math.ceil(widthPx), 1);
    const height = Math.max(Math.ceil(heightPx), 1);
    const style = window.getComputedStyle(node);
    const scale = resolveRasterScale(
      {
        ...rasterOptions,
        requestedScale: 3,
        maxDpi: Number(rasterOptions.maxDpi) || DEFAULT_MAX_RASTER_DPI,
      },
      3
    );
    const traceCommon = traceEnabled
      ? {
          operation: 'html2canvas_element',
          slide_number: Number.isFinite(Number(rasterOptions._slideIndex)) ? Number(rasterOptions._slideIndex) + 1 : null,
          reason: rasterOptions.rasterizationReason || 'element_fallback',
          tag: String(node?.tagName || '').toLowerCase() || 'unknown',
          css_width: width,
          css_height: height,
          scale,
        }
      : null;
    if (traceCommon) void reportRasterizationEvent(rasterOptions, { event: 'rasterization_start', ...traceCommon });

    // Add padding to the clone to capture spilling content (like extensive font glyphs)
    const padding = 10;

    html2canvas(node, {
      backgroundColor: null,
      logging: false,
      scale,
      useCORS: true, // critical for external fonts/images
      width: width + padding * 2, // Capture a larger area
      height: height + padding * 2,
      x: -padding, // Offset capture to include the padding
      y: -padding,
      onclone: (clonedDoc) => {
        const clonedNode = clonedDoc.getElementById(tempId);
        if (clonedNode) {
          // --- FIX: CLIP & FONT ISSUES ---
          // Apply styles DIRECTLY to elements to ensure html2canvas picks them up
          // This avoids issues where <style> tags in onclone are ignored or delayed

          // 1. Force FontAwesome Family on Icons
          const icons = clonedNode.querySelectorAll('.fa, .fas, .far, .fab');
          icons.forEach((icon) => {
            icon.style.setProperty('font-family', 'FontAwesome', 'important');
          });

          // 2. Fix Image Display
          const images = clonedNode.querySelectorAll('img');
          images.forEach((img) => {
            img.style.setProperty('display', 'inline-block', 'important');
          });

          // 3. Force overflow visible on the container so glyphs bleeding out aren't cut
          clonedNode.style.overflow = 'visible';

          // 4. Adjust alignment for Icons to prevent baseline clipping
          // (Applies to <i>, <span>, or standard icon classes)
          const tag = (clonedNode?.tagName || '').toLowerCase();
          const className =
            typeof clonedNode.className === 'string'
              ? clonedNode.className
              : (clonedNode.className && clonedNode.className.baseVal) || '';
          if (tag === 'i' || tag === 'span' || className.includes('fa-')) {
            // Flex center helps align the glyph exactly in the middle of the box
            // preventing top/bottom cropping due to line-height mismatches.
            clonedNode.style.display = 'inline-flex';
            clonedNode.style.justifyContent = 'center';
            clonedNode.style.alignItems = 'center';
            clonedNode.style.setProperty('font-family', 'FontAwesome', 'important'); // Ensure root icon gets it too

            // Remove margins that might offset the capture
            clonedNode.style.margin = '0';

            // Ensure the font fits
            clonedNode.style.lineHeight = '1';
            clonedNode.style.verticalAlign = 'middle';
          }
        }
      },
    })
      .then(async (canvas) => {
        // Restore the original ID
        if (originalId) node.id = originalId;
        else node.removeAttribute('id');

        const destCanvas = document.createElement('canvas');
        destCanvas.width = width;
        destCanvas.height = height;
        const ctx = destCanvas.getContext('2d');

        // Draw captured canvas (which is padded) back to the original size
        // We need to draw the CENTER of the source canvas to the destination
        // The source canvas is (width + 2*padding) * scale
        // We want to draw the crop starting at padding*scale
        const sX = padding * scale;
        const sY = padding * scale;
        const sW = width * scale;
        const sH = height * scale;

        ctx.drawImage(canvas, sX, sY, sW, sH, 0, 0, width, height);

        // --- Border Radius Clipping (Existing Logic) ---
        let tl = parseFloat(style.borderTopLeftRadius) || 0;
        let tr = parseFloat(style.borderTopRightRadius) || 0;
        let br = parseFloat(style.borderBottomRightRadius) || 0;
        let bl = parseFloat(style.borderBottomLeftRadius) || 0;

        const f = Math.min(
          width / (tl + tr) || Infinity,
          height / (tr + br) || Infinity,
          width / (br + bl) || Infinity,
          height / (bl + tl) || Infinity
        );

        if (f < 1) {
          tl *= f;
          tr *= f;
          br *= f;
          bl *= f;
        }

        if (tl + tr + br + bl > 0) {
          ctx.globalCompositeOperation = 'destination-in';
          ctx.beginPath();
          ctx.moveTo(tl, 0);
          ctx.lineTo(width - tr, 0);
          ctx.arcTo(width, 0, width, tr, tr);
          ctx.lineTo(width, height - br);
          ctx.arcTo(width, height, width - br, height, br);
          ctx.lineTo(bl, height);
          ctx.arcTo(0, height, 0, height - bl, bl);
          ctx.lineTo(0, tl);
          ctx.arcTo(0, 0, tl, 0, tl);
          ctx.closePath();
          ctx.fill();
        }

        const data = destCanvas.toDataURL('image/png');
        if (traceCommon) {
          await reportRasterizationEvent(rasterOptions, {
            event: 'rasterization_end',
            ...traceCommon,
            duration_ms: Math.round((performance.now() - traceStartedAt) * 10) / 10,
            ok: Boolean(data),
            source_canvas_width: canvas.width,
            source_canvas_height: canvas.height,
            destination_canvas_width: destCanvas.width,
            destination_canvas_height: destCanvas.height,
          });
        }
        resolve(data);
      })
      .catch(async (e) => {
        if (originalId) node.id = originalId;
        else node.removeAttribute('id');
        console.warn('Canvas capture failed for node', node, e);
        if (traceCommon) {
          await reportRasterizationEvent(rasterOptions, {
            event: 'rasterization_end',
            ...traceCommon,
            duration_ms: Math.round((performance.now() - traceStartedAt) * 10) / 10,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        resolve(null);
      });
  });
}

/**
 * Helper to identify elements that should be rendered as icons (Images).
 * Detects Custom Elements AND generic tags (<i>, <span>) with icon classes/pseudo-elements.
 */
function isIconElement(node) {
  // 1. Custom Elements (hyphenated tags) or Explicit Library Tags
  const tag = (node?.tagName || '').toLowerCase();
  if (
    tag.includes('-') ||
    ['material-icon', 'iconify-icon', 'remix-icon', 'ion-icon', 'eva-icon', 'box-icon', 'fa-icon'].includes(tag)
  ) {
    return true;
  }

  // 2. Class-based Icons (FontAwesome, Bootstrap, Material symbols) on <i> or <span>
  if (tag === 'i' || tag === 'span') {
    const cls = node.getAttribute('class') || '';
    if (
      typeof cls === 'string' &&
      (cls.includes('fa-') ||
        cls.includes('fas') ||
        cls.includes('far') ||
        cls.includes('fab') ||
        cls.includes('bi-') ||
        cls.includes('material-icons') ||
        cls.includes('icon'))
    ) {
      // Double-check: Must have pseudo-element content to be a CSS icon
      const before = window.getComputedStyle(node, '::before').content;
      const after = window.getComputedStyle(node, '::after').content;
      const hasContent = (c) => c && c !== 'none' && c !== 'normal' && c !== '""';

      if (hasContent(before) || hasContent(after)) return true;
    }
  }

  return false;
}

/**
 * Replaces createRenderItem.
 * Returns { items: [], job: () => Promise, stopRecursion: boolean }
 */
function getPseudoElementRect(hostRect, pseudoStyle) {
  const w = parseFloat(pseudoStyle.width) || 0;
  const h = parseFloat(pseudoStyle.height) || 0;
  if (w <= 0 || h <= 0) return null;

  let x = hostRect.left;
  let y = hostRect.top;

  const position = pseudoStyle.position;
  if (position === 'absolute') {
    const leftStr = pseudoStyle.left;
    const topStr = pseudoStyle.top;
    const rightStr = pseudoStyle.right;
    const bottomStr = pseudoStyle.bottom;

    let left = 0;
    let hasLeft = false;
    if (leftStr && leftStr !== 'auto') {
      hasLeft = true;
      left = leftStr.endsWith('%') ? (parseFloat(leftStr) / 100) * hostRect.width : parseFloat(leftStr);
    }

    let top = 0;
    let hasTop = false;
    if (topStr && topStr !== 'auto') {
      hasTop = true;
      top = topStr.endsWith('%') ? (parseFloat(topStr) / 100) * hostRect.height : parseFloat(topStr);
    }

    let right = 0;
    let hasRight = false;
    if (rightStr && rightStr !== 'auto') {
      hasRight = true;
      right = rightStr.endsWith('%') ? (parseFloat(rightStr) / 100) * hostRect.width : parseFloat(rightStr);
    }

    let bottom = 0;
    let hasBottom = false;
    if (bottomStr && bottomStr !== 'auto') {
      hasBottom = true;
      bottom = bottomStr.endsWith('%') ? (parseFloat(bottomStr) / 100) * hostRect.height : parseFloat(bottomStr);
    }

    if (hasLeft) {
      x += left;
    } else if (hasRight) {
      x += hostRect.width - right - w;
    }
    if (hasTop) {
      y += top;
    } else if (hasBottom) {
      y += hostRect.height - bottom - h;
    }
  } else {
    const marginLeft = parseFloat(pseudoStyle.marginLeft) || 0;
    const marginTop = parseFloat(pseudoStyle.marginTop) || 0;
    x += marginLeft;
    y += marginTop;
  }

  // Apply CSS transform translation (e.g. translateY(-50%))
  const transform = pseudoStyle.transform;
  if (transform && transform !== 'none') {
    const matrixMatch = transform.match(/matrix\((.+?)\)/);
    if (matrixMatch) {
      const parts = matrixMatch[1].split(',').map((p) => parseFloat(p.trim()));
      if (parts.length === 6) {
        x += parts[4];
        y += parts[5];
      }
    } else {
      const matrix3dMatch = transform.match(/matrix3d\((.+?)\)/);
      if (matrix3dMatch) {
        const parts = matrix3dMatch[1].split(',').map((p) => parseFloat(p.trim()));
        if (parts.length === 16) {
          x += parts[12];
          y += parts[13];
        }
      }
    }
  }

  return { left: x, top: y, width: w, height: h };
}

function preparePseudoElementItem(node, pseudoType, hostRect, config, zIndex, domOrder, pptx) {
  const pseudoStyle = window.getComputedStyle(node, pseudoType);
  const content = pseudoStyle.content;
  const hasContent = content && content !== 'none' && content !== 'normal' && content !== '""';

  const bgColor = parseColor(pseudoStyle.backgroundColor);
  const hasBg = bgColor.hex && bgColor.opacity > 0;
  const borderCol = parseColor(pseudoStyle.borderColor);
  const borderWidth = parseFloat(pseudoStyle.borderWidth) || 0;
  const hasBorder = borderWidth > 0 && borderCol.opacity > 0;

  if (!hasBg && !hasBorder && !hasContent) return null;

  // `collectTextParts` already folds an in-flow pseudo's generated text into
  // its host text frame. Exporting it again as an independent item duplicates
  // labels such as `h2::before { content: "01" }`.  Positioned decorations
  // have no place in that inline text flow, so they keep their own object.
  const pseudoPosition = String(pseudoStyle.position || 'static').toLowerCase();
  if (hasContent && pseudoPosition !== 'absolute' && pseudoPosition !== 'fixed') return null;

  const rect = getPseudoElementRect(hostRect, pseudoStyle);
  if (!rect) return null;

  const scale = config.scale;
  const w = rect.width * PX_TO_INCH * scale;
  const h = rect.height * PX_TO_INCH * scale;
  const x = config.offX + (rect.left - config.rootX) * PX_TO_INCH * scale;
  const y = config.offY + (rect.top - config.rootY) * PX_TO_INCH * scale;

  const borderRadius = parseFloat(pseudoStyle.borderRadius) || 0;
  const isCircle = borderRadius >= Math.min(rect.width, rect.height) / 2 - 1;

  if (hasContent) {
    const cleanText = content.replace(/^['"]|['"]$/g, '');
    const textOpts = getTextStyle(pseudoStyle, scale, false);
    // The pseudo element's own background becomes this shape's fill just below,
    // where its alpha survives. Leaving it on the run as well paints the colour
    // a second time at full opacity, because `highlight` carries no alpha.
    if (hasBg) delete textOpts.highlight;
    const textOptions = {
      x,
      y,
      w,
      h,
      align: pseudoStyle.textAlign || 'left',
      valign: 'middle',
      margin: 0,
      wrap: true,
      ...textOpts,
      ...(hasBg && { fill: { color: bgColor.hex, transparency: (1 - bgColor.opacity) * 100 } }),
      line: hasBorder ? { color: borderCol.hex, width: borderWidth * 0.75 * scale } : null,
    };

    if (isCircle) {
      textOptions.rectRadius = Math.min(w, h) / 2;
    } else if (borderRadius > 0) {
      let cappedRadiusPx = Math.min(borderRadius, Math.min(rect.width, rect.height) / 2);
      textOptions.rectRadius = cappedRadiusPx * PX_TO_INCH * scale;
    }

    return {
      type: 'text',
      zIndex,
      domOrder,
      textParts: [
        {
          text: cleanText,
          options: textOpts,
        },
      ],
      options: textOptions,
    };
  }

  let shapeType = pptx.ShapeType.rect;
  let shapeOpts = {
    x,
    y,
    w,
    h,
    ...(hasBg && { fill: { color: bgColor.hex, transparency: (1 - bgColor.opacity) * 100 } }),
    line: hasBorder ? { color: borderCol.hex, width: borderWidth * 0.75 * scale } : null,
  };

  if (isCircle) {
    shapeType = pptx.ShapeType.ellipse;
  } else if (borderRadius > 0) {
    shapeType = pptx.ShapeType.roundRect;
    let cappedRadiusPx = Math.min(borderRadius, Math.min(rect.width, rect.height) / 2);
    shapeOpts.rectRadius = cappedRadiusPx * PX_TO_INCH * scale;
  }

  return {
    type: 'shape',
    zIndex,
    domOrder,
    shapeType,
    options: shapeOpts,
  };
}

function countParagraphs(node, scale) {
  if (!node) return 1;
  const style = window.getComputedStyle(node);
  const parts = collectTextParts(node, style, scale, null, true, 1);
  let count = 1;
  for (const part of parts) {
    if (part.options?.breakLine) {
      count++;
    }
  }
  return count;
}

function countRenderedTextLines(node) {
  if (!node || typeof document?.createRange !== 'function') return null;

  const range = document.createRange();
  try {
    range.selectNodeContents(node);
    if (typeof range.getClientRects !== 'function') return null;

    const fragments = Array.from(range.getClientRects())
      .map((rect) => {
        const left = Number(rect.left);
        const top = Number(rect.top);
        const right = Number(rect.right);
        const bottom = Number(rect.bottom);
        const width = Number.isFinite(Number(rect.width)) ? Number(rect.width) : right - left;
        const height = Number.isFinite(Number(rect.height)) ? Number(rect.height) : bottom - top;
        return { left, top, right, bottom, width, height };
      })
      .filter(
        (rect) =>
          Number.isFinite(rect.left) &&
          Number.isFinite(rect.top) &&
          Number.isFinite(rect.right) &&
          Number.isFinite(rect.bottom) &&
          rect.width > 0 &&
          rect.height > 0
      )
      .sort((a, b) => a.top - b.top || a.left - b.left);

    if (fragments.length === 0) return null;

    const lines = [];
    for (const fragment of fragments) {
      const fragmentCenter = (fragment.top + fragment.bottom) / 2;
      let matchingLine = null;

      for (const line of lines) {
        const overlap = Math.min(line.bottom, fragment.bottom) - Math.max(line.top, fragment.top);
        const minHeight = Math.min(line.bottom - line.top, fragment.height);
        const centerDelta = Math.abs((line.top + line.bottom) / 2 - fragmentCenter);
        const hasMeaningfulOverlap = overlap >= Math.max(0.5, minHeight * 0.25);
        const hasNearlyEqualCenter = centerDelta <= Math.max(0.75, minHeight * 0.15);

        if (hasMeaningfulOverlap || hasNearlyEqualCenter) {
          matchingLine = line;
          break;
        }
      }

      if (matchingLine) {
        matchingLine.top = Math.min(matchingLine.top, fragment.top);
        matchingLine.bottom = Math.max(matchingLine.bottom, fragment.bottom);
      } else {
        lines.push({ top: fragment.top, bottom: fragment.bottom });
      }
    }

    return lines.length;
  } catch {
    return null;
  } finally {
    range.detach?.();
  }
}

function shouldWrapText(node, style, writingModeVert = null, rotation = 0) {
  if (style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre') return false;

  // Keep objects that Chromium already rendered on one line stable. For
  // multi-line content, PowerPoint is allowed to wrap within the same
  // paragraph; its visual line positions are never materialized as breaks.
  if (rotation !== 0 || (writingModeVert && writingModeVert !== 'none')) return true;
  return countRenderedTextLines(node) !== 1;
}

function getEffectiveRotation(node, root, ownStyle) {
  // CSS transforms on ancestors affect every descendant. PPTX has no
  // transform hierarchy, so each emitted item must receive the total visual
  // rotation of its own box.
  //
  // Translation is already contained in getBoundingClientRect(). This is
  // intentionally limited to 2D rotation; scale, skew and 3D transforms need
  // a complete affine-transform implementation (or rasterization).
  let rotation = getRotation(ownStyle?.transform);
  let current = node?.parentElement;
  while (current && current !== root) {
    rotation += getRotation(window.getComputedStyle(current).transform);
    current = current.parentElement;
  }

  rotation %= 360;
  if (rotation > 180) rotation -= 360;
  if (rotation <= -180) rotation += 360;
  return rotation;
}

function collectTableCellOverlayItems(table, config, pptx, parentSortKey, domOrder) {
  // PPT tables cannot contain child DrawingML shapes. Preserve the editable
  // table for text/borders, then reproduce simple, non-text cell decorations
  // as slide-level shapes immediately above it (dots, progress bars, check
  // boxes and similar CSS primitives).
  const items = [];
  const cells = Array.from(table.querySelectorAll('td, th'));
  const pxToIn = PX_TO_INCH * config.scale;

  for (const cell of cells) {
    const cellRect = cell.getBoundingClientRect();
    for (const node of Array.from(cell.querySelectorAll('*'))) {
      if (String(node.textContent || '').trim()) continue;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const rect = node.getBoundingClientRect();
      if (rect.width < 0.5 || rect.height < 0.5) continue;
      // Do not accidentally export a decorative node that visually escapes its
      // cell. Native PPT tables cannot clip a sibling shape to the cell.
      if (
        rect.left < cellRect.left - 0.5 ||
        rect.top < cellRect.top - 0.5 ||
        rect.right > cellRect.right + 0.5 ||
        rect.bottom > cellRect.bottom + 0.5
      ) {
        continue;
      }

      const background = parseColor(style.backgroundColor, style);
      const borderInfo = getBorderInfo(style, config.scale, node);
      const hasFill = background.hex && background.opacity > 0;
      const hasUniformBorder = borderInfo.type === 'uniform';
      if (!hasFill && !hasUniformBorder) continue;

      const radius = parseFloat(style.borderRadius) || 0;
      const minDimension = Math.min(rect.width, rect.height);
      let shapeType = pptx.ShapeType.rect;
      if (radius >= minDimension / 2 && minDimension > 0) shapeType = pptx.ShapeType.ellipse;
      else if (radius > 0) shapeType = pptx.ShapeType.roundRect;

      const opacity = parseFloat(style.opacity);
      const safeOpacity = Number.isFinite(opacity) ? opacity : 1;
      const transparency = (1 - background.opacity * safeOpacity) * 100;
      const options = {
        x: config.offX + (rect.left - config.rootX) * pxToIn,
        y: config.offY + (rect.top - config.rootY) * pxToIn,
        w: rect.width * pxToIn,
        h: rect.height * pxToIn,
        fill: hasFill ? { color: background.hex, transparency } : { color: 'FFFFFF', transparency: 100 },
        line: hasUniformBorder ? borderInfo.options : null,
      };
      // CSS rects include the border box, while DrawingML draws its line
      // centred on the shape boundary. Inset the geometry by half the line
      // width so the visible outer edge stays on the browser's boundary.
      if (hasUniformBorder && borderInfo.options?.width > 0) {
        const inset = borderInfo.options.width / 144;
        options.x += inset;
        options.y += inset;
        options.w = Math.max(0, options.w - inset * 2);
        options.h = Math.max(0, options.h - inset * 2);
      }
      if (shapeType === pptx.ShapeType.roundRect) {
        options.rectRadius = Math.min(radius, minDimension / 2) * pxToIn;
      }
      items.push({
        type: 'shape',
        zIndex: parentSortKey.concat([0, 0, items.length]),
        domOrder,
        shapeType,
        options,
      });
    }
  }
  return items;
}

function prepareRenderItem(node, config, domOrder, pptx, effectiveZIndex, computedStyle, globalOptions = {}) {
  // 1. Text Node Handling
  if (node.nodeType === 3) {
    const textContent = node.nodeValue.trim();
    if (!textContent) return null;

    const parent = node.parentElement;
    if (!parent) return null;

    if (isTextContainer(parent)) return null; // Parent handles it

    const range = document.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    range.detach();

    const style = window.getComputedStyle(parent);
    const rotation = getRotation(style.transform);
    const writingModeVert = getWritingModeVert(style.writingMode, style.textOrientation);
    const widthPx = rect.width;
    const heightPx = rect.height;
    const unrotatedW = widthPx * PX_TO_INCH * config.scale;
    const unrotatedH = heightPx * PX_TO_INCH * config.scale;

    const x = config.offX + (rect.left - config.rootX) * PX_TO_INCH * config.scale;
    const y = config.offY + (rect.top - config.rootY) * PX_TO_INCH * config.scale;

    const textOpts = getTextStyle(style, config.scale, true, globalOptions._inheritedOpacity || 1);

    // Apply __spc_ suffix if charSpacing is defined
    if (textOpts.charSpacing !== undefined) {
      const spcVal = Math.round(textOpts.charSpacing * 100);
      if (textOpts.fontFace) {
        textOpts.fontFace = `${textOpts.fontFace}__spc_${spcVal}`;
      }
    }

    // Same rule as in collectTextParts: a block-level parent paints its
    // background as a shape fill (with alpha), so a run highlight here would
    // repaint it as an opaque band; only inline parents keep the highlight.
    const highlight = resolveRunHighlight(style, parent, false);
    if (highlight) textOpts.highlight = highlight;
    else delete textOpts.highlight;

    return {
      items: [
        {
          type: 'text',
          zIndex: effectiveZIndex.concat([0, -1]),
          domOrder,
          textParts: [
            {
              text: textContent,
              options: textOpts,
            },
          ],
          // Honor CSS white-space: a `nowrap`/`pre` element must not re-wrap in
          // the exported slide (otherwise a single line measured in the browser
          // can wrap in PowerPoint/LibreOffice due to font-metric differences).
          options: {
            x,
            y,
            w: unrotatedW,
            h: unrotatedH,
            margin: 0,
            autoFit: true,
            wrap: shouldWrapText(node, style, writingModeVert, rotation),
          },
        },
      ],
      stopRecursion: false,
    };
  }

  if (node.nodeType !== 1) return null;

  // If this element has an ancestor that is a text container,
  // its text/content is already captured as part of that ancestor's text box.
  // We should not render a separate shape/text box for it.
  let ancestor = node.parentElement;
  while (ancestor) {
    if (isTextContainer(ancestor)) {
      return null;
    }
    ancestor = ancestor.parentElement;
  }

  const style = computedStyle; // Use pre-computed style

  const anim = parseAnimation(node, style);
  // Use the node's own animation, or fall back to the inherited one from an ancestor.
  // Inherited animations use start='with' so children animate simultaneously with the parent.
  const effectiveAnim =
    anim || (globalOptions._inheritedAnimation ? { ...globalOptions._inheritedAnimation, start: 'with' } : null);
  if (effectiveAnim) {
    let numParagraphs = 1;
    if (isTextContainer(node)) {
      numParagraphs = countParagraphs(node, config.scale);
    }
    globalOptions._animations = globalOptions._animations || [];
    globalOptions._animations.push({
      domOrder,
      ...effectiveAnim,
      numParagraphs,
    });
  }

  const rect = node.getBoundingClientRect();
  if (rect.width < 0.5 || rect.height < 0.5) return null;

  const parentSortKey = effectiveZIndex;
  const rotation = getEffectiveRotation(node, config.root, style);
  const writingModeVert = getWritingModeVert(style.writingMode, style.textOrientation);
  const elementOpacity = parseFloat(style.opacity);
  const localOpacity = isNaN(elementOpacity) ? 1 : elementOpacity;
  const inheritedOpacity = globalOptions._inheritedOpacity || 1;
  const safeOpacity = localOpacity * inheritedOpacity;

  // Prefer the sub-pixel rect size to avoid 1px text-wrap artifacts caused by
  // offsetWidth/offsetHeight being integer-rounded. When the element is rotated
  // we must fall back to offset* because rect.* describes the rotated bounding box.
  const widthPx = rotation === 0 ? rect.width || node.offsetWidth : node.offsetWidth || rect.width;
  const heightPx = rotation === 0 ? rect.height || node.offsetHeight : node.offsetHeight || rect.height;
  const unrotatedW = widthPx * PX_TO_INCH * config.scale;
  const unrotatedH = heightPx * PX_TO_INCH * config.scale;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  let x = config.offX + (centerX - config.rootX) * PX_TO_INCH * config.scale - unrotatedW / 2;
  let y = config.offY + (centerY - config.rootY) * PX_TO_INCH * config.scale - unrotatedH / 2;
  let w = unrotatedW;
  let h = unrotatedH;

  const items = [];

  const customShapeName =
    style.getPropertyValue('--shape') ||
    style.getPropertyValue('--shape-type') ||
    style.getPropertyValue('--pptx-shape');

  // Effects such as blend modes and masks cannot be represented by editable
  // PPTX primitives. A backdrop filter is captured only when its lower layers
  // can remain visible; foreground cards continue through normal recursion so
  // their text stays editable. The managed ppt-engine path supplies a real
  // Chrome screenshot callback; standalone use falls back to html2canvas.
  const independentBlendTexture = isIndependentBlendTexture(node, style);
  const unsupportedVisual = hasUnsupportedVisual(style) && !independentBlendTexture;
  // Use editable native text for ordinary textboxes.  A rotated, nested
  // textbox has browser-only font metrics, stroke and shadow composition,
  // however, so it is deliberately exported as one browser-rendered image.
  // This avoids the ambiguous middle ground where its text is not editable
  // yet still differs from the HTML source.
  const compositeIllustration =
    isCompositeIllustrationContainer(node, style) || isCompositeTextboxContainer(node, style);
  // Decorative grain is often authored as z-index:30 so it visually overlays
  // the page. In PowerPoint an otherwise transparent full-slide image blocks
  // clicking every object below it. Keep it above the slide's own background
  // but below all authored child objects instead.
  const textureBackgroundSortKey =
    independentBlendTexture && isFullSlideDecorativeTexture(node, config)
      ? effectiveZIndex.slice(0, 2).concat([-500000, domOrder])
      : null;
  if (compositeIllustration) {
    // Explicit image panels and rotated nested textboxes are CSS visual
    // groups. The browser screenshot already contains any rotation, so use
    // its transformed bounding box as-is; applying `rotate` again would
    // rotate the panel twice and offset its artwork.
    const capturePaddingPx = 24;
    const capturedW = (rect.width + capturePaddingPx * 2) * PX_TO_INCH * config.scale;
    const capturedH = (rect.height + capturePaddingPx * 2) * PX_TO_INCH * config.scale;
    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([0, -1]),
      domOrder,
      options: {
        x: config.offX + (rect.left - config.rootX - capturePaddingPx) * PX_TO_INCH * config.scale,
        y: config.offY + (rect.top - config.rootY - capturePaddingPx) * PX_TO_INCH * config.scale,
        w: capturedW,
        h: capturedH,
        data: null,
      },
    };
    const job = async () => {
      let capturedResult;
      try {
        // A declared image panel or rotated nested textbox is an explicit
        // request for one visual object. Keep the capture transparent and
        // isolated from sibling layers, otherwise a z-index comparison can
        // bake unrelated text into the panel and then remove it from the
        // editable output.
        capturedResult = await captureUnsupportedElement(node, config, globalOptions, capturePaddingPx, true);
      } catch {
        capturedResult = null;
      }
      const data = capturedResult?.data || (await elementToCanvasImage(
        node, rect.width, rect.height, createRasterOptions(globalOptions, config, 'composite_image_container')
      ));
      if (data) item.options.data = data;
      else item.skip = true;
    };
    return { items: [item], job, stopRecursion: true };
  }
  if (unsupportedVisual || (hasBackdropFilter(style) && shouldCaptureBelow(node, config.root))) {
    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([0, -1]),
      domOrder,
      options: { x, y, w, h, rotate: rotation, data: null },
    };
    const job = async () => {
      let capturedResult;
      try {
        capturedResult = await captureUnsupportedElement(node, config, globalOptions);
      } catch {
        // A managed screenshot can reject when a clip is outside the viewport;
        // let the standalone html2canvas path provide a best-effort fallback.
        capturedResult = null;
      }
      const captured = capturedResult?.data;
      const data =
        captured ||
        (await elementToCanvasImage(
          node, widthPx, heightPx, createRasterOptions(globalOptions, config, 'unsupported_css_visual')
        ));
      if (data) {
        item.options.data = data;
        if (capturedResult?.captureBelow) item.captureBelow = true;
      } else {
        item.skip = true;
      }
    };
    return { items: [item], job, stopRecursion: true };
  }

  if ((node?.tagName || '').toLowerCase() === 'table') {
    const tableData = extractTableData(node, config.scale);
    const tableItems = [
      {
        type: 'table',
        zIndex: parentSortKey.concat([0, -1]),
        domOrder,
        tableData: tableData,
        options: { x, y, w: unrotatedW, h: unrotatedH },
      },
    ];
    tableItems.push(...collectTableCellOverlayItems(node, config, pptx, parentSortKey, domOrder));

    // 1. Check for Background / Shadow / Radius on the table itself
    const shadowStr = style.boxShadow;
    const hasShadow = shadowStr && shadowStr !== 'none';
    const borderRadius = parseFloat(style.borderRadius) || 0;
    const bgColor = parseColor(style.backgroundColor);
    const hasBg = bgColor.hex && bgColor.opacity > 0;

    if (hasShadow || borderRadius > 0 || hasBg) {
      const transparency = (1 - bgColor.opacity) * 100;
      const shadow = hasShadow ? getVisibleShadow(shadowStr, config.scale) : null;
      let shapeType = pptx.ShapeType.rect;
      let rectRadius = 0;

      if (borderRadius > 0) {
        shapeType = pptx.ShapeType.roundRect;
        let cappedRadiusPx = Math.min(borderRadius, Math.min(widthPx, heightPx) / 2);
        rectRadius = cappedRadiusPx * PX_TO_INCH * config.scale;
      }

      // Add a backing shape item before the table
      tableItems.unshift({
        type: 'shape',
        zIndex: parentSortKey.concat([-Infinity]),
        domOrder, // Same domOrder ensures it renders before the table (queue order)
        shapeType,
        options: {
          x,
          y,
          w: unrotatedW,
          h: unrotatedH,
          ...(hasBg && { fill: { color: bgColor.hex, transparency } }),
          shadow,
          rectRadius,
        },
      });
    }

    return {
      items: tableItems,
      stopRecursion: true,
    };
  }

  const nodeTag = (node?.tagName || '').toLowerCase();
  if ((nodeTag === 'ul' || nodeTag === 'ol') && !isComplexHierarchy(node)) {
    const listItems = [];
    const liChildren = Array.from(node.children).filter((c) => (c?.tagName || '').toLowerCase() === 'li');

    // --- Extract UL/OL container CSS for proper rendering ---
    const ulPaddingTop = parseFloat(style.paddingTop) || 0;
    const ulPaddingRight = parseFloat(style.paddingRight) || 0;
    const ulPaddingBottom = parseFloat(style.paddingBottom) || 0;
    const ulPaddingLeft = parseFloat(style.paddingLeft) || 0;

    // Convert to inches for PPTX margin array: [top, right, bottom, left]
    const listMargin = [
      ulPaddingTop * PX_TO_INCH * config.scale * 72,
      ulPaddingRight * PX_TO_INCH * config.scale * 72,
      ulPaddingBottom * PX_TO_INCH * config.scale * 72,
      ulPaddingLeft * PX_TO_INCH * config.scale * 72,
    ];

    liChildren.forEach((child, index) => {
      const liStyle = window.getComputedStyle(child);
      const liRect = child.getBoundingClientRect();
      const parentRect = node.getBoundingClientRect(); // node is UL/OL

      // 1. Determine Bullet Config
      let bullet;
      const listStyleType = liStyle.listStyleType || 'disc';

      if (nodeTag === 'ol' || listStyleType === 'decimal') {
        bullet = { type: 'number' };
      } else if (listStyleType === 'none') {
        bullet = false;
      } else {
        let code = '2022'; // disc
        if (listStyleType === 'circle') code = '25CB';
        if (listStyleType === 'square') code = '25A0';

        // --- CHANGE: Color & Size Logic (Option > ::marker > CSS color) ---
        let finalHex = '000000';
        let markerFontSize = null;

        // A. Check Global Option override
        if (globalOptions?.listConfig?.color) {
          finalHex = parseColor(globalOptions.listConfig.color).hex || '000000';
        }
        // B. Check ::marker pseudo element (supported in modern browsers)
        else {
          const markerStyle = window.getComputedStyle(child, '::marker');
          const markerColor = parseColor(markerStyle.color);
          if (markerColor.hex) {
            finalHex = markerColor.hex;
          } else {
            // C. Fallback to LI text color
            const colorObj = parseColor(liStyle.color);
            if (colorObj.hex) finalHex = colorObj.hex;
          }

          // Check ::marker font-size
          const markerFs = parseFloat(markerStyle.fontSize);
          if (!isNaN(markerFs) && markerFs > 0) {
            // Convert px->pt for PPTX
            markerFontSize = markerFs * 0.75 * config.scale;
          }
        }

        bullet = { code, color: finalHex };
        if (markerFontSize) {
          bullet.fontSize = markerFontSize;
        }
      }

      // 2. Calculate Bullet Indent
      // visualIndentPx = total horizontal offset from UL left edge to where the LI text starts.
      // ulPaddingLeft = UL's own left padding; it's already accounted for by the text box margin.
      // bullet.indent = gap between bullet glyph and text content, in points.
      // This equals the distance the LI content is shifted past the UL padding boundary.
      const visualIndentPx = liRect.left - parentRect.left;
      // Bullet indent = visual indent minus the UL's own padding-left (which is in margin) plus the LI's padding-left,
      // clamped to 0. Convert px -> pt.
      const liPaddingLeft = parseFloat(liStyle.paddingLeft) || 0;
      const extraIndentPx = Math.max(0, visualIndentPx - ulPaddingLeft);
      const visualIndentOffset = extraIndentPx > 5 ? extraIndentPx : 0;

      if (bullet) {
        bullet.indent = 20 * config.scale + (visualIndentOffset + liPaddingLeft) * 0.75 * config.scale;
      }

      // 3. Extract Text Parts
      const parts = collectTextParts(child, liStyle, config.scale);

      if (parts.length > 0) {
        parts.forEach((p) => {
          if (!p.options) p.options = {};
        });

        // A. Apply Bullet
        if (bullet) {
          if (parts.length > 0) {
            parts.forEach((p) => {
              p.options.bullet = bullet;
            });
          } else {
            parts.push({
              text: '',
              options: {
                bullet: bullet,
              },
            });
          }
        }

        // B. Apply Spacing
        let ptBefore = 0;
        let ptAfter = 0;

        if (globalOptions.listConfig?.spacing) {
          if (typeof globalOptions.listConfig.spacing.before === 'number') {
            ptBefore = globalOptions.listConfig.spacing.before;
          }
          if (typeof globalOptions.listConfig.spacing.after === 'number') {
            ptAfter = globalOptions.listConfig.spacing.after;
          }
        } else {
          const mt = parseFloat(liStyle.marginTop) || 0;
          const mb = parseFloat(liStyle.marginBottom) || 0;
          if (mt > 0) ptBefore = mt * 0.75 * config.scale;
          if (mb > 0) ptAfter = mb * 0.75 * config.scale;
        }

        if (ptBefore > 0) {
          parts.forEach((p) => {
            p.options.paraSpaceBefore = ptBefore;
          });
        }
        if (ptAfter > 0) {
          parts.forEach((p) => {
            p.options.paraSpaceAfter = ptAfter;
          });
        }

        if (index < liChildren.length - 1) {
          parts[parts.length - 1].options.breakLine = true;
        }

        listItems.push(...parts);
      }
    });

    if (listItems.length > 0) {
      // Build background/border/shadow shape for the list container
      const bgColorObj = parseColor(style.backgroundColor);
      const hasBg = bgColorObj.hex && bgColorObj.opacity > 0;
      const borderColorObj = parseColor(style.borderColor);
      const borderWidth = parseFloat(style.borderWidth);
      const hasBorder = borderWidth > 0 && borderColorObj.hex;
      const shadowStr = style.boxShadow;
      const hasShadow = shadowStr && shadowStr !== 'none';

      // Resolve border-radius for the list container
      const listBorderRadius = parseFloat(style.borderRadius) || 0;
      const listMinDim = Math.min(widthPx, heightPx);
      const listIsPercent = style.borderRadius && style.borderRadius.toString().includes('%');
      let listRadiusPx = listBorderRadius;
      if (listIsPercent) listRadiusPx = (listBorderRadius / 100) * listMinDim;

      if (hasBg || hasBorder || hasShadow) {
        let listShapeType = pptx.ShapeType.rect;
        const listShapeOpts = {
          x,
          y,
          w,
          h,
          ...(hasBg && { fill: { color: bgColorObj.hex, transparency: (1 - bgColorObj.opacity) * 100 } }),
          ...(hasBorder && { line: { color: borderColorObj.hex, width: borderWidth * 0.75 * config.scale } }),
        };

        if (hasShadow) listShapeOpts.shadow = getVisibleShadow(shadowStr, config.scale);

        if (listRadiusPx > 0) {
          const isFullRound = listRadiusPx >= listMinDim / 2;
          const isSquare = Math.abs(widthPx - heightPx) < 1;
          if (isFullRound && (listIsPercent || isSquare)) {
            listShapeType = pptx.ShapeType.ellipse;
          } else {
            listShapeType = pptx.ShapeType.roundRect;
            listShapeOpts.rectRadius = Math.min(listRadiusPx, listMinDim / 2) * PX_TO_INCH * config.scale;
          }
        }

        items.push({
          type: 'shape',
          zIndex: parentSortKey.concat([-Infinity]),
          domOrder,
          shapeType: listShapeType,
          options: listShapeOpts,
        });
      }

      items.push({
        type: 'text',
        zIndex: parentSortKey.concat([0, -1]),
        domOrder,
        textParts: listItems,
        options: {
          x,
          y,
          w,
          h,
          align: 'left',
          valign: 'top',
          // Apply CSS padding as PPTX text box inset margin [top, right, bottom, left] in points
          margin: listMargin,
          autoFit: true,
          wrap: shouldWrapText(node, style, writingModeVert, rotation),
          vert: writingModeVert,
          ...(writingModeVert && { textDirection: mapVertToTextDirection(writingModeVert) }),
        },
      });

      return { items, stopRecursion: true };
    }
  }

  if ((node?.tagName || '').toLowerCase() === 'canvas') {
    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([0, -1]),
      domOrder,
      options: { x, y, w, h, rotate: rotation, data: null },
    };

    const job = async () => {
      try {
        const dataUrl = node.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 10) {
          item.options.data = dataUrl;
        } else {
          item.skip = true;
        }
      } catch (e) {
        console.warn('Failed to capture canvas content:', e);
        item.skip = true;
      }
    };

    return { items: [item], job, stopRecursion: true };
  }

  // --- ASYNC JOB: SVG Tags ---
  if ((node?.nodeName || '').toLowerCase() === 'svg') {
    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([0, -1]),
      domOrder,
      options: { data: null, x, y, w, h, rotate: rotation },
    };

    const job = async () => {
      const converter = globalOptions.svgAsVector ? svgToSvg : svgToPng;
      const processed = await converter(node);
      if (processed) item.options.data = processed;
      else item.skip = true;
    };

    return { items: [item], job, stopRecursion: true };
  }

  // --- ASYNC JOB: IMG Tags ---
  if ((node?.tagName || '').toLowerCase() === 'img') {
    const cropFrame =
      node.getAttribute('data-ppt-editor-image-source') === 'true' &&
      node.parentElement?.getAttribute('data-ppt-editor-image-crop') === 'true'
        ? node.parentElement
        : null;
    let imageX = x;
    let imageY = y;
    let imageW = w;
    let imageH = h;
    let imageWidthPx = widthPx;
    let imageHeightPx = heightPx;
    let imageRotation = rotation;
    let sourceCrop = null;

    if (cropFrame) {
      const cropRect = cropFrame.getBoundingClientRect();
      const cropStyle = window.getComputedStyle(cropFrame);
      imageRotation = getRotation(cropStyle.transform);
      imageWidthPx = imageRotation === 0
        ? cropRect.width || cropFrame.offsetWidth
        : cropFrame.offsetWidth || cropRect.width;
      imageHeightPx = imageRotation === 0
        ? cropRect.height || cropFrame.offsetHeight
        : cropFrame.offsetHeight || cropRect.height;
      imageW = imageWidthPx * PX_TO_INCH * config.scale;
      imageH = imageHeightPx * PX_TO_INCH * config.scale;
      const cropCenterX = cropRect.left + cropRect.width / 2;
      const cropCenterY = cropRect.top + cropRect.height / 2;
      imageX = config.offX + (cropCenterX - config.rootX) * PX_TO_INCH * config.scale - imageW / 2;
      imageY = config.offY + (cropCenterY - config.rootY) * PX_TO_INCH * config.scale - imageH / 2;
      sourceCrop = {
        x: parseFloat(cropFrame.dataset.pptEditorCropX || '0'),
        y: parseFloat(cropFrame.dataset.pptEditorCropY || '0'),
        width: parseFloat(cropFrame.dataset.pptEditorCropWidth || '1'),
        height: parseFloat(cropFrame.dataset.pptEditorCropHeight || '1'),
      };
    }

    let radii = {
      tl: parseFloat(style.borderTopLeftRadius) || 0,
      tr: parseFloat(style.borderTopRightRadius) || 0,
      br: parseFloat(style.borderBottomRightRadius) || 0,
      bl: parseFloat(style.borderBottomLeftRadius) || 0,
    };

    if (cropFrame) {
      const cropStyle = window.getComputedStyle(cropFrame);
      radii = {
        tl: parseFloat(cropStyle.borderTopLeftRadius) || 0,
        tr: parseFloat(cropStyle.borderTopRightRadius) || 0,
        br: parseFloat(cropStyle.borderBottomRightRadius) || 0,
        bl: parseFloat(cropStyle.borderBottomLeftRadius) || 0,
      };
    }

    const hasAnyRadius = radii.tl > 0 || radii.tr > 0 || radii.br > 0 || radii.bl > 0;
    if (!hasAnyRadius && !cropFrame) {
      const parent = node.parentElement;
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.overflow !== 'visible') {
        const pRadii = {
          tl: parseFloat(parentStyle.borderTopLeftRadius) || 0,
          tr: parseFloat(parentStyle.borderTopRightRadius) || 0,
          br: parseFloat(parentStyle.borderBottomRightRadius) || 0,
          bl: parseFloat(parentStyle.borderBottomLeftRadius) || 0,
        };
        const pRect = parent.getBoundingClientRect();
        if (Math.abs(pRect.width - rect.width) < 5 && Math.abs(pRect.height - rect.height) < 5) {
          radii = pRadii;
        }
      }
    }

    const objectFit = style.objectFit || 'fill';
    const objectPosition = style.objectPosition || '50% 50%';
    const transparency = getImageTransparency(safeOpacity);

    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([0, -1]),
      domOrder,
      options: {
        x: imageX,
        y: imageY,
        w: imageW,
        h: imageH,
        rotate: imageRotation,
        data: null,
        ...(transparency !== undefined && { transparency }),
      },
    };

    const job = async () => {
      const processed = await getProcessedImage(
        node.src,
        imageWidthPx,
        imageHeightPx,
        radii,
        objectFit,
        objectPosition,
        sourceCrop,
        {
          pptxScale: config.scale,
          maxDpi: globalOptions._maxRasterDpi,
        }
      );
      if (processed) item.options.data = processed;
      else item.skip = true;
    };

    return { items: [item], job, stopRecursion: true };
  }

  // --- ASYNC JOB: Icons and Other Elements ---
  if (isIconElement(node)) {
    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([0, -1]),
      domOrder,
      options: { x, y, w, h, rotate: rotation, data: null },
    };
    const job = async () => {
      const pngData = await elementToCanvasImage(
        node, widthPx, heightPx, createRasterOptions(globalOptions, config, 'icon_element')
      );
      if (pngData) item.options.data = pngData;
      else item.skip = true;
    };
    return { items: [item], job, stopRecursion: true };
  }

  // Radii logic
  const borderRadiusValue = parseFloat(style.borderRadius) || 0;
  const borderBottomLeftRadius = parseFloat(style.borderBottomLeftRadius) || 0;
  const borderBottomRightRadius = parseFloat(style.borderBottomRightRadius) || 0;
  const borderTopLeftRadius = parseFloat(style.borderTopLeftRadius) || 0;
  const borderTopRightRadius = parseFloat(style.borderTopRightRadius) || 0;

  const hasPartialBorderRadius =
    borderTopLeftRadius !== borderTopRightRadius ||
    borderTopLeftRadius !== borderBottomRightRadius ||
    borderTopLeftRadius !== borderBottomLeftRadius;
  const hasAnyBorderRadius =
    borderRadiusValue > 0 ||
    borderTopLeftRadius > 0 ||
    borderTopRightRadius > 0 ||
    borderBottomRightRadius > 0 ||
    borderBottomLeftRadius > 0;
  const hasContent = node.textContent.trim().length > 0 || node.children.length > 0;

  // A rotated hard-shadow card does not have a faithful editable DrawingML
  // counterpart. Capture only its visual base so sibling text remains
  // editable. Asymmetric-radius map pins are rendered below as transparent
  // SVGs instead, because a screenshot would erase the map beneath them.
  const hasCssBorder =
    (parseFloat(style.borderTopWidth) || 0) > 0 ||
    (parseFloat(style.borderRightWidth) || 0) > 0 ||
    (parseFloat(style.borderBottomWidth) || 0) > 0 ||
    (parseFloat(style.borderLeftWidth) || 0) > 0;
  const hardShadow = String(style.boxShadow || '').trim().toLowerCase();
  const needsExactShapeCapture =
    !hasContent &&
    (!hasPartialBorderRadius && rotation !== 0 && hasCssBorder && hardShadow && hardShadow !== 'none');

  if (needsExactShapeCapture) {
    const capturePaddingPx = 16;
    const capturedW = (rect.width + capturePaddingPx * 2) * PX_TO_INCH * config.scale;
    const capturedH = (rect.height + capturePaddingPx * 2) * PX_TO_INCH * config.scale;
    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([-Infinity, -2]),
      domOrder,
      options: {
        x: config.offX + (rect.left - config.rootX - capturePaddingPx) * PX_TO_INCH * config.scale,
        y: config.offY + (rect.top - config.rootY - capturePaddingPx) * PX_TO_INCH * config.scale,
        w: capturedW,
        h: capturedH,
        data: null,
      },
    };
    const job = async () => {
      let capturedResult;
      try {
        capturedResult = await captureUnsupportedElement(node, config, globalOptions, capturePaddingPx);
      } catch {
        capturedResult = null;
      }
      const data = capturedResult?.data || (await elementToCanvasImage(
        node, rect.width, rect.height, createRasterOptions(globalOptions, config, 'exact_shape_capture')
      ));
      if (data) item.options.data = data;
      else item.skip = true;
    };
    return { items: [item], job, stopRecursion: true };
  }

  let bgJob = null;

  // --- ASYNC JOB: Clipped Divs via Canvas ---
  if (hasPartialBorderRadius && isClippedByParent(node) && !hasContent) {
    const marginLeft = parseFloat(style.marginLeft) || 0;
    const marginTop = parseFloat(style.marginTop) || 0;
    x += marginLeft * PX_TO_INCH * config.scale;
    y += marginTop * PX_TO_INCH * config.scale;

    const item = {
      type: 'image',
      zIndex: parentSortKey.concat([0, -1]),
      domOrder,
      options: { x, y, w, h, rotate: rotation, data: null },
    };

    bgJob = async () => {
      const canvasImageData = await elementToCanvasImage(
        node, widthPx, heightPx, createRasterOptions(globalOptions, config, 'asymmetric_border_radius')
      );
      if (canvasImageData) item.options.data = canvasImageData;
      else item.skip = true;
    };

    items.push(item);
  }

  // --- SYNC: Standard CSS Extraction ---
  const bgColorObj = parseColor(style.backgroundColor);
  const bgClip = style.webkitBackgroundClip || style.backgroundClip;
  const isBgClipText = bgClip === 'text';
  const bgImgStr = style.backgroundImage;
  const hasGradient =
    !isBgClipText &&
    bgImgStr &&
    /(?:^|,)\s*(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(bgImgStr);
  const hasRepeatingGradientTexture = hasGradient && hasExplicitRepeatingGradientTexture(style);
  const backgroundImageUrls = !isBgClipText && !hasGradient ? extractCssImageUrls(bgImgStr) : [];
  const hasNoiseSvgTexture = backgroundImageUrls.some((url) => isNoiseSvgDataUrl(url));
  // Keep CSS layer order stable. The converter currently emits one URL image
  // layer; choosing the first layer avoids silently moving a lower layer above
  // the page while still inspecting every URL for noise diagnostics.
  const bgUrl = backgroundImageUrls[0];
  const hasBgImgUrl = !!bgUrl;
  const backgroundLayerCount = isBgClipText ? 0 : countBackgroundLayers(bgImgStr);
  const needsPaintedBg = !isBgClipText && !!bgImgStr && needsPaintedBackground(bgImgStr);

  if (hasNoiseSvgTexture) {
    console.warn('[dom-to-pptx] Rasterizing an SVG noise texture at its tile size instead of the full element size.');
  }

  const backgroundTileSize =
    !isBgClipText && !hasPartialBorderRadius && !hasAnyBorderRadius
      ? getBackgroundTileSize(style, widthPx, heightPx, bgUrl)
      : null;
  // A tile larger than the element is not really tiling, and it would push the
  // sampled tile window past the element bounds.
  const canTileBackground =
    !!backgroundTileSize &&
    (hasBgImgUrl || hasRepeatingGradientTexture) &&
    backgroundTileSize.width <= widthPx &&
    backgroundTileSize.height <= heightPx;
  const backgroundTileMetadata = canTileBackground
    ? getBackgroundTileTransport(
        style,
        backgroundTileSize,
        widthPx,
        heightPx,
        config.scale,
        globalOptions._maxRasterDpi
      )
    : null;

  const borderColorObj = parseColor(style.borderColor);
  const borderWidth = parseFloat(style.borderWidth);
  const hasBorder = borderWidth > 0 && borderColorObj.hex;

  const borderInfo = getBorderInfo(style, config.scale, node);
  const hasUniformBorder = borderInfo.type === 'uniform';
  const hasCompositeBorder = borderInfo.type === 'composite';

  const shadowStr = style.boxShadow;
  const hasShadow = shadowStr && shadowStr !== 'none';
  const softEdge = getSoftEdges(style.filter, config.scale);

  let isImageWrapper = false;
  const imgChild = Array.from(node.children).find((c) => (c?.tagName || '').toLowerCase() === 'img');
  if (imgChild) {
    const childW = imgChild.offsetWidth || imgChild.getBoundingClientRect().width;
    const childH = imgChild.offsetHeight || imgChild.getBoundingClientRect().height;
    if (childW >= widthPx - 2 && childH >= heightPx - 2) isImageWrapper = true;
  }

  let textPayload = null;
  const isText = isTextContainer(node);

  if (isText) {
    const textParts = collectTextParts(node, style, config.scale, null, true, inheritedOpacity);

    if (textParts.length > 0) {
      let align = style.textAlign || 'left';
      if (align === 'start') align = 'left';
      if (align === 'end') align = 'right';
      let valign = 'top';
      if (style.verticalAlign === 'middle') valign = 'middle';
      if (style.verticalAlign === 'bottom') valign = 'bottom';

      const isVertical = writingModeVert && writingModeVert !== 'none';
      const isColumn = style.flexDirection === 'column' || style.flexDirection === 'column-reverse';

      if (isVertical || isColumn) {
        if (style.alignItems === 'center') align = 'center';
        if (style.alignItems === 'flex-end' || style.alignItems === 'end') align = 'right';

        if (style.justifyContent === 'center' && style.display.includes('flex')) valign = 'middle';
        if (style.justifyContent === 'flex-end' && style.display.includes('flex')) valign = 'bottom';
      } else {
        if (style.alignItems === 'center') valign = 'middle';
        if (style.alignItems === 'flex-end' || style.alignItems === 'end') valign = 'bottom';

        if (style.justifyContent === 'center' && style.display.includes('flex')) align = 'center';
        if (style.justifyContent === 'flex-end' || style.justifyContent === 'end') {
          if (style.display.includes('flex')) align = 'right';
        }
      }

      if (isVertical) {
        textParts.forEach((p) => {
          if (p.options) delete p.options.lineSpacing;
        });
      }

      const padding = getPadding(style, config.scale);
      const margin = [
        padding[3] * 72, // top
        padding[1] * 72, // right
        padding[2] * 72, // bottom
        padding[0] * 72, // left
      ];

      textPayload = {
        text: textParts,
        align,
        valign,
        margin,
        wrap: shouldWrapText(node, style, writingModeVert, rotation),
      };
    }
  }

  if (hasBgImgUrl || hasGradient || (softEdge && !isBgClipText && bgColorObj.hex && !isImageWrapper)) {
    const hasLayeredBackground = hasBgImgUrl || hasGradient;
    const hasBackgroundFillLayer = hasLayeredBackground && bgColorObj.hex && !isImageWrapper;
    const useUniformBorderOverlay = hasLayeredBackground && hasUniformBorder && !hasPartialBorderRadius;

    if (hasBackgroundFillLayer) {
      const finalAlpha = safeOpacity * bgColorObj.opacity;
      const transparency = (1 - finalAlpha) * 100;

      if (hasPartialBorderRadius && !customShapeName) {
        const shapeSvg = generateCustomShapeSVG(widthPx, heightPx, bgColorObj.hex, finalAlpha, {
          tl: borderTopLeftRadius,
          tr: borderTopRightRadius,
          br: borderBottomRightRadius,
          bl: borderBottomLeftRadius,
        });
        items.push({
          type: 'image',
          zIndex: parentSortKey.concat([-Infinity, -2]),
          domOrder,
          options: { data: shapeSvg, x, y, w, h, rotate: rotation },
        });
      } else {
        const minDimension = Math.min(widthPx, heightPx);
        const rawRadius = parseFloat(style.borderRadius) || 0;
        const isPercentage = style.borderRadius && style.borderRadius.toString().includes('%');
        const radiusPx = isPercentage ? (rawRadius / 100) * minDimension : rawRadius;
        const isSquare = Math.abs(widthPx - heightPx) < 1;
        const isFullyRound = radiusPx >= minDimension / 2;
        let shapeType = pptx.ShapeType.rect;
        const shapeOptions = {
          x,
          y,
          w,
          h,
          rotate: rotation,
          fill: { color: bgColorObj.hex, transparency },
          line: null,
        };

        if (isFullyRound && (isPercentage || isSquare)) {
          shapeType = pptx.ShapeType.ellipse;
        } else if (radiusPx > 0) {
          shapeType = pptx.ShapeType.roundRect;
          shapeOptions.rectRadius = Math.min(radiusPx, minDimension / 2) * PX_TO_INCH * config.scale;
        }
        if (hasShadow) shapeOptions.shadow = getVisibleShadow(shadowStr, config.scale);

        items.push({
          type: 'shape',
          zIndex: parentSortKey.concat([-Infinity, -2]),
          domOrder,
          shapeType,
          options: shapeOptions,
        });
      }
    }

    if (hasBgImgUrl && !needsPaintedBg) {
      const transparency = getImageTransparency(safeOpacity);
      const radii = {
        tl: parseFloat(style.borderTopLeftRadius) || 0,
        tr: parseFloat(style.borderTopRightRadius) || 0,
        br: parseFloat(style.borderBottomRightRadius) || 0,
        bl: parseFloat(style.borderBottomLeftRadius) || 0,
      };

      const bgItem = {
        type: 'image',
        zIndex: textureBackgroundSortKey ? textureBackgroundSortKey.concat([-1]) : parentSortKey.concat([-Infinity, -1]),
        domOrder,
        options: {
          x,
          y,
          w,
          h,
          rotate: rotation,
          data: null,
          ...(transparency !== undefined && { transparency }),
          ...(backgroundTileMetadata && { _pptxTile: backgroundTileMetadata }),
        },
      };
      items.push(bgItem);

      bgJob = async () => {
        const processed = await getProcessedImage(
          bgUrl,
          canTileBackground ? backgroundTileSize.width : widthPx,
          canTileBackground ? backgroundTileSize.height : heightPx,
          radii,
          canTileBackground ? 'fill' : style.backgroundSize || 'cover',
          style.backgroundPosition || '50% 50%',
          null,
          {
            pptxScale: config.scale,
            maxDpi: globalOptions._maxRasterDpi,
          }
        );
        if (processed) bgItem.options.data = processed;
        else bgItem.skip = true;
      };
    } else if (!softEdge && (needsPaintedBg || (hasGradient && canTileBackground))) {
      // Anything CSS can express but DrawingML and SVG cannot gets painted by
      // the browser. When the period is a known rectangle we paint one tile and
      // let <a:tile> repeat it; otherwise (a diagonal `repeating-*` period, a
      // conic sweep, a stack of layers) we paint the background layer once.
      // A stack never tiles: one tile cannot carry two layers' periods.
      const tileable = canTileBackground && backgroundLayerCount <= 1;
      const transparency = getImageTransparency(safeOpacity);
      const paintedItem = {
        type: 'image',
        zIndex: parentSortKey.concat([-Infinity, -1]),
        domOrder,
        options: {
          x,
          y,
          w,
          h,
          rotate: rotation,
          data: null,
          ...(transparency !== undefined && { transparency }),
          ...(tileable && { _pptxTile: backgroundTileMetadata }),
        },
      };
      items.push(paintedItem);

      bgJob = async () => {
        const rasterOptions = createRasterOptions(
          globalOptions,
          config,
          tileable ? 'painted_css_background_tile' : 'painted_css_background'
        );
        const raster = tileable
          ? await rasterizeBackgroundTile(node, backgroundTileMetadata, rasterOptions)
          : await paintBackgroundRegion(
              node,
              {
                width: widthPx,
                height: heightPx,
                // Only safe when the base shape carries nothing else: an opaque
                // raster would otherwise cover its border or shadow.
                includeBackgroundColor: !hasBorder && !hasShadow && isOpaqueCssColor(style.backgroundColor),
              },
              rasterOptions
            );
        if (!raster) {
          console.warn(
            `[dom-to-pptx] Could not paint the background layer of <${String(node.tagName || '?').toLowerCase()}` +
              `${node.className ? ` class="${node.className}"` : ''}>; its background-image is dropped ` +
              `and only the background color remains. background-image: ${String(bgImgStr).slice(0, 120)}`
          );
          paintedItem.skip = true;
          return;
        }
        paintedItem.options.data = raster.data;
        if (tileable) applyTileRasterSize(backgroundTileMetadata, raster.rasterWidth, raster.rasterHeight);
      };
    } else {
      let bgData;
      let padIn = 0;
      if (softEdge) {
        const svgInfo = generateBlurredSVG(widthPx, heightPx, bgColorObj.hex, borderRadiusValue, softEdge);
        bgData = svgInfo.data;
        padIn = svgInfo.padding * PX_TO_INCH * config.scale;
      } else {
        // Only a uniform border may be baked into the gradient: the SVG carries
        // one stroke, so a composite border (differing sides) is reduced to
        // parseFloat of the multi-value "borderWidth" shorthand (the top width,
        // leaking onto all four sides) and an unparseable "borderColor"
        // shorthand, which fell back to the cached canvas fill — an opaque white
        // ring. Composite sides are emitted by createCompositeBorderItems.
        bgData = generateGradientSVG(
          widthPx,
          heightPx,
          style.backgroundImage,
          hasPartialBorderRadius
            ? {
                tl: borderTopLeftRadius,
                tr: borderTopRightRadius,
                br: borderBottomRightRadius,
                bl: borderBottomLeftRadius,
              }
            : borderRadiusValue,
          hasUniformBorder && !useUniformBorderOverlay
            ? { color: borderInfo.options.color, width: parseFloat(style.borderTopWidth) || 0 }
            : null
        );
      }

      if (bgData) {
        const backgroundItem = {
          type: 'image',
          zIndex: parentSortKey.concat([-Infinity, -1]),
          domOrder,
          options: {
            data: softEdge ? null : bgData,
            x: x - padIn,
            y: y - padIn,
            w: w + padIn * 2,
            h: h + padIn * 2,
            rotate: rotation,
          },
        };
        items.push(backgroundItem);
        if (softEdge) {
          const priorBackgroundJob = bgJob;
          bgJob = async () => {
            if (priorBackgroundJob) await priorBackgroundJob();
            const preview = await getCachedSvgPreview(bgData, globalOptions._svgPreviewCache);
            if (preview) backgroundItem.options.data = preview;
            else backgroundItem.skip = true;
          };
        }
      }
    }

    if (useUniformBorderOverlay) {
      const minDimension = Math.min(widthPx, heightPx);
      const rawRadius = parseFloat(style.borderRadius) || 0;
      const isPercentage = style.borderRadius && style.borderRadius.toString().includes('%');
      const radiusPx = isPercentage ? (rawRadius / 100) * minDimension : rawRadius;
      const isSquare = Math.abs(widthPx - heightPx) < 1;
      const isFullyRound = radiusPx >= minDimension / 2;
      let shapeType = pptx.ShapeType.rect;
      const borderOptions = {
        x,
        y,
        w,
        h,
        rotate: rotation,
        fill: { color: 'FFFFFF', transparency: 100 },
        line: borderInfo.options,
      };

      if (isFullyRound && (isPercentage || isSquare)) {
        shapeType = pptx.ShapeType.ellipse;
      } else if (radiusPx > 0) {
        shapeType = pptx.ShapeType.roundRect;
        borderOptions.rectRadius = Math.min(radiusPx, minDimension / 2) * PX_TO_INCH * config.scale;
      }

      items.push({
        type: 'shape',
        zIndex: parentSortKey.concat([-500000]),
        domOrder,
        shapeType,
        options: borderOptions,
      });
    }

    if (textPayload) {
      items.push({
        type: 'text',
        zIndex: parentSortKey.concat([0, -1]),
        domOrder,
        textParts: textPayload.text,
        options: {
          x,
          y,
          w,
          h,
          align: textPayload.align,
          valign: textPayload.valign,
          rotate: rotation,
          margin: textPayload.margin,
          wrap: textPayload.wrap,
          autoFit: true,
          vert: writingModeVert,
          ...(writingModeVert && { textDirection: mapVertToTextDirection(writingModeVert) }),
        },
      });
    }
    if (hasCompositeBorder) {
      const borderItems = createCompositeBorderItems(
        borderInfo.sides,
        x,
        y,
        w,
        h,
        config.scale,
        parentSortKey.concat([-500000]),
        domOrder
      );
      items.push(...borderItems);
    }
  } else if (
    ((bgColorObj.hex && !isBgClipText) && !isImageWrapper) ||
    hasUniformBorder ||
    hasCompositeBorder ||
    hasShadow ||
    textPayload ||
    customShapeName
  ) {
    const finalAlpha = safeOpacity * bgColorObj.opacity;
    const transparency = (1 - finalAlpha) * 100;
    const useSolidFill = ((bgColorObj.hex && !isBgClipText) && !isImageWrapper) || customShapeName;

    if (hasPartialBorderRadius && useSolidFill && !textPayload && !customShapeName) {
      const shapeSvg = generateCustomShapeSVG(widthPx, heightPx, bgColorObj.hex, bgColorObj.opacity, {
        tl: parseFloat(style.borderTopLeftRadius) || 0,
        tr: parseFloat(style.borderTopRightRadius) || 0,
        br: parseFloat(style.borderBottomRightRadius) || 0,
        bl: parseFloat(style.borderBottomLeftRadius) || 0,
      }, hasUniformBorder ? {
        color: borderInfo.options.color,
        opacity: 1 - (borderInfo.options.transparency || 0) / 100,
        width: parseFloat(style.borderTopWidth) || 0,
      } : null);

      items.push({
        type: 'image',
        zIndex: parentSortKey.concat([-Infinity]),
        domOrder,
        options: { data: shapeSvg, x, y, w, h, rotate: rotation },
      });
    } else {
      const shapeOpts = {
        x,
        y,
        w,
        h,
        rotate: rotation,
        ...(useSolidFill && {
          fill: { color: bgColorObj.hex || 'FFFFFF', transparency: transparency },
        }),
        line: hasUniformBorder ? borderInfo.options : null,
      };

      // See the corresponding table-overlay adjustment above. Do this only
      // for shape-only nodes: changing a text box's geometry would also move
      // its editable text content.
      if (!textPayload && hasUniformBorder && borderInfo.options?.width > 0) {
        const inset = borderInfo.options.width / 144;
        shapeOpts.x += inset;
        shapeOpts.y += inset;
        shapeOpts.w = Math.max(0, shapeOpts.w - inset * 2);
        shapeOpts.h = Math.max(0, shapeOpts.h - inset * 2);
      }

      if (hasShadow) shapeOpts.shadow = getVisibleShadow(shadowStr, config.scale);

      const minDimension = Math.min(widthPx, heightPx);

      let rawRadius = parseFloat(style.borderRadius) || 0;
      const isPercentage = style.borderRadius && style.borderRadius.toString().includes('%');

      let radiusPx = rawRadius;
      if (isPercentage) {
        radiusPx = (rawRadius / 100) * minDimension;
      }

      let shapeType = pptx.ShapeType.rect;

      const isSquare = Math.abs(widthPx - heightPx) < 1;
      const isFullyRound = radiusPx >= minDimension / 2;

      if (customShapeName) {
        shapeType = getCustomShapeType(customShapeName, pptx);
      } else if (isFullyRound && (isPercentage || isSquare)) {
        shapeType = pptx.ShapeType.ellipse;
      } else if (radiusPx > 0) {
        shapeType = pptx.ShapeType.roundRect;
        let cappedRadiusPx = Math.min(radiusPx, minDimension / 2);
        shapeOpts.rectRadius = cappedRadiusPx * PX_TO_INCH * config.scale;
      }

      if (textPayload) {
        const textOptions = {
          shape: shapeType,
          ...shapeOpts,
          w,
          h,
          rotate: rotation,
          align: textPayload.align,
          valign: textPayload.valign,
          margin: textPayload.margin,
          wrap: textPayload.wrap,
          autoFit: true,
          vert: writingModeVert,
          ...(writingModeVert && { textDirection: mapVertToTextDirection(writingModeVert) }),
        };
        items.push({
          type: 'text',
          zIndex: parentSortKey.concat([0, -1]),
          domOrder,
          textParts: textPayload.text,
          options: textOptions,
        });
      } else if (!hasPartialBorderRadius || customShapeName) {
        items.push({
          type: 'shape',
          zIndex: parentSortKey.concat([-Infinity]),
          domOrder,
          shapeType,
          options: shapeOpts,
        });
      }
    }

    if (hasCompositeBorder) {
      const borderSvgData = generateCompositeBorderSVG(widthPx, heightPx, borderRadiusValue, borderInfo.sides);
      if (borderSvgData) {
        items.push({
          type: 'image',
          zIndex: parentSortKey.concat([-500000]),
          domOrder,
          options: { data: borderSvgData, x, y, w, h, rotate: rotation },
        });
      }
    }
  }

  const pseudoBefore = preparePseudoElementItem(
    node,
    '::before',
    rect,
    config,
    parentSortKey.concat([-1000000]),
    domOrder,
    pptx
  );
  if (pseudoBefore) items.unshift(pseudoBefore);

  const pseudoAfter = preparePseudoElementItem(
    node,
    '::after',
    rect,
    config,
    parentSortKey.concat([0, Infinity]),
    domOrder,
    pptx
  );
  if (pseudoAfter) items.push(pseudoAfter);

  return { items, job: bgJob, stopRecursion: !!textPayload };
}

function isComplexHierarchy(root) {
  // Use a simple tree traversal to find forbidden elements in the list structure
  const stack = [root];
  while (stack.length > 0) {
    const el = stack.pop();

    // 1. Layouts: Flex/Grid on LIs
    const elTag = (el?.tagName || '').toLowerCase();
    // 1. Layouts: Flex/Grid on LIs
    if (elTag === 'li') {
      const s = window.getComputedStyle(el);
      if (s.display === 'flex' || s.display === 'grid' || s.display === 'inline-flex') return true;
    }

    // 2. Media / Icons
    if (['img', 'svg', 'canvas', 'video', 'iframe'].includes(elTag)) return true;
    if (isIconElement(el)) return true;

    // 3. Nested Lists (Flattening logic doesn't support nested bullets well yet)
    if (el !== root && (elTag === 'ul' || elTag === 'ol')) return true;

    // Recurse, but don't go too deep if not needed
    for (let i = 0; i < el.children.length; i++) {
      stack.push(el.children[i]);
    }
  }
  return false;
}

function createCompositeBorderItems(sides, x, y, w, h, scale, zIndex, domOrder) {
  const items = [];
  const pxToInch = 1 / 96;
  // The 'type' field is what routes items through slide.addShape in the
  // render loop; omitting it silently drops every composite border side.
  const common = { type: 'shape', zIndex: zIndex, domOrder, shapeType: 'rect' };

  if (sides.top.width > 0)
    items.push({
      ...common,
      options: {
        x,
        y,
        w,
        h: sides.top.width * pxToInch * scale,
        fill: {
          color: sides.top.color,
          ...(sides.top.opacity < 1 && { transparency: (1 - sides.top.opacity) * 100 }),
        },
      },
    });
  if (sides.right.width > 0)
    items.push({
      ...common,
      options: {
        x: x + w - sides.right.width * pxToInch * scale,
        y,
        w: sides.right.width * pxToInch * scale,
        h,
        fill: {
          color: sides.right.color,
          ...(sides.right.opacity < 1 && { transparency: (1 - sides.right.opacity) * 100 }),
        },
      },
    });
  if (sides.bottom.width > 0)
    items.push({
      ...common,
      options: {
        x,
        y: y + h - sides.bottom.width * pxToInch * scale,
        w,
        h: sides.bottom.width * pxToInch * scale,
        fill: {
          color: sides.bottom.color,
          ...(sides.bottom.opacity < 1 && { transparency: (1 - sides.bottom.opacity) * 100 }),
        },
      },
    });
  if (sides.left.width > 0)
    items.push({
      ...common,
      options: {
        x,
        y,
        w: sides.left.width * pxToInch * scale,
        h,
        fill: {
          color: sides.left.color,
          ...(sides.left.opacity < 1 && { transparency: (1 - sides.left.opacity) * 100 }),
        },
      },
    });

  return items;
}

function getBrowserAnimationName(name, direction, orientation) {
  let animName = name.toLowerCase();

  // Map compatibility aliases to base names
  if (animName === 'rise-up' || animName === 'drop-in') animName = 'fade-in';
  if (animName === 'drop-out') animName = 'fade-out';
  if (animName.startsWith('swivel-in')) animName = 'fade-in';
  if (animName.startsWith('swivel-out')) animName = 'fade-out';
  if (animName.startsWith('fly-in-left')) {
    animName = 'fly-in';
    direction = 'left';
  }
  if (animName.startsWith('fly-in-right')) {
    animName = 'fly-in';
    direction = 'right';
  }
  if (animName.startsWith('fly-in-top')) {
    animName = 'fly-in';
    direction = 'down';
  }
  if (animName.startsWith('fly-in-bottom')) {
    animName = 'fly-in';
    direction = 'up';
  }
  if (animName.startsWith('fly-out-left')) {
    animName = 'fly-out';
    direction = 'left';
  }
  if (animName.startsWith('fly-out-right')) {
    animName = 'fly-out';
    direction = 'right';
  }
  if (animName.startsWith('fly-out-top')) {
    animName = 'fly-out';
    direction = 'up';
  }
  if (animName.startsWith('fly-out-bottom')) {
    animName = 'fly-out';
    direction = 'down';
  }

  if (animName.startsWith('fly-in')) {
    const dir = direction || 'up';
    animName = `fly-in-to-${dir}`;
  } else if (animName.startsWith('fly-out')) {
    const dir = direction || 'down';
    animName = `fly-out-to-${dir}`;
  } else if (animName.startsWith('wipe-in')) {
    const dir = direction || 'down';
    animName = `wipe-in-to-${dir}`;
  } else if (animName.startsWith('wipe-out')) {
    const dir = direction || 'down';
    animName = `wipe-out-to-${dir}`;
  } else if (animName.startsWith('split-in')) {
    const orient = orientation || 'vertical';
    animName = `split-in-${orient}`;
  } else if (animName.startsWith('split-out')) {
    const orient = orientation || 'vertical';
    animName = `split-out-${orient}`;
  } else if (animName.startsWith('random-bars-in') || animName.startsWith('randombar-in')) {
    const orient = orientation || 'horizontal';
    animName = `random-bars-in-${orient}`;
  } else if (animName.startsWith('random-bars-out') || animName.startsWith('randombar-out')) {
    const orient = orientation || 'horizontal';
    animName = `random-bars-out-${orient}`;
  }
  return animName;
}

function makeParagraphBuild(el, anim, baseDelay, playState = 'running', triggerGap = 800) {
  const children = Array.from(el.children);
  if (children.length === 0) return [];

  // Start child staggers after the parent container animation finishes
  let currentDelay = baseDelay + anim.duration;
  const childElements = [];

  children.forEach((child, index) => {
    child.style.animationName = getBrowserAnimationName(anim.name, anim.direction, anim.orientation);
    child.style.animationDuration = `${anim.duration}ms`;
    child.style.animationFillMode = 'both';
    child.style.animationPlayState = playState;

    if (index === 0) {
      child.style.animationDelay = `${currentDelay}ms`;
    } else {
      currentDelay += anim.duration + triggerGap;
      child.style.animationDelay = `${currentDelay}ms`;
    }
    childElements.push(child);
  });

  return childElements;
}

function makeLetterBuild(el, anim, baseDelay, playState = 'running') {
  const spans = [];
  const state = { charIndex: 0 };

  // Start letter typing after the parent container animation finishes
  const startDelay = baseDelay + anim.duration;

  function splitTextNodeIntoSpans(textNode) {
    const text = textNode.textContent;
    const parent = textNode.parentNode;
    const fragment = document.createDocumentFragment();

    for (const char of text) {
      const span = document.createElement('span');
      if (char === ' ') {
        span.innerHTML = '&nbsp;';
      } else {
        span.textContent = char;
      }
      span.style.display = 'inline-block';

      const animName = getBrowserAnimationName(anim.name, anim.direction, anim.orientation);
      span.style.animationName = animName;
      span.style.animationDuration = `${anim.duration}ms`;
      span.style.animationFillMode = 'both';
      span.style.animationPlayState = playState;

      // Stagger delay by 30ms per character
      const letterDelay = startDelay + state.charIndex * 30;
      span.style.animationDelay = `${letterDelay}ms`;

      fragment.appendChild(span);
      spans.push(span);
      state.charIndex++;
    }

    parent.replaceChild(fragment, textNode);
  }

  function walkTextNodes(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 3) {
        // Text Node
        if (child.textContent.trim().length > 0) {
          splitTextNodeIntoSpans(child);
        }
      } else if (child.nodeType === 1) {
        // Element Node
        walkTextNodes(child);
      }
    }
  }

  walkTextNodes(el);

  return spans;
}

function getActualEndTime(el, anim, baseDelay) {
  if (anim.build === 'paragraph') {
    const children = el.children ? Array.from(el.children) : [];
    if (children.length > 0) {
      const triggerGap = 800;
      let currentDelay = baseDelay + anim.duration;
      for (let i = 1; i < children.length; i++) {
        currentDelay += anim.duration + triggerGap;
      }
      return currentDelay + anim.duration;
    }
  } else if (anim.build === 'letter') {
    let charCount = 0;
    function countChars(node) {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === 3) {
          if (child.textContent.trim().length > 0) {
            charCount += child.textContent.length;
          }
        } else if (child.nodeType === 1) {
          countChars(child);
        }
      }
    }
    countChars(el);
    if (charCount > 0) {
      const startDelay = baseDelay + anim.duration;
      const lastCharDelay = startDelay + (charCount - 1) * 30;
      return lastCharDelay + anim.duration;
    }
  }
  return baseDelay + anim.duration;
}

/**
 * Applies browser animation inline styles by parsing animation class utilities.
 * This helper enables real-time browser previewing of custom slide animation speeds/delays.
 *
 * @param {HTMLElement} parentElement
 * @param {Object} [options]
 * @param {boolean} [options.enableClick=false] - If true, click-triggered builds require clicks to advance
 */
export function applyBrowserAnimations(parentElement, options = {}) {
  if (!parentElement) return;

  const elements = parentElement.querySelectorAll ? parentElement.querySelectorAll('*') : [];
  const allElements = [parentElement, ...Array.from(elements)];

  // 1. Apply basic utility classes for all elements (backward compatibility)
  for (const el of allElements) {
    if (el.nodeType !== 1) continue;
    let duration = null;
    let delay = null;
    const classList = el.classList ? Array.from(el.classList) : [];

    for (const cls of classList) {
      const durMatch = cls.match(/^animate-duration-\[(\d+)\]$/);
      if (durMatch) {
        duration = `${durMatch[1]}ms`;
      }
      const delayMatch = cls.match(/^animate-delay-\[(\d+)\]$/);
      if (delayMatch) {
        delay = `${delayMatch[1]}ms`;
      }
    }

    if (duration && el.style) el.style.animationDuration = duration;
    if (delay && el.style) el.style.animationDelay = delay;
  }

  // 2. Setup full timeline sequencer for elements with recognized slide animations
  const slides = parentElement.querySelectorAll ? parentElement.querySelectorAll('.slide') : [];
  const slidesList = slides.length > 0 ? Array.from(slides) : [parentElement];

  for (const slide of slidesList) {
    if (slide.__animationsApplied) continue;

    const slideElements = slide.querySelectorAll ? slide.querySelectorAll('*') : [];
    const allSlideElements = [slide, ...Array.from(slideElements)];
    const animatedElements = [];

    for (const el of allSlideElements) {
      if (el.nodeType !== 1) continue;
      let style;
      try {
        style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : null;
      } catch (e) {
        style = null;
      }
      if (!style) {
        style = {
          animationName: el.style?.animationName || 'none',
          getPropertyValue: (prop) => el.style?.[prop] || '',
        };
      }

      const anim = parseAnimation(el, style);
      if (anim) {
        animatedElements.push({ el, anim });
      }
    }

    if (animatedElements.length === 0) continue;

    slide.__animationsApplied = true;

    // Group elements into sequential click-groups (steps)
    const stepGroups = [];
    let currentGroup = [];

    animatedElements.forEach((item) => {
      if (item.anim.start === 'click' && currentGroup.length > 0) {
        stepGroups.push(currentGroup);
        currentGroup = [];
      }
      currentGroup.push(item);
    });
    if (currentGroup.length > 0) {
      stepGroups.push(currentGroup);
    }

    const enableClick = options?.enableClick === true;
    let autoTimelineTime = 0;
    const stepAdvanceActions = [];

    stepGroups.forEach((group, groupIdx) => {
      let groupLocalStart = 0;
      let lastElementEndTime = 0;
      const groupActions = [];

      // Compute local delays relative to the step's start
      group.forEach((item, itemIdx) => {
        const { anim } = item;
        let localDelay = 0;

        if (itemIdx === 0) {
          localDelay = anim.delay;
          groupLocalStart = localDelay;
          lastElementEndTime = getActualEndTime(item.el, anim, localDelay);
        } else {
          if (anim.start === 'with') {
            localDelay = groupLocalStart + anim.delay;
            const endTime = getActualEndTime(item.el, anim, localDelay);
            if (endTime > lastElementEndTime) {
              lastElementEndTime = endTime;
            }
          } else if (anim.start === 'after') {
            localDelay = lastElementEndTime + anim.delay;
            groupLocalStart = localDelay;
            lastElementEndTime = getActualEndTime(item.el, anim, localDelay);
          }
        }
        item.computedLocalDelay = localDelay;
      });

      // Apply animation styles and builds
      const isPausedStep = enableClick && groupIdx > 0;
      const playState = isPausedStep ? 'paused' : 'running';

      group.forEach((item) => {
        const { el, anim, computedLocalDelay } = item;

        let finalDelay = computedLocalDelay;
        if (!enableClick && groupIdx > 0) {
          finalDelay += autoTimelineTime;
        }

        const resolvedAnimName = getBrowserAnimationName(anim.name, anim.direction, anim.orientation);
        if (el.style) {
          el.style.animationName = resolvedAnimName;
          el.style.animationDuration = `${anim.duration}ms`;
          el.style.animationDelay = `${finalDelay}ms`;
          el.style.animationFillMode = 'both';
          el.style.animationPlayState = playState;
        }

        let buildChildren = [];
        if (anim.build === 'paragraph') {
          buildChildren = makeParagraphBuild(el, anim, finalDelay, playState);
        } else if (anim.build === 'letter') {
          buildChildren = makeLetterBuild(el, anim, finalDelay, playState);
        }

        groupActions.push({ el, buildChildren });
      });

      stepAdvanceActions.push(groupActions);

      if (!enableClick) {
        // Advance automatic timeline by the maximum duration of this group plus a default gap
        let groupMaxEnd = 0;
        group.forEach((item) => {
          const end = getActualEndTime(item.el, item.anim, item.computedLocalDelay);
          if (end > groupMaxEnd) groupMaxEnd = end;
        });
        autoTimelineTime += groupMaxEnd + 800; // 800ms step delay
      }
    });

    // Bind click listener for click-to-play sequencing
    if (enableClick && stepAdvanceActions.length > 1 && slide.addEventListener) {
      let currentStep = 0;
      slide.addEventListener('click', (e) => {
        if (e.target && e.target.closest && (e.target.closest('a') || e.target.closest('button'))) return;

        if (currentStep < stepAdvanceActions.length - 1) {
          currentStep++;
          const actions = stepAdvanceActions[currentStep];
          actions.forEach(({ el, buildChildren }) => {
            if (el.style) el.style.animationPlayState = 'running';
            if (buildChildren) {
              buildChildren.forEach((child) => {
                if (child.style) child.style.animationPlayState = 'running';
              });
            }
          });
        }
      });
    }
  }
}
