import { useEffect, useState } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

import { copy, type Locale } from "@/lib/i18n";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

export function AppErrorComponent({ error }: ErrorComponentProps) {
  const [locale, setLocale] = useState<Locale>("zh");
  useEffect(() => {
    const stored = localStorage.getItem("luopian.lang");
    if (stored === "en" || stored === "zh") setLocale(stored);
  }, []);
  const phrases = copy(locale);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg">
      <span className="text-danger" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={1.75} />
      </span>
      <h1 className="text-lg font-medium">{phrases.pageBroke}</h1>
      <p className="max-w-md text-sm break-words text-muted">{errorMessage(error, phrases.pageRetry)}</p>
    </main>
  );
}
