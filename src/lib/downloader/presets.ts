import { copy, type Locale } from "@/lib/i18n";

export const PRESET_IDS = [
  "best",
  "mp3",
  "audio",
  "hd1080",
  "playlist",
  "subs",
  "thumb",
  "tweet",
  "media",
  "artwork",
  "illustrations",
  "author",
  "bookmarks",
  "ranking",
] as const;

export type PresetId = (typeof PRESET_IDS)[number];

export type Preset = {
  id: PresetId;
  label: string;
  detail: string;
  en: string;
  enDetail: string;
};

export const PRESETS: Preset[] = [
  {
    id: "best",
    label: "最高画质",
    detail: "只下这一条，自动合并最佳视频和音频",
    en: "Best",
    enDetail: "This item only. Merge the best video and audio.",
  },
  {
    id: "mp3",
    label: "MP3",
    detail: "提取音轨并转为 MP3",
    en: "MP3",
    enDetail: "Extract the audio as MP3.",
  },
  {
    id: "audio",
    label: "原始音频",
    detail: "不转码，保留站点给的最高音质",
    en: "Audio",
    enDetail: "No re-encode. Keep the best audio the site offers.",
  },
  {
    id: "hd1080",
    label: "1080p",
    detail: "不超过 1080p 的最佳画面，再配上最佳音频",
    en: "1080p",
    enDetail: "Best picture up to 1080p, plus the best audio.",
  },
  {
    id: "playlist",
    label: "播放列表",
    detail: "下载整个播放列表（默认不截断，可选手动限条）",
    en: "Playlist",
    enDetail: "Download the full playlist (no end cap by default).",
  },
  {
    id: "subs",
    label: "简中字幕",
    detail: "内嵌简体字幕；没有正式字幕时改用自动字幕",
    en: "Subs",
    enDetail: "Embed Simplified Chinese subtitles, or auto captions if none exist.",
  },
  {
    id: "thumb",
    label: "封面",
    detail: "不下载视频，只保存封面图",
    en: "Cover",
    enDetail: "Skip the video and save the thumbnail.",
  },
  {
    id: "tweet",
    label: "推文原图",
    detail: "一条推文里的全部原图，四张也会一起收下",
    en: "Tweet",
    enDetail: "Every original image in that one post.",
  },
  {
    id: "media",
    label: "画师媒体",
    detail: "X 的 Media 页，按条数截断",
    en: "Media",
    enDetail: "An X media page, limited by count.",
  },
  {
    id: "artwork",
    label: "作品原画",
    detail: "Pixiv 单张或多图作品的最高清原图",
    en: "Artwork",
    enDetail: "The full-size images of one Pixiv artwork.",
  },
  {
    id: "illustrations",
    label: "插画列表",
    detail: "画师 illustrations 或漫画页，按条数截断",
    en: "Illustrations",
    enDetail: "An artist’s illustrations or manga, limited by count.",
  },
  {
    id: "author",
    label: "全部作品",
    detail: "画师主页上的插画和漫画，按条数截断",
    en: "All works",
    enDetail: "Illustrations and manga on an artist page, limited by count.",
  },
  {
    id: "bookmarks",
    label: "收藏夹",
    detail: "公开或私密收藏，需要你自己的 Cookie",
    en: "Bookmarks",
    enDetail: "Public or private bookmarks. Needs your own cookies.",
  },
  {
    id: "ranking",
    label: "排行榜",
    detail: "日榜或其他排行链接，按条数截断",
    en: "Ranking",
    enDetail: "A daily or other ranking, limited by count.",
  },
];

export type Intent = {
  preset: PresetId;
  /** Playlist item cap. null/undefined = full playlist (no --playlist-end). */
  playlistEnd?: number | null;
  formatId?: string | null;
  videoOnly?: boolean;
  withCookies?: boolean;
};

const FORMAT_OK = /^[0-9A-Za-z][0-9A-Za-z._-]{0,48}$/;

export function isPresetId(value: string): value is PresetId {
  return (PRESET_IDS as readonly string[]).includes(value);
}

export function presetText(locale: Locale, id: PresetId): { label: string; detail: string } {
  const item = PRESETS.find((entry) => entry.id === id);
  if (!item) return { label: id, detail: "" };
  if (locale === "en") return { label: item.en, detail: item.enDetail };
  return { label: item.label, detail: item.detail };
}

const IMAGE_PRESETS = new Set<PresetId>([
  "tweet",
  "media",
  "artwork",
  "illustrations",
  "author",
  "bookmarks",
  "ranking",
]);

const BULK_IMAGE_PRESETS = new Set<PresetId>([
  "media",
  "illustrations",
  "author",
  "bookmarks",
  "ranking",
]);

export function isImagePreset(value: PresetId): boolean {
  return IMAGE_PRESETS.has(value);
}

export function isBulkImagePreset(value: PresetId): boolean {
  return BULK_IMAGE_PRESETS.has(value);
}

export function clampImageEnd(value: number): number {
  if (!Number.isFinite(value)) return 40;
  return Math.min(40, Math.max(1, Math.round(value)));
}

export function imageHost(raw: string): "x" | "pixiv" | null {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com")) {
      return "x";
    }
    if (host === "pixiv.net" || host.endsWith(".pixiv.net")) return "pixiv";
  } catch {
    return null;
  }
  return null;
}

export function inferImagePreset(raw: string): PresetId | null {
  const host = imageHost(raw);
  if (!host) return null;
  let path = "";
  try {
    path = new URL(raw.trim()).pathname.toLowerCase();
  } catch {
    return host === "x" ? "tweet" : "artwork";
  }
  if (host === "x") {
    if (path.endsWith("/media") || path.includes("/media/")) return "media";
    return "tweet";
  }
  if (path.includes("/bookmarks")) return "bookmarks";
  if (path.includes("ranking")) return "ranking";
  if (/\/artworks\/\d+/.test(path)) return "artwork";
  if (path.includes("/illustrations") || path.includes("/manga")) return "illustrations";
  if (path.includes("/users/")) return "author";
  return "artwork";
}

export function showsImageCap(preset: PresetId, raw: string): boolean {
  if (!isImagePreset(preset)) return false;
  if (isBulkImagePreset(preset)) return true;
  const inferred = inferImagePreset(raw);
  return inferred != null && isBulkImagePreset(inferred);
}

export function imagePostRange(preset: PresetId, raw: string, count: number): string | null {
  if (!showsImageCap(preset, raw)) return null;
  return `1-${clampImageEnd(count)}`;
}

export function clampPlaylistEnd(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.min(20, Math.max(1, Math.round(value)));
}

export function safeFormatId(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.trim();
  return FORMAT_OK.test(id) ? id : null;
}

export function intentArgs(input: Intent): string[] {
  const args: string[] = [];
  // Recipe map:
  // best     → yt-dlp "URL"  (no -f; --no-playlist keeps a single item)
  // hd1080   → -f "bestvideo[height<=1080]+bestaudio/best"
  // mp3      → -x --audio-format mp3
  // playlist → full playlist; --playlist-end only when caller sets a limit
  if (input.preset === "playlist") {
    args.push("--yes-playlist");
    if (input.playlistEnd != null && Number.isFinite(input.playlistEnd)) {
      args.push("--playlist-end", String(clampPlaylistEnd(input.playlistEnd)));
    }
  } else {
    args.push("--no-playlist");
  }

  if (input.preset === "mp3") args.push("-x", "--audio-format", "mp3");
  else if (input.preset === "audio") args.push("-x");
  else if (input.preset === "thumb") args.push("--write-thumbnail", "--skip-download");
  else if (input.preset === "subs") {
    args.push(
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "zh-Hans,zh-CN,zh",
      "--embed-subs",
    );
  }

  const formatId = safeFormatId(input.formatId);
  const canPick =
    input.preset === "best" ||
    input.preset === "hd1080" ||
    input.preset === "subs" ||
    input.preset === "playlist";

  if (canPick && formatId) {
    args.push("-f", input.videoOnly ? `${formatId}+bestaudio/best` : formatId);
  } else if (input.preset === "hd1080") {
    // Recipe: yt-dlp -f "bestvideo[height<=1080]+bestaudio/best" --merge-output-format mp4
    args.push("-f", "bestvideo[height<=1080]+bestaudio/best");
  }
  // best / playlist with no formatId: omit -f → yt-dlp default best quality

  if (input.withCookies) args.push("--cookies", "cookies.txt");
  return args;
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.:/@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function previewCommand(url: string, input: Intent, locale: Locale = "zh"): string {
  const phrases = copy(locale);
  const image = isImagePreset(input.preset);
  const target = url.trim() || (image ? phrases.placeholderImage : phrases.placeholderVideo);
  if (image) {
    const flags = ["gallery-dl"];
    const range =
      input.playlistEnd != null && Number.isFinite(input.playlistEnd)
        ? imagePostRange(input.preset, url, input.playlistEnd)
        : null;
    if (range) flags.push("--post-range", range);
    if (input.withCookies) flags.push("--cookies", "cookies.txt");
    flags.push(shellQuote(target));
    return flags.join(" ");
  }
  // Recipe parity in the GUI preview: hd1080 includes --merge-output-format mp4.
  // Engine always applies merge + -o "%(title)s.%(ext)s" on real downloads.
  const flags = [...intentArgs(input)];
  if (input.preset === "hd1080" || (safeFormatId(input.formatId) != null && input.videoOnly)) {
    flags.push("--merge-output-format", "mp4");
  }
  const parts = ["yt-dlp", ...flags.map(shellQuote), shellQuote(target)];
  return parts.join(" ");
}

function isPrivateIp(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const nums = ipv4.slice(1).map(Number);
    if (nums.some((n) => n > 255)) return true;
    const [a, b] = nums;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const v6 = host.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  return false;
}

export function validateUrl(raw: string, locale: Locale = "zh"): string {
  const phrases = copy(locale);
  const text = raw.trim();
  if (!text) throw new Error(phrases.needUrl);
  if (text.length > 2000) throw new Error(phrases.urlLong);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(phrases.urlBad);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(phrases.urlProtocol);
  }
  if (url.username || url.password) throw new Error(phrases.urlCreds);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    throw new Error(phrases.privateHost);
  }
  if (isPrivateIp(host)) throw new Error(phrases.privateHost);
  return url.toString();
}

export function friendlyError(raw: string, locale: Locale = "zh"): string {
  const phrases = copy(locale);
  const text = raw.replace(/\x1B\[[0-9;]*m/g, "").trim();
  if (/Authentication required|Login required|No cookies|401 Unauthorized|请登录|ログイン/i.test(text)) {
    return phrases.loginPage;
  }
  if (/HTTP Error 403/.test(text)) return phrases.http403;
  if (/Sign in to confirm|not a bot|login required|Use --cookies|logged-in/i.test(text)) {
    return phrases.loginCookies;
  }
  if (/Video unavailable|Private video|This video is unavailable|removed/i.test(text)) {
    return phrases.unavailable;
  }
  if (/Requested format is not available/i.test(text)) return phrases.badFormat;
  if (/Unsupported URL/i.test(text)) return phrases.unknownUrl;
  if (/unable to download video data/i.test(text)) return phrases.videoData;
  const line =
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? phrases.downloadFail;
  return line.replace(/^ERROR:\s*/, "").slice(0, 280);
}
