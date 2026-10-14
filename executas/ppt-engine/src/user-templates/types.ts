export interface UserTemplatePage {
  page_number: number;
  description: string;
}

/** One brand color token distilled from the source deck. */
export interface DesignProfileColor {
  /** Short token name, e.g. "primary" / "accent". */
  token: string;
  /** Exact color, e.g. "#1B4F9C". */
  hex: string;
  /** Human-readable role, e.g. "主色 Primary". */
  role: string;
  /** Where the color is used, e.g. "cover title, chart series". */
  usage?: string;
  /** Evidence: which source page this was read from. */
  source?: string;
}

export interface DesignProfileTypography {
  heading_font?: string;
  body_font?: string;
  fallback_fonts?: string[];
  notes?: string;
}

/** A fixed brand asset the model must never redraw (composited after generation). */
export interface DesignProfileFixedAsset {
  kind: "logo";
  label?: string;
  position_rule?: string;
  notes?: string;
  /** Imported logo image stored under the template's assets/ directory.
   *  Metadata only — the binary lives on the engine's disk, never in profile.json. */
  image?: {
    filename: string;
    mime_type: string;
    size_bytes: number;
  };
}

/**
 * Structured, editable brand rules extracted from the user's material. Serves as
 * the human-reviewable control panel and as hard constraints during master/page
 * generation. Distilled from the Claude Cowork "Design System" pattern.
 */
export interface DesignProfile {
  colors: DesignProfileColor[];
  typography?: DesignProfileTypography;
  layout_rules?: string[];
  fixed_assets?: DesignProfileFixedAsset[];
  voice?: string;
  do?: string[];
  dont?: string[];
  /** free-form provenance: field -> "old -> new (date, reason)" audit notes */
  evidence?: Record<string, string>;
}

export interface UserTemplate {
  id: string;
  version: number;
  name: string;
  description: string;
  filename: string;
  status: "draft" | "ready";
  created_at: string;
  pages: UserTemplatePage[];
  master_ready: boolean;
  completed_pages: number[];
  /** Hydrated from profile.json; null until the extraction stage saves it. */
  profile?: DesignProfile | null;
  profile_ready?: boolean;
  /** "pptx" (default) or "images": what kind of source material the template was distilled from. */
  source_kind?: "pptx" | "images";
  /** For image sources: stored source file names, index n-1 is page n. */
  source_files?: string[];
  /** Computed on read; older records did not persist this field. */
  source_ready?: boolean;
}

export type UserTemplateAsset = "source" | "reference" | "master" | "page" | "preview" | "snapshot" | "profile" | "profile_asset";

export interface UserTemplateMetadata {
  name: string;
  description: string;
  pages: UserTemplatePage[];
}
