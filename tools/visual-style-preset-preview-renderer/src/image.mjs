import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { MAX_PREVIEW_BYTES, PREVIEW_HEIGHT, PREVIEW_WIDTH } from "./constants.mjs";

// Staged preset directories are renamed after validation. Disabling Sharp's
// file cache prevents retained WebP handles from blocking that rename on Windows.
sharp.cache(false);

export async function validateWebp(path) {
  const metadata = await sharp(path).metadata();
  if (metadata.format !== "webp") throw new Error(`${path} is not a WebP file.`);
  if (metadata.width !== PREVIEW_WIDTH || metadata.height !== PREVIEW_HEIGHT) {
    throw new Error(
      `${path} must be ${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}; received ${metadata.width}x${metadata.height}.`,
    );
  }

  const sample = await sharp(path)
    .ensureAlpha()
    .resize(64, 36, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let allWhite = true;
  let allBlack = true;
  let allTransparent = true;
  for (let index = 0; index < sample.data.length; index += 4) {
    const [red, green, blue, alpha] = sample.data.subarray(index, index + 4);
    if (red < 250 || green < 250 || blue < 250 || alpha < 250) allWhite = false;
    if (red > 5 || green > 5 || blue > 5 || alpha < 250) allBlack = false;
    if (alpha > 5) allTransparent = false;
  }
  if (allWhite) throw new Error(`${path} is effectively all white.`);
  if (allBlack) throw new Error(`${path} is effectively all black.`);
  if (allTransparent) throw new Error(`${path} is effectively transparent.`);

  const { size } = await stat(path);
  if (size > MAX_PREVIEW_BYTES) throw new Error(`${path} exceeds 300KB (${size} bytes).`);
  return { width: metadata.width, height: metadata.height, sizeBytes: size };
}

export async function convertImageToWebp(sourcePath, outputPath, quality) {
  await mkdir(dirname(outputPath), { recursive: true });
  await sharp(sourcePath)
    .rotate()
    .resize(PREVIEW_WIDTH, PREVIEW_HEIGHT, { fit: "fill" })
    .webp({ quality })
    .toFile(outputPath);
  return validateWebp(outputPath);
}
