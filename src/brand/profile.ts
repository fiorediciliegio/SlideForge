/**
 * M4 · 品牌档案：从 PPTX theme XML 确定性提取品牌色/字体（不依赖多模态模型）。
 */
import { createRequire } from "node:module";

const engineRequire = createRequire(
  new URL("../../executas/ppt-engine/package.json", import.meta.url),
);
const JSZip = engineRequire("jszip") as typeof import("jszip");

export interface BrandProfile {
  name: string;
  primary: string;   // 主色（accent1）
  accent: string;    // 强调色（accent2，缺省回退琥珀）
  background: string;
  text: string;
  muted: string;
  fontFamily: string;
  source: "pptx-theme";
}

const FALLBACK = {
  primary: "1e40af",
  accent: "f59e0b",
  background: "f7f8fb",
  text: "182033",
  muted: "697386",
  fontFamily: 'Arial, "Microsoft YaHei", "PingFang SC", sans-serif',
};

function hexOf(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<a:${tag}>\\s*<a:srgbClr val="([0-9a-fA-F]{6})"`));
  return match?.[1]?.toLowerCase() ?? null;
}

export async function extractBrandProfile(pptxBuffer: Buffer, name: string): Promise<BrandProfile> {
  const zip = await JSZip.loadAsync(pptxBuffer);
  const themeEntry = Object.keys(zip.files).find((f) => /ppt\/theme\/theme1\.xml$/.test(f));
  if (!themeEntry) {
    return { name, ...FALLBACK, source: "pptx-theme" };
  }
  const theme = await zip.file(themeEntry)!.async("string");

  const fontMatch = theme.match(/<a:majorFont>\s*<a:latin typeface="([^"]+)"/);
  const minorMatch = theme.match(/<a:minorFont>\s*<a:latin typeface="([^"]+)"/);
  const eaMatch = theme.match(/<a:majorFont>[\s\S]*?<a:ea typeface="([^"]+)"/);
  const latin = fontMatch?.[1] || minorMatch?.[1];
  const ea = eaMatch?.[1];
  const fontFamily = latin || ea
    ? [latin, ea, "Microsoft YaHei", "PingFang SC", "sans-serif"].filter(Boolean).join(", ")
    : FALLBACK.fontFamily;

  return {
    name,
    primary: hexOf(theme, "accent1") ?? FALLBACK.primary,
    accent: hexOf(theme, "accent2") ?? FALLBACK.accent,
    background: hexOf(theme, "lt1") ?? FALLBACK.background,
    text: hexOf(theme, "dk1") ?? FALLBACK.text,
    muted: FALLBACK.muted,
    fontFamily: fontFamily.startsWith(",") ? FALLBACK.fontFamily : fontFamily,
    source: "pptx-theme",
  };
}

/** 把品牌档案翻译成页面提示词的视觉规范段。 */
export function brandVisualSpec(profile: BrandProfile): string {
  return `视觉规范（必须遵守，来自用户品牌模板 ${profile.name}）：
- 背景 #${profile.background}，主色 #${profile.primary}，强调色 #${profile.accent}，正文 #${profile.text}，辅助文字 #${profile.muted}。
- 卡片：白色或主色 5% 浅底圆角（border-radius 20px），轻阴影。
- 标题字号 56~72px，正文 20~26px，行距 1.5；内容区左右留白 80px。
- 字体栈：${profile.fontFamily}。`;
}
