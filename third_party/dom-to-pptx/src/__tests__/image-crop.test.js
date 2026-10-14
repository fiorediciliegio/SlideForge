import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProcessedImage, resolveRasterScale } from '../image-processor.js';

describe('manual editor image crops', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the physical PPTX scale when resolving raster dimensions', () => {
    expect(resolveRasterScale({ requestedScale: 3, pptxScale: 2 / 3, maxDpi: 150 })).toBeCloseTo(1.0416667, 6);
    expect(resolveRasterScale({ requestedScale: 3, pptxScale: 2 / 3, maxDpi: 96 })).toBeCloseTo(2 / 3, 6);
  });

  it('maps a normalized source crop directly into the target image box', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      drawImage,
      set fillStyle(_value) {},
      set globalCompositeOperation(_value) {},
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,cropped');

    class FakeImage {
      width = 1000;
      height = 500;
      onload = null;
      onerror = null;
      set src(_value) {
        this.onload?.();
      }
    }
    vi.stubGlobal('Image', FakeImage);

    const result = await getProcessedImage(
      'data:image/png;base64,source',
      400,
      200,
      0,
      'fill',
      '50% 50%',
      { x: 0.25, y: 0.1, width: 0.5, height: 0.5 }
    );

    expect(result).toBe('data:image/png;base64,cropped');
    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), -200, -40, 800, 400);
  });

  it('caps raster dimensions by physical DPI and uses JPEG for opaque images', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })),
      set fillStyle(_value) {},
      set globalCompositeOperation(_value) {},
    });
    let rasterWidth = 0;
    let rasterHeight = 0;
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (mime) {
      rasterWidth = this.width;
      rasterHeight = this.height;
      return `data:${mime};base64,opaque`;
    });

    class FakeImage {
      width = 1920;
      height = 1080;
      onload = null;
      onerror = null;
      set src(_value) {
        this.onload?.();
      }
    }
    vi.stubGlobal('Image', FakeImage);

    const result = await getProcessedImage('data:image/jpeg;base64,source', 1920, 1080, 0, 'fill', '50% 50%', null, {
      pptxScale: 13.333333 / 20,
      maxDpi: 150,
    });

    expect(result).toBe('data:image/jpeg;base64,opaque');
    expect(rasterWidth).toBe(2000);
    expect(rasterHeight).toBe(1125);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('keeps uncovered contain areas transparent even for JPEG sources', async () => {
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      drawImage: vi.fn(),
      getImageData,
      set fillStyle(_value) {},
      set globalCompositeOperation(_value) {},
    });
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((mime) => `data:${mime}`);

    class FakeImage {
      width = 100;
      height = 100;
      onload = null;
      onerror = null;
      set src(_value) {
        this.onload?.();
      }
    }
    vi.stubGlobal('Image', FakeImage);

    await getProcessedImage('https://example.com/source.jpg', 400, 200, 0, 'contain');

    // Letterboxing already proves transparency, so the pixel scan is skipped.
    expect(getImageData).not.toHaveBeenCalled();
    expect(toDataURL).toHaveBeenCalledWith('image/png');
  });

  it('inspects pixels before choosing JPEG even when the image covers the canvas', async () => {
    // An SVG noise texture fills its box yet is almost entirely transparent;
    // treating "covers the canvas" as "opaque" flattens it onto JPEG black.
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([9, 9, 9, 40]) }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      drawImage: vi.fn(),
      getImageData,
      set fillStyle(_value) {},
      set globalCompositeOperation(_value) {},
    });
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((mime) => `data:${mime}`);

    class FakeImage {
      width = 200;
      height = 200;
      onload = null;
      onerror = null;
      set src(_value) {
        this.onload?.();
      }
    }
    vi.stubGlobal('Image', FakeImage);

    const noiseUrl =
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><filter id="n"><feTurbulence type="fractalNoise"/></filter><rect width="200" height="200" filter="url(%23n)" opacity="0.2"/></svg>';
    await getProcessedImage(noiseUrl, 200, 200, 0, 'fill');

    expect(getImageData).toHaveBeenCalled();
    expect(toDataURL).toHaveBeenCalledWith('image/png');
  });

  it('resolves null when a tainted canvas cannot be serialized', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      set fillStyle(_value) {},
      set globalCompositeOperation(_value) {},
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    class FakeImage {
      width = 100;
      height = 100;
      onload = null;
      onerror = null;
      set src(_value) {
        this.onload?.();
      }
    }
    vi.stubGlobal('Image', FakeImage);

    await expect(getProcessedImage('https://example.com/cross-origin.png', 100, 100, 0)).resolves.toBeNull();
  });
});
