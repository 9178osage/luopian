import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { copy, parseLocale, toolInstallHint, type Locale } from "@/lib/i18n";
import {
  clampPlaylistEnd,
  friendlyError,
  imageHost,
  imagePostRange,
  intentArgs,
  isImagePreset,
  isPresetId,
  safeFormatId,
  validateUrl,
  type PresetId,
} from "@/lib/downloader/presets";
import type { EngineInfo, JobView, ProbeFormat, ProbeResult } from "@/lib/downloader/types";

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function firstExisting(candidates: Array<string | undefined | null>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** PATH lookup. Windows skips .cmd/.bat so spawn() does not need a shell. */
function which(cmd: string): string | null {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.COM;.CMD;.BAT")
          .split(";")
          .map((ext) => ext.trim())
          .filter((ext) => ext && !/^\.(cmd|bat)$/i.test(ext))
      : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    const names =
      process.platform === "win32" && !path.extname(cmd)
        ? [cmd, ...exts.map((ext) => cmd + ext)]
        : [cmd];
    for (const name of names) {
      const full = path.join(dir, name);
      if (isFile(full)) return full;
    }
  }
  return null;
}

function winToolCandidates(name: string): string[] {
  const exe = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
  const local = process.env.LOCALAPPDATA || "";
  const appData = process.env.APPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const profile = process.env.USERPROFILE || os.homedir();
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const pythons = ["Python313", "Python312", "Python311", "Python310"].map((py) =>
    local ? path.join(local, "Programs", "Python", py, "Scripts", exe) : "",
  );
  return [
    local && path.join(local, "Microsoft", "WinGet", "Links", exe),
    path.join(profile, "scoop", "shims", exe),
    path.join(programData, "chocolatey", "bin", exe),
    path.join(pf, "ffmpeg", "bin", exe),
    path.join(pf86, "ffmpeg", "bin", exe),
    local && path.join(local, "Programs", "yt-dlp", exe),
    local && path.join(local, name, exe),
    path.join(pf, name, exe),
    path.join(pf, name, "bin", exe),
    appData && path.join(appData, "Python", "Scripts", exe),
    local && path.join(local, "Programs", "nodejs", exe),
    path.join(pf, "nodejs", exe),
    ...pythons,
  ].filter((item): item is string => Boolean(item));
}

function winShimDirs(): string[] {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "";
  const programData = process.env.ProgramData || "";
  return [
    local && path.join(local, "Microsoft", "WinGet", "Links"),
    path.join(os.homedir(), "scoop", "shims"),
    programData && path.join(programData, "chocolatey", "bin"),
    pf && path.join(pf, "ffmpeg", "bin"),
    pf && path.join(pf, "nodejs"),
  ].filter((dir): dir is string => Boolean(dir) && existsSync(dir));
}

/** Null when no node binary is on disk. Do not pass --js-runtimes in that case. */
function resolveNodeBin(): string | null {
  const fromEnv = process.env.LUOPIAN_NODE;
  if (fromEnv && isFile(fromEnv)) return fromEnv;
  const execPath = typeof process.execPath === "string" ? process.execPath : "";
  const base = execPath ? path.basename(execPath).toLowerCase() : "";
  if (execPath && isFile(execPath) && base.startsWith("node")) return execPath;
  if (process.platform === "darwin") {
    const mac = firstExisting(["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"]);
    if (mac && isFile(mac)) return mac;
  }
  const fromPath = which("node");
  if (fromPath) return fromPath;
  if (process.platform === "win32") {
    return winToolCandidates("node").find((candidate) => isFile(candidate)) ?? null;
  }
  return null;
}

const isDarwin = process.platform === "darwin";
const isWin = process.platform === "win32";
const homeDir = os.homedir();

const PYTHON =
  process.env.LUOPIAN_PYTHON ||
  (isWin
    ? which("python") || which("python3") || which("py") || "python"
    : firstExisting([
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3.11",
        "/usr/bin/python3",
      ]) || "python3");

const VENDOR =
  process.env.LUOPIAN_VENDOR ||
  firstExisting(["/workspace/vendor/ytdlp"]) ||
  path.join(process.cwd(), "vendor", "ytdlp");

const FFMPEG =
  process.env.LUOPIAN_FFMPEG ||
  (isWin
    ? which("ffmpeg") || winToolCandidates("ffmpeg").find((candidate) => isFile(candidate)) || "ffmpeg"
    : firstExisting(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) ||
      "ffmpeg");

const NODE_BIN = resolveNodeBin();

/** Prefer brew/system CLI on Mac; on Windows, PATH then winget/scoop/chocolatey. Else python -m. */
const YTDLP_BIN =
  process.env.LUOPIAN_YTDLP ||
  (isWin
    ? which("yt-dlp") || winToolCandidates("yt-dlp").find((candidate) => isFile(candidate)) || null
    : firstExisting(["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp"]));

const GALLERY_BIN =
  process.env.LUOPIAN_GALLERY ||
  (isWin
    ? which("gallery-dl") || winToolCandidates("gallery-dl").find((candidate) => isFile(candidate)) || null
    : firstExisting([
        "/opt/homebrew/bin/gallery-dl",
        "/usr/local/bin/gallery-dl",
        "/usr/bin/gallery-dl",
      ]));

const ROOT =
  process.env.LUOPIAN_ROOT ||
  (isDarwin
    ? path.join(homeDir, "Library", "Application Support", "Luopian", "jobs")
    : isWin
      ? path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "Luopian", "jobs")
      : "/tmp/luopian");

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const exec = promisify(execFile);

function ytdlpCmd(extra: string[]): { bin: string; args: string[] } {
  if (YTDLP_BIN) return { bin: YTDLP_BIN, args: extra };
  return { bin: PYTHON, args: ["-m", "yt_dlp", ...extra] };
}

function galleryCmd(extra: string[]): { bin: string; args: string[] } {
  if (GALLERY_BIN) return { bin: GALLERY_BIN, args: extra };
  return { bin: PYTHON, args: ["-m", "gallery_dl", ...extra] };
}

type Job = JobView & {
  dir: string;
  filePath: string | null;
  child: ChildProcess | null;
  startedAt: number;
  settled: boolean;
  locale: Locale;
  halted: boolean;
};

type Store = { jobs: Map<string, Job> };

const store: Store = ((globalThis as typeof globalThis & { __luopian?: Store }).__luopian ??= {
  jobs: new Map(),
});

let engineCache: { at: number; info: EngineInfo } | null = null;

function childEnv(): NodeJS.ProcessEnv {
  if (isWin) {
    return {
      ...process.env,
      PYTHONPATH: [VENDOR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      PYTHONIOENCODING: "utf-8",
      PATH: [...winShimDirs(), process.env.PATH || process.env.Path || ""].filter(Boolean).join(path.delimiter),
    };
  }
  const brewBin = firstExisting(["/opt/homebrew/bin", "/usr/local/bin"]);
  return {
    ...process.env,
    PYTHONPATH: [VENDOR, process.env.PYTHONPATH].filter(Boolean).join(":"),
    PYTHONIOENCODING: "utf-8",
    PATH: [brewBin, "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH]
      .filter(Boolean)
      .join(":"),
  };
}

/** yt-dlp flags only (no `-m yt_dlp`); pair with ytdlpCmd(). */
function toolArgs(url?: string): string[] {
  const args = ["--no-colors", "--ffmpeg-location", FFMPEG];
  if (url && isYoutube(url)) {
    if (NODE_BIN) {
      args.push("--js-runtimes", `node:${NODE_BIN}`, "--remote-components", "ejs:github");
    } else {
      args.push("--remote-components", "ejs:github");
    }
    args.push("-4", "--extractor-args", "youtube:player_client=android,web");
    // Linux vendor stack had curl_cffi; brew yt-dlp often does not.
    // Enable with LUOPIAN_IMPERSONATE=chrome when available.
    const impersonate = process.env.LUOPIAN_IMPERSONATE?.trim();
    if (impersonate) args.push("--impersonate", impersonate);
  }
  return args;
}

function isYoutube(url: string): boolean {
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

function killGroup(child: ChildProcess | null) {
  if (!child?.pid) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 1200);
}

class HostDenied extends Error {}

async function assertPublicHost(url: string, locale: Locale) {
  const phrases = copy(locale);
  const host = new URL(url).hostname;
  try {
    const records = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new HostDenied(phrases.unresolved)), 5000);
      }),
    ]);
    const blocked = records.some((record) => {
      const address = record.address.toLowerCase();
      return (
        address === "::1" ||
        address.startsWith("fe80:") ||
        address.startsWith("fc") ||
        address.startsWith("fd") ||
        /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
          address,
        )
      );
    });
    if (blocked) throw new HostDenied(phrases.privateHost);
  } catch (error) {
    if (error instanceof HostDenied) throw error;
    throw new HostDenied(phrases.hostMissing);
  }
}

function publicJob(job: Job): JobView {
  return {
    id: job.id,
    url: job.url,
    preset: job.preset,
    title: job.title,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    total: job.total,
    log: job.log,
    filename: job.filename,
    bytes: job.bytes,
    error: job.error,
    warning: job.warning,
  };
}

function pushLog(job: Job, line: string) {
  const clean = line.replace(/\x1B\[[0-9;]*m/g, "").trim().slice(0, 400);
  if (!clean || clean.includes("cookies.txt")) return;
  const last = job.log[job.log.length - 1];
  if (last === clean) return;
  job.log.push(clean);
  if (job.log.length > 40) job.log.splice(0, job.log.length - 40);
}

function consumeLine(job: Job, line: string) {
  const clean = line.replace(/\x1B\[[0-9;]*m/g, "").trim();
  if (!clean) return;
  const item = /Downloading item (\d+) of (\d+)/.exec(clean);
  if (item) {
    const index = Number(item[1]);
    const total = Number(item[2]);
    job.percent = Math.min(99, ((index - 1) / total) * 100);
    pushLog(job, clean);
    return;
  }
  const pct =
    /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*([\d.]+\S*))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/.exec(
      clean,
    );
  if (pct && clean.startsWith("[download]")) {
    const value = Math.max(0, Math.min(100, Number(pct[1])));
    job.percent = value;
    if (pct[2]) job.total = pct[2];
    if (pct[3] && pct[3] !== "Unknown") job.speed = pct[3];
    if (pct[4] && pct[4] !== "Unknown") job.eta = pct[4];
    if (value >= 100) pushLog(job, clean);
    return;
  }
  if (/^(ERROR|WARNING|\[(Merger|ExtractAudio|EmbedSubtitle|Thumbnails|youtube|info)\])/.test(clean)) {
    pushLog(job, clean);
  } else if (/Destination:|Merging formats/.test(clean)) {
    pushLog(job, clean);
  } else if (isImagePreset(job.preset)) {
    if (/\[(error|warning)\]/i.test(clean)) {
      pushLog(job, clean);
      return;
    }
    const base = clean.split("/").pop() ?? "";
    if (/\.(jpe?g|png|gif|webp|mp4|webm|zip|psd)$/i.test(base)) pushLog(job, base);
  }
}

function attachPipes(job: Job, child: ChildProcess) {
  const buffers = { out: "", err: "" };
  const take = (key: "out" | "err", chunk: Buffer) => {
    buffers[key] += chunk.toString("utf8");
    const parts = buffers[key].split(/\r?\n/);
    buffers[key] = parts.pop() ?? "";
    for (const part of parts) consumeLine(job, part);
  };
  child.stdout?.on("data", (chunk: Buffer) => take("out", chunk));
  child.stderr?.on("data", (chunk: Buffer) => take("err", chunk));
  child.on("close", () => {
    if (buffers.out) consumeLine(job, buffers.out);
    if (buffers.err) consumeLine(job, buffers.err);
  });
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function deliverable(file: string): boolean {
  const base = path.basename(file);
  if (base === "cookies.txt" || base === "gallery-config.json" || base === "_pack.zip" || base.startsWith(".")) {
    return false;
  }
  if (base.endsWith(".part") || base.endsWith(".ytdl") || base.endsWith(".temp")) return false;
  return true;
}

async function dirBytes(dir: string): Promise<number> {
  const files = await walk(dir);
  let total = 0;
  for (const file of files) {
    try {
      total += (await stat(file)).size;
    } catch {
      /* vanished */
    }
  }
  return total;
}

async function zipDir(dir: string, dest: string) {
  const script = `
import os, sys, zipfile
root, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
    for dirpath, _, names in os.walk(root):
        for name in names:
            if name in {"cookies.txt", "gallery-config.json", "_pack.zip"} or name.endswith(".part"):
                continue
            full = os.path.join(dirpath, name)
            bundle.write(full, os.path.relpath(full, root))
`;
  await exec(PYTHON, ["-c", script, dir, dest], { env: childEnv(), timeout: 120000 });
}

function contentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".zip": "application/zip",
    ".vtt": "text/vtt",
    ".srt": "application/x-subrip",
  };
  return map[ext] ?? "application/octet-stream";
}

function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function sweep() {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [id, job] of store.jobs) {
    if (job.status === "running") continue;
    if (job.startedAt < cutoff) {
      store.jobs.delete(id);
      await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const idle = [...store.jobs.values()].filter((job) => job.status !== "running");
  if (idle.length > 8) {
    idle
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, idle.length - 8)
      .forEach((job) => {
        store.jobs.delete(job.id);
        void rm(job.dir, { recursive: true, force: true });
      });
  }
}

export async function getEngineInfo(): Promise<EngineInfo> {
  if (engineCache && Date.now() - engineCache.at < 60_000) return engineCache.info;
  let version: string | null = null;
  try {
    const cmd = ytdlpCmd(["--version"]);
    const { stdout } = await exec(cmd.bin, cmd.args, {
      env: childEnv(),
      timeout: 20000,
    });
    version = stdout.trim() || null;
  } catch {
    version = null;
  }
  let ffmpeg = false;
  try {
    await exec(FFMPEG, ["-version"], { timeout: 8000, env: childEnv() });
    ffmpeg = true;
  } catch {
    ffmpeg = false;
  }
  let galleryVersion: string | null = null;
  try {
    const cmd = galleryCmd(["--version"]);
    const { stdout } = await exec(cmd.bin, cmd.args, {
      env: childEnv(),
      timeout: 20000,
    });
    galleryVersion = stdout.trim().replace(/^gallery-dl\s+/i, "") || null;
  } catch {
    galleryVersion = null;
  }
  const info = {
    ytdlp: Boolean(version),
    ffmpeg,
    gallerydl: Boolean(galleryVersion),
    version,
    galleryVersion,
  };
  engineCache = { at: Date.now(), info };
  return info;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapFormats(raw: unknown): ProbeFormat[] {
  if (!Array.isArray(raw)) return [];
  const formats: ProbeFormat[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const id = text(row.format_id);
    if (!id || id === "none") continue;
    const vcodec = text(row.vcodec) ?? "none";
    const acodec = text(row.acodec) ?? "none";
    const height = num(row.height);
    formats.push({
      id,
      ext: text(row.ext) ?? "",
      height,
      fps: num(row.fps),
      vcodec,
      acodec,
      filesize: num(row.filesize) ?? num(row.filesize_approx),
      note: text(row.format_note) ?? text(row.resolution) ?? "",
      videoOnly: vcodec !== "none" && acodec === "none",
      audioOnly: acodec !== "none" && vcodec === "none",
    });
  }
  const ranked = formats.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.id.localeCompare(a.id));
  const video = ranked.filter((row) => !row.audioOnly).slice(0, 18);
  const audio = ranked.filter((row) => row.audioOnly).slice(0, 6);
  return [...video, ...audio];
}

function summarizeProbe(data: Record<string, unknown>, locale: Locale): ProbeResult {
  const phrases = copy(locale);
  const kind = data._type === "playlist" ? "playlist" : "video";
  const entries = Array.isArray(data.entries) ? data.entries.map(asRecord).filter(Boolean) : [];
  const first = entries[0] ?? null;
  const source = kind === "video" ? data : (first ?? data);
  const formats = mapFormats(source.formats ?? data.formats);
  return {
    kind,
    title: text(data.title) ?? text(source.title) ?? phrases.unnamed,
    thumbnail: text(data.thumbnail) ?? text(source.thumbnail),
    duration: num(data.duration) ?? num(source.duration),
    uploader: text(data.uploader) ?? text(data.channel) ?? text(source.uploader),
    extractor: text(data.extractor_key) ?? text(data.extractor),
    id: text(data.id),
    entryCount: kind === "playlist" ? (num(data.playlist_count) ?? entries.length) : null,
    formats,
  };
}

function explainGalleryError(url: string, message: string, locale: Locale): string {
  const phrases = copy(locale);
  const host = imageHost(url);
  if (host === "pixiv" || /refresh-token|oauth:pixiv|AuthenticationError/i.test(message)) {
    return phrases.pixivNeed;
  }
  if (host === "x") return phrases.xNeed;
  return friendlyError(message, locale);
}

function readGallery(stdout: string, url: string, locale: Locale): Record<string, unknown>[] {
  const phrases = copy(locale);
  let value: unknown = null;
  const lines = stdout.split(/\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed !== "[" && !trimmed.startsWith("{")) continue;
    try {
      value = JSON.parse(lines.slice(index).join("\n"));
      break;
    } catch {
      value = null;
    }
  }
  if (value == null) return [];
  const rows: Record<string, unknown>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      if (node.length === 2 && node[0] === -1) {
        const err = asRecord(node[1]);
        const message = text(err?.message) ?? text(err?.error) ?? phrases.imageInfo;
        throw new Error(explainGalleryError(url, message, locale));
      }
      for (const item of node) visit(item);
      return;
    }
    const record = asRecord(node);
    if (!record || record.error) return;
    if (
      record.category ||
      record.filename ||
      record.extension ||
      record.content ||
      record.title ||
      record.id
    ) {
      rows.push(record);
    }
  };
  visit(value);
  return rows;
}

async function probeImages(url: string, locale: Locale): Promise<ProbeResult> {
  const phrases = copy(locale);
  const galleryArgs = [
    "--no-colors",
    "--no-input",
    "--dump-json",
    "--simulate",
    "--post-range",
    "1-3",
    url,
  ];
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const cmd = galleryCmd(galleryArgs);
    const child = spawn(cmd.bin, cmd.args, { env: childEnv(), detached: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      killGroup(child);
      reject(new Error(phrases.probeTimeout));
    }, 40000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 4_000_000) {
        killGroup(child);
        reject(new Error(phrases.imageTooBig));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.includes("{") && !out.includes("[")) {
        reject(new Error(friendlyError(err || out || phrases.imageInfo, locale)));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
  const rows = readGallery(stdout, url, locale);
  if (!rows.length) throw new Error(friendlyError(stderr || stdout || phrases.imageInfo, locale));
  const first = rows[0] ?? {};
  const user = asRecord(first.user) ?? asRecord(first.author);
  const rawTitle = text(first.content) ?? text(first.title) ?? text(first.description) ?? phrases.image;
  const idValue = first.id ?? first.tweet_id ?? first.post_id;
  return {
    kind: "images",
    title: rawTitle.replace(/\s+/g, " ").slice(0, 180),
    thumbnail: text(first.thumbnail),
    duration: null,
    uploader: text(user?.name) ?? text(user?.nick) ?? text(first.username) ?? text(first.user_name),
    extractor: text(first.category) ?? imageHost(url),
    id: typeof idValue === "number" ? String(idValue) : text(idValue),
    entryCount: rows.length,
    formats: [],
  };
}

export async function probeUrl(raw: string, locale: Locale = "zh"): Promise<ProbeResult> {
  const phrases = copy(locale);
  const url = validateUrl(raw, locale);
  await assertPublicHost(url, locale);
  if (imageHost(url)) return probeImages(url, locale);
  const args = [
    ...toolArgs(url),
    "--dump-single-json",
    "--skip-download",
    "--no-warnings",
    "--playlist-end",
    "1",
    url,
  ];

  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const cmd = ytdlpCmd(args);
    const child = spawn(cmd.bin, cmd.args, { env: childEnv(), detached: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      killGroup(child);
      reject(new Error(phrases.probeTimeout));
    }, 50000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 8_000_000) {
        killGroup(child);
        reject(new Error(phrases.videoTooBig));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.includes("{")) {
        reject(new Error(friendlyError(err || out || phrases.videoInfo, locale)));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });

  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(friendlyError(stderr || phrases.videoInfo, locale));
  const parsed = asRecord(JSON.parse(stdout.slice(start, end + 1)));
  if (!parsed) throw new Error(phrases.videoInfo);
  return summarizeProbe(parsed, locale);
}

export type JobRequest = {
  url: string;
  preset: string;
  playlistEnd?: number | null;
  formatId?: string | null;
  videoOnly?: boolean;
  cookies?: string;
  cookiesFromBrowser?: string | null;
  pixivToken?: string;
  title?: string;
  lang?: string;
};

export async function startJob(input: JobRequest): Promise<JobView> {
  const locale = parseLocale(input.lang);
  const phrases = copy(locale);
  const info = await getEngineInfo();
  if ([...store.jobs.values()].some((job) => job.status === "running")) {
    throw new Error(phrases.busy);
  }
  const url = validateUrl(input.url, locale);
  await assertPublicHost(url, locale);
  if (!isPresetId(input.preset)) throw new Error(phrases.badPreset);
  const preset: PresetId = input.preset;
  const image = isImagePreset(preset);
  const install = toolInstallHint(locale);
  if (image) {
    if (!info.gallerydl) throw new Error(`${phrases.noGallery} ${install}`);
  } else if (!info.ytdlp) {
    throw new Error(`${phrases.noYtdlp} ${install}`);
  }
  if ((preset === "mp3" || preset === "audio" || preset === "subs") && !info.ffmpeg) {
    throw new Error(`${phrases.noFfmpeg} ${install}`);
  }
  const cookies = (input.cookies ?? "").replaceAll("\0", "").slice(0, 200_000);
  const pixivToken = (input.pixivToken ?? "").trim();
  if (pixivToken && !/^[A-Za-z0-9._~-]{16,800}$/.test(pixivToken)) {
    throw new Error(phrases.badPixivToken);
  }
  if (image && imageHost(url) === "pixiv" && !pixivToken) {
    throw new Error(phrases.pixivNeed);
  }
  const title = (input.title ?? "").trim().slice(0, 180) || phrases.unnamed;
  await mkdir(ROOT, { recursive: true });
  await sweep();
  const id = randomUUID();
  const dir = path.join(ROOT, id);
  await mkdir(dir, { recursive: true });
  if (cookies.trim()) {
    await writeFile(path.join(dir, "cookies.txt"), cookies, { mode: 0o600 });
  }
  if (pixivToken) {
    await writeFile(
      path.join(dir, "gallery-config.json"),
      JSON.stringify({ extractor: { pixiv: { "refresh-token": pixivToken } } }),
      { mode: 0o600 },
    );
  }

  const job: Job = {
    id,
    url,
    preset,
    title,
    status: "running",
    percent: null,
    speed: null,
    eta: null,
    total: null,
    log: [],
    filename: null,
    bytes: null,
    error: null,
    warning: null,
    dir,
    filePath: null,
    child: null,
    startedAt: Date.now(),
    settled: false,
    locale,
    halted: false,
  };
  store.jobs.set(id, job);
  pushLog(job, phrases.presetLog(preset));

  const range =
    image && input.playlistEnd != null && Number.isFinite(input.playlistEnd)
      ? imagePostRange(preset, url, input.playlistEnd)
      : null;
  const rawArgs = image
    ? ["--no-colors", "--no-input", "--dest", dir, "--retries", "3"]
    : [
        ...toolArgs(url),
        "--newline",
        "--no-mtime",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--concurrent-fragments",
        "3",
        "-P",
        dir,
        // Recipe: yt-dlp -o "%(title)s.%(ext)s"
        "-o",
        "%(title)s.%(ext)s",
        // Recipe: merge DASH/HLS streams to mp4 (hd1080 / best merges)
        "--merge-output-format",
        "mp4",
        ...intentArgs({
          preset,
          // Full playlist by default; only cap when the user sets a limit
          playlistEnd:
            input.playlistEnd != null && Number.isFinite(input.playlistEnd)
              ? clampPlaylistEnd(input.playlistEnd)
              : null,
          formatId: safeFormatId(input.formatId),
          videoOnly: Boolean(input.videoOnly),
          withCookies: false,
        }),
      ];
  if (range) rawArgs.push("--post-range", range);
  if (pixivToken) rawArgs.push("--config-json", path.join(dir, "gallery-config.json"));
  if (cookies.trim()) rawArgs.push("--cookies", path.join(dir, "cookies.txt"));
  const browser = (input.cookiesFromBrowser ?? "").trim().toLowerCase();
  if (image && browser && ["chrome", "safari", "firefox", "edge"].includes(browser)) {
    rawArgs.push("--cookies-from-browser", browser);
  }
  if (image && preset === "illustrations") rawArgs.push("--filter", "type == 'illust'");
  if (!image && preset === "playlist") rawArgs.push("--ignore-errors");
  rawArgs.push(url);

  const cmd = image ? galleryCmd(rawArgs) : ytdlpCmd(rawArgs);
  const child = spawn(cmd.bin, cmd.args, { env: childEnv(), detached: true });
  job.child = child;
  attachPipes(job, child);

  const watchdog = setInterval(() => {
    void dirBytes(dir).then((bytes) => {
      if (bytes > MAX_BYTES && job.status === "running") {
        job.halted = true;
        job.error = phrases.tooBig;
        killGroup(child);
      }
    });
  }, 2000);
  const timeout = setTimeout(
    () => {
      if (job.status === "running") {
        job.halted = true;
        job.error = phrases.tooLong;
        killGroup(child);
      }
    },
    (image ? Boolean(range) : preset === "playlist") ? 20 * 60 * 1000 : 12 * 60 * 1000,
  );

  child.on("error", (error) => {
    clearInterval(watchdog);
    clearTimeout(timeout);
    job.status = "error";
    job.error = friendlyError(error.message, job.locale);
    job.child = null;
  });

  child.on("close", () => {
    clearInterval(watchdog);
    clearTimeout(timeout);
    job.child = null;
    void finishJob(job);
  });

  return publicJob(job);
}

async function finishJob(job: Job) {
  if (job.settled || job.status === "canceled") {
    job.settled = true;
    return;
  }
  job.settled = true;
  if (job.halted) {
    job.status = "error";
    await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  const files = (await walk(job.dir)).filter(deliverable);
  if (job.error && files.length === 0) {
    job.status = "error";
    return;
  }
  if (files.length === 0) {
    job.status = "error";
    job.error = job.error ?? friendlyError(job.log.at(-1) ?? copy(job.locale).noFile, job.locale);
    return;
  }
  try {
    let filePath = files[0]!;
    let filename = path.basename(filePath);
    if (files.length > 1) {
      filePath = path.join(job.dir, "_pack.zip");
      await zipDir(job.dir, filePath);
      const base = job.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || copy(job.locale).zipName;
      filename = `${base}.zip`;
    }
    const size = (await stat(filePath)).size;
    job.filePath = filePath;
    job.filename = filename;
    job.bytes = size;
    job.percent = 100;
    job.status = "done";
    if (job.error) {
      job.warning = job.error;
      job.error = null;
    }
    pushLog(job, copy(job.locale).doneLog(filename));
  } catch (error) {
    job.status = "error";
    job.error = error instanceof Error ? error.message : copy(job.locale).packFail;
  }
}

export function getJob(id: string): JobView | null {
  const job = store.jobs.get(id);
  return job ? publicJob(job) : null;
}

export function cancelJob(id: string): JobView | null {
  const job = store.jobs.get(id);
  if (!job) return null;
  if (job.status === "running") {
    job.status = "canceled";
    job.error = copy(job.locale).canceled;
    killGroup(job.child);
  }
  return publicJob(job);
}

export async function openJobFile(id: string, locale: Locale = "zh"): Promise<Response> {
  const phrases = copy(locale);
  const job = store.jobs.get(id);
  if (!job || job.status !== "done" || !job.filePath || !job.filename) {
    return Response.json({ error: phrases.fileNotReady }, { status: 404 });
  }
  const root = await realpath(job.dir);
  const file = await realpath(job.filePath);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    return Response.json({ error: phrases.fileBad }, { status: 400 });
  }
  const size = (await stat(file)).size;
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": contentType(job.filename),
      "content-length": String(size),
      "content-disposition": disposition(job.filename),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
