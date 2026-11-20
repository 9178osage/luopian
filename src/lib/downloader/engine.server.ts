import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { promisify, stripVTControlCharacters } from "node:util";

import { brewPathEnv, resolveTools } from "../../../cli/tools.mjs";
import { processIsAlive } from "../../../shared/process-lifetime.mjs";
import {
  downloadDirectFile,
  FileDownloadError,
  hasDirectCheckpoint,
  safeFilename,
} from "../../../shared/direct-download.mjs";
import {
  isOutput,
  isQuality,
  isVideoScratch,
  MAX_BATCH_URLS,
  normalizeFileUrl,
  normalizeVideoUrl,
  outputExtension,
  resolveVideoUrl,
  videoArgs,
  videoFilename,
  type Output,
} from "../../../shared/video.mjs";
import { parseLocale, type Locale } from "../i18n.ts";
import { downloadMessages } from "./messages.ts";
import { JOB_ID, jobJson } from "./request-guard.ts";
import type { EngineInfo, FileDownloader, JobView } from "./types.ts";

const windows = process.platform === "win32";
const desktop = process.env.LUOPIAN_DESKTOP === "1";
const home = os.homedir();
const root = path.resolve(
  process.env.LUOPIAN_ROOT ||
    (!desktop
      ? path.join(os.tmpdir(), "luopian-preview")
      : process.platform === "darwin"
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
const minimumFreeBytes = 512n * 1024n ** 2n;
const previewMaxBytes = 2 * 1024 ** 3;
const keepFor = 3 * 60 * 60 * 1000;
const queueLimit = 100;
const keepCount = queueLimit;
const outputPrefix = "luopian-file:";
const progressPrefix = "luopian-progress:";
const exec = promisify(execFile);

type StopReason = "cancel" | "space" | "timeout" | "size" | "shutdown";
type Settings = { quality: JobView["quality"]; output?: Output; file?: FileDownloader };

type SavedJob = {
  schema: 1;
  ownerPid: number;
  locale: Locale;
  finishedAt: number | null;
  queueOrder?: number;
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
  diskWriteFailed: boolean;
};

type Store = {
  jobs: Map<string, Job>;
  pending: Promise<JobView> | null;
  active: Job | null;
  loading: Promise<void> | null;
  pruning: Promise<void> | null;
  pruneTimer: NodeJS.Timeout | null;
  mutations: Promise<void>;
  pump: Promise<void> | null;
  nextQueueOrder: number;
  shuttingDown: boolean;
};

const store = ((globalThis as typeof globalThis & { __luopianVideo?: Store }).__luopianVideo ??= {
  jobs: new Map(),
  pending: null,
  active: null,
  loading: null,
  pruning: null,
  pruneTimer: null,
  mutations: Promise.resolve(),
  pump: null,
  nextQueueOrder: 1,
  shuttingDown: false,
});
// Vite can retain an older queue in the same process while reloading this module.
store.mutations ??= Promise.resolve();
store.pump ??= null;
store.pruneTimer ??= null;
store.nextQueueOrder ??=
  1 + Math.max(0, ...Array.from(store.jobs.values(), (job) => job.queueOrder ?? 0));

export class DownloadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function validOutputFilename(name: unknown, { output, file }: Settings): name is string {
  return (
    typeof name === "string" &&
    path.basename(name) === name &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    (file
      ? name === safeFilename(name)
      : output === undefined
        ? /\.(mp4|webm|mkv|m4v|3gp|mov|flv)$/i.test(name)
        : path.extname(name).toLowerCase() === `.${outputExtension(output)}`)
  );
}

function dataDir(job: Job) {
  return path.join(job.dir, "files");
}

function transferDir(job: Job) {
  return path.join(job.dir, "transfer");
}

async function discardFiles(job: Job) {
  const dirs = job.view.file ? [dataDir(job), transferDir(job)] : [dataDir(job)];
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
}

async function hasCheckpoint(job: Job) {
  if (!desktop) return false;
  try {
    if (job.view.file) return await hasDirectCheckpoint(transferDir(job), job.view.url);
    const directory = dataDir(job);
    if (!(await lstat(directory)).isDirectory()) return false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        isVideoScratch(entry.name) &&
        (await lstat(path.join(directory, entry.name))).size > 0
      )
        return true;
    }
    return false;
  } catch {
    return false;
  }
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
    diskWriteFailed: false,
  };
}

function terminalView(
  job: Job,
  status: "done" | "canceled" | "error",
  error: string | null,
  result?: { filename: string; bytes: number },
): JobView {
  const view: JobView = {
    ...job.view,
    status,
    percent: status === "done" ? 100 : null,
    speed: null,
    eta: null,
    filename: result?.filename ?? null,
    bytes: result?.bytes ?? null,
    error,
  };
  delete view.resumable;
  return view;
}

async function persist(job: Job, view = job.view, finishedAt = job.finishedAt) {
  const temporary = path.join(job.dir, `${manifest}.${randomUUID()}.tmp`);
  const data: SavedJob = {
    schema: 1,
    ownerPid: job.ownerPid,
    locale: job.locale,
    finishedAt,
    queueOrder: job.queueOrder,
    view,
  };
  try {
    await writeFile(temporary, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(job.dir, manifest));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function nullable<T>(value: unknown, check: (value: unknown) => value is T) {
  return value === null || check(value);
}

const isText = (value: unknown): value is string => typeof value === "string";

// Every field rendered by the download list must have its declared type, or one
// damaged manifest could break the whole page.
function validViewFields(view: JobView) {
  return (
    ["queued", "running", "canceling", "done", "error", "canceled"].includes(view.status) &&
    nullable(
      view.percent,
      (value): value is number => typeof value === "number" && value >= 0 && value <= 100,
    ) &&
    nullable(view.speed, isText) &&
    nullable(view.eta, isText) &&
    nullable(view.filename, isText) &&
    nullable(view.error, isText) &&
    nullable(
      view.bytes,
      (value): value is number => Number.isSafeInteger(value) && (value as number) >= 0,
    )
  );
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
    const file = view?.file;
    if (
      saved?.schema !== 1 ||
      !Number.isSafeInteger(saved.ownerPid) ||
      saved.ownerPid <= 0 ||
      !["zh", "en"].includes(saved.locale) ||
      view?.id !== id ||
      typeof view.url !== "string" ||
      !view.url ||
      !validViewFields(view) ||
      (file === undefined
        ? normalizeVideoUrl(view.url) !== view.url
        : !desktop ||
          (file !== "curl" && file !== "aria2") ||
          normalizeFileUrl(view.url) !== view.url) ||
      (view.url.startsWith("https://b23.tv/") &&
        !["queued", "error", "canceled"].includes(view.status)) ||
      !isQuality(view.quality) ||
      (view.output !== undefined && !isOutput(view.output)) ||
      (view.resumable !== undefined && typeof view.resumable !== "boolean") ||
      (view.retryOf !== undefined && (!JOB_ID.test(view.retryOf) || view.retryOf === id)) ||
      !Number.isFinite(view.startedAt) ||
      view.startedAt <= 0
    )
      return null;

    if (view.status === "queued") {
      const order = saved.queueOrder;
      return saved.finishedAt === null &&
        typeof order === "number" &&
        Number.isSafeInteger(order) &&
        order > 0
        ? saved
        : null;
    }
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
      (!validOutputFilename(view.filename, view) ||
        view.bytes === null ||
        view.bytes < (file ? 0 : 1) ||
        !Number.isSafeInteger(view.bytes))
    )
      return null;
    return saved;
  } catch {
    return null;
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
    if (job.view.status === "queued") {
      if (job.ownerPid !== process.pid && processIsAlive(job.ownerPid)) continue;
      job.ownerPid = process.pid;
      store.nextQueueOrder = Math.max(store.nextQueueOrder, job.queueOrder! + 1);
    } else if (job.finishedAt === null) {
      if (processIsAlive(job.ownerPid)) continue;
      job.view = terminalView(job, "error", downloadMessages(job.locale).interrupted);
      if (await hasCheckpoint(job)) job.view.resumable = true;
      job.finishedAt = Math.max(job.view.startedAt, Date.now());
      await persist(job).catch(() => undefined);
    }
    if (job.view.status !== "done" && !job.view.resumable) await discardFiles(job);
    store.jobs.set(entry.name, job);
  }
}

async function pruneJobs() {
  const cutoff = Date.now() - keepFor;
  let kept = 0;
  for (const job of [...store.jobs.values()].sort(byRecency)) {
    if (job.finishedAt === null || store.active === job) continue;
    if (job.finishedAt >= cutoff && ++kept <= keepCount) continue;
    const saved = await readManifest(job.dir, job.view.id);
    if (job.finishedAt === null || store.jobs.get(job.view.id) !== job) continue;
    if (saved) {
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
    armPruneTimer();
  });
  return store.pruning;
}

// Expired folders are removed on time even when no window is polling the service.
function armPruneTimer() {
  if (store.pruneTimer) clearTimeout(store.pruneTimer);
  store.pruneTimer = null;
  if (store.shuttingDown) return;
  let next = Infinity;
  for (const job of store.jobs.values()) {
    if (job.finishedAt !== null) next = Math.min(next, job.finishedAt + keepFor);
  }
  if (next === Infinity) return;
  const now = Date.now();
  // A folder that could not be removed yet (Windows file locks) is retried once a minute.
  const delay = next > now ? next - now + 1000 : 60_000;
  store.pruneTimer = setTimeout(
    () => {
      store.pruneTimer = null;
      void schedulePrune();
    },
    Math.min(delay, 2 ** 31 - 1),
  );
  store.pruneTimer.unref();
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
  kickQueue();
}

function byRecency(a: Job, b: Job) {
  return b.view.startedAt - a.view.startedAt;
}

type ResolvedTools = {
  command: string;
  prefix: string[];
  env: NodeJS.ProcessEnv;
  ffmpeg: string;
  curl: string;
  aria2: string | null;
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
  const [{ command, prefix, version }, ffmpeg, curl, aria2] = await Promise.all([
    checkDownloader(),
    exec(tools.ffmpeg, ["-version"], options).then(
      () => true,
      () => false,
    ),
    desktop ? checkVersion(tools.curl, ["--disable"]) : null,
    desktop && tools.aria2 ? checkVersion(tools.aria2, ["--no-conf=true"]) : null,
  ]);
  return {
    command,
    prefix,
    env,
    ffmpeg: tools.ffmpeg,
    curl: tools.curl,
    aria2: aria2 ? tools.aria2 : null,
    nodeBin: tools.nodeBin,
    info: {
      ytdlp: Boolean(version),
      ffmpeg,
      version,
      files: desktop,
      curl: Boolean(curl),
      aria2: Boolean(aria2),
    },
  };
}

export async function getTools(refresh = false) {
  if (!refresh && toolCache && Date.now() < toolCache.expiresAt) return toolCache.tools;
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

export async function getEngineInfo(refresh = false): Promise<EngineInfo> {
  return (await getTools(refresh)).info;
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
  const detail = stripVTControlCharacters(line).trim();
  if (
    desktop &&
    /\b(?:ENOSPC|EDQUOT)\b|no space left on (?:the )?device|not enough space on the disk|disk quota exceeded|the disk is full/i.test(
      detail,
    )
  ) {
    job.diskWriteFailed = true;
  }
  if (/^ERROR:/i.test(detail)) {
    job.toolError = detail.replace(/^ERROR:\s*/i, "").slice(0, 320);
  }
}

function explainFailure(job: Job): string {
  const messages = downloadMessages(job.locale);
  const detail = job.toolError;
  if (job.view.file) return detail ?? messages.fileFailed;
  if (!detail) return messages.failed;
  if (/sign[ -]?in|log[ -]?in|confirm you.re not a bot/i.test(detail)) return messages.restricted;
  if (/unavailable|private video|removed/i.test(detail)) return messages.unavailable;
  if (/requested format|no video formats/i.test(detail)) {
    return job.view.output === "mp3" ? messages.audioFormat : messages.format;
  }
  return detail;
}

async function inspectOutput(job: Job) {
  if (job.outputs.length !== 1) return null;
  const outputDir = dataDir(job);
  const output = path.resolve(outputDir, job.outputs[0]!);
  const filename = path.basename(output);
  if (
    path.relative(outputDir, path.dirname(output)) !== "" ||
    !validOutputFilename(filename, job.view)
  )
    return null;
  try {
    if (!(await lstat(outputDir)).isDirectory()) return null;
    const entries = await readdir(outputDir, { withFileTypes: true });
    const extras = entries.filter((entry) => entry.name !== filename);
    if (
      extras.some(
        (entry) =>
          !job.view.resumable || job.view.file || !entry.isFile() || !isVideoScratch(entry.name),
      )
    )
      return null;
    const details = await lstat(output);
    if (!details.isFile() || (!job.view.file && details.size === 0)) return null;
    await Promise.all(
      extras.map(({ name }) =>
        rm(path.join(outputDir, name), { force: true }).catch(() => undefined),
      ),
    );
    return { filename, bytes: details.size };
  } catch {
    return null;
  }
}

async function diskIsLow(directory: string) {
  try {
    const { bavail, bsize } = await statfs(directory, { bigint: true });
    return bsize > 0n && bavail * bsize < minimumFreeBytes;
  } catch {
    // The filesystem may not report capacity. The downloader still reports write failures.
    return false;
  }
}

async function previewIsOverSize(directory: string) {
  let bytes = 0;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const item = await lstat(path.join(directory, entry.name)).catch(() => null);
      bytes += item?.size ?? 0;
      if (bytes > previewMaxBytes) return true;
    }
  } catch {
    // A finished or canceled job may already have removed its staging directory.
  }
  return false;
}

async function finishJob(job: Job, code: number | null, signal: NodeJS.Signals | null) {
  const messages = downloadMessages(job.locale);
  const toolFailed = code !== 0 || signal !== null || job.toolError !== null;
  const diskFull =
    job.stopReason === "space" || (!job.stopReason && toolFailed && job.diskWriteFailed);
  const result = !job.stopReason && !toolFailed ? await inspectOutput(job) : null;

  let view: JobView;
  if (job.stopReason === "cancel") {
    view = terminalView(job, "canceled", null);
  } else if (diskFull) {
    view = terminalView(job, "error", messages.space);
  } else if (job.stopReason) {
    const key = job.stopReason === "shutdown" ? "interrupted" : job.stopReason;
    view = terminalView(job, "error", messages[key]);
  } else if (toolFailed) {
    view = terminalView(job, "error", explainFailure(job));
  } else if (!result || (!desktop && result.bytes > previewMaxBytes)) {
    view = terminalView(job, "error", result ? messages.size : messages.missingOutput);
  } else {
    view = terminalView(job, "done", null, result);
  }

  job.committing = true;
  const finishedAt = Math.max(job.view.startedAt, Date.now());
  if (
    view.status === "error" &&
    !diskFull &&
    (toolFailed || job.stopReason === "shutdown") &&
    (await hasCheckpoint(job))
  ) {
    view.resumable = true;
  }
  if (diskFull) {
    await discardFiles(job);
  }
  try {
    await persist(job, view, finishedAt);
  } catch {
    if (view.status !== "canceled" && !diskFull)
      view = terminalView(job, "error", messages.storage);
  }
  if (view.status !== "done" && !diskFull) {
    if (!view.resumable) await discardFiles(job);
    else if (job.view.file)
      await rm(dataDir(job), { recursive: true, force: true }).catch(() => undefined);
  } else if (view.status === "done" && job.view.file) {
    await rm(transferDir(job), { recursive: true, force: true }).catch(() => undefined);
  }
  job.finishedAt = finishedAt;
  job.view = view;
  store.active = null;
}

function trackChild(job: Job, child: ChildProcess | null) {
  if (!child && job.child && job.killTimer) {
    clearTimeout(job.killTimer);
    job.killTimer = null;
    stopProcess(job.child, "SIGKILL");
  }
  job.child = child;
}

function runVideoDownload(job: Job, tools: ResolvedTools) {
  const outputDir = dataDir(job);
  const { url, quality, output = "mp4" } = job.view;
  const child = spawn(
    tools.command,
    [
      ...tools.prefix,
      ...videoArgs({
        url,
        quality,
        ffmpeg: tools.ffmpeg,
        nodeBin: tools.nodeBin,
        output,
      }),
      "--continue",
      "--no-simulate",
      "--progress",
      "--progress-template",
      `download:${progressPrefix}%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s`,
      "--print",
      `after_move:${outputPrefix}%(filepath)j`,
      "-P",
      outputDir,
      "-o",
      videoFilename(output, quality),
      "--",
      url,
    ],
    {
      cwd: outputDir,
      env: tools.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !windows,
      windowsHide: true,
    },
  );
  trackChild(job, child);
  watchLines(child.stdout, (line) => recordLine(job, line, true));
  watchLines(child.stderr, (line) => recordLine(job, line, false));
  child.once("error", () => {
    job.toolError = downloadMessages(job.locale).missingTools;
  });

  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      trackChild(job, null);
      resolve({ code, signal });
    });
  });
}

async function runFileDownload(job: Job, tools: ResolvedTools) {
  const messages = downloadMessages(job.locale);
  try {
    const { filename, part } = await downloadDirectFile({
      url: job.view.url,
      directory: transferDir(job),
      curl: tools.curl,
      aria2: job.view.file === "aria2" ? tools.aria2 : null,
      env: tools.env,
      checkActive: () => {
        if (job.stopReason) throw new Error("Download stopped");
      },
      onProcess: (child) => trackChild(job, child),
      onProgress: ({ percent, speed, eta }) => {
        if (job.view.status !== "running") return;
        job.view = {
          ...job.view,
          percent: Math.min(99, percent),
          speed: speed ?? null,
          eta: eta ?? null,
        };
      },
    });
    if (!job.stopReason) {
      await rename(part, path.join(dataDir(job), filename));
      job.outputs.push(filename);
    }
    return { code: 0, signal: null };
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    const failure = cause instanceof FileDownloadError ? cause.kind : null;
    job.diskWriteFailed =
      error.code === "ENOSPC" ||
      error.code === "EDQUOT" ||
      failure === "space" ||
      (failure === "write" && (await diskIsLow(job.dir)));
    job.toolError =
      cause instanceof FileDownloadError
        ? cause.kind === "webpage"
          ? messages.fileWebpage
          : cause.kind === "http" && cause.status
            ? messages.fileHttp(cause.status)
            : failure === "write"
              ? messages.storage
              : messages.fileFailed
        : error.code === "ENOENT"
          ? messages.missingCurl
          : messages.fileFailed;
    return { code: 1, signal: null };
  }
}

function startDownloader(job: Job, tools: ResolvedTools) {
  const outputDir = dataDir(job);
  const transfer = job.view.file ? runFileDownload(job, tools) : runVideoDownload(job, tools);

  const storageCheck = desktop ? diskIsLow : previewIsOverSize;
  const storageLimitReason = desktop ? "space" : "size";
  let checking = false;
  const storageTimer = setInterval(async () => {
    if (checking || job.view.status !== "running") return;
    checking = true;
    try {
      const shouldStop = await storageCheck(outputDir);
      if (shouldStop && store.active === job) stopJob(job, storageLimitReason);
    } finally {
      checking = false;
    }
  }, 2000);
  const timeTimer = desktop
    ? null
    : setTimeout(() => stopJob(job, "timeout"), 12 * 60 * 1000).unref();
  storageTimer.unref();

  job.settled = transfer
    .then(async ({ code, signal }) => {
      clearInterval(storageTimer);
      if (timeTimer) clearTimeout(timeTimer);
      await finishJob(job, code, signal);
    })
    .finally(() => {
      void schedulePrune();
      kickQueue();
    });
}

function newJob(url: string, settings: Settings, locale: Locale, queueOrder?: number) {
  const id = randomUUID();
  return createJob(
    {
      schema: 1,
      ownerPid: process.pid,
      finishedAt: null,
      queueOrder,
      locale,
      view: {
        id,
        url,
        ...settings,
        status: queueOrder === undefined ? "running" : "queued",
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
}

function requireOpen(locale: Locale) {
  if (store.shuttingDown) throw new DownloadError(downloadMessages(locale).closing, 503);
}

function requireTools(tools: ResolvedTools, locale: Locale, file?: FileDownloader) {
  if (file) {
    if (!tools.info.curl) throw new DownloadError(downloadMessages(locale).missingCurl, 503);
    return;
  }
  if (!tools.info.ytdlp || !tools.info.ffmpeg) {
    throw new DownloadError(downloadMessages(locale).missingTools, 503);
  }
}

function asStorageError(error: unknown, locale: Locale) {
  if (error instanceof DownloadError) return error;
  const messages = downloadMessages(locale);
  const code = (error as NodeJS.ErrnoException)?.code;
  return desktop && (code === "ENOSPC" || code === "EDQUOT")
    ? new DownloadError(messages.space, 507)
    : new DownloadError(messages.storage, 500);
}

async function prepareFiles(job: Job) {
  const staging = dataDir(job);
  await mkdir(staging, { mode: 0o700, recursive: true });
  if (!(await lstat(staging)).isDirectory()) throw new Error("Invalid download directory");
  if (desktop && (await diskIsLow(staging))) {
    throw new DownloadError(downloadMessages(job.locale).space, 507);
  }
}

async function launch(normalized: string, settings: Settings, locale: Locale) {
  const [url, tools] = await Promise.all([
    settings.file ? normalized : resolveVideoUrl(normalized),
    getTools(),
  ]);
  if (!url) throw new DownloadError(downloadMessages(locale).shortLink, 422);
  requireTools(tools, locale, settings.file);
  requireOpen(locale);
  const job = newJob(url, settings, locale);

  let created = false;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(job.dir, { mode: 0o700 });
    created = true;
    await prepareFiles(job);
    await persist(job);
    requireOpen(locale);
    startDownloader(job, tools);
  } catch (error) {
    if (created) await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
    throw asStorageError(error, locale);
  }

  store.active = job;
  store.jobs.set(job.view.id, job);
  return job.view;
}

function mutate<T>(update: () => Promise<T>) {
  const completed = store.mutations.then(update);
  store.mutations = completed.then(
    () => undefined,
    () => undefined,
  );
  return completed;
}

function queuedJobs() {
  return [...store.jobs.values()]
    .filter((job) => job.view.status === "queued")
    .sort((a, b) => a.queueOrder! - b.queueOrder!);
}

async function launchQueued(job: Job) {
  try {
    const [url, tools] = await Promise.all([
      job.view.file ? job.view.url : resolveVideoUrl(job.view.url),
      getTools(),
    ]);
    if (store.shuttingDown || job.stopReason === "cancel") return;
    if (!url) throw new DownloadError(downloadMessages(job.locale).shortLink, 422);
    requireTools(tools, job.locale, job.view.file);
    await prepareFiles(job);
    if (!store.shuttingDown && job.stopReason === null) {
      const running: JobView = { ...job.view, url, status: "running" };
      await persist(job, running);
      if (!store.shuttingDown && job.stopReason === null) {
        job.view = running;
        startDownloader(job, tools);
        store.active = job;
        return;
      }
      // A cancellation or shutdown reached the job before its process spawned.
      await persist(job);
    }
    if (!job.view.resumable) await discardFiles(job);
  } catch (error) {
    if (job.stopReason === "cancel") return;
    const failure = asStorageError(error, job.locale);
    const view = terminalView(job, "error", failure.message);
    if (failure.status !== 507 && (await hasCheckpoint(job))) view.resumable = true;
    else await discardFiles(job);
    const finishedAt = Math.max(job.view.startedAt, Date.now());
    await persist(job, view, finishedAt).catch(() => undefined);
    job.view = view;
    job.finishedAt = finishedAt;
    void schedulePrune();
  }
}

function kickQueue() {
  if (store.shuttingDown || store.pending || store.active || store.pump || !queuedJobs().length) {
    return;
  }
  store.pump = mutate(async () => {
    if (store.shuttingDown || store.pending || store.active) return;
    const [next] = queuedJobs();
    if (next) await launchQueued(next);
  }).finally(() => {
    store.pump = null;
    kickQueue();
  });
}

function downloadSettings(qualityValue: unknown, outputValue: unknown, locale: Locale) {
  const messages = downloadMessages(locale);
  const output = outputValue === undefined ? "mp4" : outputValue;
  if (!isOutput(output)) throw new DownloadError(messages.badOutput, 400);
  const quality = output === "mp3" ? "best" : qualityValue;
  if (!isQuality(quality)) throw new DownloadError(messages.badQuality, 400);
  return { output, quality };
}

function normalizeRequestUrl(raw: unknown, locale: Locale) {
  const video = normalizeVideoUrl(raw);
  if (video) return { url: video, file: false };
  if (desktop) {
    const file = normalizeFileUrl(raw);
    if (file) return { url: file, file: true };
  }
  const messages = downloadMessages(locale);
  throw new DownloadError(desktop ? messages.badDownloadUrl : messages.badUrl, 400);
}

function fileSettings(accelerate: unknown, locale: Locale): Settings {
  if (accelerate !== undefined && typeof accelerate !== "boolean") {
    throw new DownloadError(downloadMessages(locale).badAcceleration, 400);
  }
  return { quality: "best", file: accelerate ? "aria2" : "curl" };
}

function requireCapacity(count: number, locale: Locale) {
  if (queuedJobs().length + Number(store.active !== null) + count > queueLimit) {
    throw new DownloadError(downloadMessages(locale).queueFull(queueLimit), 409);
  }
}

async function acceptQueued(
  requests: { url: string; settings: Settings; retryOf?: string }[],
  locale: Locale,
) {
  requireOpen(locale);
  const jobs = requests.map(({ url, settings, retryOf }) => {
    const job = newJob(url, settings, locale, store.nextQueueOrder++);
    if (retryOf) job.view.retryOf = retryOf;
    return job;
  });
  const created = [];
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const job of jobs) {
      await mkdir(job.dir, { mode: 0o700 });
      created.push(job.dir);
      await persist(job);
    }
  } catch (error) {
    await Promise.all(
      created.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
    throw asStorageError(error, locale);
  }

  for (const job of jobs) store.jobs.set(job.view.id, job);
  kickQueue();
  return jobs.map((job) => job.view);
}

export async function enqueueJobs(input: {
  urls?: unknown;
  quality?: unknown;
  output?: unknown;
  accelerate?: unknown;
  lang?: unknown;
}) {
  const locale = parseLocale(input.lang);
  const messages = downloadMessages(locale);
  if (!Array.isArray(input.urls) || !input.urls.length || input.urls.length > MAX_BATCH_URLS) {
    throw new DownloadError(messages.badBatch(MAX_BATCH_URLS), 400);
  }
  const normalized = input.urls.map((raw) => normalizeRequestUrl(raw, locale));
  const files = fileSettings(input.accelerate, locale);
  const videos = normalized.some((item) => !item.file)
    ? downloadSettings(input.quality === undefined ? "best" : input.quality, input.output, locale)
    : files;
  const requests = normalized.map(({ url, file }) => ({ url, settings: file ? files : videos }));
  requireOpen(locale);
  return mutate(async () => {
    await ready();
    requireOpen(locale);
    requireCapacity(normalized.length, locale);
    return acceptQueued(requests, locale);
  });
}

export async function startJob(input: {
  url?: unknown;
  quality?: unknown;
  output?: unknown;
  accelerate?: unknown;
  lang?: unknown;
}) {
  const locale = parseLocale(input.lang);
  const messages = downloadMessages(locale);
  const { url, file } = normalizeRequestUrl(input.url, locale);
  const settings = file
    ? fileSettings(input.accelerate, locale)
    : downloadSettings(input.quality, input.output, locale);
  requireOpen(locale);
  if (store.pending || store.active) throw new DownloadError(messages.busy, 409);

  store.pending = mutate(async () => {
    await ready();
    requireOpen(locale);
    if (queuedJobs().length) throw new DownloadError(messages.busy, 409);
    return launch(url, settings, locale);
  });
  try {
    return await store.pending;
  } finally {
    store.pending = null;
    kickQueue();
  }
}

function hasExpired(job: Job) {
  return job.finishedAt !== null && Date.now() - job.finishedAt > keepFor;
}

export async function listJobs(): Promise<JobView[]> {
  await ready();
  let finished = 0;
  const recent = [...store.jobs.values()]
    .filter((job) => job.view.status !== "queued")
    .sort(byRecency)
    .filter((job) => !hasExpired(job) && (job.finishedAt === null || ++finished <= keepCount));
  return Promise.all([...recent, ...queuedJobs()].map(currentView));
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
  if (job.view.status === "queued") {
    job.stopReason = "cancel";
    return mutate(async () => {
      if (job.view.status === "queued") {
        // Leave the queue in memory first, so a failed write can never let this job start.
        job.view = terminalView(job, "canceled", null);
        job.finishedAt = Math.max(job.view.startedAt, Date.now());
        try {
          await persist(job);
          await discardFiles(job);
        } catch (error) {
          // Without its manifest, a restart cannot pick the job up again either.
          await rm(job.dir, { recursive: true, force: true }).catch(() => {
            throw asStorageError(error, job.locale);
          });
        } finally {
          void schedulePrune();
          kickQueue();
        }
      } else if (!job.committing) {
        stopJob(job, "cancel");
      }
      return currentView(job);
    });
  }
  if (job.committing) await job.settled;
  else stopJob(job, "cancel");
  return currentView(job);
}

export async function retryJob(id: string, lang?: unknown) {
  const locale = parseLocale(lang);
  requireOpen(locale);
  return mutate(async () => {
    const original = await findJob(id);
    if (!original) return null;
    const status = (await currentView(original)).status;
    if (status !== "error" && status !== "canceled") {
      throw new DownloadError(downloadMessages(locale).cannotRetry, 409);
    }
    const retryOf = original.view.retryOf ?? id;
    const activeRetry = [...store.jobs.values()].find(
      (job) => job.finishedAt === null && (job.view.retryOf ?? job.view.id) === retryOf,
    );
    if (activeRetry) return activeRetry.view;
    requireCapacity(1, locale);
    if (status === "error" && original.view.resumable) {
      const finishedAt = original.finishedAt;
      // The expiry sweep must leave this directory alone while it is requeued.
      original.finishedAt = null;
      try {
        if (await hasCheckpoint(original)) {
          const view: JobView = {
            ...original.view,
            status: "queued",
            startedAt: Date.now(),
            error: null,
          };
          const resumed = createJob(
            {
              schema: 1,
              ownerPid: process.pid,
              locale,
              finishedAt: null,
              queueOrder: store.nextQueueOrder++,
              view,
            },
            original.dir,
          );
          await persist(resumed);
          store.jobs.set(id, resumed);
          kickQueue();
          return view;
        }
      } finally {
        original.finishedAt = finishedAt;
      }
    }
    const { url, quality, output, file } = original.view;
    const settings = file ? { file, quality } : { quality, output: output ?? "mp4" };
    const [retried] = await acceptQueued([{ url, settings, retryOf }], locale);
    return retried;
  });
}

async function locateFile(job: Job) {
  const { filename, status, bytes } = job.view;
  if (status !== "done" || !validOutputFilename(filename, job.view) || bytes === null) return null;
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
    case ".mp3":
      return "audio/mpeg";
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
  if (!job) return missing();
  const output = await locateFile(job);
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
          "content-type": job.view.file ? "application/octet-stream" : contentType(filename),
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
  if (store.pruneTimer) clearTimeout(store.pruneTimer);
  store.pruneTimer = null;
  await store.mutations;
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
  if (!desktop) {
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
