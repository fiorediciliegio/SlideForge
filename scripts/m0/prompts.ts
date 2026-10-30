/**
 * M0 · 提示词（四段式骨架：角色/输入/约束/输出格式）。
 * M0 为极简变体：无模板、无母版、无附件；视觉规范固定。
 * 与 src/ai 完整体系的统一留给 M1。
 */

export function buildOutlineMessages(brief: string, pageCount: number) {
  return [
    {
      role: "system" as const,
      content: `你是 PPT 大纲规划器。只输出 JSON，不要输出任何其他文字。
约束：
1. 只能使用用户输入中明确提供的信息，不得编造数字、日期、人物、机构、数据；没有依据的内容标记"待补充"。
2. 语言与用户输入一致。`,
    },
    {
      role: "user" as const,
      content: `【输入】用户需求：${brief}
【任务】规划一份 ${pageCount} 页的演示文稿大纲。第 1 页为封面，最后 1 页为总结或致谢。
【输出格式】严格输出如下 JSON（不要代码围栏）：
{"title":"演示标题","pages":[{"title":"页面标题","bullets":["要点1","要点2","要点3"]}]}
pages 数组必须恰好 ${pageCount} 项，每页 bullets 3~5 条，每条不超过 40 字。`,
    },
  ];
}

const VISUAL_SPEC = `视觉规范（必须遵守）：
- 浅色商务风：背景 #f7f8fb，主色 #1e40af（深蓝），强调色 #f59e0b（琥珀），正文 #182033，辅助文字 #697386。
- 卡片：白色圆角（border-radius 20px），轻阴影。
- 标题字号 56~72px，正文 20~26px，行距 1.5；内容区左右留白 80px。
- 中文字体栈：Arial, "Microsoft YaHei", "PingFang SC", sans-serif。`;

export function buildPageMessages(input: {
  deckTitle: string;
  brief: string;
  outlineJson: string;
  pageIndex: number; // 0-based
  pageCount: number;
  pageTitle: string;
  bullets: string[];
  visualSpec?: string;
  referenceHtml?: string;
}) {
  return [
    {
      role: "system" as const,
      content: `你是 HTML 演示页面生成器，只负责当前一页。
【事实边界，优先级最高】
1. 只能使用输入中明确提供的信息，不得编造数字、日期、人物、机构、来源。
2. 没有依据的事实性内容应省略或标记"待补充"。
3. 输出前静默复核一次。
【输出约束】
- 只输出一个完整 HTML 文档，不要 Markdown 代码块、解释或其他文字。
- 文档结构严格为：<!doctype html><html><head><meta charset="utf-8"/><style>…</style></head><body><main class="slide">…</main></body></html>
- body 中只能有一个 <main class="slide"> 根容器，尺寸固定 1920×1080（width/height 都写死，overflow:hidden）。
- 全部 CSS 内联在 <style> 中，禁止引用外部资源、外部图片 URL、外部字体。`,
    },
    {
      role: "user" as const,
      content: `【整套演示】${input.deckTitle}
【原始需求】${input.brief}
【完整大纲】${input.outlineJson}
【当前任务】生成第 ${input.pageIndex + 1} 页（共 ${input.pageCount} 页）：标题「${input.pageTitle}」
【本页要点】${input.bullets.map((b) => `- ${b}`).join("\n")}
【页码标注】右下角显示 "${input.pageIndex + 1} / ${input.pageCount}"。
${input.pageIndex === 0 ? "【封面页】主标题 + 副标题 + 日期占位，视觉突出，不要堆砌要点。" : ""}
${input.visualSpec ?? VISUAL_SPEC}
${input.referenceHtml ? `【风格参照】以下参考页 HTML 仅供学习视觉风格（配色/字体/布局/卡片语言），禁止复制其中的文字内容：\n${input.referenceHtml}` : ""}
【输出】只输出完整 HTML 文档。`,
    },
  ];
}
