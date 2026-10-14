import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../src");

// Headless preview/render paths used to skip managed-font injection, so
// screenshots silently fell back to system fonts while the editor (which
// injects @font-face at serve/save time) rendered correctly. Keep the guard
// focused on the render-plan injection; current previews use HTML-derived
// WebP thumbnails rather than persistent manual-save screenshots.
describe("managed fonts in headless renders", () => {
  it("injects managed font css into manifest render plans", async () => {
    const plan = await readFile(join(SRC, "render/manifest-render-plan.ts"), "utf8");
    assert.match(plan, /import \{ injectWorkspaceManagedFontCss \} from "\.\.\/font-library\/index\.js"/);
    // Best-effort wrapper: export flows may point cwd at a directory without
    // a font library, which must not fail a render that used to succeed.
    assert.match(plan, /async function withManagedFontCssBestEffort\(/);
    assert.match(plan, /await injectWorkspaceManagedFontCss\(workspaceDir, html, \{ injectInto: "head" \}\)/);
    assert.match(plan, /html: await withManagedFontCssBestEffort\(\s*input\.cwd,/);
  });
});
