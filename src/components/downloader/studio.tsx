import {
  AudioLines,
  Bookmark,
  Captions,
  Check,
  Clapperboard,
  ClipboardPaste,
  Copy,
  Image,
  Images,
  LayoutGrid,
  List,
  ListVideo,
  Loader2,
  MonitorPlay,
  Music,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/cn";
import { copy } from "@/lib/i18n";
import {
  PRESETS,
  clampImageEnd,
  clampPlaylistEnd,
  imageHost,
  inferImagePreset,
  isImagePreset,
  presetText,
  previewCommand,
  showsImageCap,
  validateUrl,
  type PresetId,
} from "@/lib/downloader/presets";
import type { EngineInfo, JobView, ProbeFormat, ProbeResult } from "@/lib/downloader/types";

const RECENT_KEY = "luopian.recent";

type Recent = { url: string; title: string; preset: PresetId };

const ICONS: Record<PresetId, LucideIcon> = {
  best: Clapperboard,
  mp3: Music,
  audio: AudioLines,
  hd1080: MonitorPlay,
  playlist: ListVideo,
  subs: Captions,
  thumb: Image,
  tweet: Images,
  media: LayoutGrid,
  artwork: Image,
  illustrations: LayoutGrid,
  author: User,
  bookmarks: Bookmark,
  ranking: List,
};

function pickUrl(raw: string): string {
  const text = raw.trim();
  const match = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (!match) return text;
  return match[0].replace(/[),.;，。]+$/u, "");
}

function allowsFormat(preset: PresetId) {
  return preset === "best" || preset === "hd1080" || preset === "subs" || preset === "playlist";
}

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatLabel(row: ProbeFormat, audio: string, video: string): string {
  if (row.audioOnly) return `${audio} · ${row.note || row.ext}`;
  const height = row.height ? `${row.height}p` : row.note || video;
  const fps = row.fps ? ` · ${Math.round(row.fps)}fps` : "";
  return `${height}${fps} · ${row.ext}`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return data?.error || fallback;
}

export function Studio() {
  const { locale, setLocale } = useLocale();
  const phrases = copy(locale);
  const [url, setUrl] = useState("");
  const [preset, setPreset] = useState<PresetId>("best");
  const [playlistEnd, setPlaylistEnd] = useState<number | null>(null);
  const [imageEnd, setImageEnd] = useState<number | null>(null);
  // The limit field still defaults to 40. That value means unlimited until the user edits it.
  const [cookies, setCookies] = useState("");
  const [pixivToken, setPixivToken] = useState("");
  const [formatId, setFormatId] = useState<string | null>(null);
  const [videoOnly, setVideoOnly] = useState(false);
  const [formatsOpen, setFormatsOpen] = useState(false);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeState, setProbeState] = useState<"idle" | "loading" | "error">("idle");
  const [probeError, setProbeError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [authOpen, setAuthOpen] = useState(false);
  const probeTicket = useRef(0);
  const localeRef = useRef(locale);
  const jobPanel = useRef<HTMLElement>(null);
  localeRef.current = locale;

  const command = useMemo(
    () =>
      previewCommand(
        url,
        {
          preset,
          playlistEnd: isImagePreset(preset)
            ? imageEnd != null
              ? clampImageEnd(imageEnd)
              : null
            : playlistEnd,
          formatId: allowsFormat(preset) ? formatId : null,
          videoOnly,
          withCookies: cookies.trim().length > 0,
        },
        locale,
      ),
    [cookies, formatId, imageEnd, locale, playlistEnd, preset, url, videoOnly],
  );

  useEffect(() => {
    void fetch("/api/engine")
      .then((response) => response.json())
      .then((data: EngineInfo) => setEngine(data))
      .catch(() =>
        setEngine({ ytdlp: false, ffmpeg: false, gallerydl: false, version: null, galleryVersion: null }),
      );
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Recent[];
      if (Array.isArray(stored)) setRecent(stored.slice(0, 6));
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    const ticket = ++probeTicket.current;
    setProbe(null);
    setFormatId(null);
    setVideoOnly(false);
    const trimmed = url.trim();
    if (!trimmed) {
      setProbeState("idle");
      setProbeError(null);
      return;
    }
    try {
      validateUrl(trimmed);
    } catch {
      setProbeState("idle");
      setProbeError(null);
      return;
    }
    setProbeState("loading");
    setProbeError(null);
    const lang = localeRef.current;
    const phrasesNow = copy(lang);
    const timer = setTimeout(() => {
      void fetch("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trimmed, lang }),
      })
        .then(async (response) => {
          if (ticket !== probeTicket.current) return;
          if (!response.ok) throw new Error(await readError(response, phrasesNow.requestFailed));
          const data = (await response.json()) as ProbeResult;
          setProbe(data);
          setProbeState("idle");
        })
        .catch((error: unknown) => {
          if (ticket !== probeTicket.current) return;
          setProbeState("error");
          setProbeError(error instanceof Error ? error.message : phrasesNow.videoInfo);
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [url]);

  useEffect(() => {
    if (!isImagePreset(preset)) return;
    try {
      validateUrl(url);
    } catch {
      return;
    }
    if (imageHost(url)) setAuthOpen(true);
  }, [preset, url]);

  const activeJobId = job?.status === "running" ? job.id : null;

  useEffect(() => {
    if (!activeJobId) return;
    const timer = setInterval(() => {
      void fetch(`/api/jobs/${activeJobId}?lang=${locale}`)
        .then(async (response) => {
          if (!response.ok) return;
          setJob((await response.json()) as JobView);
        })
        .catch(() => undefined);
    }, 800);
    return () => clearInterval(timer);
  }, [activeJobId, locale]);

  useEffect(() => {
    if (!job || (job.status !== "running" && job.status !== "done")) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    jobPanel.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [job?.id, job?.status]);

  function forget(target: string) {
    const list = recent.filter((item) => item.url !== target);
    setRecent(list);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }

  function remember(next: Recent) {
    const list = [next, ...recent.filter((item) => item.url !== next.url)].slice(0, 6);
    setRecent(list);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }

  function applyUrl(raw: string) {
    setUrl(raw);
    setSubmitError(null);
    const inferred = inferImagePreset(raw);
    if (inferred) setPreset(inferred);
    else if (raw.trim()) {
      try {
        validateUrl(raw);
        setPreset((current) => (isImagePreset(current) ? "best" : current));
      } catch {
        /* still typing */
      }
    }
    setJob((current) =>
      current && current.status !== "done" && current.status !== "running" ? null : current,
    );
  }

  async function pasteLink() {
    try {
      const picked = pickUrl(await navigator.clipboard.readText());
      if (!picked) {
        setSubmitError(phrases.pasteFailed);
        return;
      }
      applyUrl(picked);
    } catch {
      setSubmitError(phrases.pasteFailed);
    }
  }

  async function startDownload() {
    setSubmitError(null);
    try {
      validateUrl(url, locale);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : phrases.badLink);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          preset,
          playlistEnd: isImagePreset(preset)
            ? imageEnd != null
              ? clampImageEnd(imageEnd)
              : null
            : preset === "playlist" && playlistEnd != null
              ? clampPlaylistEnd(playlistEnd)
              : null,
          formatId: allowsFormat(preset) ? formatId : null,
          videoOnly,
          cookies,
          pixivToken,
          title: probe?.title,
          lang: locale,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, phrases.requestFailed));
      const next = (await response.json()) as JobView;
      setJob(next);
      remember({ url: url.trim(), title: probe?.title || url.trim(), preset });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : phrases.cantStart);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    const response = await fetch(`/api/jobs/${job.id}?lang=${locale}`, { method: "DELETE" });
    if (response.ok) setJob((await response.json()) as JobView);
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const engineLabel = !engine
    ? phrases.checking
    : [
        engine.ytdlp ? `yt-dlp ${engine.version ?? ""}`.trim() : null,
        engine.gallerydl ? `gallery-dl ${engine.galleryVersion ?? ""}`.trim() : null,
        engine.ffmpeg ? "ffmpeg" : null,
      ]
        .filter(Boolean)
        .join(" · ") || phrases.enginesDown;
  const duration = formatDuration(probe?.duration ?? null);
  const running = job?.status === "running";
  const lane = isImagePreset(preset) ? "image" : "video";
  const showCap = preset === "playlist" || showsImageCap(preset, url);

  function setLane(next: "video" | "image") {
    if (next === lane) return;
    if (next === "image") setPreset(inferImagePreset(url) ?? "tweet");
    else setPreset("best");
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-xs tracking-widest text-faint">LUOPIAN</p>
          <h1 className="mt-1 text-3xl font-medium tracking-tight">{phrases.title}</h1>
          <p className="mt-2 max-w-xl text-sm text-muted">{phrases.tagline}</p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex h-11 rounded-sm border border-line p-1" role="group" aria-label={phrases.language}>
            {(
              [
                ["zh", "中文"],
                ["en", "EN"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={locale === id}
                onClick={() => setLocale(id)}
                className={cn(
                  "h-9 min-w-11 rounded-sm px-3 text-sm font-medium",
                  locale === id ? "bg-subtle text-fg" : "text-muted",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="font-mono text-xs text-faint">{engineLabel}</p>
        </div>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-12">
        <section className="min-w-0 rounded-xl border border-line bg-elev p-5 lg:col-span-7">
          <label className="block text-sm font-medium" htmlFor="video-url">
            {phrases.link}
          </label>
          <div className="mt-2 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                id="video-url"
                value={url}
                onChange={(event) => applyUrl(event.target.value)}
                onPaste={(event) => {
                  const picked = pickUrl(event.clipboardData.getData("text"));
                  if (!picked || picked === event.clipboardData.getData("text").trim()) return;
                  event.preventDefault();
                  applyUrl(picked);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void startDownload();
                }}
                placeholder="https://"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={cn(
                  "h-11 w-full rounded-sm border border-line bg-bg px-3 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/40",
                  url ? "pr-12" : "",
                )}
              />
              {url ? (
                <button
                  type="button"
                  aria-label={phrases.clear}
                  onClick={() => applyUrl("")}
                  className="absolute top-0 right-0 flex size-11 items-center justify-center text-faint"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
            <Button type="button" variant="quiet" onClick={() => void pasteLink()}>
              <ClipboardPaste className="size-4" />
              {phrases.paste}
            </Button>
          </div>

          <div className="mt-3 flex items-start gap-3">
            <p className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-muted">{command}</p>
            <Button type="button" variant="quiet" size="sm" onClick={() => void copyCommand()}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? phrases.copied : phrases.copy}
            </Button>
          </div>

          <fieldset className="mt-6 border-t border-line pt-4">
            <legend className="text-sm font-medium">{phrases.spec}</legend>
            <div className="mt-3 flex gap-2" role="tablist" aria-label={phrases.downloadType}>
              {(
                [
                  ["video", phrases.video],
                  ["image", phrases.images],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={lane === id}
                  onClick={() => setLane(id)}
                  className={cn(
                    "h-11 rounded-sm border px-4 text-sm font-medium",
                    lane === id ? "border-line-strong bg-subtle text-fg" : "border-line text-muted",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid gap-2">
              {PRESETS.filter((item) => isImagePreset(item.id) === (lane === "image")).map((item) => {
                const Icon = ICONS[item.id];
                const text = presetText(locale, item.id);
                const selected = preset === item.id;
                return (
                  <label
                    key={item.id}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm border px-3 py-2",
                      selected
                        ? "border-line-strong bg-subtle text-fg"
                        : "border-transparent text-muted hover:bg-subtle hover:text-fg",
                    )}
                  >
                    <input
                      type="radio"
                      name="preset"
                      value={item.id}
                      checked={selected}
                      onChange={() => setPreset(item.id)}
                      className="sr-only"
                    />
                    <Icon
                      className={cn("size-4 shrink-0", selected ? "text-fg" : "text-faint")}
                      aria-hidden="true"
                    />
                    <span className="w-32 shrink-0 text-sm font-medium text-fg">{text.label}</span>
                    <span className="min-w-0 text-sm text-muted">{text.detail}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {showCap ? (
            <label className="mt-4 flex items-center justify-between gap-3 text-sm">
              <span>{phrases.limit}</span>
              <input
                type="number"
                min={1}
                max={lane === "image" ? 200 : 20}
                placeholder={locale === "en" ? "all" : "全部"}
                value={lane === "image" ? (imageEnd ?? "") : (playlistEnd ?? "")}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  if (lane === "image") {
                    // Empty = every post (no --post-range), same as the CLI
                    if (raw === "") {
                      setImageEnd(null);
                      return;
                    }
                    const next = Number(raw);
                    if (!Number.isFinite(next)) return;
                    setImageEnd(next);
                    return;
                  }
                  // Empty = full playlist (no --playlist-end)
                  if (raw === "") {
                    setPlaylistEnd(null);
                    return;
                  }
                  const next = Number(raw);
                  if (!Number.isFinite(next)) return;
                  setPlaylistEnd(next);
                }}
                onBlur={() => {
                  if (lane === "image") setImageEnd((value) => (value == null ? null : clampImageEnd(value)));
                  else setPlaylistEnd((value) => (value == null ? null : clampPlaylistEnd(value)));
                }}
                className="h-11 w-20 rounded-sm border border-line bg-bg px-3 text-right font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </label>
          ) : null}

          {probe?.formats.length ? (
            <div className="mt-4 border-t border-line pt-4">
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-between text-sm font-medium"
                onClick={() => setFormatsOpen((open) => !open)}
                aria-expanded={formatsOpen}
              >
                {phrases.allFormats}
                <span className="text-xs font-normal text-faint">{phrases.count(probe.formats.length)}</span>
              </button>
              {formatsOpen ? (
                <div className="mt-2 grid max-h-72 gap-1 overflow-y-auto">
                  {probe.formats.map((row) => {
                    const selected = formatId === row.id;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          if (selected) {
                            setFormatId(null);
                            setVideoOnly(false);
                            return;
                          }
                          setFormatId(row.id);
                          setVideoOnly(row.videoOnly);
                        }}
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-sm px-2 text-left",
                          selected ? "bg-subtle" : "hover:bg-subtle",
                        )}
                      >
                        <span className="w-16 shrink-0 font-mono text-xs text-muted">{row.id}</span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {formatLabel(row, phrases.audio, phrases.video)}
                        </span>
                        <span className="shrink-0 text-xs text-faint">{formatBytes(row.filesize)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {formatId && allowsFormat(preset) ? (
                <p className="mt-2 text-xs text-muted">{phrases.formatPicked(formatId)}</p>
              ) : null}
            </div>
          ) : null}

          <details
            className="mt-4 border-t border-line pt-2"
            open={authOpen}
            onToggle={(event) => setAuthOpen(event.currentTarget.open)}
          >
            <summary className="flex min-h-11 items-center justify-between text-sm font-medium">
              {phrases.cookie}
              <span className="text-xs font-normal text-faint">
                {cookies.trim() || pixivToken.trim() ? phrases.filled : phrases.cookieHint}
              </span>
            </summary>
            <p className="text-sm text-muted">{lane === "image" ? phrases.cookieImage : phrases.cookieVideo}</p>
            <textarea
              value={cookies}
              onChange={(event) => setCookies(event.target.value)}
              spellCheck={false}
              placeholder="# Netscape HTTP Cookie File"
              className="mt-3 min-h-32 w-full rounded-sm border border-line bg-bg p-3 font-mono text-xs text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            {lane === "image" ? (
              <label className="mt-4 block text-sm">
                <span className="font-medium">{phrases.pixivToken}</span>
                <span className="mt-1 block text-muted">{phrases.pixivHelp}</span>
                <input
                  value={pixivToken}
                  onChange={(event) => setPixivToken(event.target.value.trim())}
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 h-11 w-full rounded-sm border border-line bg-bg px-3 font-mono text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                />
              </label>
            ) : null}
          </details>

          {submitError ? <p className="mt-4 text-sm text-danger">{submitError}</p> : null}
          {probeState === "error" && probeError ? (
            <p className="mt-4 text-sm text-danger">{probeError}</p>
          ) : null}

          <Button
            type="button"
            className="mt-5 w-full"
            disabled={
              busy || running || (lane === "image" ? engine?.gallerydl === false : engine?.ytdlp === false)
            }
            onClick={() => void startDownload()}
          >
            {busy || running ? <Loader2 className="size-4 animate-spin" /> : null}
            {running ? phrases.downloading : phrases.start}
          </Button>
        </section>

        <aside className="grid min-w-0 gap-5 lg:sticky lg:top-6 lg:col-span-5 lg:self-start">
          <section ref={jobPanel} className="rounded-xl border border-line bg-elev p-5">
            {probeState === "loading" ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" />
                {lane === "image" ? phrases.readingImages : phrases.readingVideo}
              </p>
            ) : probe ? (
              <div className="flex gap-3">
                {probe.thumbnail ? (
                  <img
                    src={probe.thumbnail}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-20 w-32 shrink-0 rounded-sm object-cover"
                  />
                ) : (
                  <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-sm bg-subtle text-xs text-faint">
                    {probe.extractor || phrases.video}
                  </div>
                )}
                <div className="min-w-0">
                  <h2 className="line-clamp-2 text-sm font-medium">{probe.title}</h2>
                  <p className="mt-1 text-xs text-muted">
                    {[
                      probe.uploader,
                      duration,
                      probe.kind === "playlist"
                        ? phrases.items(probe.entryCount ?? phrases.many)
                        : probe.kind === "images" && probe.entryCount
                          ? phrases.previewItems(probe.entryCount)
                          : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <h2 className="text-sm font-medium">{phrases.emptyTitle}</h2>
                <p className="mt-2 text-sm text-muted">{phrases.emptyBody}</p>
              </div>
            )}

            {job ? (
              <div className="mt-5 border-t border-line pt-4" aria-live="polite">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {job.status === "running"
                        ? phrases.running
                        : job.status === "done"
                          ? phrases.ready
                          : job.status === "canceled"
                            ? phrases.canceled
                            : phrases.failed}
                    </p>
                    {job.status === "done" ? (
                      <p className="mt-1 text-xs text-muted">{phrases.saveHint}</p>
                    ) : null}
                  </div>
                  <p className="shrink-0 font-mono text-xs tabular-nums text-muted">
                    {job.percent != null ? `${Math.round(job.percent)}%` : job.status === "running" ? phrases.working : ""}
                    {job.speed ? ` · ${job.speed}` : ""}
                    {job.eta ? ` · ${job.eta}` : ""}
                  </p>
                </div>
                <div
                  className="mt-3 h-1 overflow-hidden rounded-full bg-subtle"
                  role="progressbar"
                  aria-valuenow={job.percent ?? undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  {job.percent == null && job.status === "running" ? (
                    <div className="indet-bar h-full bg-accent" />
                  ) : (
                    <div
                      className="h-full origin-left bg-accent transition-transform duration-300 ease-out"
                      style={{ transform: `scaleX(${Math.max(0, Math.min(100, job.percent ?? 0)) / 100})` }}
                    />
                  )}
                </div>
                {job.error ? <p className="mt-3 text-sm text-danger">{job.error}</p> : null}
                {job.warning ? <p className="mt-3 text-sm text-muted">{job.warning}</p> : null}
                {job.status === "done" && job.filename ? (
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm">
                      {job.filename}
                      <span className="ml-2 text-xs text-faint">{formatBytes(job.bytes)}</span>
                    </p>
                    <Button asChild>
                      <a href={`/api/jobs/${job.id}/file?lang=${locale}`} download={job.filename}>{phrases.save}</a>
                    </Button>
                  </div>
                ) : null}
                {job.status === "running" ? (
                  <Button type="button" variant="quiet" size="sm" className="mt-4" onClick={() => void cancel()}>
                    {phrases.cancel}
                  </Button>
                ) : null}
                {job.log.length ? (
                  <pre className="mt-4 max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-faint">
                    {job.log.slice(-8).join("\n")}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </section>

          {recent.length ? (
            <section className="rounded-xl border border-line bg-elev p-5">
              <h2 className="text-sm font-medium">{phrases.recent}</h2>
              <div className="mt-2">
                {recent.map((item) => (
                  <div key={item.url} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        applyUrl(item.url);
                        setPreset(item.preset);
                      }}
                      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="w-28 shrink-0 truncate text-xs text-faint">
                        {presetText(locale, item.preset).label}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={phrases.remove}
                      onClick={() => forget(item.url)}
                      className="flex size-11 shrink-0 items-center justify-center text-faint"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>

      <p className="mt-8 text-xs text-faint">{phrases.footer}</p>
    </main>
  );
}
