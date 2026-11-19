import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { normalizeVideoUrl, resolveVideoUrl, videoArgs } from "../../../shared/video.mjs";
import type { Locale } from "../i18n.ts";
import { DownloadError, getTools } from "./engine.server.ts";
import { downloadMessages } from "./messages.ts";

export type VideoPreview = {
  url: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  maxHeight: number | null;
  heights: number[];
  parts: { number: number; title: string }[];
  selectedPart: number | null;
};

const descriptions = {
  zh: {
    failed: "无法读取视频预览。请检查视频链接，或直接下载。",
    timeout: "预览超时。请重试，或直接下载。",
    busy: "正在读取其他预览。请稍后重试。",
    missing: "请安装 yt-dlp，再试一次。",
  },
  en: {
    failed: "Couldn’t preview this video. Check the link or start the download directly.",
    timeout: "The preview timed out. Try again or start the download directly.",
    busy: "Other previews are in progress. Try again shortly.",
    missing: "Install yt-dlp and try again.",
  },
};

const exec = promisify(execFile);
let activePreviews = 0;

function coverUrl(value: unknown, bilibili: boolean): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (!/^https?:$/.test(url.protocol) || url.port || url.username || url.password) return null;
    const trusted = bilibili
      ? /^i\d+\.(hdslb|biliimg)\.com$/.test(url.hostname)
      : url.hostname === "i.ytimg.com" || url.hostname === "img.youtube.com";
    if (!trusted) return null;
    url.protocol = "https:";
    return url.href;
  } catch {
    return null;
  }
}

async function bilibiliParts(url: URL, signal: AbortSignal): Promise<VideoPreview["parts"]> {
  const id = url.pathname.split("/").at(-1)!;
  const endpoint = new URL("https://api.bilibili.com/x/player/pagelist");
  if (id.startsWith("BV")) endpoint.searchParams.set("bvid", id);
  else endpoint.searchParams.set("aid", id.slice(2));
  const parts = new Map<number, string>();
  try {
    // The part list is optional. Its availability should not hold up the metadata preview.
    const response = await fetch(endpoint, {
      headers: { accept: "application/json", referer: "https://www.bilibili.com/" },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return [];
    }
    const data = (await response.json()) as { code?: unknown; data?: unknown };
    if (data.code !== 0 || !Array.isArray(data.data)) return [];
    const selected = Number(url.searchParams.get("p"));
    for (const item of data.data) {
      if (!item || !Number.isSafeInteger(item.page) || item.page < 1 || item.page >= 1e9) continue;
      if (parts.size >= 200 && item.page !== selected) continue;
      const title = typeof item.part === "string" ? item.part.trim().slice(0, 200) : "";
      parts.set(item.page, title);
    }
  } catch {
    return [];
  }
  return [...parts].sort(([a], [b]) => a - b).map(([number, title]) => ({ number, title }));
}

type Format = { height?: unknown; vcodec?: unknown; protocol?: unknown };
type Metadata = Format & {
  title?: unknown;
  thumbnail?: unknown;
  duration?: unknown;
  playlist_index?: unknown;
};

export async function probeVideo(input: unknown, locale: Locale, clientSignal?: AbortSignal) {
  const text = descriptions[locale];
  const messages = downloadMessages(locale);
  const normalized = normalizeVideoUrl(input);
  if (!normalized) throw new DownloadError(messages.badUrl, 400);
  if (activePreviews >= 2) throw new DownloadError(text.busy, 429);

  activePreviews++;
  const deadline = AbortSignal.timeout(25_000);
  const signal = clientSignal ? AbortSignal.any([deadline, clientSignal]) : deadline;
  try {
    const [resolved, tools] = await Promise.all([
      resolveVideoUrl(normalized, (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      ),
      getTools(),
    ]);
    signal.throwIfAborted();
    if (!resolved) throw new DownloadError(messages.shortLink, 422);
    if (!tools.info.ytdlp) throw new DownloadError(text.missing, 503);

    const url = new URL(resolved);
    const bilibili = url.hostname === "www.bilibili.com";
    const [{ stdout }, parts] = await Promise.all([
      exec(
        tools.command,
        [
          ...tools.prefix,
          ...videoArgs({
            url: resolved,
            quality: "best",
            ffmpeg: tools.ffmpeg,
            nodeBin: tools.nodeBin,
          }),
          "--simulate",
          "--playlist-items",
          "1",
          "--ignore-no-formats-error",
          "--output-na-placeholder",
          "null",
          "--socket-timeout",
          "7",
          "--retries",
          "0",
          "--extractor-retries",
          "0",
          "--print",
          "%(.{title,thumbnail,duration,height,vcodec,playlist_index})j",
          "--print",
          "%(formats.:.{height,vcodec,protocol})j",
          "--",
          resolved,
        ],
        { env: tools.env, signal, maxBuffer: 512 * 1024, windowsHide: true },
      ),
      bilibili ? bilibiliParts(url, signal) : Promise.resolve([]),
    ]);
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length !== 2) throw new DownloadError(text.failed, 502);
    const [metadata, formats] = lines.map((line) => JSON.parse(line)) as [Metadata | null, unknown];
    if (
      !metadata ||
      typeof metadata.title !== "string" ||
      !metadata.title.trim() ||
      metadata.playlist_index != null
    ) {
      throw new DownloadError(text.failed, 502);
    }
    const heights = new Set<number>();
    for (const format of [metadata, ...(Array.isArray(formats) ? (formats as Format[]) : [])]) {
      if (
        format &&
        typeof format.height === "number" &&
        Number.isInteger(format.height) &&
        format.height > 0 &&
        format.vcodec !== "none" &&
        format.protocol !== "mhtml"
      ) {
        heights.add(format.height);
      }
    }
    const sorted = [...heights].sort((a, b) => b - a);
    return {
      url: resolved,
      title: metadata.title.trim().slice(0, 500),
      thumbnail: coverUrl(metadata.thumbnail, bilibili),
      duration:
        typeof metadata.duration === "number" &&
        Number.isFinite(metadata.duration) &&
        metadata.duration > 0
          ? metadata.duration
          : null,
      maxHeight: sorted[0] ?? null,
      heights: sorted,
      parts,
      selectedPart: bilibili
        ? Number(url.searchParams.get("p")) || (parts.length > 1 ? 1 : null)
        : null,
    } satisfies VideoPreview;
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    if (signal.aborted) throw new DownloadError(text.timeout, 504);
    throw new DownloadError(text.failed, 502);
  } finally {
    activePreviews--;
  }
}
