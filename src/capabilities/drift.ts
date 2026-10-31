/**
 * M4 · 偏离度报告：重生成前后页面 HTML 的确定性 diff。
 * 文本增删 + 样式声明变化（颜色/字号/字体等），全部由代码计算，不经模型。
 */

export interface StyleChange {
  selector: string;
  property: string;
  from?: string;
  to?: string;
}

export interface PageDrift {
  textAdded: string[];
  textRemoved: string[];
  styleChanges: StyleChange[];
  summary: {
    textAddedCount: number;
    textRemovedCount: number;
    styleChangeCount: number;
  };
}

function extractTextLines(html: string): string[] {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function extractStyleRules(html: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  for (const match of html.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    const declarations = match[2];
    const props = new Map<string, string>();
    for (const decl of declarations.split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 1) continue;
      const prop = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim().replace(/\s+/g, " ");
      if (prop) props.set(prop, value);
    }
    if (props.size > 0) rules.set(selector, props);
  }
  return rules;
}

const LIMIT = 20;

function extractInlineStyles(html: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  let index = 0;
  for (const match of html.matchAll(/<(\w+)([^>]*?)style="([^"]+)"/g)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const className = (attrs.match(/class="([^"]+)"/)?.[1] ?? "").split(" ")[0];
    // 每个元素独立键，避免无 class 元素互相覆盖导致改动漏报
    const key = `${tag}.${className}#${index++}`;
    const props = new Map<string, string>();
    for (const decl of match[3].split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 1) continue;
      const prop = decl.slice(0, idx).trim();
      const value = decl.slice(idx + 1).trim().replace(/\s+/g, " ");
      if (prop) props.set(prop, value);
    }
    if (props.size > 0) result.set(key, props);
  }
  return result;
}

export function computePageDrift(oldHtml: string, newHtml: string): PageDrift {
  const oldText = new Set(extractTextLines(oldHtml));
  const newText = new Set(extractTextLines(newHtml));
  const textAdded = [...newText].filter((line) => !oldText.has(line)).slice(0, LIMIT);
  const textRemoved = [...oldText].filter((line) => !newText.has(line)).slice(0, LIMIT);

  const oldRules = extractStyleRules(oldHtml);
  const newRules = extractStyleRules(newHtml);
  const styleChanges: StyleChange[] = [];

  for (const [selector, props] of newRules) {
    const oldProps = oldRules.get(selector);
    if (!oldProps) continue; // 新增选择器不计（结构变化已在文本 diff 体现）
    for (const [prop, value] of props) {
      const oldValue = oldProps.get(prop);
      if (oldValue !== undefined && oldValue !== value) {
        styleChanges.push({ selector, property: prop, from: oldValue, to: value });
      }
    }
  }

  // 内联样式（拖拽/手动编辑直接改 style 属性）也纳入审计
  const oldInline = extractInlineStyles(oldHtml);
  const newInline = extractInlineStyles(newHtml);
  for (const [key, props] of newInline) {
    const oldProps = oldInline.get(key);
    if (!oldProps) continue;
    for (const [prop, value] of props) {
      const oldValue = oldProps.get(prop);
      if (oldValue !== undefined && oldValue !== value) {
        styleChanges.push({ selector: `${key}[inline]`, property: prop, from: oldValue, to: value });
      }
    }
  }

  return {
    textAdded,
    textRemoved,
    styleChanges: styleChanges.slice(0, LIMIT),
    summary: {
      textAddedCount: textAdded.length,
      textRemovedCount: textRemoved.length,
      styleChangeCount: styleChanges.length,
    },
  };
}
