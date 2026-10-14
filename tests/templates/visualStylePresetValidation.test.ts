import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";

import { validateVisualStylePresets } from "../../scripts/validate-visual-style-presets.mjs";

const validPreset = {
  id: "test-preset",
  version: 1,
  ppt_number: 999,
  score: 90,
  theme: "light",
  color: ["blue"],
  name: "Test preset",
  description: "Test description",
  user: "Business Professionals",
  use_case: "Reports & Analysis",
  industry: "Business & Finance",
  style_guide: "# Test",
  preview_images: [{ path: "images/reference.webp", alt: "Preview" }],
  reference_html_pages: [{ path: "html/reference.html", description: "Reference page" }],
};

async function createPresetRoot(
  preset: Record<string, unknown>,
  includeImage = true,
  referenceHtml = '<!doctype html><html><body><div class="slide"></div></body></html>',
) {
  const root = await mkdtemp(join(tmpdir(), "visual-style-presets-"));
  const presetDir = join(root, "test-preset");
  await mkdir(join(presetDir, "images"), { recursive: true });
  await mkdir(join(presetDir, "html"), { recursive: true });
  await writeFile(join(presetDir, "preset.json"), JSON.stringify(preset));
  if (includeImage) {
    await sharp({
      create: { width: 1280, height: 720, channels: 3, background: "#3478c9" },
    }).webp({ quality: 90 }).toFile(join(presetDir, "images/reference.webp"));
  }
  await writeFile(join(presetDir, "html/reference.html"), referenceHtml);
  return root;
}

describe("visual style preset build validation", () => {
  it("accepts the repository presets", async () => {
    const root = resolve("src/features/templates/presets");
    const result = await validateVisualStylePresets(root);
    const entries = await readdir(root, { withFileTypes: true });
    const expected = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        await access(join(root, entry.name, "preset.json"));
        return 1;
      } catch {
        return 0;
      }
    }));
    assert.equal(result.presetCount, expected.reduce((total, count) => total + count, 0));
  });

  it("accepts a negative decimal score", async () => {
    const root = await createPresetRoot({ ...validPreset, score: -1.5 });
    const result = await validateVisualStylePresets(root);
    assert.equal(result.presetCount, 1);
  });

  it("rejects a missing metadata field", async () => {
    const { theme: _theme, ...preset } = validPreset;
    const root = await createPresetRoot(preset);
    await assert.rejects(() => validateVisualStylePresets(root), /missing required field "theme"/);
  });

  it("rejects a metadata field with the wrong type", async () => {
    const root = await createPresetRoot({ ...validPreset, color: "blue" });
    await assert.rejects(() => validateVisualStylePresets(root), /field "color" must be array/);
  });

  it("accepts custom color labels", async () => {
    const root = await createPresetRoot({ ...validPreset, color: ["cream"] });
    const result = await validateVisualStylePresets(root);
    assert.equal(result.presetCount, 1);
  });

  it("rejects blank or duplicate color labels", async () => {
    const blankRoot = await createPresetRoot({ ...validPreset, color: [" "] });
    await assert.rejects(() => validateVisualStylePresets(blankRoot), /unique non-blank strings/);

    const duplicateRoot = await createPresetRoot({ ...validPreset, color: ["cream", "cream"] });
    await assert.rejects(() => validateVisualStylePresets(duplicateRoot), /unique non-blank strings/);
  });

  it("rejects a non-numeric score", async () => {
    const root = await createPresetRoot({ ...validPreset, score: "90" });
    await assert.rejects(() => validateVisualStylePresets(root), /field "score" must be a finite number/);
  });

  it("ignores numbered directories that have not received preset.json yet", async () => {
    const root = await createPresetRoot(validPreset);
    await mkdir(join(root, "100-pending-template", "images"), { recursive: true });
    const result = await validateVisualStylePresets(root);
    assert.equal(result.presetCount, 1);
  });

  it("accepts a missing optional score", async () => {
    const { score: _score, ...preset } = validPreset;
    const root = await createPresetRoot(preset);
    const result = await validateVisualStylePresets(root);
    assert.equal(result.presetCount, 1);
  });

  it("rejects a missing preview image", async () => {
    const root = await createPresetRoot(validPreset, false);
    await assert.rejects(() => validateVisualStylePresets(root), /path does not exist/);
  });

  it("rejects a preview path that is not WebP", async () => {
    const root = await createPresetRoot({
      ...validPreset,
      preview_images: [{ path: "images/preview.png", alt: "Preview" }],
    });
    await assert.rejects(() => validateVisualStylePresets(root), /must use images\/<filename>\.webp/);
  });

  it("rejects an orphaned WebP and a legacy image", async () => {
    const root = await createPresetRoot(validPreset);
    const imagesDir = join(root, "test-preset", "images");
    await writeFile(join(imagesDir, "legacy.png"), "legacy");
    await assert.rejects(() => validateVisualStylePresets(root), /contains legacy image legacy\.png/);

    await (await import("node:fs/promises")).rm(join(imagesDir, "legacy.png"));
    await sharp({
      create: { width: 1280, height: 720, channels: 3, background: "#102030" },
    }).webp({ quality: 90 }).toFile(join(imagesDir, "orphan.webp"));
    await assert.rejects(() => validateVisualStylePresets(root), /contains an unreferenced WebP orphan\.webp/);
  });

  it("rejects preview and HTML pages that do not use the same filename stem", async () => {
    const root = await createPresetRoot({
      ...validPreset,
      preview_images: [{ path: "images/other.webp", alt: "Preview" }],
    });
    await sharp({
      create: { width: 1280, height: 720, channels: 3, background: "#3478c9" },
    }).webp({ quality: 90 }).toFile(join(root, "test-preset", "images", "other.webp"));
    await assert.rejects(() => validateVisualStylePresets(root), /must match reference_html_pages\[0\]\.path by filename stem/);
  });

  it("reports a missing local HTML resource as a warning", async () => {
    const root = await createPresetRoot(
      validPreset,
      true,
      '<!doctype html><html><body><img src="../assets/missing.png"><div class="slide"></div></body></html>',
    );
    const result = await validateVisualStylePresets(root);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /references a missing local resource/);
  });

  it("rejects a reference page without a .slide root", async () => {
    const root = await createPresetRoot(
      validPreset,
      true,
      '<!doctype html><html><body><div class="slide-container"></div></body></html>',
    );
    await assert.rejects(
      () => validateVisualStylePresets(root),
      /must contain exactly one \.slide root; found 0/,
    );
  });

  it("rejects a reference page with multiple .slide roots", async () => {
    const root = await createPresetRoot(
      validPreset,
      true,
      '<!doctype html><html><body><div class="slide"></div><div class="slide"></div></body></html>',
    );
    await assert.rejects(
      () => validateVisualStylePresets(root),
      /must contain exactly one \.slide root; found 2/,
    );
  });

  it("rejects metadata outside the existing catalog enums", async () => {
    const root = await createPresetRoot({ ...validPreset, industry: "Technology & IT" });
    await assert.rejects(
      () => validateVisualStylePresets(root),
      /field "industry" must use an existing catalog enum value/,
    );
  });

  it("rejects external font stylesheets in semantic color presets", async () => {
    const semanticPreset = {
      ...validPreset,
      theme_mode: "semantic-v1",
      color_variants: [
        {
          id: "base",
          name: "Base",
          swatches: ["#FFFFFF", "#111111"],
          roles: {
            bg: "#FFFFFF",
            surface: "#FFFFFF",
            ink: "#111111",
            muted: "#666666",
            accent_primary: "#2463EB",
            accent_secondary: "#F59E0B",
            accent_tertiary: "#14B8A6",
            line: "#D1D5DB",
          },
        },
        {
          id: "alternate",
          name: "Alternate",
          swatches: ["#101828", "#F8FAFC"],
          roles: {
            bg: "#101828",
            surface: "#1E293B",
            ink: "#F8FAFC",
            muted: "#CBD5E1",
            accent_primary: "#60A5FA",
            accent_secondary: "#FBBF24",
            accent_tertiary: "#2DD4BF",
            line: "#475569",
          },
        },
      ],
    };
    const root = await createPresetRoot(
      semanticPreset,
      true,
      '<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo"></head><body><div class="slide"></div></body></html>',
    );
    await assert.rejects(
      () => validateVisualStylePresets(root),
      /semantic visual style preset must not load a Google Fonts stylesheet directly/,
    );
  });
});
