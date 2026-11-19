import { Film } from "lucide-react";

import type { VideoPreview } from "@/lib/downloader/probe.server";
import { copy, type Locale } from "@/lib/i18n";

function formatDuration(seconds: number) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${minutes}:${remainder}` : `${minutes}:${remainder}`;
}

export function VideoPreviewCard({
  preview,
  locale,
  part,
  showDetails,
  onPartChange,
}: {
  preview: VideoPreview;
  locale: Locale;
  part: number | null;
  showDetails: boolean;
  onPartChange: (part: number) => void;
}) {
  const text = copy(locale);
  return (
    <div className="mt-3 rounded-sm border border-line bg-bg p-3" aria-live="polite">
      {showDetails && (
        <div className="flex items-start gap-3">
          <div className="relative grid aspect-video w-24 shrink-0 place-items-center overflow-hidden rounded-sm bg-subtle sm:w-32">
            <Film className="size-4 text-muted" aria-hidden />
            {preview.thumbnail && (
              <img
                key={preview.thumbnail}
                src={preview.thumbnail}
                alt=""
                referrerPolicy="no-referrer"
                className="absolute inset-0 size-full object-cover"
                onError={(event) => {
                  event.currentTarget.style.visibility = "hidden";
                }}
              />
            )}
          </div>
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{preview.title}</p>
            {preview.duration != null && (
              <p className="mt-1 text-xs text-muted tabular-nums">
                {formatDuration(preview.duration)}
              </p>
            )}
            {preview.heights.length > 0 ? (
              <p className="mt-1 text-xs text-muted">
                {text.previewQuality(preview.heights.map((height) => `${height}p`).join(" / "))}
              </p>
            ) : (
              preview.maxHeight != null && (
                <p className="mt-1 text-xs text-muted">
                  {text.previewMaxQuality(preview.maxHeight)}
                </p>
              )
            )}
          </div>
        </div>
      )}
      {preview.parts.length > 1 && (
        <label
          className={showDetails ? "mt-3 block text-xs font-medium" : "block text-xs font-medium"}
        >
          {text.part}
          <select
            value={part ?? preview.parts[0]?.number}
            onChange={(event) => onPartChange(Number(event.target.value))}
            className="mt-1 block min-h-10 w-full rounded-sm border border-line-strong bg-bg px-2 text-sm focus:border-accent focus:outline-none"
          >
            {preview.parts.map(({ number, title }) => (
              <option key={number} value={number}>
                P{number} · {title}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
