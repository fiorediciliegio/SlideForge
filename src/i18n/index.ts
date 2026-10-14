import type { Locale } from "./locales";
import type { Messages } from "./types";
import { en } from "./en";
import { zh } from "./zh-CN";
import { ja } from "./ja-JP";
import { de } from "./de-DE";

export type { Locale };
export type { Messages };

export const messages: Record<Locale, Messages> = { en, zh, ja, de };

export function formatMessage(
  template: string,
  values: Record<string, string | number>
) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, String(value)),
    template
  );
}


/**
 * 由 Messages 对象实例反查 Locale（messages 是 Record<Locale, Messages> 单例）。
 * 用途：只拿到 t 的展示层（如 buildResearchDiscoveryStageRecords）需要 locale
 * 来翻译诊断错误码，避免逐层 prop drilling。
 */
export function localeFromMessages(t: Messages): Locale {
  for (const [locale, value] of Object.entries(messages)) {
    if (value === t) return locale as Locale;
  }
  return "en";
}
