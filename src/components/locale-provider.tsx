import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { copy, type Locale } from "@/lib/i18n";

const KEY = "luopian.lang";

type LocaleValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

const LocaleContext = createContext<LocaleValue>({
  locale: "zh",
  setLocale: () => undefined,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("zh");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored === "en" || stored === "zh") setLocale(stored);
    } catch {
      // The default locale still works when storage is unavailable.
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hans";
    document.title = copy(locale).title;
    try {
      localStorage.setItem(KEY, locale);
    } catch {
      // A storage error should not affect the current language.
    }
  }, [locale, ready]);

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- Hook shares the provider's context.
export function useLocale() {
  return useContext(LocaleContext);
}
