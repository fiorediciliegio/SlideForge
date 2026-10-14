import { slideFormat, stampSlideFormat, type SlideAspectRatio } from "../slide-format.js";
import { getBrowserRenderRuntimeBundle } from "./runtime-bundle.js";
import type { BrowserRenderContext } from "./types.js";

function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function createPageSourceRenderContext(input: {
  id: string;
  aspect_ratio?: SlideAspectRatio;
  title: string;
  templateGroup?: string;
  pageNumber?: number;
  totalPages?: number;
}): BrowserRenderContext {
  return {
    aspect_ratio: input.aspect_ratio,
    templateGroup: input.templateGroup ?? "authoring-kit",
    layoutId: input.id,
    runtimeLayoutId: input.id,
    slideData: {},
    speakerNote: "",
    title: input.title,
    theme: {
      logoUrl: null,
      companyName: null,
      colors: {},
      variables: {},
      fontName: null,
      fontUrl: null,
    },
    pageNumber: input.pageNumber,
    totalPages: input.totalPages,
  };
}

export function buildPageSourceDocumentHtml(input: {
  context: BrowserRenderContext;
  runtimeBundle?: string | null;
  tailwindRuntimeBundle: string;
}): string {
  const runtimeBundle = input.runtimeBundle ?? getBrowserRenderRuntimeBundle();
  const serializedContext = escapeJsonForInlineScript(input.context);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=1920, initial-scale=1" />',
    `  <title>${input.context.title}</title>`,
    "  <style>",
    "    html, body { margin: 0; padding: 0; width: 1920px; min-height: 1080px; overflow: hidden; background: #ffffff; }",
    "    body { position: relative; font-family: system-ui, sans-serif; }",
    "    #presentation-slides-wrapper { width: 1920px; min-height: 1080px; }",
    '    [data-presenton-render-status="error"] { display: flex; align-items: center; justify-content: center; color: #991b1b; background: #fef2f2; font-size: 14px; padding: 24px; box-sizing: border-box; }',
    "  </style>",
    '  <script data-presenton-runtime="tailwind">',
    input.tailwindRuntimeBundle,
    "  </script>",
    "</head>",
    "<body>",
    '  <div id="presentation-slides-wrapper" data-presenton-render-status="loading"></div>',
    "  <script>",
    `    window.__PRESENTON_RENDER_CONTEXT__ = ${serializedContext};`,
    "  </script>",
    "  <script>",
    runtimeBundle,
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function injectBeforeClosingTag(html: string, tagName: "head" | "body", content: string): string {
  const pattern = new RegExp(`</${tagName}\\s*>`, "i");
  if (pattern.test(html)) return html.replace(pattern, `${content}\n</${tagName}>`);
  if (tagName === "head") return html.replace(/<html([^>]*)>/i, `<html$1><head>${content}</head>`);
  return `${html}\n${content}`;
}

/**
 * Adds only the engine-owned render shell and readiness contract around a
 * complete Agent-authored HTML document. The source document remains the
 * authority; this derived document is what managed Chrome executes once.
 */
export function buildHtmlPageSourceDocumentHtml(input: {
  sourceHtml: string;
  context: BrowserRenderContext;
}): string {
  if (/data-presenton-slide-shell\s*=\s*["']true["']/i.test(input.sourceHtml)
    && !/<(?:script|iframe|object|embed)\b/i.test(input.sourceHtml)) {
    return stampSlideFormat(input.sourceHtml, input.context.aspect_ratio);
  }
  const { width, height } = slideFormat(input.context.aspect_ratio);
  const serializedContext = escapeJsonForInlineScript(input.context);
  const engineStyle = [
    '<style data-presenton-runtime="html-page-shell">',
    `html,body{margin:0!important;padding:0!important;width:${width}px!important;height:${height}px!important;overflow:hidden!important;background:#fff;}`,
    `#presentation-slides-wrapper{position:relative!important;display:block!important;visibility:visible!important;width:${width}px!important;height:${height}px!important;min-width:${width}px!important;min-height:${height}px!important;margin:0!important;padding:0!important;overflow:hidden!important;box-sizing:border-box!important;}`,
    `#presentation-slides-wrapper>[data-presenton-slide-shell="true"]{position:relative!important;display:block!important;visibility:visible!important;width:${width}px!important;height:${height}px!important;min-width:${width}px!important;min-height:${height}px!important;margin:0!important;padding:0!important;overflow:hidden!important;box-sizing:border-box!important;}`,
    "</style>",
  ].join("\n");
  const bootstrap = [
    '<script data-presenton-runtime="html-page-shell">',
    `window.__PRESENTON_RENDER_CONTEXT__=${serializedContext};`,
    "(()=>{try{",
    'const slides=Array.from(document.querySelectorAll(".slide"));',
    'if(slides.length!==1)throw new Error(`HTML Page Source must contain exactly one .slide root; found ${slides.length}`);',
    "const slide=slides[0];",
    'slide.setAttribute("data-presenton-authored-slide","true");',
    'const shell=document.createElement("div");',
    'shell.setAttribute("data-presenton-slide-shell","true");',
    `shell.setAttribute("data-presenton-page-id",${JSON.stringify(input.context.layoutId)});`,
    `shell.setAttribute("data-layout",${JSON.stringify(input.context.layoutId)});`,
    `shell.setAttribute("data-presenton-page-current",${JSON.stringify(String(input.context.pageNumber ?? ""))});`,
    `shell.setAttribute("data-presenton-page-total",${JSON.stringify(String(input.context.totalPages ?? ""))});`,
    'slide.querySelectorAll("[data-presenton-page-number]").forEach((element)=>{const kind=element.getAttribute("data-presenton-page-number");const raw=kind==="current"?window.__PRESENTON_RENDER_CONTEXT__.pageNumber:kind==="total"?window.__PRESENTON_RENDER_CONTEXT__.totalPages:null;if(!Number.isInteger(raw)||raw<1)throw new Error(`Invalid data-presenton-page-number marker: ${kind||"missing"}`);const pad=Number(element.getAttribute("data-presenton-page-number-pad")||"0");element.textContent=String(raw).padStart(Number.isInteger(pad)&&pad>0?pad:0,"0");});',
    'shell.append(slide);',
    'const wrapper=document.createElement("div");',
    'wrapper.id="presentation-slides-wrapper";',
    'wrapper.setAttribute("data-presenton-render-status","loading");',
    'wrapper.append(shell);',
    "document.body.replaceChildren(wrapper);",
    'wrapper.setAttribute("data-presenton-render-status","ready");',
    'window.dispatchEvent(new CustomEvent("presenton:render-ready"));',
    `}catch(error){const message=error instanceof Error?error.message:String(error);const fallback=document.createElement("div");fallback.id="presentation-slides-wrapper";fallback.setAttribute("data-presenton-render-status","error");fallback.setAttribute("data-presenton-render-message",message);fallback.style.cssText="width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:center;padding:48px;box-sizing:border-box;background:#fef2f2;color:#991b1b;font:24px/1.4 system-ui,sans-serif";fallback.textContent=message;document.body.replaceChildren(fallback);}})();`,
    "</script>",
  ].join("\n");

  let html = input.sourceHtml.trim();
  html = injectBeforeClosingTag(html, "head", engineStyle);
  html = injectBeforeClosingTag(html, "body", bootstrap);
  return stampSlideFormat(html, input.context.aspect_ratio);
}
