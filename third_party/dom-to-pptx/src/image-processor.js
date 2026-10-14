// src/image-processor.js

const DEFAULT_REQUESTED_SCALE = 2;
const DEFAULT_MAX_DPI = 150;

/**
 * Resolves the raster scale shared by DOM captures and processed images.
 * `maxDpi` is a physical-resolution ceiling; it may intentionally produce a
 * scale below 1 when the requested DPI is lower than the source CSS DPI.
 */
export function resolveRasterScale(rasterOptions = {}, defaultRequestedScale = DEFAULT_REQUESTED_SCALE) {
  const requestedScale = Math.max(Number(rasterOptions.requestedScale) || defaultRequestedScale, 0.01);
  const maxDpi = Math.max(Number(rasterOptions.maxDpi) || DEFAULT_MAX_DPI, 1);
  const pptxScale = Math.max(Number(rasterOptions.pptxScale) || 1, 0.01);
  const maxScale = Math.max((pptxScale * maxDpi) / 96, 0.01);
  return Math.min(requestedScale, maxScale);
}

export async function getProcessedImage(
  src,
  targetW,
  targetH,
  radius,
  objectFit = 'fill',
  objectPosition = '50% 50%',
  sourceCrop = null,
  rasterOptions = {}
) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const logicalWidth = Math.max(Number(targetW) || 1, 1);
        const logicalHeight = Math.max(Number(targetH) || 1, 1);
        const scale = resolveRasterScale(rasterOptions);
        canvas.width = Math.max(Math.round(logicalWidth * scale), 1);
        canvas.height = Math.max(Math.round(logicalHeight * scale), 1);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.scale(scale, scale);

        let r = { tl: 0, tr: 0, br: 0, bl: 0 };
        if (typeof radius === 'number') {
          r = { tl: radius, tr: radius, br: radius, bl: radius };
        } else if (typeof radius === 'object' && radius !== null) {
          r = { ...r, ...radius };
        }

        ctx.beginPath();
        const factor = Math.min(
          logicalWidth / (r.tl + r.tr) || Infinity,
          logicalHeight / (r.tr + r.br) || Infinity,
          logicalWidth / (r.br + r.bl) || Infinity,
          logicalHeight / (r.bl + r.tl) || Infinity
        );
        if (factor < 1) {
          r.tl *= factor;
          r.tr *= factor;
          r.br *= factor;
          r.bl *= factor;
        }

        ctx.moveTo(r.tl, 0);
        ctx.lineTo(logicalWidth - r.tr, 0);
        ctx.arcTo(logicalWidth, 0, logicalWidth, r.tr, r.tr);
        ctx.lineTo(logicalWidth, logicalHeight - r.br);
        ctx.arcTo(logicalWidth, logicalHeight, logicalWidth - r.br, logicalHeight, r.br);
        ctx.lineTo(r.bl, logicalHeight);
        ctx.arcTo(0, logicalHeight, 0, logicalHeight - r.bl, r.bl);
        ctx.lineTo(0, r.tl);
        ctx.arcTo(0, 0, r.tl, 0, r.tl);
        ctx.closePath();
        ctx.fillStyle = '#000';
        ctx.fill();

        ctx.globalCompositeOperation = 'source-in';

        const wRatio = logicalWidth / img.width;
        const hRatio = logicalHeight / img.height;
        let renderW;
        let renderH;
        const hasSourceCrop =
          sourceCrop &&
          Number.isFinite(sourceCrop.x) &&
          Number.isFinite(sourceCrop.y) &&
          Number.isFinite(sourceCrop.width) &&
          Number.isFinite(sourceCrop.height) &&
          sourceCrop.width > 0 &&
          sourceCrop.height > 0;

        if (hasSourceCrop) {
          renderW = logicalWidth / sourceCrop.width;
          renderH = logicalHeight / sourceCrop.height;
        } else if (objectFit === 'contain') {
          const fitScale = Math.min(wRatio, hRatio);
          renderW = img.width * fitScale;
          renderH = img.height * fitScale;
        } else if (objectFit === 'cover') {
          const coverScale = Math.max(wRatio, hRatio);
          renderW = img.width * coverScale;
          renderH = img.height * coverScale;
        } else if (objectFit === 'none') {
          renderW = img.width;
          renderH = img.height;
        } else if (objectFit === 'scale-down') {
          const scaleDown = Math.min(1, Math.min(wRatio, hRatio));
          renderW = img.width * scaleDown;
          renderH = img.height * scaleDown;
        } else {
          renderW = logicalWidth;
          renderH = logicalHeight;
        }

        let posX = 0.5;
        let posY = 0.5;
        const posParts = String(objectPosition || '50% 50%').split(/\s+/);
        const parsePos = (value) => {
          if (value === 'left' || value === 'top') return 0;
          if (value === 'center') return 0.5;
          if (value === 'right' || value === 'bottom') return 1;
          if (String(value).includes('%')) return parseFloat(value) / 100;
          return 0.5;
        };
        if (posParts.length > 0) {
          posX = parsePos(posParts[0]);
          posY = posParts.length > 1 ? parsePos(posParts[1]) : 0.5;
        }

        const renderX = hasSourceCrop ? -sourceCrop.x * renderW : (logicalWidth - renderW) * posX;
        const renderY = hasSourceCrop ? -sourceCrop.y * renderH : (logicalHeight - renderH) * posY;
        ctx.drawImage(img, renderX, renderY, renderW, renderH);

        const coversCanvas =
          renderX <= 0 &&
          renderY <= 0 &&
          renderX + renderW >= logicalWidth &&
          renderY + renderH >= logicalHeight;
        // Covering the canvas only rules out letterboxing. The source can still
        // carry its own alpha — an SVG noise texture does, and flattening it
        // onto JPEG black turns a faint grain into an opaque dark wash — so
        // these conditions make opacity possible, never certain.
        const mayBeOpaque = !hasSourceCrop && r.tl + r.tr + r.br + r.bl === 0 && coversCanvas;
        const rawSrc = String(src || '').trim();
        const sourceCannotCarryAlpha =
          /^data:image\/jpe?g/i.test(rawSrc) || /\.jpe?g(?:[?#]|$)/i.test(rawSrc);

        let hasTransparency = true;
        if (mayBeOpaque && sourceCannotCarryAlpha) {
          hasTransparency = false;
        } else if (mayBeOpaque && typeof ctx.getImageData === 'function') {
          try {
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            hasTransparency = false;
            for (let index = 3; index < pixels.length; index += 4) {
              if (pixels[index] < 255) {
                hasTransparency = true;
                break;
              }
            }
          } catch {
            // A tainted canvas cannot be inspected; PNG is the safe choice.
            hasTransparency = true;
          }
        }

        try {
          resolve(
            hasTransparency
              ? canvas.toDataURL('image/png')
              : canvas.toDataURL('image/jpeg', Number(rasterOptions.jpegQuality) || 0.85)
          );
        } catch {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => resolve(null);
    img.src = src;
  });
}
