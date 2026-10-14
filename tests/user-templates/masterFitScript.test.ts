import assert from "node:assert/strict";
import test from "node:test";
import { withFitScript } from "../../src/features/user-templates/MasterPreviewPanel";

const SLIDE_HTML = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=1920, height=1080\"></head><body><div class=\"slide\" style=\"width:1920px;height:1080px\"></div></body></html>";

test("withFitScript injects the scale-to-fit script before </html>", () => {
  const out = withFitScript(SLIDE_HTML);
  assert.match(out, /querySelector\('\.slide'\)/);
  assert.match(out, /Math\.min\(innerWidth\/d\[0\],innerHeight\/d\[1\]\)/);
  assert.ok(out.indexOf("</scr" + "ipt>") < out.toLowerCase().indexOf("</html>"));
  // The design size falls back to the meta viewport when no .slide exists.
  const noSlide = withFitScript("<html><head><meta name=\"viewport\" content=\"width=1280, height=720\"></head><body></body></html>");
  assert.match(noSlide, /meta\[name="viewport"\]/);
});

test("withFitScript appends the script when </html> is missing", () => {
  const out = withFitScript("<div>partial</div>");
  assert.match(out, /scale-to-fit|querySelector\('\.slide'\)/);
});
