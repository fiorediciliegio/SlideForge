/**
 * 语言注册表：全仓唯一的语言清单。
 *
 * 语言切换器、localStorage 校验、Intl 区域格式、<html lang> 均从这里派生。
 * 新增语言 = 这里加一行 + 新增对应语言包文件。
 * 依据：《系统语言v1-技术方案与排期》§4.1
 */
export const locales = {
  en: { label: "English", short: "EN", intl: "en-US" },
  zh: { label: "中文", short: "中", intl: "zh-CN" },
  ja: { label: "日本語", short: "日", intl: "ja-JP" },
  de: { label: "Deutsch", short: "DE", intl: "de-DE" },
} as const;

/** Locale 类型由注册表推导，不单独维护 */
export type Locale = keyof typeof locales;

export const localeIds = Object.keys(locales) as Locale[];

export const DEFAULT_LOCALE: Locale = "en";

/** localStorage 等外部值的白名单校验 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && value in locales;
}

/**
 * 四语取值：替代"中文/否则英文"式二元判断（v1.3 清零手段）。
 * 用于非 React 层（workflow/runner）拿不到 t 的场景；Record<Locale, T>
 * 由编译期强制四语齐全，加语言时 tsc 直接报缺口。
 */
export function pickLocale<T>(locale: Locale, values: Record<Locale, T>): T {
  return values[locale];
}
