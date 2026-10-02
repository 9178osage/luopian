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
    const stored = localStorage.getItem(KEY);
    if (stored === "en" || stored === "zh") setLocale(stored);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.lang = locale === "en" ? "en" : "zh-Hans";
    document.title = copy(locale).title;
    localStorage.setItem(KEY, locale);
  }, [locale, ready]);

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}
