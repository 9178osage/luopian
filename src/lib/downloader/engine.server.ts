import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify, stripVTControlCharacters } from "node:util";

import { brewPathEnv, resolveTools } from "../../../cli/tools.mjs";
import {
  isQuality,
  normalizeYouTubeUrl,
  VIDEO_FILENAME,
  youtubeArgs,
} from "../../../shared/youtube.mjs";
import { parseLocale, type Locale } from "../i18n.ts";
import { downloadMessages } from "./messages.ts";
import { JOB_ID, jobJson } from "./request-guard.ts";
import type { EngineInfo, JobView } from "./types.ts";

const windows = process.platform === "win32";
const home = os.homedir();
const root = path.resolve(
  process.env.LUOPIAN_ROOT ||
    (process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Luopian", "jobs")
      : windows
        ? path.join(
            process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
            "Luopian",
            "jobs",
          )
        : path.join(os.tmpdir(), "luopian")),
);
const manifest = ".luopian-job.json";
const maxBytes = 2 * 1024 ** 3;
const keepFor = 3 * 60 * 60 * 1000;
const keepCount = 8;
const outputPrefix = "luopian-file:";
const progressPrefix = "luopian-progress:";
const exec = promisify(execFile);

type StopReason = "cancel" | "timeout" | "size" | "shutdown";

type SavedJob = {
  schema: 1;
  ownerPid: number;
  locale: Locale;
  finishedAt: number | null;
  view: JobView;
};

type Job = SavedJob & {
  dir: string;
  child: ChildProcess | null;
  settled: Promise<void> | null;
  committing: boolean;
  stopReason: StopReason | null;
  killTimer: NodeJS.Timeout | null;
  outputs: string[];
  toolError: string | null;
};

type Store = {
  jobs: Map<string, Job>;
  pending: Promise<JobView> | null;
  active: Job | null;
  loading: Promise<void> | null;
  pruning: Promise<void> | null;
  shuttingDown: boolean;
};

const store = ((globalThis as typeof globalThis & { __luopianVideo?: Store }).__luopianVideo ??= {
  jobs: new Map(),
  pending: null,
  active: null,
  loading: null,
  pruning: null,
  shuttingDown: false,
});

export class DownloadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function videoFilename(name: unknown): name is string {
  return (
    typeof name === "string" &&
    path.basename(name) === name &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    /\.(mp4|webm|mkv|m4v|3gp|mov|flv)$/i.test(name)
  );
}

function dataDir(job: Job) {
  return path.join(job.dir, "files");
}

function createJob(saved: SavedJob, dir: string): Job {
  return {
    ...saved,
    dir,
    child: null,
    settled: null,
    committing: false,
    stopReason: null,
    killTimer: null,
    outputs: [],
    toolError: null,
  };
}

function terminalView(
  job: Job,
  status: "done" | "canceled" | "error",
  error: string | null,
  result?: { filename: string; bytes: number },
): JobView {
  return {
    ...job.view,
    status,
    percent: status === "done" ? 100 : null,
    speed: null,
    eta: null,
    filename: result?.filename ?? null,
    bytes: result?.bytes ?? null,
    error,
  };
}

async function persist(job: Job, view = job.view, finishedAt = job.finishedAt) {
  const temporary = path.join(job.dir, `${manifest}.${randomUUID()}.tmp`);
  const data: SavedJob = {
    schema: 1,
    ownerPid: job.ownerPid,
    locale: job.locale,
    finishedAt,
    view,
  };
  try {
    await writeFile(temporary, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(job.dir, manifest));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readManifest(dir: string, id: string): Promise<SavedJob | null> {
  if (!JOB_ID.test(id)) return null;
  try {
    if (!(await lstat(dir)).isDirectory()) return null;
    const marker = path.join(dir, manifest);
    const details = await lstat(marker);
    if (!details.isFile() || details.size > 8192) return null;
    const saved = JSON.parse(await readFile(marker, "utf8")) as SavedJob;
    const view = saved?.view;
    if (
      saved?.schema !== 1 ||
      !Number.isSafeInteger(saved.ownerPid) ||
      saved.ownerPid <= 0 ||
      !["zh", "en"].includes(saved.locale) ||
      view?.id !== id ||
      !view.url ||
      normalizeYouTubeUrl(view.url) !== view.url ||
      !isQuality(view.quality) ||
      !Number.isFinite(view.startedAt) ||
      view.startedAt <= 0
    )
      return null;

    if (view.status === "running" || view.status === "canceling") {
      return saved.finishedAt === null ? saved : null;
    }
    if (!["done", "error", "canceled"].includes(view.status)) return null;
    if (
      typeof saved.finishedAt !== "number" ||
      !Number.isFinite(saved.finishedAt) ||
      saved.finishedAt < view.startedAt
    )
      return null;
    if (
      view.status === "done" &&
      (!videoFilename(view.filename) ||
        !view.bytes ||
        view.bytes < 0 ||
        !Number.isSafeInteger(view.bytes))
    )
      return null;
    return saved;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function loadJobs() {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const saved = await readManifest(dir, entry.name);
    if (!saved) continue;
    const job = createJob(saved, dir);
    if (job.finishedAt === null) {
      if (processIsAlive(job.ownerPid)) continue;
      job.view = terminalView(job, "error", downloadMessages(job.locale).interrupted);
      job.finishedAt = Math.max(job.view.startedAt, Date.now());
      await persist(job).catch(() => undefined);
    }
    if (job.view.status !== "done") {
      await rm(dataDir(job), { recursive: true, force: true }).catch(() => undefined);
    }
    store.jobs.set(entry.name, job);
  }
}

async function pruneJobs() {
  const cutoff = Date.now() - keepFor;
  let kept = 0;
  for (const job of [...store.jobs.values()].sort(byRecency)) {
    if (job.finishedAt === null || store.active === job) continue;
    if (job.finishedAt >= cutoff && ++kept <= keepCount) continue;
    if (await readManifest(job.dir, job.view.id)) {
      try {
        await rm(job.dir, { recursive: true, force: true });
      } catch {
        // Windows can hold a file open while it is being saved. Retry on the next pass.
        continue;
      }
    }
    store.jobs.delete(job.view.id);
  }
}

function schedulePrune() {
  store.pruning ??= pruneJobs().finally(() => {
    store.pruning = null;
  });
  return store.pruning;
}

let lastSweep = 0;

async function ready() {
  store.loading ??= loadJobs().catch((error: unknown) => {
    store.loading = null;
    throw error;
  });
  await store.loading;
  if (Date.now() - lastSweep >= 60_000) {
    lastSweep = Date.now();
    await schedulePrune();
  } else if (store.pruning) {
    await store.pruning;
  }
}

function byRecency(a: Job, b: Job) {
  return b.view.startedAt - a.view.startedAt;
}

type ResolvedTools = {
  command: string;
  prefix: string[];
  env: NodeJS.ProcessEnv;
  ffmpeg: string;
  nodeBin: string | null;
  info: EngineInfo;
};

let checkingTools: Promise<ResolvedTools> | null = null;
let toolCache: { expiresAt: number; tools: ResolvedTools } | null = null;

async function inspectTools(): Promise<ResolvedTools> {
  const tools = resolveTools();
  const vendor = process.env.LUOPIAN_VENDOR || path.resolve("vendor", "ytdlp");
  const vendorAvailable = existsSync(vendor);
  const env: NodeJS.ProcessEnv = vendorAvailable
    ? brewPathEnv({
        PYTHONPATH: [vendor, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONIOENCODING: "utf-8",
      })
    : brewPathEnv({ PYTHONIOENCODING: "utf-8" });
  if (tools.nodeBin !== process.execPath || !process.versions.electron) {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  const options = { env, timeout: 3500, maxBuffer: 64 * 1024, windowsHide: true };
  const checkVersion = (bin: string, prefix: string[]) =>
    exec(bin, [...prefix, "--version"], options)
      .then(({ stdout }) => stdout.trim().split("\n", 1)[0]?.slice(0, 80) || null)
      .catch(() => null);
  const checkDownloader = async () => {
    const version = await checkVersion(tools.ytdlp, []);
    if (version || process.env.LUOPIAN_YTDLP || !vendorAvailable) {
      return { command: tools.ytdlp, prefix: [], version };
    }
    const command = process.env.LUOPIAN_PYTHON || "python3";
    const prefix = ["-m", "yt_dlp"];
    return { command, prefix, version: await checkVersion(command, prefix) };
  };
  const [{ command, prefix, version }, ffmpeg] = await Promise.all([
    checkDownloader(),
    exec(tools.ffmpeg, ["-version"], options).then(
      () => true,
      () => false,
    ),
  ]);
  return {
    command,
    prefix,
    env,
    ffmpeg: tools.ffmpeg,
    nodeBin: tools.nodeBin,
    info: { ytdlp: Boolean(version), ffmpeg, version },
  };
}

async function getTools() {
  if (toolCache && Date.now() < toolCache.expiresAt) return toolCache.tools;
  checkingTools ??= inspectTools()
    .then((tools) => {
      const ttl = tools.info.ytdlp && tools.info.ffmpeg ? 30_000 : 2000;
      toolCache = { tools, expiresAt: Date.now() + ttl };
      return tools;
    })
    .finally(() => {
      checkingTools = null;
    });
  return checkingTools;
}

export async function getEngineInfo(): Promise<EngineInfo> {
  return (await getTools()).info;
}

function stopProcess(child: ChildProcess, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  const pid = child.pid;
  if (!pid) return;
  if (windows) {
    const task = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    task.on("error", () => child.kill());
    task.on("exit", (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

function stopJob(job: Job, reason: StopReason) {
  if (job.committing || job.stopReason !== null || job.view.status !== "running") return;
  job.stopReason = reason;
  job.view = { ...job.view, status: "canceling", speed: null, eta: null };
  const child = job.child;
  if (!child) return;
  stopProcess(child);
  if (!windows) {
    job.killTimer = setTimeout(() => stopProcess(child, "SIGKILL"), 1200);
    job.killTimer.unref();
  }
}

function watchLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void) {
  let tail = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    const lines = (tail + chunk).split(/\r?\n/);
    tail = (lines.pop() ?? "").slice(-8192);
    for (const line of lines) onLine(line);
  });
  stream?.on("end", () => {
    if (tail) onLine(tail);
  });
}

function recordLine(job: Job, line: string, stdout: boolean) {
  if (stdout && line.startsWith(outputPrefix)) {
    try {
      const output = JSON.parse(line.slice(outputPrefix.length)) as unknown;
      if (typeof output === "string" && job.outputs.length < 2) job.outputs.push(output);
    } catch {
      job.toolError ??= downloadMessages(job.locale).missingOutput;
    }
    return;
  }
  if (job.view.status === "running" && line.startsWith(progressPrefix)) {
    const [rawPercent, rawSpeed, rawEta] = line.slice(progressPrefix.length).split("|");
    const percent = Number.parseFloat(rawPercent ?? "");
    const display = (value?: string) =>
      value?.trim() && !/^(NA|Unknown)$/i.test(value.trim()) ? value.trim().slice(0, 24) : null;
    job.view = {
      ...job.view,
      percent: Number.isFinite(percent)
        ? Math.max(job.view.percent ?? 0, Math.min(99, percent))
        : job.view.percent,
      speed: display(rawSpeed),
      eta: display(rawEta),
    };
    return;
  }
  if (/^ERROR:/i.test(line.trimStart())) {
    job.toolError = stripVTControlCharacters(line)
      .trim()
      .replace(/^ERROR:\s*/i, "")
      .slice(0, 320);
  }
}

function explainFailure(job: Job): string {
  const messages = downloadMessages(job.locale);
  const detail = job.toolError;
  if (!detail) return messages.failed;
  if (/sign in|login|confirm you.re not a bot/i.test(detail)) return messages.restricted;
  if (/unavailable|private video|removed/i.test(detail)) return messages.unavailable;
  if (/requested format|no video formats/i.test(detail)) return messages.format;
  return detail;
}

async function inspectOutput(job: Job) {
  if (job.outputs.length !== 1) return null;
  const outputDir = dataDir(job);
  const output = path.resolve(outputDir, job.outputs[0]!);
  const filename = path.basename(output);
  if (path.relative(outputDir, path.dirname(output)) !== "" || !videoFilename(filename))
    return null;
  try {
    if (!(await lstat(outputDir)).isDirectory()) return null;
    const entries = await readdir(outputDir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0]?.isFile()) return null;
    const details = await lstat(output);
    return details.isFile() && details.size > 0 ? { filename, bytes: details.size } : null;
  } catch {
    return null;
  }
}

async function watchStagingSize(job: Job) {
  const dir = dataDir(job);
  let bytes = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const item = await lstat(path.join(dir, entry.name)).catch(() => null);
      bytes += item?.size ?? 0;
      if (bytes > maxBytes) {
        stopJob(job, "size");
        return;
      }
    }
  } catch {
    // A finished or canceled job may already have removed its staging directory.
  }
}

async function finishJob(job: Job, code: number | null, signal: NodeJS.Signals | null) {
  const messages = downloadMessages(job.locale);
  const result =
    !job.stopReason && code === 0 && !signal && !job.toolError ? await inspectOutput(job) : null;

  let view: JobView;
  if (job.stopReason === "cancel") {
    view = terminalView(job, "canceled", null);
  } else if (job.stopReason) {
    const key = job.stopReason === "shutdown" ? "interrupted" : job.stopReason;
    view = terminalView(job, "error", messages[key]);
  } else if (code !== 0 || signal || job.toolError) {
    view = terminalView(job, "error", explainFailure(job));
  } else if (!result || result.bytes > maxBytes) {
    view = terminalView(job, "error", result ? messages.size : messages.missingOutput);
  } else {
    view = terminalView(job, "done", null, result);
  }

  job.committing = true;
  const finishedAt = Math.max(job.view.startedAt, Date.now());
  try {
    await persist(job, view, finishedAt);
  } catch {
    if (view.status !== "canceled") view = terminalView(job, "error", messages.storage);
  }
  if (view.status !== "done") {
    await rm(dataDir(job), { recursive: true, force: true }).catch(() => undefined);
  }
  job.finishedAt = finishedAt;
  job.view = view;
  store.active = null;
}

function startDownloader(job: Job, tools: ResolvedTools) {
  const outputDir = dataDir(job);
  const child = spawn(
    tools.command,
    [
      ...tools.prefix,
      ...youtubeArgs({ quality: job.view.quality, ffmpeg: tools.ffmpeg, nodeBin: tools.nodeBin }),
      "--no-simulate",
      "--progress",
      "--progress-template",
      `download:${progressPrefix}%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s`,
      "--print",
      `after_move:${outputPrefix}%(filepath)j`,
      "-P",
      outputDir,
      "-o",
      VIDEO_FILENAME,
      "--",
      job.view.url,
    ],
    {
      cwd: outputDir,
      env: tools.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !windows,
      windowsHide: true,
    },
  );
  job.child = child;
  watchLines(child.stdout, (line) => recordLine(job, line, true));
  watchLines(child.stderr, (line) => recordLine(job, line, false));
  child.once("error", () => {
    job.toolError = downloadMessages(job.locale).missingTools;
  });

  let checking = false;
  const sizeTimer = setInterval(() => {
    if (checking || job.view.status !== "running") return;
    checking = true;
    void watchStagingSize(job).finally(() => {
      checking = false;
    });
  }, 2000);
  const timeTimer = setTimeout(() => stopJob(job, "timeout"), 12 * 60 * 1000);
  sizeTimer.unref();
  timeTimer.unref();

  job.settled = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      clearInterval(sizeTimer);
      clearTimeout(timeTimer);
      if (job.killTimer) {
        clearTimeout(job.killTimer);
        stopProcess(child, "SIGKILL");
      }
      job.child = null;
      void finishJob(job, code, signal).finally(() => {
        resolve();
        void schedulePrune();
      });
    });
  });
}

async function launch(url: string, quality: JobView["quality"], locale: Locale) {
  const messages = downloadMessages(locale);
  const tools = await getTools();
  if (!tools.info.ytdlp || !tools.info.ffmpeg) {
    throw new DownloadError(messages.missingTools, 503);
  }
  const id = randomUUID();
  const job = createJob(
    {
      schema: 1,
      ownerPid: process.pid,
      finishedAt: null,
      locale,
      view: {
        id,
        url,
        quality,
        status: "running",
        percent: null,
        speed: null,
        eta: null,
        filename: null,
        bytes: null,
        error: null,
        startedAt: Date.now(),
      },
    },
    path.join(root, id),
  );

  let created = false;
  try {
    await ready();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(job.dir, { mode: 0o700 });
    created = true;
    await mkdir(dataDir(job), { mode: 0o700 });
    await persist(job);
    if (store.shuttingDown) throw new DownloadError(messages.closing, 503);
    startDownloader(job, tools);
  } catch (error) {
    if (created) await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof DownloadError) throw error;
    throw new DownloadError(messages.storage, 500);
  }

  store.active = job;
  store.jobs.set(id, job);
  return job.view;
}

export async function startJob(input: { url?: unknown; quality?: unknown; lang?: unknown }) {
  const locale = parseLocale(input.lang);
  const messages = downloadMessages(locale);
  const url = typeof input.url === "string" ? normalizeYouTubeUrl(input.url) : null;
  if (!url) throw new DownloadError(messages.badUrl, 400);
  if (!isQuality(input.quality)) throw new DownloadError(messages.badQuality, 400);
  if (store.shuttingDown) throw new DownloadError(messages.closing, 503);
  if (store.pending || store.active) throw new DownloadError(messages.busy, 409);

  store.pending = launch(url, input.quality, locale);
  try {
    return await store.pending;
  } finally {
    store.pending = null;
  }
}

function hasExpired(job: Job) {
  return job.finishedAt !== null && Date.now() - job.finishedAt > keepFor;
}

export async function listJobs(): Promise<JobView[]> {
  await ready();
  let finished = 0;
  const recent = [...store.jobs.values()]
    .sort(byRecency)
    .filter((job) => !hasExpired(job) && (job.finishedAt === null || ++finished <= keepCount));
  return Promise.all(recent.map(currentView));
}

async function findJob(id: string) {
  if (!JOB_ID.test(id)) return null;
  await ready();
  const job = store.jobs.get(id);
  return job && !hasExpired(job) ? job : null;
}

export async function getJob(id: string) {
  const job = await findJob(id);
  return job ? currentView(job) : null;
}

export async function cancelJob(id: string) {
  const job = await findJob(id);
  if (!job) return null;
  if (job.committing) await job.settled;
  else stopJob(job, "cancel");
  return currentView(job);
}

async function locateFile(job: Job) {
  const { filename, status, bytes } = job.view;
  if (status !== "done" || !videoFilename(filename) || !bytes) return null;
  const dir = dataDir(job);
  try {
    if (!(await lstat(job.dir)).isDirectory() || !(await lstat(dir)).isDirectory()) return null;
    const filePath = path.join(dir, filename);
    const details = await lstat(filePath);
    return details.isFile() && details.size === bytes ? { filePath, filename, bytes } : null;
  } catch {
    return null;
  }
}

async function currentView(job: Job) {
  if (job.view.status === "done" && !(await locateFile(job))) {
    return terminalView(job, "error", downloadMessages(job.locale).missingFile);
  }
  return job.view;
}

function contentType(filename: string) {
  switch (path.extname(filename).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

export async function openJobFile(id: string, locale: Locale = "zh"): Promise<Response> {
  const missing = () => jobJson({ error: downloadMessages(locale).missingFile }, 404);
  const job = await findJob(id);
  const output = job ? await locateFile(job) : null;
  if (!output) return missing();
  const { filename, filePath, bytes } = output;
  try {
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const details = await file.stat();
      if (!details.isFile() || details.size !== bytes) {
        await file.close();
        return missing();
      }
      const printable = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "") || "video";
      const encoded = encodeURIComponent(filename).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      const body = Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
      return new Response(body, {
        headers: {
          "content-type": contentType(filename),
          "content-length": String(details.size),
          "content-disposition": `attachment; filename="${printable}"; filename*=UTF-8''${encoded}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      await file.close().catch(() => undefined);
      return missing();
    }
  } catch {
    return missing();
  }
}

export async function shutdownDownloads() {
  store.shuttingDown = true;
  await store.pending?.catch(() => undefined);
  const job = store.active;
  if (!job) return;
  stopJob(job, "shutdown");
  await job.settled;
}

const shutdownKey = Symbol.for("luopian.shutdownDownloads");
const runtime = globalThis as Record<symbol, unknown>;
if (!runtime[shutdownKey]) {
  const halt = () => {
    void shutdownDownloads().finally(() => process.exit(0));
  };
  if (process.env.LUOPIAN_DESKTOP !== "1") {
    process.prependOnceListener("SIGTERM", halt);
    process.prependOnceListener("SIGINT", halt);
  }
  process.once("exit", () => {
    const pid = store.active?.child?.pid;
    if (!pid) return;
    if (windows) {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      });
    } else {
      stopProcess(store.active!.child!, "SIGKILL");
    }
  });
}
runtime[shutdownKey] = shutdownDownloads;
