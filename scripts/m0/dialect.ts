/**
 * D2 · SlideForge-HTML 方言静态校验（不渲染，纯结构检查）。
 * 与 ADR-0072 契约对应：结构锚点 + 外部资源禁令 + 不可映射 CSS 禁令。
 * 错误 = 拒收重生成；警告 = 放行但记录。
 */

export interface DialectIssue {
  rule: string;
  detail: string;
}

export interface DialectResult {
  ok: boolean;
  errors: DialectIssue[];
  warnings: DialectIssue[];
}

export function validateHtmlDialect(html: string): DialectResult {
  const errors: DialectIssue[] = [];
  const warnings: DialectIssue[] = [];

  // ── 结构锚点 ──
  const slideCount = (html.match(/<main[^>]*class="[^"]*slide/g) ?? []).length;
  if (slideCount !== 1) {
    errors.push({ rule: "structure.single-slide", detail: `应有且仅有 1 个 main.slide，实际 ${slideCount} 个` });
  }
  if (!/<!doctype html>/i.test(html)) {
    warnings.push({ rule: "structure.doctype", detail: "缺少 <!doctype html>" });
  }

  // ── 外部资源禁令（自包含要求）──
  if (/<script\b/i.test(html)) {
    errors.push({ rule: "resource.no-script", detail: "禁止 <script>（静态导出无需 JS）" });
  }
  if (/<link\b[^>]*rel=["']?stylesheet/i.test(html)) {
    errors.push({ rule: "resource.no-external-css", detail: "禁止外链样式表，CSS 必须内联 <style>" });
  }
  if (/@import\b/i.test(html)) {
    errors.push({ rule: "resource.no-import", detail: "禁止 @import" });
  }
  for (const match of html.matchAll(/<(?:img|source)[^>]*src=["'](https?:\/\/[^"']+)/gi)) {
    errors.push({ rule: "resource.no-remote-media", detail: `禁止远程图片：${match[1].slice(0, 80)}` });
  }
  for (const match of html.matchAll(/url\(\s*["']?(https?:\/\/[^)"']+)/gi)) {
    errors.push({ rule: "resource.no-remote-css-url", detail: `禁止 CSS 远程资源：${match[1].slice(0, 80)}` });
  }
  if (/<iframe\b/i.test(html)) {
    errors.push({ rule: "resource.no-iframe", detail: "禁止 <iframe>" });
  }

  // ── 不可映射 CSS 禁令（OOXML 无对应物）──
  const cssChecks: Array<{ rule: string; pattern: RegExp; label: string }> = [
    { rule: "css.no-fixed", pattern: /position\s*:\s*fixed/i, label: "position:fixed（导出为静态页面）" },
    { rule: "css.no-backdrop-filter", pattern: /backdrop-filter\s*:/i, label: "backdrop-filter" },
    { rule: "css.no-blend-mode", pattern: /mix-blend-mode\s*:/i, label: "mix-blend-mode" },
    { rule: "css.no-filter", pattern: /(?<!backdrop-)filter\s*:/i, label: "filter" },
    { rule: "css.no-animation", pattern: /(?:animation|transition)\s*:/i, label: "animation/transition（静态导出）" },
  ];
  for (const check of cssChecks) {
    const hit = html.match(check.pattern);
    if (hit) errors.push({ rule: check.rule, detail: `禁止 ${check.label}` });
  }

  // ── 画布尺寸提示（渲染闸门兜底精确测量）──
  if (!/1920/.test(html) || !/1080/.test(html)) {
    warnings.push({ rule: "canvas.explicit-size", detail: "未检测到 1920×1080 尺寸声明，依赖渲染闸门复核" });
  }

  return { ok: errors.length === 0, errors, warnings };
}
