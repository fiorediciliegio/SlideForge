/**
 * 品牌档案存取（HTTP 与 MCP 共用）。
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { BrandProfile } from "./profile.js";

export const BRANDS_DIR = path.resolve(import.meta.dirname, "..", "..", "data", "brands");

export interface BrandRecord extends BrandProfile {
  brand_id?: string;
  logoFile?: string;
  logoPosition?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
}

export async function loadBrand(brandId: string): Promise<BrandRecord | null> {
  try {
    return JSON.parse(await readFile(path.join(BRANDS_DIR, brandId, "profile.json"), "utf8")) as BrandRecord;
  } catch {
    return null;
  }
}
