import { useEffect, useRef, useState } from "react";

import type { JobView } from "@/lib/downloader/types";
import type { Locale } from "@/lib/i18n";

export function isActive(job: JobView) {
  return job.status === "queued" || job.status === "running" || job.status === "canceling";
}

function orderJobs(jobs: JobView[]) {
  function rank(job: JobView) {
    if (job.status === "running" || job.status === "canceling") return 0;
    return job.status === "queued" ? 1 : 2;
  }
  return jobs.sort((first, second) => {
    const firstRank = rank(first);
    const difference = firstRank - rank(second);
    return difference || (firstRank === 2 ? second.startedAt - first.startedAt : 0);
  });
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
        setJobs(orderJobs(next));
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

  function refresh(updates: JobView[] = []) {
    currentPoll.current?.abort();
    if (updates.length) {
      setJobs((current) => {
        const byId = new Map(current.map((job) => [job.id, job]));
        for (const job of updates) byId.set(job.id, job);
        return orderJobs([...byId.values()]);
      });
    }
    setRevision((value) => value + 1);
  }

  return { jobs, connection, refresh };
}
