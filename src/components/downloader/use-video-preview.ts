import { useEffect, useRef, useState } from "react";

import type { VideoPreview } from "@/lib/downloader/probe.server";
import type { Locale } from "@/lib/i18n";

export function useVideoPreview(locale: Locale) {
  const [result, setResult] = useState<{ requestUrl: string; details: VideoPreview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  function reset() {
    request.current?.abort();
    request.current = null;
    setResult(null);
    setLoading(false);
    setFailed(false);
  }

  async function load(url: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, lang: locale }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error(String(response.status));
      const details: VideoPreview = await response.json();
      if (!controller.signal.aborted) setResult({ requestUrl: url, details });
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setLoading(false);
      }
    }
  }

  return { result, loading, failed, load, reset };
}
