import { useEffect, useRef, useState } from "react";

import type { JobView } from "@/lib/downloader/types";
import type { Locale } from "@/lib/i18n";

export function isActive(job: JobView) {
  return job.status === "running" || job.status === "canceling";
}

export function useDownloads(locale: Locale) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [connection, setConnection] = useState<"loading" | "ready" | "offline">("loading");
  const [revision, setRevision] = useState(0);
  const currentPoll = useRef<AbortController | null>(null);

  useEffect(() => {
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;

    async function poll() {
      const controller = new AbortController();
      currentPoll.current = controller;
      const signal = AbortSignal.any([
        lifetime.signal,
        controller.signal,
        AbortSignal.timeout(8000),
      ]);
      let delay = retryDelay;
      try {
        const response = await fetch(`/api/jobs?lang=${locale}`, { cache: "no-store", signal });
        if (!response.ok) throw new Error(String(response.status));
        const next: JobView[] = await response.json();
        if (signal.aborted) return;
        setJobs(next);
        setConnection("ready");
        retryDelay = 1000;
        delay = next.some(isActive) ? 950 : 4000;
      } catch {
        if (lifetime.signal.aborted || controller.signal.aborted) return;
        setConnection("offline");
        retryDelay = Math.min(retryDelay * 2, 8000);
      } finally {
        if (currentPoll.current === controller) currentPoll.current = null;
      }
      if (!lifetime.signal.aborted && !controller.signal.aborted) {
        timer = setTimeout(() => void poll(), delay);
      }
    }

    void poll();
    return () => {
      clearTimeout(timer);
      lifetime.abort();
    };
  }, [locale, revision]);

  function refresh(job?: JobView) {
    currentPoll.current?.abort();
    if (job) {
      setJobs((current) =>
        [job, ...current.filter((entry) => entry.id !== job.id)].sort(
          (first, second) => second.startedAt - first.startedAt,
        ),
      );
    }
    setRevision((value) => value + 1);
  }

  return { jobs, connection, refresh };
}
