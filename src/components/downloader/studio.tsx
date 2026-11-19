import { Clipboard, Download, Film, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  extractDownloadUrls,
  extractVideoUrls,
  MAX_BATCH_URLS,
  MAX_SHARE_TEXT,
  normalizeVideoUrl,
  OUTPUTS,
  type Output,
} from "../../../shared/video.mjs";
import { useLocale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { EngineInfo, JobView } from "@/lib/downloader/types";
import { copy } from "@/lib/i18n";
import { DownloadRow } from "./download-row";
import { isActive, useDownloads } from "./use-downloads";
import { useVideoPreview } from "./use-video-preview";
import { VideoPreviewCard } from "./video-preview";

const QUALITIES = ["best", "hd1080"] as const;
type JobAction = "cancel" | "retry";

async function responseJson<Result>(response: Response, fallback: string): Promise<Result> {
  if (response.ok) return response.json();
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(data?.error || fallback);
}

function RadioChoices<Option extends string>({
  name,
  legend,
  options,
  selected,
  onSelect,
  optionLabel,
}: {
  name: string;
  legend: string;
  options: readonly Option[];
  selected: Option;
  onSelect: (value: Option) => void;
  optionLabel: (value: Option) => string;
}) {
  return (
    <fieldset className="mt-5">
      <legend className="text-sm font-medium">{legend}</legend>
      <div
        className={cn(
          "mt-2 grid gap-2",
          options.length === 3 ? "grid-cols-1 min-[380px]:grid-cols-3" : "grid-cols-2",
        )}
      >
        {options.map((value) => (
          <label
            key={value}
            className={cn(
              "flex min-h-11 cursor-pointer items-center gap-2 rounded-sm border px-2 py-2 text-sm sm:px-3",
              selected === value
                ? "border-accent/70 bg-accent/8 text-fg"
                : "border-line bg-bg text-muted hover:border-line-strong",
            )}
          >
            <input
              type="radio"
              name={name}
              value={value}
              checked={selected === value}
              onChange={() => onSelect(value)}
              className="size-4 shrink-0 accent-accent"
            />
            {optionLabel(value)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Studio() {
  const { locale, setLocale } = useLocale();
  const text = copy(locale);
  const [source, setSource] = useState("");
  const [previewTarget, setPreviewTarget] = useState("");
  const [partUrls, setPartUrls] = useState<Record<string, string>>({});
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>("best");
  const [output, setOutput] = useState<Output>("mp4");
  const [accelerate, setAccelerate] = useState(false);
  const [engine, setEngine] = useState<EngineInfo | "checking" | "unavailable">("checking");
  const [engineRevision, setEngineRevision] = useState(0);
  const [pending, setPending] = useState<{ action: "start" | JobAction; id?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<{ id: string; message: string } | null>(null);
  const mutation = useRef(false);
  const editRevision = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const { jobs, connection, refresh } = useDownloads(locale);
  const activeAttempts = new Set(jobs.filter(isActive).map((job) => job.retryOf ?? job.id));
  const preview = useVideoPreview(locale);
  const filesEnabled = typeof engine === "object" && engine.files;
  const aria2Available = typeof engine === "object" && engine.aria2;
  const shareTooLong = source.length > MAX_SHARE_TEXT;
  const links = useMemo(() => extractDownloadUrls(source, filesEnabled), [source, filesEnabled]);
  const sourceError = shareTooLong
    ? text.shareTooLong
    : links.length > MAX_BATCH_URLS
      ? text.tooManyLinks(MAX_BATCH_URLS)
      : null;
  const queueUrls = [...new Set(links.map((link) => partUrls[link] ?? link))];
  const videoLinks = links.filter((link) => normalizeVideoUrl(link) !== null);
  const hasFiles = videoLinks.length !== links.length;
  const needsVideo = !hasFiles || videoLinks.length > 0;
  const previewSource = previewTarget || videoLinks[0];
  const previewUrl = previewSource ? (partUrls[previewSource] ?? previewSource) : null;
  const currentPreview = preview.result?.requestUrl === previewUrl;
  const selectedPart = previewUrl
    ? Number(new URL(previewUrl).searchParams.get("p")) ||
      preview.result?.details.selectedPart ||
      null
    : null;
  const videoReady = typeof engine === "object" && engine.ytdlp && engine.ffmpeg;
  const fileReady = typeof engine === "object" && engine.curl;
  const toolsReady = (!needsVideo || videoReady) && (!hasFiles || fileReady);
  const canQueue = !pending && connection === "ready";
  const canStart = canQueue && toolsReady && !sourceError;
  const canPreview = Boolean(
    previewUrl && !sourceError && typeof engine === "object" && engine.ytdlp,
  );
  const missing =
    typeof engine === "object"
      ? [
          needsVideo && !engine.ytdlp ? "yt-dlp" : null,
          needsVideo && !engine.ffmpeg ? "ffmpeg" : null,
          hasFiles && !engine.curl ? "curl" : null,
        ]
          .filter(Boolean)
          .join(" / ")
      : "";

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    void fetch(engineRevision ? "/api/engine?refresh=1" : "/api/engine", {
      cache: "no-store",
      signal,
    })
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

  function changeSource(value: string) {
    editRevision.current += 1;
    setSource(value);
    setPreviewTarget("");
    setPartUrls((current) => {
      const nextLinks = extractVideoUrls(value);
      return Object.fromEntries(
        nextLinks.flatMap((link) => (current[link] ? [[link, current[link]]] : [])),
      );
    });
    preview.reset();
    setError(null);
  }

  function changePart(part: number) {
    if (!preview.result || !previewSource) return;
    const selected = new URL(preview.result.details.url);
    selected.searchParams.set("p", String(part));
    const canonical = normalizeVideoUrl(selected.href);
    if (!canonical) return;
    editRevision.current += 1;
    setPartUrls((current) => ({ ...current, [previewSource]: canonical }));
    void preview.load(canonical);
  }

  async function paste() {
    const previousRevision = editRevision.current;
    try {
      const value = (await navigator.clipboard.readText()).trim();
      if (editRevision.current !== previousRevision) return;
      if (!value) throw new Error();
      changeSource(value);
    } catch {
      if (editRevision.current === previousRevision) setError(text.pasteFailed);
    }
    input.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStart || mutation.current) return;
    if (!queueUrls.length) {
      setError(filesEnabled ? text.badFileLink : text.badLink);
      input.current?.focus();
      return;
    }
    const submittedRevision = editRevision.current;
    mutation.current = true;
    setPending({ action: "start" });
    setError(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          urls: queueUrls,
          output,
          quality: output === "mp3" ? undefined : quality,
          accelerate: hasFiles && aria2Available && accelerate,
          lang: locale,
        }),
        signal: AbortSignal.timeout(12000),
      });
      refresh(await responseJson<JobView[]>(response, text.cantStart));
      if (editRevision.current === submittedRevision) changeSource("");
    } catch (cause) {
      setError(cause instanceof Error && cause.name === "Error" ? cause.message : text.cantStart);
      refresh();
    } finally {
      mutation.current = false;
      setPending(null);
    }
  }

  async function updateJob(id: string, action: JobAction) {
    if (mutation.current) return;
    const retrying = action === "retry";
    const fallback = retrying ? text.cantRetry : text.cantCancel;
    mutation.current = true;
    setPending({ action, id });
    setJobError(null);
    try {
      const response = await fetch(
        `/api/jobs/${id}?lang=${locale}`,
        retrying
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ lang: locale }),
              signal: AbortSignal.timeout(12000),
            }
          : { method: "DELETE", signal: AbortSignal.timeout(8000) },
      );
      refresh([await responseJson<JobView>(response, fallback)]);
    } catch (cause) {
      const message = cause instanceof Error && cause.name === "Error" ? cause.message : fallback;
      setJobError({ id, message });
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
          {filesEnabled ? text.fileHeading : text.heading}
        </h1>
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          className="rounded-lg border border-line bg-elev p-4 sm:p-6"
        >
          <label htmlFor="video-url" className="text-sm font-medium">
            {filesEnabled ? text.fileLink : text.link}
          </label>
          <p id="video-url-help" className="mt-1 text-xs text-muted">
            {text.linkHelp}
          </p>
          <div className="mt-2 flex gap-2">
            <textarea
              ref={input}
              id="video-url"
              aria-describedby={sourceError ? "video-url-help video-url-error" : "video-url-help"}
              aria-invalid={Boolean(sourceError)}
              value={source}
              onChange={(event) => changeSource(event.target.value)}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              rows={3}
              placeholder="https://…"
              className="max-h-[min(12rem,35vh)] min-h-20 min-w-0 flex-1 resize-y overflow-y-auto rounded-sm border border-line-strong bg-bg px-3 py-2.5 text-base placeholder:text-faint focus:border-accent focus:outline-none sm:text-sm"
            />
            <Button
              type="button"
              variant="quiet"
              className="h-11 px-3"
              onClick={() => void paste()}
            >
              <Clipboard className="size-4" aria-hidden />
              {text.paste}
            </Button>
          </div>
          {sourceError && (
            <p id="video-url-error" role="alert" className="mt-2 text-xs text-danger">
              {sourceError}
            </p>
          )}
          {!sourceError && links.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p role="status" className="text-xs text-muted">
                {text.linksFound(queueUrls.length)}
              </p>
              {videoLinks.length > 0 && (
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                  {videoLinks.length > 1 && (
                    <select
                      aria-label={text.previewLink}
                      value={previewSource}
                      onChange={(event) => {
                        setPreviewTarget(event.target.value);
                        preview.reset();
                      }}
                      className="max-w-full min-w-0 rounded-sm border border-line-strong bg-bg px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
                    >
                      {videoLinks.map((link) => (
                        <option key={link} value={link}>
                          {partUrls[link] ?? link}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    disabled={!canPreview || preview.loading}
                    onClick={() => {
                      if (previewUrl) void preview.load(previewUrl);
                    }}
                  >
                    {preview.loading ? (
                      <LoaderCircle aria-hidden className="size-4 animate-spin" />
                    ) : (
                      <Search aria-hidden className="size-4" />
                    )}
                    {preview.loading ? text.previewing : text.preview}
                  </Button>
                </div>
              )}
            </div>
          )}
          {preview.result && (
            <VideoPreviewCard
              preview={preview.result.details}
              locale={locale}
              part={selectedPart}
              showDetails={currentPreview}
              onPartChange={changePart}
            />
          )}
          {preview.failed && (
            <p role="status" className="mt-2 text-xs text-muted">
              {text.cantPreview}
            </p>
          )}

          {needsVideo && (
            <RadioChoices
              name="output"
              legend={text.output}
              options={OUTPUTS}
              selected={output}
              onSelect={setOutput}
              optionLabel={(value) => text.outputs[value]}
            />
          )}
          {needsVideo && output !== "mp3" && (
            <RadioChoices
              name="quality"
              legend={text.quality}
              options={QUALITIES}
              selected={quality}
              onSelect={setQuality}
              optionLabel={(value) => text[value]}
            />
          )}
          {hasFiles && (
            <div className="mt-5">
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={aria2Available && accelerate}
                  disabled={!aria2Available}
                  onChange={(event) => setAccelerate(event.target.checked)}
                  className="size-4 accent-accent"
                />
                {text.accelerate}
              </label>
              {!aria2Available && <p className="text-xs text-muted">{text.aria2Missing}</p>}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 break-words text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" disabled={!canStart} className="mt-5 h-12 w-full">
            {pending?.action === "start" ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <Download className="size-4" aria-hidden />
            )}
            {pending?.action === "start" ? text.starting : text.start}
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
          {(!toolsReady || (hasFiles && !aria2Available)) && engine !== "checking" && (
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
                busy={pending !== null}
                retrying={pending?.action === "retry" && pending.id === job.id}
                canRetry={
                  canQueue &&
                  !activeAttempts.has(job.retryOf ?? job.id) &&
                  (job.file ? fileReady : videoReady)
                }
                error={jobError?.id === job.id ? jobError.message : undefined}
                onCancel={() => void updateJob(job.id, "cancel")}
                onRetry={() => void updateJob(job.id, "retry")}
                onRefill={() => {
                  changeSource(job.url);
                  if (job.file) setAccelerate(job.file === "aria2");
                  else {
                    setOutput(job.output ?? "mp4");
                    if (job.output !== "mp3") setQuality(job.quality);
                  }
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
