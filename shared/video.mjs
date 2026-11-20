/** @typedef {"best" | "hd1080"} Quality */
/** @typedef {(typeof OUTPUTS)[number]} Output */

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com"]);
const BILIBILI_SHORT_HOST = "b23.tv";
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_VIDEO_PATH = /^\/video\/((?:BV[A-Za-z0-9]{10}|av[1-9]\d{0,19}))\/?$/i;

export const VIDEO_FILENAME = "%(title).160B [%(id)s].%(ext)s";
export const OUTPUTS = /** @type {const} */ (["mp4", "mp4-silent", "mp3"]);
export const MAX_BATCH_URLS = 20;
export const MAX_SHARE_TEXT = 32_768;

/**
 * yt-dlp's resumable leftovers: partial downloads, fragment state and separate
 * format streams (`name.f137.mp4`) that are merged after every stream finishes.
 * @param {string} name
 */
export function isVideoScratch(name) {
  return /(?:\.part(?:-Frag\d+)?|\.ytdl|\.f\d+[\w.-]*\.[a-z0-9]+)$/i.test(name);
}

/** @param {unknown} raw @returns {string | null} */
export function normalizeFileUrl(raw) {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (input.length > 4096 || !/^https?:\/\/[^\s\\]+$/i.test(input)) return null;
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/\.$/, "");
    if (
      url.username ||
      url.password ||
      /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be|bilibili\.com|b23\.tv)$/i.test(host)
    ) {
      return null;
    }
    url.hash = "";
    return url.href.length <= 4096 ? url.href : null;
  } catch {
    return null;
  }
}

/** @param {unknown} raw @returns {string | null} */
export function normalizeVideoUrl(raw) {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (input.length > 4096 || !/^https?:\/\//i.test(input)) return null;

  try {
    const url = new URL(input);
    if (url.username || url.password || url.port) return null;

    if (BILIBILI_HOSTS.has(url.hostname)) {
      const video = BILIBILI_VIDEO_PATH.exec(url.pathname);
      if (!video) return null;
      const id = video[1];
      const prefix = id.slice(0, 2).toLowerCase() === "bv" ? "BV" : "av";
      const pages = url.searchParams.getAll("p");
      if (pages.length > 1 || (pages.length === 1 && !/^[1-9]\d{0,8}$/.test(pages[0]))) return null;
      const page = pages.length === 1 ? `?p=${pages[0]}` : "";
      return `https://www.bilibili.com/video/${prefix}${id.slice(2)}${page}`;
    }
    if (url.hostname === BILIBILI_SHORT_HOST) {
      const code = /^\/([A-Za-z0-9]{1,32})\/?$/.exec(url.pathname);
      return code ? `https://${BILIBILI_SHORT_HOST}/${code[1]}` : null;
    }

    const pathname = url.pathname.replace(/\/$/, "");
    const [, kind, pathId, extra] = pathname.split("/");
    let id;
    if (url.hostname === "youtu.be") {
      if (pathId === undefined) id = kind;
    } else if (YOUTUBE_HOSTS.has(url.hostname)) {
      if (pathname === "/watch") {
        const ids = url.searchParams.getAll("v");
        if (ids.length === 1) id = ids[0];
      } else if (extra === undefined && ["shorts", "live", "embed", "v"].includes(kind)) {
        id = pathId;
      }
    } else if (EMBED_HOSTS.has(url.hostname) && kind === "embed" && extra === undefined) {
      id = pathId;
    }

    if (id && YOUTUBE_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    // An incomplete or malformed paste is not a video link.
  }
  return null;
}

/** @param {unknown} raw @returns {string[]} */
export function extractVideoUrls(raw) {
  return extractDownloadUrls(raw, false);
}

/** @param {unknown} raw @param {boolean} [includeFiles] @returns {string[]} */
export function extractDownloadUrls(raw, includeFiles = true) {
  if (typeof raw !== "string" || raw.length > MAX_SHARE_TEXT) return [];

  const urls = new Set();
  for (const line of raw.split(/\r?\n|[,，、；;。](?=https?:\/\/)/i)) {
    const whole = line.trim();
    if (/^https?:\/\/[^\s<>"'{}「」『』【】《》〈〉]+$/i.test(whole)) {
      const url = normalizeVideoUrl(whole) ?? (includeFiles ? normalizeFileUrl(whole) : null);
      if (url) {
        urls.add(url);
        continue;
      }
    }
    const links = line.match(/https?:\/\/[^\s<>"'{}，。！？、；：…《》〈〉【】「」『』]+/gi) ?? [];
    for (const link of links) {
      let candidate = link.replace(/[.,!?;:]+$/, "");
      for (const [open, close] of [
        ["(", ")"],
        ["（", "）"],
        ["[", "]"],
      ]) {
        const unmatched = candidate.split(close).length - candidate.split(open).length;
        for (let index = 0; index < unmatched && candidate.endsWith(close); index++) {
          candidate = candidate.slice(0, -1);
        }
      }
      const url =
        normalizeVideoUrl(candidate) ?? (includeFiles ? normalizeFileUrl(candidate) : null);
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

/** @param {string} normalized @param {typeof fetch} [fetchUrl] @returns {Promise<string | null>} */
export async function resolveVideoUrl(normalized, fetchUrl = fetch) {
  const initial = new URL(normalized);
  if (initial.hostname !== BILIBILI_SHORT_HOST) return normalized;

  const signal = AbortSignal.timeout(6000);
  let shortUrl = normalized;
  const visited = new Set();
  try {
    while (visited.size < 4 && !visited.has(shortUrl)) {
      visited.add(shortUrl);
      const response = await fetchUrl(shortUrl, { redirect: "manual", signal });
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return null;
      const target = normalizeVideoUrl(new URL(location, shortUrl).href);
      if (!target) return null;
      const host = new URL(target).hostname;
      if (BILIBILI_HOSTS.has(host)) return target;
      if (host !== BILIBILI_SHORT_HOST) return null;
      shortUrl = target;
    }
  } catch {
    // The redirect was unavailable or invalid.
  }
  return null;
}

/** @param {unknown} value @returns {value is Quality} */
export function isQuality(value) {
  return value === "best" || value === "hd1080";
}

/** @param {unknown} value @returns {value is Output} */
export function isOutput(value) {
  return OUTPUTS.some((output) => output === value);
}

/** @param {Output} output */
export function outputExtension(output) {
  return output === "mp3" ? "mp3" : "mp4";
}

/** @param {Output} output @param {Quality} quality */
export function videoFilename(output, quality) {
  const mode = output === "mp4-silent" ? " [silent]" : "";
  const resolution = output !== "mp3" && quality === "hd1080" ? " [1080p]" : "";
  return VIDEO_FILENAME.replace(".%(ext)s", `${mode}${resolution}.%(ext)s`);
}

/** @param {{ url: string, quality: Quality, ffmpeg: string | null, nodeBin: string | null, output?: Output }} options */
export function videoArgs({ url, quality, ffmpeg, nodeBin, output = "mp4" }) {
  const limit = quality === "hd1080" ? "[height<=1080]" : "";
  const args = [
    "--ignore-config",
    "--no-plugin-dirs",
    "--no-playlist",
    "--no-write-subs",
    "--no-write-auto-subs",
    "--no-embed-subs",
    "--no-colors",
    "--newline",
    "--no-mtime",
    "--no-overwrites",
    "--abort-on-unavailable-fragments",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--windows-filenames",
  ];
  if (output === "mp3") {
    args.push("--format", "ba/b", "--extract-audio", "--audio-format", "mp3");
  } else {
    const formats = output === "mp4-silent" ? `bv${limit}/b${limit}` : `bv*${limit}+ba/b${limit}`;
    args.push("--format", formats, "--merge-output-format", "mp4", "--remux-video", "mp4");
    if (output === "mp4-silent") {
      // This postprocessor remuxes even an existing MP4, which may have come from the muxed fallback.
      args.push(
        "--embed-metadata",
        "--no-embed-chapters",
        "--postprocessor-args",
        "Metadata+ffmpeg_o:-an -sn -dn -map_chapters -1",
      );
    }
  }
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
  if (new URL(url).hostname === "www.bilibili.com") {
    // Some interactive videos still return multiple entries with --no-playlist.
    args.push("--use-extractors", "BiliBili", "--break-match-filters", "!playlist_index");
  } else {
    if (nodeBin) args.push("--js-runtimes", `node:${nodeBin}`);
    args.push("--remote-components", "ejs:github");
  }
  return args;
}
