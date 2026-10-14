// src/pptx-normalizer.js
import { buildTimingXml } from './animations/xml-templates.js';
import { getTransitionXml } from './animations/transitions.js';
//
// Defensive OOXML normalizer that runs over the PPTX produced by PptxGenJS
// before we hand the .pptx blob to the user. Microsoft PowerPoint refuses to
// open files when [Content_Types].xml advertises parts that are not actually
// present in the package — see 错误诊断.md for the original incident report.
//
// This module operates on an already-loaded JSZip instance and mutates it in
// place. The caller is responsible for re-serializing the zip with DEFLATE
// compression afterwards.

const pPrOrder = [
  'lnSpc',
  'spcBef',
  'spcAft',
  'buClrTx',
  'buClr',
  'buSzTx',
  'buSzPct',
  'buSzPts',
  'buFontTx',
  'buFont',
  'buNone',
  'buAutoNum',
  'buChar',
  'buBlip',
  'tabLst',
  'defRPr',
  'extLst',
];

/**
 * Strips dangling <Override> entries from [Content_Types].xml.
 *
 * An Override is "dangling" when its PartName attribute references a file path
 * that does not exist inside the zip. Default entries are left untouched
 * because they apply to every file with a matching extension, and removing
 * them would break legitimate parts (e.g. the fntdata default added by the
 * font embedder).
 *
 * The function is idempotent: running it twice on the same zip yields the
 * same result as running it once.
 *
 * @param {import('jszip')} zip - JSZip instance with the loaded PPTX package.
 * @returns {Promise<void>}
 */
export async function normalizePptxZip(zip, options = {}) {
  if (!zip) return;

  await deduplicateMedia(zip);

  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!contentTypesFile) return;

  let xmlStr;
  try {
    xmlStr = await contentTypesFile.async('string');
  } catch (e) {
    console.warn('[pptx-normalizer] Failed to read [Content_Types].xml:', e);
    return;
  }

  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
  } catch (e) {
    console.warn('[pptx-normalizer] Failed to parse [Content_Types].xml:', e);
    return;
  }

  const parserError = doc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    console.warn('[pptx-normalizer] [Content_Types].xml has parser errors, skipping cleanup.');
    return;
  }

  const overrides = Array.from(doc.getElementsByTagName('Override'));
  let removedCount = 0;

  for (const node of overrides) {
    const partName = node.getAttribute('PartName');
    if (!partName) continue;

    // PartName is always an absolute path inside the zip, e.g. "/ppt/slideMasters/slideMaster2.xml".
    // JSZip indexes its files without the leading slash.
    const zipPath = partName.startsWith('/') ? partName.slice(1) : partName;

    if (!zip.file(zipPath)) {
      node.parentNode?.removeChild(node);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    const serialized = serializeXmlWithDeclaration(doc);
    zip.file('[Content_Types].xml', serialized);
  }

  // Process all XML files inside the ppt/ directory
  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (relativePath.startsWith('ppt/') && relativePath.endsWith('.xml')) {
      let xmlStr = await file.async('string');
      let doc;
      try {
        doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
      } catch (e) {
        console.warn(`[pptx-normalizer] Failed to parse ${relativePath}:`, e);
        continue;
      }

      const parserError = doc.getElementsByTagName('parsererror')[0];
      if (parserError) {
        console.warn(`[pptx-normalizer] ${relativePath} has parser errors, skipping.`);
        continue;
      }

      let mutated = false;

      if (cleanParagraphProperties(doc)) {
        mutated = true;
      }

      if (restoreCharSpacing(doc)) {
        mutated = true;
      }

      // Must run after restoreCharSpacing: a run carrying both markers
      // arrives as `Base__ea_EA__spc_200`, and charSpacing owns the outer
      // suffix.
      if (restoreEastAsianTypeface(doc)) {
        mutated = true;
      }

      // PptxGenJS serializes fontFace verbatim but has no run-level gradFill
      // option. getTextStyle therefore transports a compact gradient payload
      // in that attribute; restore it only after the other typeface markers
      // have been peeled off.
      if (applyTextGradients(doc)) {
        mutated = true;
      }

      if (relativePath.startsWith('ppt/slides/slide')) {
        const slideMatch = relativePath.match(/ppt\/slides\/slide(\d+)\.xml/);
        const slideIndex = slideMatch ? parseInt(slideMatch[1], 10) - 1 : -1;

        if (slideIndex >= 0) {
          if (options._slideTransitions && options._slideTransitions[slideIndex]) {
            if (applySlideTransitions(doc, slideIndex, options)) {
              mutated = true;
            }
          }
          if (options._slideAnimations) {
            if (applySlideAnimations(doc, slideIndex, options)) {
              mutated = true;
            }
          }
        }

        // applyTileFills must run before sortSpTree: the latter strips the
        // transport marker after it has served as the OOXML tile metadata.
        if (applyTileFills(doc)) {
          mutated = true;
        }

        if (sortSpTree(doc)) {
          mutated = true;
        }
      }

      if (mutated) {
        const serialized = serializeXmlWithDeclaration(doc);
        zip.file(relativePath, serialized);
      }
    }
  }
}

async function deduplicateMedia(zip) {
  const mediaPaths = Object.keys(zip.files)
    .filter((path) => path.startsWith('ppt/media/') && !path.endsWith('/'))
    .sort();
  if (mediaPaths.length < 2) return;

  const canonicalByHash = new Map();
  const duplicateToCanonical = new Map();
  for (const mediaPath of mediaPaths) {
    const bytes = await zip.files[mediaPath].async('uint8array');
    const extension = mediaPath.split('.').pop()?.toLowerCase() || '';
    const hash = `${extension}:${await hashBytes(bytes)}`;
    const canonical = canonicalByHash.get(hash);
    if (canonical) duplicateToCanonical.set(mediaPath, canonical);
    else canonicalByHash.set(hash, mediaPath);
  }
  if (duplicateToCanonical.size === 0) return;

  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (!relativePath.startsWith('ppt/') || !relativePath.includes('/_rels/') || !relativePath.endsWith('.rels')) {
      continue;
    }
    const xml = await file.async('string');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.getElementsByTagName('parsererror')[0]) continue;
    let mutated = false;
    const sourceDir = relativePath.split('/_rels/')[0] || '';
    for (const relationship of Array.from(doc.getElementsByTagName('Relationship'))) {
      if (relationship.getAttribute('TargetMode')) continue;
      const target = relationship.getAttribute('Target');
      if (!target) continue;
      const resolved = resolveZipTarget(sourceDir, target);
      const canonical = duplicateToCanonical.get(resolved);
      if (!canonical) continue;
      relationship.setAttribute('Target', relativeZipPath(sourceDir, canonical));
      mutated = true;
    }
    if (mutated) zip.file(relativePath, serializeXmlWithDeclaration(doc));
  }

  for (const duplicate of duplicateToCanonical.keys()) zip.remove(duplicate);
}

async function hashBytes(bytes) {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  // Deterministic fallback for test environments without Web Crypto.
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function resolveZipTarget(sourceDir, target) {
  if (target.startsWith('/')) return normalizeZipPath(target.slice(1));
  return normalizeZipPath(`${sourceDir}/${target}`);
}

function normalizeZipPath(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function relativeZipPath(sourceDir, targetPath) {
  const from = sourceDir.split('/').filter(Boolean);
  const to = targetPath.split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...Array(from.length - common).fill('..'), ...to.slice(common)].join('/');
}

function applyTileFills(doc) {
  let mutated = false;
  for (const picture of Array.from(doc.getElementsByTagName('*')).filter((node) => node.localName === 'pic')) {
    const cNvPr = Array.from(picture.getElementsByTagName('*')).find((node) => node.localName === 'cNvPr');
    if (!cNvPr) continue;
    const marker = `${cNvPr.getAttribute('descr') || ''} ${cNvPr.getAttribute('name') || ''}`;
    const match = marker.match(/__tile_(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)/);
    if (!match) continue;

    const sx = Number(match[1]);
    const sy = Number(match[2]);
    const tx = Number(match[3] || 0);
    const ty = Number(match[4] || 0);
    if (!(sx > 0) || !(sy > 0)) continue;

    const blipFill = Array.from(picture.childNodes).find((node) => node.nodeType === 1 && node.localName === 'blipFill');
    if (!blipFill) continue;
    const stretch = Array.from(blipFill.childNodes).find((node) => node.nodeType === 1 && node.localName === 'stretch');
    const tile = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:tile');
    tile.setAttribute('sx', String(Math.round(sx)));
    tile.setAttribute('sy', String(Math.round(sy)));
    if (tx !== 0) tile.setAttribute('tx', String(Math.round(tx)));
    if (ty !== 0) tile.setAttribute('ty', String(Math.round(ty)));
    tile.setAttribute('algn', 'tl');
    if (stretch) blipFill.replaceChild(tile, stretch);
    else blipFill.appendChild(tile);
    mutated = true;
  }
  return mutated;
}

function cleanParagraphProperties(doc) {
  let mutated = false;
  const elements = Array.from(doc.getElementsByTagName('*'));
  const paragraphs = elements.filter((n) => n.localName === 'p');

  for (const p of paragraphs) {
    const pPrs = Array.from(p.childNodes).filter((node) => node.nodeType === 1 && node.localName === 'pPr');
    if (pPrs.length > 0) {
      const targetPPr = pPrs[0];

      // Merge subsequent pPr elements
      if (pPrs.length > 1) {
        for (let i = 1; i < pPrs.length; i++) {
          const sourcePPr = pPrs[i];
          // merge attributes
          for (const attr of Array.from(sourcePPr.attributes)) {
            if (targetPPr.getAttribute(attr.name) !== attr.value) {
              targetPPr.setAttribute(attr.name, attr.value);
            }
          }
          // merge children
          while (sourcePPr.firstChild) {
            targetPPr.appendChild(sourcePPr.firstChild);
          }
          p.removeChild(sourcePPr);
          mutated = true;
        }
      }

      // Duplicate <a:lnSpc> is the rule rather than the exception: PptxGenJS
      // writes one <a:pPr> per run, so a paragraph mixing font sizes arrives
      // with one exact line height per run. Keeping the last one let the
      // smallest run size the whole line, and viewers lay exact spacing out
      // from the line bottom, so taller runs were pushed up out of the frame.
      // CSS sizes a line box from the tallest box on it, so keep the largest.
      const lnSpcs = Array.from(targetPPr.childNodes).filter(
        (node) => node.nodeType === 1 && node.localName === 'lnSpc'
      );
      if (lnSpcs.length > 1) {
        const exactPoints = (lnSpc) => {
          const children = Array.from(lnSpc.childNodes).filter((node) => node.nodeType === 1);
          if (children.length !== 1 || children[0].localName !== 'spcPts') return null;
          const value = Number(children[0].getAttribute('val'));
          return Number.isFinite(value) ? value : null;
        };
        const points = lnSpcs.map(exactPoints);
        // A percentage and a point value share no scale to compare on, so
        // mixed or malformed spacing falls through to the keep-the-last rule.
        if (points.every((value) => value !== null)) {
          let tallest = 0;
          for (let i = 1; i < points.length; i++) {
            if (points[i] > points[tallest]) tallest = i;
          }
          lnSpcs.forEach((lnSpc, index) => {
            if (index !== tallest) {
              targetPPr.removeChild(lnSpc);
              mutated = true;
            }
          });
        }
      }

      // Resolve duplicate child elements in targetPPr (keep the last one of each localName)
      const childElements = Array.from(targetPPr.childNodes).filter((node) => node.nodeType === 1);
      const seen = new Map();
      for (let i = childElements.length - 1; i >= 0; i--) {
        const child = childElements[i];
        const key = child.localName;
        if (seen.has(key)) {
          targetPPr.removeChild(child);
          mutated = true;
        } else {
          seen.set(key, child);
        }
      }

      // Ensure mutual exclusivity of bullet elements (buNone, buChar, buAutoNum, buBlip)
      const hasActiveBullet = Array.from(targetPPr.childNodes).some(
        (node) => node.nodeType === 1 && ['buChar', 'buAutoNum', 'buBlip'].includes(node.localName)
      );
      if (hasActiveBullet) {
        const buNones = Array.from(targetPPr.childNodes).filter(
          (node) => node.nodeType === 1 && node.localName === 'buNone'
        );
        for (const buNone of buNones) {
          targetPPr.removeChild(buNone);
          mutated = true;
        }
      }

      // Sort children of targetPPr
      const finalChildren = Array.from(targetPPr.childNodes).filter((node) => node.nodeType === 1);
      const sortedChildren = [...finalChildren].sort((a, b) => {
        const idxA = pPrOrder.indexOf(a.localName);
        const idxB = pPrOrder.indexOf(b.localName);
        const orderA = idxA !== -1 ? idxA : 999;
        const orderB = idxB !== -1 ? idxB : 999;
        return orderA - orderB;
      });

      let needsReorder = false;
      for (let i = 0; i < finalChildren.length; i++) {
        if (finalChildren[i] !== sortedChildren[i]) {
          needsReorder = true;
          break;
        }
      }

      if (needsReorder) {
        while (targetPPr.firstChild) {
          targetPPr.removeChild(targetPPr.firstChild);
        }
        for (const child of sortedChildren) {
          targetPPr.appendChild(child);
        }
        mutated = true;
      }

      // Ensure targetPPr is the first child element of p
      const firstElementChild = Array.from(p.childNodes).find((node) => node.nodeType === 1);
      if (firstElementChild && firstElementChild !== targetPPr) {
        p.insertBefore(targetPPr, firstElementChild);
        mutated = true;
      }
    }
  }
  return mutated;
}

function restoreCharSpacing(doc) {
  let mutated = false;
  const elements = Array.from(doc.getElementsByTagName('*'));
  const typefaceElements = elements.filter(
    (n) => n.hasAttribute('typeface') && n.getAttribute('typeface').includes('__spc_')
  );

  for (const el of typefaceElements) {
    const typeface = el.getAttribute('typeface');
    const parts = typeface.split('__spc_');
    el.setAttribute('typeface', parts[0]);
    mutated = true;

    // Find the parent rPr or defRPr or endParaRPr to set 'spc'
    let parent = el.parentNode;
    if (parent && (parent.localName === 'rPr' || parent.localName === 'defRPr' || parent.localName === 'endParaRPr')) {
      const spcVal = parts[1];
      if (parent.getAttribute('spc') !== spcVal) {
        parent.setAttribute('spc', spcVal);
      }
    }
  }
  return mutated;
}

/**
 * Split the `Latin__ea_EastAsian` transport marker back into the two
 * typeface slots it encodes.
 *
 * PptxGenJS has one `fontFace` per run and writes it verbatim into
 * <a:latin>, <a:ea> and <a:cs>. That is wrong for a CSS stack like
 * `Kalam, "PingFang SC", sans-serif`, where the browser takes Latin from
 * Kalam and Han from PingFang SC: pinning <a:ea> to Kalam hands PowerPoint
 * a font with no Han glyphs and lets its own substitution table pick the
 * replacement. So the East Asian family rides along inside the typeface
 * string and lands in <a:ea> here.
 *
 * <a:cs> (complex script — Arabic, Hebrew, Thai) keeps the Latin family:
 * the marker says nothing about those scripts.
 */
function restoreEastAsianTypeface(doc) {
  let mutated = false;
  const marker = '__ea_';
  const elements = Array.from(doc.getElementsByTagName('*'));
  const typefaceElements = elements.filter(
    (n) => n.hasAttribute('typeface') && n.getAttribute('typeface').includes(marker)
  );

  for (const el of typefaceElements) {
    const typeface = el.getAttribute('typeface');
    const separator = typeface.indexOf(marker);
    const latinFamily = typeface.slice(0, separator);
    const eastAsianFamily = typeface.slice(separator + marker.length);
    el.setAttribute('typeface', el.localName === 'ea' ? eastAsianFamily : latinFamily);
    mutated = true;
  }

  return mutated;
}

const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const GRADIENT_TYPEFACE_MARKER = '__grad_';

function stripGradientMarker(typeface) {
  const markerIndex = typeface.indexOf(GRADIENT_TYPEFACE_MARKER);
  if (markerIndex < 0) return typeface;
  const nextMarkerIndex = typeface.indexOf('__', markerIndex + GRADIENT_TYPEFACE_MARKER.length);
  return typeface.slice(0, markerIndex) + (nextMarkerIndex < 0 ? '' : typeface.slice(nextMarkerIndex));
}

function parseTextGradientPayload(payload) {
  const parts = payload.split(';');
  if (parts.length !== 4 || parts[0] !== 'lin') return null;

  const cssAngleDeg = Number(parts[1]);
  const runOpacity = Number(parts[3]);
  if (!Number.isFinite(cssAngleDeg) || !Number.isFinite(runOpacity) || runOpacity < 0 || runOpacity > 100) {
    return null;
  }

  const stopParts = parts[2].split(',');
  if (stopParts.length < 2) return null;
  let previousPos = -1;
  const stops = [];
  for (const stopPart of stopParts) {
    const match = stopPart.match(/^(\d{1,3}):([0-9A-Fa-f]{6}):(\d{1,3}(?:\.\d+)?)$/);
    if (!match) return null;
    const posPct = Number(match[1]);
    const alphaPct = Number(match[3]);
    if (posPct < 0 || posPct > 100 || posPct < previousPos || alphaPct < 0 || alphaPct > 100) return null;
    previousPos = posPct;
    stops.push({ posPct, hex: match[2].toUpperCase(), alphaPct });
  }

  return {
    cssAngleDeg: ((cssAngleDeg % 360) + 360) % 360,
    runOpacityPct: runOpacity,
    stops,
  };
}

function replaceSolidFillWithGradient(doc, rPr, gradient) {
  const gradFill = doc.createElementNS(DRAWINGML_NS, 'a:gradFill');
  gradFill.setAttribute('rotWithShape', '0');

  const gsLst = doc.createElementNS(DRAWINGML_NS, 'a:gsLst');
  for (const stop of gradient.stops) {
    const gs = doc.createElementNS(DRAWINGML_NS, 'a:gs');
    gs.setAttribute('pos', String(Math.round(stop.posPct * 1000)));
    const srgbClr = doc.createElementNS(DRAWINGML_NS, 'a:srgbClr');
    srgbClr.setAttribute('val', stop.hex);
    const alpha = doc.createElementNS(DRAWINGML_NS, 'a:alpha');
    // DrawingML stores percent in 1/1000ths. Both source percentages are
    // converted to fractions before multiplication, so 55% × 80% = 44%.
    alpha.setAttribute('val', String(Math.round((stop.alphaPct / 100) * (gradient.runOpacityPct / 100) * 100000)));
    srgbClr.appendChild(alpha);
    gs.appendChild(srgbClr);
    gsLst.appendChild(gs);
  }
  gradFill.appendChild(gsLst);

  const lin = doc.createElementNS(DRAWINGML_NS, 'a:lin');
  const drawingMlAngle = ((gradient.cssAngleDeg - 90) % 360 + 360) % 360;
  lin.setAttribute('ang', String(Math.round(drawingMlAngle * 60000)));
  lin.setAttribute('scaled', '1');
  gradFill.appendChild(lin);

  const childElements = Array.from(rPr.childNodes).filter((node) => node.nodeType === 1);
  const solidFill = childElements.find((node) => node.localName === 'solidFill');
  if (solidFill) {
    rPr.replaceChild(gradFill, solidFill);
    return;
  }

  // A fill precedes the typeface children in CT_TextCharacterProperties.
  const firstTypeface = childElements.find((node) => ['latin', 'ea', 'cs'].includes(node.localName));
  rPr.insertBefore(gradFill, firstTypeface || null);
}

/**
 * Restores run-level DrawingML gradients transported through a fontFace
 * marker. A malformed marker is always stripped and leaves PptxGenJS's
 * original solid fill in place, preserving the safe single-colour fallback.
 */
function applyTextGradients(doc) {
  let mutated = false;
  const typefaceElements = Array.from(doc.getElementsByTagName('*')).filter(
    (node) => node.hasAttribute('typeface') && node.getAttribute('typeface').includes(GRADIENT_TYPEFACE_MARKER)
  );
  const parents = new Map();

  for (const el of typefaceElements) {
    const parent = el.parentNode;
    if (!parent || !['rPr', 'defRPr', 'endParaRPr'].includes(parent.localName)) {
      el.setAttribute('typeface', stripGradientMarker(el.getAttribute('typeface')));
      mutated = true;
      continue;
    }
    if (!parents.has(parent)) parents.set(parent, []);
    parents.get(parent).push(el);
  }

  for (const [rPr, typefaces] of parents) {
    const markedTypeface = typefaces.find((el) => el.getAttribute('typeface').includes(GRADIENT_TYPEFACE_MARKER));
    const typeface = markedTypeface.getAttribute('typeface');
    const markerIndex = typeface.indexOf(GRADIENT_TYPEFACE_MARKER);
    const payloadStart = markerIndex + GRADIENT_TYPEFACE_MARKER.length;
    const payloadEnd = typeface.indexOf('__', payloadStart);
    const payload = typeface.slice(payloadStart, payloadEnd < 0 ? undefined : payloadEnd);
    const gradient = parseTextGradientPayload(payload);

    if (gradient) {
      replaceSolidFillWithGradient(doc, rPr, gradient);
    } else {
      console.warn('[pptx-normalizer] Ignored malformed text-gradient marker.');
    }

    for (const el of typefaces) {
      const current = el.getAttribute('typeface');
      const stripped = stripGradientMarker(current);
      if (stripped !== current) el.setAttribute('typeface', stripped);
    }
    mutated = true;
  }

  return mutated;
}

function sortSpTree(doc) {
  let mutated = false;
  const elements = Array.from(doc.getElementsByTagName('*'));
  const spTrees = elements.filter((n) => n.localName === 'spTree');

  for (const spTree of spTrees) {
    const childNodes = Array.from(spTree.childNodes);
    const elementChildren = childNodes.filter((node) => node.nodeType === 1);

    const firstElements = [];
    const lastElements = [];
    const visualElements = [];

    for (const el of elementChildren) {
      const localName = el.localName;
      if (localName === 'nvGrpSpPr' || localName === 'grpSpPr') {
        firstElements.push(el);
      } else if (localName === 'extLst') {
        lastElements.push(el);
      } else {
        visualElements.push(el);
      }
    }

    // Parse z-order for visualElements
    const elementInfos = visualElements.map((el, originalIndex) => {
      let zVal = Infinity;
      let domVal = originalIndex;

      // Find cNvPr element
      let cNvPr = null;
      const nvPr = Array.from(el.childNodes).find((n) => n.nodeType === 1 && n.localName.startsWith('nv'));
      if (nvPr) {
        cNvPr = Array.from(nvPr.childNodes).find((n) => n.nodeType === 1 && n.localName === 'cNvPr');
      }
      if (!cNvPr) {
        cNvPr = Array.from(el.getElementsByTagName('*')).find((n) => n.localName === 'cNvPr');
      }

      if (cNvPr) {
        const descr = cNvPr.getAttribute('descr') || '';
        const nameAttr = cNvPr.getAttribute('name') || '';
        let hasVal = false;

        const descrMatch = descr.match(/^__z_(\d+)__dom_(\d+)(.*)/);
        if (descrMatch) {
          zVal = parseInt(descrMatch[1], 10);
          domVal = parseInt(descrMatch[2], 10);
          hasVal = true;
          const userText = stripTransportMetadata(descrMatch[3]);
          if (userText) {
            cNvPr.setAttribute('descr', userText);
          } else {
            cNvPr.removeAttribute('descr');
          }
          mutated = true;
        }

        const nameMatch =
          nameAttr.match(/^__z_(\d+)__dom_(\d+)__type_([^_]*)/) || nameAttr.match(/^__z_(\d+)__dom_(\d+)(.*)/);
        if (nameMatch) {
          if (!hasVal) {
            zVal = parseInt(nameMatch[1], 10);
            domVal = parseInt(nameMatch[2], 10);
          }

          let shapeName;
          if (nameAttr.includes('__type_')) {
            // New format: __z_N__dom_N__type_TYPE — use type to set a proper name
            const typeSegment = nameMatch[3] || '';
            const typePrefix =
              typeSegment === 'text'
                ? 'TextBox'
                : typeSegment === 'image'
                  ? 'Picture'
                  : typeSegment === 'table'
                    ? 'Table'
                    : typeSegment === 'line'
                      ? 'Line'
                      : typeSegment === 'shape'
                        ? 'Shape'
                        : 'Shape';
            shapeName = `${typePrefix} ${domVal + 1}`;
          } else {
            // Old format: __z_N__dom_N [optional user text]
            const userText = (nameMatch[3] || '').trim();
            shapeName = userText || `Shape ${domVal + 1}`;
          }

          cNvPr.setAttribute('name', shapeName);
          mutated = true;
        }
      }
      return { el, zVal, domVal, originalIndex };
    });

    // Sort visualElements
    elementInfos.sort((a, b) => {
      if (a.zVal !== b.zVal) {
        return a.zVal - b.zVal;
      }
      return a.domVal - b.domVal;
    });

    const sortedVisualElements = elementInfos.map((info) => info.el);

    // Check if the order has changed
    let orderChanged = false;
    for (let i = 0; i < visualElements.length; i++) {
      if (visualElements[i] !== sortedVisualElements[i]) {
        orderChanged = true;
        break;
      }
    }

    if (orderChanged) {
      // Re-construct spTree children
      while (spTree.firstChild) {
        spTree.removeChild(spTree.firstChild);
      }

      for (const el of firstElements) {
        spTree.appendChild(el);
      }
      for (const el of sortedVisualElements) {
        spTree.appendChild(el);
      }
      for (const el of lastElements) {
        spTree.appendChild(el);
      }
      mutated = true;
    }
  }
  return mutated;
}

function stripTransportMetadata(value) {
  return String(value || '')
    .replace(/^__type_[^_\s]+/, '')
    .replace(/^__tile_-?[\d.]+_-?[\d.]+_-?[\d.]+_-?[\d.]+/, '')
    .trim();
}

function serializeXmlWithDeclaration(doc) {
  let serialized = new XMLSerializer().serializeToString(doc);
  if (!serialized.startsWith('<?xml')) {
    serialized = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + serialized;
  }
  return serialized;
}

function applySlideAnimations(doc, slideIndex, options) {
  const slideAnimations = options._slideAnimations?.[slideIndex];
  if (!slideAnimations || slideAnimations.length === 0) return false;

  const domToSpIdMap = new Map();
  const textBoxSpIds = new Set();

  // Find all cNvPr elements to build the mapping from domVal to spId
  const cNvPrs = Array.from(doc.getElementsByTagName('*')).filter((n) => n.localName === 'cNvPr');

  for (const cNvPr of cNvPrs) {
    const descr = cNvPr.getAttribute('descr') || '';
    const nameAttr = cNvPr.getAttribute('name') || '';
    const spId = cNvPr.getAttribute('id');
    if (!spId) continue;

    const descrMatch = descr.match(/^__z_(\d+)__dom_(\d+)(.*)/);
    const nameMatch = nameAttr.match(/^__z_(\d+)__dom_(\d+)(.*)/);

    let domVal = null;
    if (descrMatch) {
      domVal = parseInt(descrMatch[2], 10);
    } else if (nameMatch) {
      domVal = parseInt(nameMatch[2], 10);
    }

    if (domVal !== null && !isNaN(domVal)) {
      if (!domToSpIdMap.has(domVal)) {
        domToSpIdMap.set(domVal, []);
      }
      domToSpIdMap.get(domVal).push(spId);

      // Check if this cNvPr's shape represents a TextBox (has <p:txBody>)
      // Structure: <p:sp> -> <p:nvSpPr> -> <p:cNvPr>
      const grandParent = cNvPr.parentNode?.parentNode;
      if (grandParent) {
        const hasTxBody = Array.from(grandParent.childNodes).some(
          (child) => child.nodeType === 1 && child.localName === 'txBody'
        );
        if (hasTxBody) {
          textBoxSpIds.add(spId);
        }
      }
    }
  }

  // Build the p:timing XML block
  const timingXml = buildTimingXml(slideAnimations, domToSpIdMap, textBoxSpIds);
  if (!timingXml) return false;

  let timingDoc;
  try {
    timingDoc = new DOMParser().parseFromString(timingXml, 'text/xml');
  } catch (e) {
    console.warn('[pptx-normalizer] Failed to parse timing XML string:', e);
    return false;
  }

  const parserError = timingDoc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    console.warn('[pptx-normalizer] Timing XML parsing failed:', parserError.textContent);
    return false;
  }

  const timingNode = doc.importNode(timingDoc.documentElement, true);
  const sld = doc.documentElement;

  // Find where to insert (before extLst if exists)
  const extLst = Array.from(sld.childNodes).find((n) => n.nodeType === 1 && n.localName === 'extLst');

  if (extLst) {
    sld.insertBefore(timingNode, extLst);
  } else {
    sld.appendChild(timingNode);
  }

  return true;
}

/**
 * Injects a transition node into the slide XML.
 */
function applySlideTransitions(doc, slideIndex, options) {
  const transitionData = options._slideTransitions[slideIndex];
  if (!transitionData) return false;

  const transitionXml = getTransitionXml(transitionData);
  if (!transitionXml) return false;

  const sldNode = doc.documentElement;

  // Parse the transition XML fragment
  const tmpDoc = new DOMParser().parseFromString(
    `<root xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${transitionXml}</root>`,
    'text/xml'
  );

  const parserError = tmpDoc.getElementsByTagName('parsererror')[0];
  if (parserError) {
    console.warn('[pptx-normalizer] Transition XML parsing failed:', parserError.textContent);
    return false;
  }

  const transitionNode = tmpDoc.documentElement.firstChild;
  if (!transitionNode) return false;

  const importedNode = doc.importNode(transitionNode, true);

  const isP14 = transitionXml.includes('p14:');
  const isP15 = transitionXml.includes('p15:');
  let finalNode;

  if (isP14 || isP15) {
    const prefix = isP15 ? 'p15' : 'p14';
    const nsPrefixUri =
      prefix === 'p14'
        ? 'http://schemas.microsoft.com/office/powerpoint/2010/main'
        : 'http://schemas.microsoft.com/office/powerpoint/2012/main';
    const spd = transitionNode.getAttribute('spd') || transitionData.spd || 'med';

    const altXml = `
      <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <mc:Choice xmlns:${prefix}="${nsPrefixUri}" Requires="${prefix}">
          ${transitionXml}
        </mc:Choice>
        <mc:Fallback>
          <p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" spd="${spd}">
            <p:fade/>
          </p:transition>
        </mc:Fallback>
      </mc:AlternateContent>
    `.trim();

    const altDoc = new DOMParser().parseFromString(altXml, 'text/xml');
    const altParserError = altDoc.getElementsByTagName('parsererror')[0];
    if (altParserError) {
      console.warn('[pptx-normalizer] AlternateContent XML parsing failed:', altParserError.textContent);
      return false;
    }

    finalNode = doc.importNode(altDoc.documentElement, true);

    // Add required namespaces to slide root if they aren't on the root
    if (!sldNode.getAttribute('xmlns:mc')) {
      sldNode.setAttribute('xmlns:mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006');
    }
    if (!sldNode.getAttribute(`xmlns:${prefix}`)) {
      sldNode.setAttribute(`xmlns:${prefix}`, nsPrefixUri);
    }
    const currentIgnorable = sldNode.getAttribute('mc:Ignorable') || '';
    const existingIgnorables = currentIgnorable.split(/\s+/).filter(Boolean);
    if (!existingIgnorables.includes(prefix)) {
      existingIgnorables.push(prefix);
      sldNode.setAttribute('mc:Ignorable', existingIgnorables.join(' '));
    }
  } else {
    finalNode = importedNode;
  }

  // The transition node (or mc:AlternateContent) must be inserted in the correct OOXML schema order:
  // p:cSld, p:clrMapOvr, p:transition, p:timing, p:extLst
  // So we insert it before p:timing, p:hf, or p:extLst. If none exist, we append it.
  const insertBeforeTags = ['p:timing', 'p:hf', 'p:extLst'];
  let insertRef = null;
  for (const tag of insertBeforeTags) {
    const el = doc.getElementsByTagName(tag)[0];
    if (el && el.parentNode === sldNode) {
      insertRef = el;
      break;
    }
  }

  if (insertRef) {
    sldNode.insertBefore(finalNode, insertRef);
  } else {
    sldNode.appendChild(finalNode);
  }

  return true;
}
