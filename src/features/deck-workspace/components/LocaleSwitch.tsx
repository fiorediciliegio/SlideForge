import { useEffect, useRef } from "react";
import { localeIds, locales, type Locale } from "../../../i18n/locales";
import type { Messages } from "../../../i18n/messages";

interface LocaleSwitchProps {
  t: Messages;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/**
 * Globe dropdown language switcher (leader-provided design, 2026-09-23).
 * Trigger shows the current language label; the menu lists every registered
 * locale with a check mark on the active one. Locale data comes from the
 * registry in i18n/locales.ts — never hardcode a locale here.
 */
export function LocaleSwitch({ t, locale, setLocale }: LocaleSwitchProps) {
  const rootRef = useRef<HTMLDetailsElement>(null);

  // <details> has no built-in "close on outside click" or Escape handling.
  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root?.open && event.target instanceof Node && !root.contains(event.target)) {
        root.open = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (event.key === "Escape" && root?.open) {
        root.open = false;
        root.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const select = (id: Locale) => {
    setLocale(id);
    if (rootRef.current) rootRef.current.open = false;
  };

  return (
    <details ref={rootRef} className="lang-switch">
      <summary aria-label={t.languageSwitcher.chooseLanguage} aria-haspopup="listbox">
        <svg
          className="lang-switch-globe"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18"></path>
        </svg>
        <span className="lang-switch-current">{locales[locale].label}</span>
        <svg
          className="lang-switch-chevron"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m5 7.5 5 5 5-5"></path>
        </svg>
      </summary>

      <ul className="lang-switch-menu" role="listbox" aria-label={t.languageSwitcher.languageOptions}>
        {localeIds.map((id) => (
          <li key={id}>
            <button
              type="button"
              role="option"
              aria-selected={locale === id}
              data-performance-id={`locale.select-${id}`}
              lang={locales[id].intl}
              onClick={() => select(id)}
            >
              <span className="lang-switch-name">{locales[id].label}</span>
              <span className="lang-switch-check" aria-hidden="true">
                ✓
              </span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
