import { useEffect, useMemo, useState } from "react";
import { DEFAULT_LOCALE, isLocale, locales, type Locale } from "./locales";
import { messages } from "./messages";

const STORAGE_KEY = "ppt-app-locale";

function readInitialLocale(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isLocale(stored) ? stored : DEFAULT_LOCALE;
}

export function useI18n() {
  const [locale, setLocaleState] = useState<Locale>(() => readInitialLocale());

  function setLocale(nextLocale: Locale) {
    localStorage.setItem(STORAGE_KEY, nextLocale);
    setLocaleState(nextLocale);
  }

  // <html lang> 跟随界面语言（无障碍发音 / 断词 / 浏览器翻译提示）
  useEffect(() => {
    document.documentElement.lang = locales[locale].intl;
  }, [locale]);

  return useMemo(
    () => ({
      locale,
      setLocale,
      t: messages[locale]
    }),
    [locale]
  );
}
