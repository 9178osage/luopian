/** Preset → yt-dlp / gallery-dl flags (mirrors src/lib/downloader/presets.ts intentArgs). */
import { detectLang } from "./locale.mjs";
import { messages } from "./messages.mjs";

function cliText(lang) {
  return messages(lang || detectLang().lang);
}

export const VIDEO_PRESETS = new Set([
  "best",
  "mp3",
  "audio",
  "hd1080",
  "playlist",
  "subs",
  "thumb",
]);

export const IMAGE_PRESETS = new Set([
  "tweet",
  "media",
  "artwork",
  "illustrations",
  "author",
  "bookmarks",
  "ranking",
]);

export const ALL_PRESETS = [...VIDEO_PRESETS, ...IMAGE_PRESETS];

export function isImagePreset(preset) {
  return IMAGE_PRESETS.has(preset);
}

export function clampPlaylistEnd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 8;
  return Math.min(20, Math.max(1, Math.round(n)));
}

export function clampImageEnd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 40;
  return Math.min(200, Math.max(1, Math.round(n)));
}

export function imageHost(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com" || host.endsWith(".twitter.com")) return "x";
    if (host === "pixiv.net" || host.endsWith(".pixiv.net")) return "pixiv";
  } catch {
    /* ignore */
  }
  return null;
}

export function inferPreset(url) {
  const host = imageHost(url);
  if (host === "x") {
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (path.endsWith("/media") || path.includes("/media/")) return "media";
    } catch {
      /* ignore */
    }
    return "tweet";
  }
  if (host === "pixiv") return "artwork";
  return "best";
}

export function toArtistMediaUrl(raw) {
  const u = new URL(raw);
  const user = u.pathname.split("/").filter(Boolean)[0];
  if (!user) throw new Error(cliText().noArtist);
  return `${u.origin}/${user}/media`;
}

export function imagePostRange(preset, url, count) {
  const host = imageHost(url);
  if (!host) return null;
  if (preset === "tweet" || preset === "artwork" || preset === "media") {
    return `1-${clampImageEnd(count)}`;
  }
  if (preset === "author" || preset === "bookmarks" || preset === "ranking" || preset === "illustrations") {
    return `1-${clampImageEnd(count)}`;
  }
  return null;
}

export function intentArgs({ preset, playlistEnd = null, formatId = null, videoOnly = false }) {
  const args = [];
  // Mirrors src/lib/downloader/presets.ts intentArgs recipes:
  // best     → no -f (yt-dlp default best)
  // hd1080   → -f "bestvideo[height<=1080]+bestaudio/best"
  // mp3      → -x --audio-format mp3
  // playlist → --yes-playlist; --playlist-end only when end is set
  if (preset === "playlist") {
    args.push("--yes-playlist");
    if (playlistEnd != null && Number.isFinite(Number(playlistEnd))) {
      args.push("--playlist-end", String(clampPlaylistEnd(playlistEnd)));
    }
  } else {
    args.push("--no-playlist");
  }

  if (preset === "mp3") args.push("-x", "--audio-format", "mp3");
  else if (preset === "audio") args.push("-x");
  else if (preset === "thumb") args.push("--write-thumbnail", "--skip-download");
  else if (preset === "subs") {
    args.push(
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "zh-Hans,zh-CN,zh",
      "--embed-subs",
    );
  }

  const canPick =
    preset === "best" || preset === "hd1080" || preset === "subs" || preset === "playlist";
  if (canPick && formatId) {
    args.push("-f", videoOnly ? `${formatId}+bestaudio/best` : formatId);
  } else if (preset === "hd1080") {
    args.push("-f", "bestvideo[height<=1080]+bestaudio/best");
  }

  return args;
}

export function isYoutube(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com"
    );
  } catch {
    return false;
  }
}

export function validateUrl(raw, lang) {
  const t = cliText(lang);
  const text = String(raw || "").trim();
  if (!text) throw new Error(t.needUrl);
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error(t.badUrl(text));
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(t.badProtocol);
  }
  return u.href;
}
