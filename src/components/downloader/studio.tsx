import { ArrowDownToLine, Clipboard, Download, Film, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { normalizeYouTubeUrl } from "../../../shared/youtube.mjs";
import { useLocale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { EngineInfo, JobView } from "@/lib/downloader/types";
import { copy, type Locale } from "@/lib/i18n";
import { isActive, useDownloads } from "./use-downloads";

const QUALITIES = ["best", "hd1080"] as const;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function responseJob(response: Response, fallback: string): Promise<JobView> {
  if (response.ok) return response.json();
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(data?.error || fallback);
}

function DownloadRow({
  job,
  locale,
  canceling,
  onCancel,
  onRefill,
}: {
  job: JobView;
  locale: Locale;
  canceling: boolean;
  onCancel: () => void;
  onRefill: () => void;
}) {
  const text = copy(locale);
  const active = isActive(job);
  const videoId = new URL(job.url).searchParams.get("v") ?? "";
  const stats = [
    job.percent == null ? null : `${Math.floor(job.percent)}%`,
    job.speed,
    job.eta && text.eta(job.eta),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="min-w-0 border-t border-line px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-sm bg-subtle text-muted">
          <Film className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-sm font-medium" title={job.filename ?? job.url}>
            {job.filename ?? text.videoId(videoId)}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            <span
              className={cn(
                job.status === "done" && "text-accent",
                job.status === "error" && "text-danger",
              )}
            >
              {text.status[job.status]}
            </span>
            {" · "}
            {text[job.quality]}
            {job.bytes != null && ` · ${formatBytes(job.bytes)}`}
          </p>
        </div>
        {job.status === "done" && job.filename && (
          <Button asChild variant="quiet" size="sm">
            <a href={`/api/jobs/${job.id}/file?lang=${locale}`} download={job.filename}>
              <ArrowDownToLine className="size-4" aria-hidden />
              {text.save}
            </a>
          </Button>
        )}
        {active && (
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={canceling || job.status === "canceling"}
            onClick={onCancel}
          >
            {text.cancel}
          </Button>
        )}
        {(job.status === "error" || job.status === "canceled") && (
          <Button type="button" variant="quiet" size="sm" onClick={onRefill}>
            {text.refill}
          </Button>
        )}
      </div>
      {active && (
        <div className="mt-3">
          <div
            className="h-1 overflow-hidden rounded-full bg-subtle"
            role="progressbar"
            aria-label={text.status[job.status]}
            aria-valuenow={job.percent ?? undefined}
          >
            <div
              className={cn("h-full bg-accent", job.percent == null && "indet-bar")}
              style={job.percent != null ? { width: `${job.percent}%` } : undefined}
            />
          </div>
          {stats && <p className="mt-1.5 text-right text-xs tabular-nums text-muted">{stats}</p>}
        </div>
      )}
      {job.status === "error" && job.error && (
        <p className="mt-3 break-words text-sm text-danger">{job.error}</p>
      )}
    </li>
  );
}

export function Studio() {
  const { locale, setLocale } = useLocale();
  const text = copy(locale);
  const [url, setUrl] = useState("");
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>("best");
  const [engine, setEngine] = useState<EngineInfo | "checking" | "unavailable">("checking");
  const [engineRevision, setEngineRevision] = useState(0);
  const [pending, setPending] = useState<"start" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const { jobs, connection, refresh } = useDownloads(locale);
  const active = jobs.some(isActive);
  const toolsReady = typeof engine === "object" && engine.ytdlp && engine.ffmpeg;
  const canStart = !active && !pending && toolsReady && connection === "ready";
  const missing =
    typeof engine === "object"
      ? [engine.ytdlp ? null : "yt-dlp", engine.ffmpeg ? null : "ffmpeg"]
          .filter(Boolean)
          .join(" / ")
      : "";

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    void fetch("/api/engine", { cache: "no-store", signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const next: EngineInfo = await response.json();
        if (!controller.signal.aborted) setEngine(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEngine("unavailable");
      });
    return () => controller.abort();
  }, [engineRevision]);

  function changeUrl(value: string) {
    setUrl(value);
    setError(null);
  }

  async function paste() {
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (!value) throw new Error();
      changeUrl(value);
    } catch {
      setError(text.pasteFailed);
    }
    input.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStart || mutation.current) return;
    const normalized = normalizeYouTubeUrl(url);
    if (!normalized) {
      setError(text.badLink);
      input.current?.focus();
      return;
    }
    mutation.current = true;
    setPending("start");
    setError(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: normalized, quality, lang: locale }),
        signal: AbortSignal.timeout(12000),
      });
      refresh(await responseJob(response, text.cantStart));
      setUrl((current) => (normalizeYouTubeUrl(current) === normalized ? "" : current));
    } catch (cause) {
      setError(cause instanceof Error && cause.name === "Error" ? cause.message : text.cantStart);
      refresh();
    } finally {
      mutation.current = false;
      setPending(null);
    }
  }

  async function cancel(id: string) {
    if (mutation.current) return;
    mutation.current = true;
    setPending("cancel");
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${id}?lang=${locale}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(8000),
      });
      refresh(await responseJob(response, text.cantCancel));
    } catch {
      setError(text.cantCancel);
      refresh();
    } finally {
      mutation.current = false;
      setPending(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-[46rem] px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between gap-4 border-b border-line py-5">
        <div className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="grid size-8 place-items-center rounded-sm bg-accent text-accent-fg">
            <Download className="size-4" aria-hidden />
          </span>
          {text.title}
        </div>
        <div
          className="flex rounded-sm border border-line p-0.5"
          role="group"
          aria-label={text.language}
        >
          {(["zh", "en"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={locale === value}
              className={cn(
                "min-h-9 min-w-10 rounded-[0.35rem] px-2 text-xs focus-visible:outline-2 focus-visible:outline-accent",
                locale === value ? "bg-subtle text-fg" : "text-muted",
              )}
              onClick={() => setLocale(value)}
            >
              {value === "zh" ? "中文" : "EN"}
            </button>
          ))}
        </div>
      </header>

      <section className="mt-8 sm:mt-13" aria-labelledby="download-heading">
        <h1
          id="download-heading"
          className="mb-5 text-[clamp(1.8rem,5vw,2.75rem)] leading-tight font-semibold tracking-tight sm:mb-7"
        >
          {text.heading}
        </h1>
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="rounded-lg border border-line bg-elev p-4 sm:p-6"
        >
          <label htmlFor="video-url" className="text-sm font-medium">
            {text.link}
          </label>
          <div className="mt-2 flex gap-2">
            <input
              ref={input}
              id="video-url"
              value={url}
              onChange={(event) => changeUrl(event.target.value)}
              inputMode="url"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://www.youtube.com/watch?v=…"
              className="h-12 min-w-0 flex-1 rounded-sm border border-line-strong bg-bg px-3 text-base placeholder:text-faint focus:border-accent focus:outline-none sm:text-sm"
            />
            <Button
              type="button"
              variant="quiet"
              className="h-12 px-3"
              onClick={() => void paste()}
            >
              <Clipboard className="size-4" aria-hidden />
              {text.paste}
            </Button>
          </div>

          <fieldset className="mt-5">
            <legend className="text-sm font-medium">{text.quality}</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {QUALITIES.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-2 rounded-sm border px-3 py-2 text-sm",
                    quality === value
                      ? "border-accent/70 bg-accent/8 text-fg"
                      : "border-line bg-bg text-muted hover:border-line-strong",
                  )}
                >
                  <input
                    type="radio"
                    name="quality"
                    value={value}
                    checked={quality === value}
                    onChange={() => setQuality(value)}
                    className="size-4 shrink-0 accent-accent"
                  />
                  {text[value]}
                </label>
              ))}
            </div>
          </fieldset>

          {error && (
            <p role="alert" className="mt-4 break-words text-sm text-danger">
              {error}
            </p>
          )}
          {active && <p className="mt-4 text-sm text-muted">{text.oneAtATime}</p>}
          <Button type="submit" disabled={!canStart} className="mt-5 h-12 w-full">
            {pending === "start" ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <Download className="size-4" aria-hidden />
            )}
            {pending === "start" ? text.starting : text.start}
          </Button>
        </form>

        <div className="mt-2 flex min-h-10 flex-wrap items-center justify-between gap-x-3 text-xs text-muted">
          <p className="flex items-center gap-2" aria-label={text.dependencies} role="status">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                toolsReady ? "bg-accent" : engine === "checking" ? "bg-muted" : "bg-danger",
              )}
              aria-hidden
            />
            {toolsReady
              ? text.toolsReady
              : engine === "checking"
                ? text.checking
                : missing
                  ? text.toolsMissing(missing)
                  : text.toolsUnavailable}
          </p>
          {!toolsReady && engine !== "checking" && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEngine("checking");
                setEngineRevision((value) => value + 1);
              }}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {text.checkAgain}
            </Button>
          )}
        </div>
      </section>

      <section
        className="mt-5 overflow-hidden rounded-lg border border-line bg-elev"
        aria-labelledby="jobs-heading"
      >
        <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <h2 id="jobs-heading" className="text-base font-semibold">
            {text.jobs}
          </h2>
          {jobs.length > 0 && (
            <span className="text-xs text-muted">{text.jobCount(jobs.length)}</span>
          )}
        </header>
        {connection === "offline" && (
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 sm:px-6">
            <p className="text-sm text-danger" role="status">
              {text.offline}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => refresh()}>
              {text.recheckJobs}
            </Button>
          </div>
        )}
        {jobs.length > 0 ? (
          <ul>
            {jobs.map((job) => (
              <DownloadRow
                key={job.id}
                job={job}
                locale={locale}
                canceling={pending === "cancel"}
                onCancel={() => void cancel(job.id)}
                onRefill={() => {
                  changeUrl(job.url);
                  setQuality(job.quality);
                  input.current?.focus();
                }}
              />
            ))}
          </ul>
        ) : (
          connection !== "offline" && (
            <div className="flex items-center gap-3 border-t border-line px-4 py-6 text-sm text-muted sm:px-6">
              <Film className="size-4 shrink-0" aria-hidden />
              <p>{connection === "loading" ? text.loading : text.empty}</p>
            </div>
          )
        )}
        {jobs.some((job) => job.status === "done") && (
          <p className="border-t border-line px-4 py-3 text-xs text-muted sm:px-6">
            {text.saveHint}
          </p>
        )}
      </section>
    </main>
  );
}
