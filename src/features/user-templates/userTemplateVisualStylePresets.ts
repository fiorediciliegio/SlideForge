import type { VisualStylePreset, VisualStylePresetPreview } from "../../api/types";
import type { UserTemplateListEntry } from "./types";

/** Lazily resolved cover thumbnails, keyed by template id. The list API no
 *  longer ships preview bytes, so the deck flow gets its covers through the
 *  single-asset channel; entries missing here simply render the fallback. */
export type UserTemplateCoverMap = Record<string, VisualStylePresetPreview[]>;

/** Ready user templates already have the descriptions and reference pages required for recommendation. */
export function toReadyUserVisualStylePresets(
  templates: readonly UserTemplateListEntry[],
  covers: UserTemplateCoverMap = {},
): VisualStylePreset[] {
  return templates
    .filter((template) => template.status === "ready")
    .map((template, index) => ({
      id: template.id,
      version: template.version,
      name: template.name,
      description: template.description,
      ppt_number: index + 1,
      theme: "light",
      color: [],
      user: "",
      use_case: "",
      industry: "",
      preview_images: covers[template.id] ?? template.preview_images,
      reference_html_pages: template.pages.map((page) => ({
        path: `html/page-${String(page.page_number).padStart(3, "0")}.html`,
        description: page.description,
      })),
      source: "user" as const,
    }));
}
