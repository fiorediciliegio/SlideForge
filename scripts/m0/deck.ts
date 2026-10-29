/**
 * M0 · deck.html 组装与 HTML 提取校验。
 * deck 格式与 evals/export/cases 夹具一致（导出管线的既有契约）。
 */

/** 从模型输出提取完整 HTML 文档：剥围栏、截 doctype 到 </html>。 */
export function extractHtmlDocument(text: string): string {
  let cleaned = text.trim();
  // 剥 markdown 围栏
  cleaned = cleaned.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "");
  const start = cleaned.toLowerCase().indexOf("<!doctype html");
  const startAlt = cleaned.toLowerCase().indexOf("<html");
  const begin = start >= 0 ? start : startAlt;
  const end = cleaned.toLowerCase().lastIndexOf("</html>");
  if (begin < 0 || end < 0) {
    throw new Error(`No complete HTML document found (preview: ${cleaned.slice(0, 120)})`);
  }
  return cleaned.slice(begin, end + "</html>".length);
}

/** 校验并拆出 deck 所需部件：style 块 + body 内唯一 <main class="slide">。 */
export function splitSlideDocument(html: string): { styles: string; body: string } {
  if (!/<main[^>]*class="slide"/.test(html)) {
    throw new Error('Missing <main class="slide"> root');
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) throw new Error("Missing <body>");
  const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)]
    .map((m) => m[0])
    .join("\n");
  return { styles, body: bodyMatch[1].trim() };
}

export function buildDeckHtml(input: {
  title: string;
  slides: Array<{ styles: string; body: string }>;
}): string {
  const baseCss = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 1920px; min-height: 1080px; background: #f7f8fb; }
body { font-family: Arial, "Microsoft YaHei", "PingFang SC", sans-serif; color: #182033; }
#presentation-slides-wrapper { width: 1920px; margin: 0; padding: 0; display: block; }
#presentation-slides-wrapper > [data-presenton-slide-shell="true"] {
  position: relative; display: block; visibility: visible; width: 1920px; height: 1080px;
  min-width: 1920px; min-height: 1080px; overflow: hidden; margin: 0; padding: 0;
}
.slide { position: relative; width: 1920px; height: 1080px; overflow: hidden; }`;

  const shells = input.slides
    .map((slide, i) => {
      const pageId = `page-${i + 1}`;
      return `<div data-presenton-slide-shell="true" data-presenton-page-id="${pageId}" data-layout="${pageId}" data-presenton-page-current="${i + 1}" data-presenton-page-total="${input.slides.length}">${slide.body}</div>`;
    })
    .join("\n");

  return `<!doctype html><html lang="zh-CN" data-presenton-render-document="static"><head><meta charset="utf-8"/><meta name="viewport" content="width=1920, initial-scale=1"/><title>${input.title}</title><style>${baseCss}</style>
${input.slides.map((s) => s.styles).join("\n")}
</head><body><div id="presentation-slides-wrapper" data-presenton-render-status="ready">
${shells}
</div></body></html>`;
}
