import { ArrowDownToLine, File, Film, Music2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { JobView } from "@/lib/downloader/types";
import { copy, type Locale } from "@/lib/i18n";
import { isActive } from "./use-downloads";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fileLabel(url: URL) {
  const name = url.pathname.split("/").filter(Boolean).at(-1);
  if (!name) return url.hostname;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function DownloadRow({
  job,
  locale,
  busy,
  retrying,
  canRetry,
  error,
  onCancel,
  onRefill,
  onRetry,
}: {
  job: JobView;
  locale: Locale;
  busy: boolean;
  retrying: boolean;
  canRetry: boolean;
  error: string | undefined;
  onCancel: () => void;
  onRefill: () => void;
  onRetry: () => void;
}) {
  const text = copy(locale);
  const active = isActive(job);
  const MediaIcon = job.file ? File : job.output === "mp3" ? Music2 : Film;
  const videoUrl = new URL(job.url);
  const videoId = videoUrl.searchParams.get("v") ?? videoUrl.pathname.split("/").at(-1) ?? "";
  const part = job.file ? null : videoUrl.searchParams.get("p");
  const title = job.filename ?? (job.file ? fileLabel(videoUrl) : text.videoId(videoId));
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
          <MediaIcon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-sm font-medium" title={title}>
            {title}
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
            {job.file && ` · ${text.file}`}
            {part && ` · P${part}`}
            {job.output && ` · ${text.outputs[job.output]}`}
            {!job.file && job.output !== "mp3" && ` · ${text[job.quality]}`}
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
            disabled={busy || job.status === "canceling"}
            onClick={onCancel}
          >
            {text.cancel}
          </Button>
        )}
        {(job.status === "error" || job.status === "canceled") && (
          <div className="flex flex-wrap items-center gap-1">
            <Button type="button" variant="quiet" size="sm" onClick={onRefill}>
              {text.refill}
            </Button>
            <Button type="button" variant="quiet" size="sm" disabled={!canRetry} onClick={onRetry}>
              {retrying ? text.retrying : job.resumable ? text.resume : text.retry}
            </Button>
          </div>
        )}
      </div>
      {active && job.status !== "queued" && (
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
      {error && (
        <p role="alert" className="mt-3 break-words text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
