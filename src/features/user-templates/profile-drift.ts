import type { DesignProfile } from "./types";

export interface DriftSample { hex: string; coverage: number }
export interface PageDrift { page_number: number; drifted: boolean; dominant: DriftSample[]; unmatched: DriftSample[] }

const CHANNEL_BITS = 4;
const CHANNEL_MAX = (1 << CHANNEL_BITS) - 1;
/** A dominant color covering less than this is ignored (noise). */
const MIN_COVERAGE = 0.06;
/** RGB euclidean distance above which a color counts as outside the palette. */
const PALETTE_DISTANCE_THRESHOLD = 90;

export function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function rgbDistance(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}

export function nearestPaletteDistance(hex: string, palette: string[]): number {
  return Math.min(...palette.map((candidate) => rgbDistance(hex, candidate)));
}

/** Aggregate sampled pixels into quantized buckets and return the dominant ones. */
export function dominantFromPixels(pixels: Uint8ClampedArray, pixelCount: number): DriftSample[] {
  const buckets = new Map<number, { r: number; g: number; b: number; count: number }>();
  for (let i = 0; i < pixelCount; i += 1) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const key = ((r >> (8 - CHANNEL_BITS)) << (CHANNEL_BITS * 2)) | ((g >> (8 - CHANNEL_BITS)) << CHANNEL_BITS) | (b >> (8 - CHANNEL_BITS));
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((bucket) => {
      const hex = `#${[bucket.r, bucket.g, bucket.b].map((channel) => Math.round(channel / bucket.count).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      return { hex, coverage: bucket.count / pixelCount };
    })
    .filter((sample) => sample.coverage >= MIN_COVERAGE)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, 8);
}

/** Pure drift verdict for one page's dominant colors against the profile palette. */
export function evaluateDrift(page_number: number, dominant: DriftSample[], palette: string[]): PageDrift {
  const significant = dominant.filter((sample) => sample.coverage >= MIN_COVERAGE);
  const unmatched = significant.filter((sample) => nearestPaletteDistance(sample.hex, palette) > PALETTE_DISTANCE_THRESHOLD);
  return { page_number, drifted: unmatched.length > 0, dominant: significant, unmatched };
}

/** Browser-only: load an image and extract its dominant colors via canvas. */
export async function extractDominantColors(imageUrl: string): Promise<DriftSample[]> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not load preview image for drift check"));
    image.src = imageUrl;
  });
  const canvas = document.createElement("canvas");
  const width = 96;
  const height = Math.max(1, Math.round((image.naturalHeight / Math.max(1, image.naturalWidth)) * width));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  return dominantFromPixels(data, width * height);
}

/** Default drift check used by the workflow; failures resolve to "no drift". */
export async function checkPageDrift(page_number: number, previewUrl: string, profile: DesignProfile): Promise<PageDrift> {
  try {
    const dominant = await extractDominantColors(previewUrl);
    return evaluateDrift(page_number, dominant, profile.colors.map((color) => color.hex));
  } catch {
    return { page_number, drifted: false, dominant: [], unmatched: [] };
  }
}
