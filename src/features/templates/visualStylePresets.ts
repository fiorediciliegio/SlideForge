import type {
  VisualStylePreset,
  VisualStylePresetColor,
  VisualStylePresetColorVariant,
  VisualStylePresetCatalogCohort,
  VisualStylePresetRecommendationProfile,
  VisualStylePresetReferenceHtmlPage,
  VisualStylePresetTheme,
  VisualStylePresetThemeMode,
} from "../../api/types";
import {
  buildVisualStylePresetFilterOptions,
  sortVisualStylePresetsByScore,
} from "./visualStylePresetFilters";
import { sampleVisualStylePresetsByColor as samplePresetsByColor } from "./visualStylePresetSampling";
export { toVisualStylePresetSelection } from "./visualStylePresetSelection";

export const NO_VISUAL_STYLE_PRESET_ID = "none";
const COLOR_VARIANT_SEPARATOR = "::";

interface VisualStylePresetSource {
  id: string;
  version: number;
  ppt_number: number;
  score?: number;
  catalog_cohort?: VisualStylePresetCatalogCohort;
  theme: VisualStylePresetTheme;
  color: VisualStylePresetColor[];
  name: string;
  description: string;
  user: string;
  use_case: string;
  industry: string;
  recommendation_profile?: VisualStylePresetRecommendationProfile;
  theme_mode?: VisualStylePresetThemeMode;
  color_role_anchors?: Record<string, string>;
  color_variants?: VisualStylePresetColorVariant[];
  preview_images: Array<{ path: string; alt: string }>;
  reference_html_pages: Array<{ path: string; description: string }>;
}

const presetModules = import.meta.glob("./presets/*/preset.json", {
  eager: true,
  import: "default",
}) as Record<string, VisualStylePresetSource>;

const previewModules = import.meta.glob("./presets/*/images/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const referenceHtmlModules = import.meta.glob("./presets/*/html/*.html", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const VISUAL_STYLE_PRESET_THEMES = new Set<VisualStylePresetTheme>(["dark", "light"]);
const SEMANTIC_THEME_ROLE_KEYS = [
  "bg", "surface", "ink", "muted", "accent_primary", "accent_secondary", "accent_tertiary", "line",
] as const;

function assertSource(value: VisualStylePresetSource, configPath: string): void {
  if (!value || typeof value !== "object") throw new Error(`Invalid visual style preset: ${configPath}`);
  if (typeof value.id !== "string" || !value.id || !Number.isInteger(value.version) || value.version < 1) {
    throw new Error(`Invalid visual style preset identity: ${configPath}`);
  }
  if (!Number.isInteger(value.ppt_number) || value.ppt_number < 1) {
    throw new Error(`Invalid visual style preset PPT number: ${configPath}`);
  }
  if (value.score !== undefined && !Number.isFinite(value.score)) {
    throw new Error(`Invalid visual style preset score: ${configPath}`);
  }
  if (value.catalog_cohort !== undefined && value.catalog_cohort !== "established" && value.catalog_cohort !== "new") {
    throw new Error(`Invalid visual style preset catalogue cohort: ${configPath}`);
  }
  if (!VISUAL_STYLE_PRESET_THEMES.has(value.theme)) {
    throw new Error(`Invalid visual style preset theme: ${configPath}`);
  }
  if (
    !Array.isArray(value.color) ||
    value.color.length === 0 ||
    value.color.some((color) => typeof color !== "string" || !color.trim()) ||
    new Set(value.color).size !== value.color.length
  ) {
    throw new Error(`Invalid visual style preset colors: ${configPath}`);
  }
  if (!value.name || !value.description || !Array.isArray(value.preview_images) || !Array.isArray(value.reference_html_pages)) {
    throw new Error(`Incomplete visual style preset: ${configPath}`);
  }
  const taxonomy = [value.user, value.use_case, value.industry];
  if (taxonomy.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Incomplete visual style preset taxonomy: ${configPath}`);
  }
  if (value.recommendation_profile !== undefined) {
    const profile = value.recommendation_profile;
    const values = [
      profile.use_cases,
      profile.industries,
      profile.audiences,
      profile.formats,
      profile.primary_styles,
      profile.visual_traits,
      profile.styles,
    ];
    if (!profile || typeof profile !== "object" || values.some((tags) => (
      tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !tag.trim()))
    ))) {
      throw new Error(`Invalid visual style preset recommendation profile: ${configPath}`);
    }
  }
  if (value.theme_mode !== "semantic-v1" && (value.color_role_anchors || value.color_variants)) {
    if (!value.color_role_anchors || Object.keys(value.color_role_anchors).length === 0) {
      throw new Error(`Visual style preset variants need colour-role anchors: ${configPath}`);
    }
    if (!Array.isArray(value.color_variants) || value.color_variants.length < 2) {
      throw new Error(`Visual style preset variants need at least two palettes: ${configPath}`);
    }
    const variantIds = new Set<string>();
    for (const variant of value.color_variants) {
      if (!variant || !variant.id || !variant.name || variantIds.has(variant.id)
        || !Array.isArray(variant.swatches) || variant.swatches.length < 2
        || !variant.roles || typeof variant.roles !== "object") {
        throw new Error(`Invalid visual style preset colour variant: ${configPath}`);
      }
      variantIds.add(variant.id);
    }
  }
  if (value.theme_mode === "semantic-v1") {
    if (!Array.isArray(value.color_variants) || value.color_variants.length < 2) {
      throw new Error(`Semantic visual style preset needs at least two palettes: ${configPath}`);
    }
    for (const variant of value.color_variants) {
      const roleKeys = variant ? Object.keys(variant.roles ?? {}) : [];
      if (!variant
        || !SEMANTIC_THEME_ROLE_KEYS.every((role) => typeof variant.roles?.[role] === "string")
        || roleKeys.some((role) => !SEMANTIC_THEME_ROLE_KEYS.includes(role as typeof SEMANTIC_THEME_ROLE_KEYS[number]))) {
        throw new Error(`Semantic visual style preset has incomplete theme roles: ${configPath}`);
      }
    }
  }
}

function loadVisualStylePresets(): VisualStylePreset[] {
  const ids = new Set<string>();
  const pptNumbers = new Set<number>();

  return sortVisualStylePresetsByScore(
    Object.entries(presetModules)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([configPath, source]) => {
        assertSource(source, configPath);
        const match = /^\.\/presets\/([^/]+)\/preset\.json$/.exec(configPath);
        if (!match || match[1] !== source.id) {
          throw new Error(`Preset directory must match its id: ${configPath}`);
        }
        if (ids.has(source.id)) throw new Error(`Duplicate visual style preset id: ${source.id}`);
        ids.add(source.id);
        if (pptNumbers.has(source.ppt_number)) {
          throw new Error(`Duplicate visual style preset PPT number: ${source.ppt_number}`);
        }
        pptNumbers.add(source.ppt_number);

        const preview_images = source.preview_images.map(({ path, alt }) => {
          if (!/^images\/[^/]+\.webp$/i.test(path)) {
            throw new Error(`Invalid preview path for ${source.id}: ${path}`);
          }
          const imagePath = `./presets/${source.id}/${path}`;
          const url = previewModules[imagePath];
          if (!url) throw new Error(`Preview image not found for ${source.id}: ${path}`);
          return { url, alt: alt || source.name };
        });

        if (preview_images.length === 0) throw new Error(`Visual style preset has no previews: ${source.id}`);
        const reference_html_pages = source.reference_html_pages.map(({ path, description }) => {
          if (!/^html\/[^/]+\.html$/i.test(path) || !description?.trim()) {
            throw new Error(`Invalid reference HTML page for ${source.id}: ${path}`);
          }
          const loadHtml = referenceHtmlModules[`./presets/${source.id}/${path}`];
          if (!loadHtml) throw new Error(`Reference HTML not found for ${source.id}: ${path}`);
          return { path, description: description.trim() };
        });
        if (reference_html_pages.length === 0) {
          throw new Error(`Visual style preset has no reference HTML pages: ${source.id}`);
        }
        return { ...source, catalog_cohort: source.catalog_cohort ?? "established", preview_images, reference_html_pages };
      }),
  );
}

export const VISUAL_STYLE_PRESETS = loadVisualStylePresets();

export const VISUAL_STYLE_PRESET_FILTER_OPTIONS =
  buildVisualStylePresetFilterOptions(VISUAL_STYLE_PRESETS);

export function listVisualStylePresetColors(): VisualStylePresetColor[] {
  return [...new Set(VISUAL_STYLE_PRESETS.flatMap((preset) => preset.color))];
}

export function sampleVisualStylePresetsByColor(
  color: VisualStylePresetColor,
  limit = 10,
  random = Math.random,
): VisualStylePreset[] {
  return samplePresetsByColor(VISUAL_STYLE_PRESETS, color, limit, random);
}

export function findVisualStylePreset(id: string | null | undefined): VisualStylePreset | null {
  if (!id || id === NO_VISUAL_STYLE_PRESET_ID) return null;
  const direct = VISUAL_STYLE_PRESETS.find((preset) => preset.id === id);
  if (direct) return direct;
  const separatorIndex = id.lastIndexOf(COLOR_VARIANT_SEPARATOR);
  if (separatorIndex < 1) return null;
  const basePreset = VISUAL_STYLE_PRESETS.find((preset) => preset.id === id.slice(0, separatorIndex));
  if (!basePreset) return null;
  return resolveVisualStylePresetColorVariant(basePreset, id.slice(separatorIndex + COLOR_VARIANT_SEPARATOR.length));
}

export function getVisualStylePresetColorVariants(
  preset: VisualStylePreset,
): readonly VisualStylePresetColorVariant[] {
  return preset.color_variants ?? [];
}

export function getVisualStylePresetFamilyId(preset: VisualStylePreset): string {
  return preset.base_preset_id ?? preset.id;
}

export function resolveVisualStylePresetColorVariant(
  preset: VisualStylePreset,
  variantId: string | null | undefined,
): VisualStylePreset | null {
  const familyId = getVisualStylePresetFamilyId(preset);
  const basePreset = preset.base_preset_id
    ? VISUAL_STYLE_PRESETS.find((candidate) => candidate.id === familyId) ?? null
    : preset;
  if (!basePreset || !variantId) return null;
  const variant = basePreset.color_variants?.find((candidate) => candidate.id === variantId);
  if (!variant) return null;
  return {
    ...basePreset,
    id: `${basePreset.id}${COLOR_VARIANT_SEPARATOR}${variant.id}`,
    name: `${basePreset.name} · ${variant.name}`,
    base_preset_id: basePreset.id,
    selected_color_variant: variant,
  };
}

export function isVisualStylePresetSelection(
  selectedPresetId: string | null | undefined,
  preset: VisualStylePreset,
): boolean {
  const selected = findVisualStylePreset(selectedPresetId);
  if (!selected || getVisualStylePresetFamilyId(selected) !== getVisualStylePresetFamilyId(preset)) return false;
  const selectedVariant = selected.selected_color_variant?.id ?? selected.color_variants?.[0]?.id ?? null;
  const candidateVariant = preset.selected_color_variant?.id ?? preset.color_variants?.[0]?.id ?? null;
  return selectedVariant === candidateVariant;
}

export async function loadVisualStylePresetReferenceHtmlPages(
  preset: VisualStylePreset,
  options: { applyColorVariant?: boolean } = {},
): Promise<VisualStylePresetReferenceHtmlPage[]> {
  const sourcePresetId = preset.base_preset_id ?? preset.id;
  return Promise.all(preset.reference_html_pages.map(async ({ path, description }) => {
    const loadHtml = referenceHtmlModules[`./presets/${sourcePresetId}/${path}`];
    if (!loadHtml) throw new Error(`Reference HTML not found for ${preset.id}: ${path}`);
    const html = await loadHtml();
    if (typeof html !== "string" || !html.trim()) {
      throw new Error(`Reference HTML is empty for ${preset.id}: ${path}`);
    }
    return {
      path,
      description,
      html: options.applyColorVariant === false ? html : applyVisualStylePresetColorVariant(html, preset),
    };
  }));
}

interface RgbaColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

const CSS_COLOR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)/gi;
const PRESET_COLOR_VARIABLE_DECLARATION = /(--preset-color-\d+)\s*:\s*([^;]+);/g;
const SEMANTIC_THEME_VARIABLE_DECLARATION = /(--theme-([a-z-]+))\s*:\s*([^;]+);/g;

function parseCssColor(value: string): RgbaColor | null {
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expanded = hex.length === 3 || hex.length === 4
      ? [...hex].map((part) => `${part}${part}`).join("")
      : hex;
    if (expanded.length !== 6 && expanded.length !== 8) return null;
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
      alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const values = value.match(/[\d.]+/g)?.map(Number);
  if (!values || values.length < 3 || values.some((part) => !Number.isFinite(part))) return null;
  return { red: values[0], green: values[1], blue: values[2], alpha: values[3] ?? 1 };
}

function colorDistance(left: RgbaColor, right: RgbaColor): number {
  return Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue);
}

function clampColorChannel(value: number): number {
  return Math.round(Math.max(0, Math.min(255, value)));
}

function formatCssColor(color: RgbaColor, alpha: number): string {
  const red = clampColorChannel(color.red);
  const green = clampColorChannel(color.green);
  const blue = clampColorChannel(color.blue);
  if (alpha >= 0.999) return `rgb(${red}, ${green}, ${blue})`;
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")})`;
}

/**
 * Preserve a template's shading and transparency while shifting colours from
 * its declared source anchors to the selected palette.  This keeps each
 * preset to one HTML file instead of duplicating every colour variant.
 */
export function applyVisualStylePresetColorVariant(html: string, preset: VisualStylePreset): string {
  if (preset.theme_mode === "semantic-v1") return applySemanticVisualStylePresetColorVariant(html, preset);
  return html.replace(CSS_COLOR_LITERAL, (literal) => transformVisualStylePresetCssColor(literal, preset));
}

/**
 * Returns the custom-property values for the reference HTML's palette.  The
 * picker applies these to an already-loaded iframe, so changing a colour does
 * not recreate the document (and therefore does not flash unloaded fonts).
 */
export function getVisualStylePresetColorVariableOverrides(
  html: string,
  preset: VisualStylePreset,
): Record<string, string> {
  if (preset.theme_mode === "semantic-v1") return getSemanticThemeVariableOverrides(html, preset);
  const variables: Record<string, string> = {};
  for (const match of html.matchAll(PRESET_COLOR_VARIABLE_DECLARATION)) {
    variables[match[1]] = transformVisualStylePresetCssColor(match[2].trim(), preset);
  }
  return variables;
}

function semanticThemeCssVariableName(role: string): string {
  return `--theme-${role.replaceAll("_", "-")}`;
}

function getSemanticThemeVariableOverrides(html: string, preset: VisualStylePreset): Record<string, string> {
  const variant = preset.selected_color_variant;
  if (!variant) return {};
  const variables: Record<string, string> = {};
  for (const match of html.matchAll(SEMANTIC_THEME_VARIABLE_DECLARATION)) {
    const role = match[2].replaceAll("-", "_");
    if (variant.roles[role]) variables[match[1]] = variant.roles[role];
  }
  return variables;
}

function applySemanticVisualStylePresetColorVariant(html: string, preset: VisualStylePreset): string {
  const overrides = getSemanticThemeVariableOverrides(html, preset);
  if (Object.keys(overrides).length === 0) return html;
  return html.replace(SEMANTIC_THEME_VARIABLE_DECLARATION, (declaration, variableName) => {
    const value = overrides[variableName];
    return value ? `${variableName}: ${value};` : declaration;
  });
}

function transformVisualStylePresetCssColor(literal: string, preset: VisualStylePreset): string {
  const variant = preset.selected_color_variant;
  const anchors = preset.color_role_anchors;
  if (!variant || !anchors) return literal;
  const palette = Object.entries(anchors).flatMap(([role, anchorValue]) => {
    const anchor = parseCssColor(anchorValue);
    const target = variant.roles[role] ? parseCssColor(variant.roles[role]) : null;
    return anchor && target ? [{ anchor, target }] : [];
  });
  if (palette.length === 0) return literal;
  const source = parseCssColor(literal);
  if (!source) return literal;
  const match = palette.reduce<{ anchor: RgbaColor; target: RgbaColor; distance: number } | null>((closest, candidate) => {
    const distance = colorDistance(source, candidate.anchor);
    return !closest || distance < closest.distance ? { ...candidate, distance } : closest;
  }, null);
  // This threshold keeps unrelated neutral shadows and white text intact.
  if (!match || match.distance > 178) return literal;
  return formatCssColor({
    red: match.target.red + (source.red - match.anchor.red),
    green: match.target.green + (source.green - match.anchor.green),
    blue: match.target.blue + (source.blue - match.anchor.blue),
    alpha: source.alpha,
  }, source.alpha);
}
