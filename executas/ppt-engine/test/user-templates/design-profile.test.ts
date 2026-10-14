import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUserTemplate, getUserTemplate, getUserTemplateAsset, publishUserTemplate, saveUserTemplateHtml, saveUserTemplateProfile, selectUserTemplatePages, validateDesignProfile } from "../../src/user-templates/index.ts";
import type { DesignProfile } from "../../src/user-templates/types.ts";
import { rasterizePptxToImages } from "../../src/pptx-rasterization/index.ts";

const validProfile: DesignProfile = {
  colors: [
    { token: "primary", hex: "#1b4f9c", role: "主色 Primary", usage: "cover title, chart series", source: "page 2" },
    { token: "accent", hex: "#F2A900", role: "强调色 Accent" },
  ],
  typography: { heading_font: "Microsoft YaHei", body_font: "Arial", fallback_fonts: ["PingFang SC", "sans-serif"] },
  layout_rules: ["Page numbers use the NN / MM format", "Cover and closing pages carry no header/footer chrome"],
  fixed_assets: [{ kind: "logo", label: "starlan-mark", position_rule: "top-right on content pages, centered on cover" }],
  voice: "confident, plain-spoken",
  do: ["Reuse the accent color for small marks only"],
  dont: ["Never redraw the logo"],
  evidence: { "colors.primary": "#1B4F9C -> #2E7D32 (2026-09-22, user request)" },
};

test("validateDesignProfile enforces schema bounds", () => {
  assert.throws(() => validateDesignProfile(null), /object/);
  assert.throws(() => validateDesignProfile({ colors: [] }), /between 1 and 6/);
  assert.throws(() => validateDesignProfile({ colors: Array.from({ length: 7 }, (_, i) => ({ token: `c${i}`, hex: "#112233", role: "r" })) }), /between 1 and 6/);
  assert.throws(() => validateDesignProfile({ colors: [{ token: "primary", hex: "1B4F9C", role: "主色" }] }), /hex/);
  assert.throws(() => validateDesignProfile({ colors: [{ token: "primary", hex: "#1B4F9C" }] }), /role/);
  assert.throws(() => validateDesignProfile({ colors: [{ token: "a", hex: "#111111", role: "x" }, { token: "a", hex: "#222222", role: "y" }] }), /unique/);
  assert.throws(() => validateDesignProfile({ colors: [{ token: "a", hex: "#111111", role: "x" }], fixed_assets: [{ kind: "mascot" }] }), /logo/);
  const normalized = validateDesignProfile(validProfile);
  assert.equal(normalized.colors[0].hex, "#1B4F9C", "hex values are normalized to uppercase");
});

test("saveUserTemplateProfile persists, hydrates and locks after publish", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "design-profile-test-"));
  const previousRoot = process.env.SLIDEFORGE_WORKSPACE_DIR;
  process.env.SLIDEFORGE_WORKSPACE_DIR = temporary;
  try {
    const source = path.join(temporary, "source.pptx");
    await writeFile(source, "PKsource");
    const record = await createUserTemplate({ filename: "source.pptx", staging_file_path: source, size_bytes: 8 });
    assert.equal((await getUserTemplate(record.id)).profile_ready, false, "no profile before extraction");

    const saved = await saveUserTemplateProfile(record.id, validProfile);
    assert.equal(saved.profile_ready, true);
    assert.equal(saved.profile?.colors.length, 2);
    assert.equal(saved.profile?.fixed_assets?.[0].kind, "logo");

    const asset = await getUserTemplateAsset(record.id, "profile");
    assert.equal(asset.filename, "profile.json");
    assert.match(asset.mime_type, /json/);
    const onDisk = JSON.parse(await readFile(asset.file_path, "utf8"));
    assert.equal(onDisk.colors[0].hex, "#1B4F9C");

    await assert.rejects(saveUserTemplateProfile(record.id, { colors: [{ token: "bad", hex: "#12345", role: "x" }] }), /hex/);
    await assert.rejects(saveUserTemplateProfile("user-00000000-0000-0000-0000-000000000000", validProfile), /Invalid|ENOENT|Unknown user template/);

    // Publish path stays intact while a profile is attached.
    await selectUserTemplatePages(record.id, [1], (input) => rasterizePptxToImages(input, {
      loadPptxSvgSlides: async () => [{ page_number: 1, svg: "<svg/>" }],
      convertSvgToPng: async ({ outputPath }) => { await writeFile(outputPath, "image"); return { width: 1920, height: 1080 }; },
    }));
    const html = "<!doctype html><html><body><div class='slide'>{{PAGE_TITLE}}{{PAGE_CONTENT}}</div></body></html>";
    const staging = path.join(temporary, "template.html");
    await writeFile(staging, html);
    const render = async (_html: string, file: string, image: string) => { await writeFile(image, "image"); };
    await saveUserTemplateHtml({ id: record.id, staging_file_path: staging }, render);
    await saveUserTemplateHtml({ id: record.id, page_number: 1, staging_file_path: staging }, render);
    const published = await publishUserTemplate(record.id, { name: "Branded", description: "Profile-backed template.", pages: [{ page_number: 1, description: "A balanced content page." }] });
    assert.equal(published.status, "ready");
    assert.equal(published.profile_ready, true, "profile survives publication");
    await assert.rejects(saveUserTemplateProfile(record.id, validProfile), /immutable/);
  } finally {
    if (previousRoot === undefined) delete process.env.SLIDEFORGE_WORKSPACE_DIR;
    else process.env.SLIDEFORGE_WORKSPACE_DIR = previousRoot;
    await rm(temporary, { recursive: true, force: true });
  }
});
