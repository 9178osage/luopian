/** @typedef {"best" | "hd1080"} Quality */

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const VIDEO_FILENAME = "%(title).160B [%(id)s].%(ext)s";

/** @param {string} raw @returns {string | null} */
export function normalizeYouTubeUrl(raw) {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (input.length > 4096 || !/^https?:\/\//i.test(input)) return null;

  try {
    const url = new URL(input);
    if (url.username || url.password || url.port) return null;

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

    if (id && VIDEO_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  } catch {
    // An incomplete or malformed paste is not a video link.
  }
  return null;
}

/** @param {unknown} value @returns {value is Quality} */
export function isQuality(value) {
  return value === "best" || value === "hd1080";
}

/** @param {{ quality: Quality, ffmpeg: string | null, nodeBin: string | null }} options */
export function youtubeArgs({ quality, ffmpeg, nodeBin }) {
  const formats = quality === "hd1080" ? "bv*[height<=1080]+ba/b[height<=1080]" : "bv*+ba/b";
  const args = [
    "--ignore-config",
    "--no-plugin-dirs",
    "--no-playlist",
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
    "--merge-output-format",
    "mp4",
    "--format",
    formats,
  ];
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
  if (nodeBin) args.push("--js-runtimes", `node:${nodeBin}`);
  args.push("--remote-components", "ejs:github");
  return args;
}
