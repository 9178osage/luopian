#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, promisify } from "node:util";

import { detectLang, normalizeLang, saveLang } from "../cli/locale.mjs";
import { messages } from "../cli/messages.mjs";
import { brewPathEnv, resolveTools } from "../cli/tools.mjs";
import {
  downloadDirectFile,
  FileDownloadError,
  hasDirectCheckpoint,
} from "../shared/direct-download.mjs";
import { processIsAlive, waitForProcessExit } from "../shared/process-lifetime.mjs";
import {
  extractDownloadUrls,
  isOutput,
  isQuality,
  isVideoScratch,
  MAX_SHARE_TEXT,
  normalizeVideoUrl,
  outputExtension,
  resolveVideoUrl,
  videoArgs,
  videoFilename,
} from "../shared/video.mjs";

const copy = messages(detectLang().lang);
const exec = promisify(execFile);

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseOptions() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        format: { type: "string", short: "f" },
        quality: { type: "string", short: "q" },
        preset: { type: "string", short: "p" },
        out: { type: "string", short: "o" },
        aria2: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new CliError(error.message, 2);
  }
}

async function readStdinUrl() {
  const terminal = process.stdin.isTTY;
  const reader = createInterface({
    input: process.stdin,
    output: terminal ? process.stdout : undefined,
    crlfDelay: Infinity,
  });
  reader.setPrompt(copy.prompt);
  if (terminal) reader.prompt();
  let text = "";
  try {
    for await (const line of reader) {
      if (terminal) {
        if (line.trim()) return line;
        reader.prompt();
      } else {
        text += `${line}\n`;
        if (text.length > MAX_SHARE_TEXT) return null;
      }
    }
  } finally {
    reader.close();
  }
  return text;
}

async function readToolVersion(bin, args, env) {
  const result = await exec(bin, args, { env, timeout: 8000, windowsHide: true, maxBuffer: 65536 });
  return result.stdout.trim().split(/\r?\n/, 1)[0] || result.stderr.trim().split(/\r?\n/, 1)[0];
}

async function doctor() {
  const tools = resolveTools();
  const env = brewPathEnv();
  const required = [
    ["yt-dlp", tools.ytdlp, ["--ignore-config", "--no-plugin-dirs", "--version"]],
    ["ffmpeg", tools.ffmpeg, ["-version"]],
    ["curl", tools.curl, ["--disable", "--version"]],
  ];
  const checks = [...required];
  if (tools.aria2) checks.push(["aria2c", tools.aria2, ["--no-conf=true", "--version"]]);
  const results = await Promise.allSettled(
    checks.map(([, bin, args]) => readToolVersion(bin, args, env)),
  );
  console.log(copy.doctorTitle);
  results.forEach((result, index) => {
    const [name, bin] = checks[index];
    if (result.status === "fulfilled") console.log(`  ✓ ${name} · ${result.value} · ${bin}`);
    else console.error(`  ✗ ${copy.toolMissing(name)} (${bin})`);
  });
  if (results.slice(0, required.length).some((result) => result.status === "rejected")) {
    console.error(copy.toolInstall);
    process.exitCode = 1;
  }
}

const windows = process.platform === "win32";

function stopProcessTree(child, signal) {
  if (!child.pid) return;
  const stopChild = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  if (windows) {
    const task = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    task.once("error", stopChild);
    task.once("exit", (code) => {
      if (code !== 0) stopChild();
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    stopChild();
  }
}

async function withInterrupt(action, recordWriter) {
  let child;
  let stopping;
  let killTimer;
  let writerError;
  const onProcess = (next) => {
    if (!next && child && killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
      stopProcessTree(child, "SIGKILL");
    }
    child = next;
    if (next?.pid && recordWriter) {
      try {
        recordWriter(next.pid);
      } catch (error) {
        writerError = error;
        stopProcessTree(next, "SIGKILL");
      }
    }
  };
  const stop = (signal) => {
    if (stopping) return;
    stopping = signal;
    if (!child) return;
    const active = child;
    stopProcessTree(active, signal);
    if (!windows) {
      killTimer = setTimeout(() => stopProcessTree(active, "SIGKILL"), 1200);
      killTimer.unref();
    }
  };
  const checkActive = () => {
    if (stopping) throw new CliError(copy.exitSignal(stopping), 128 + constants.signals[stopping]);
    if (writerError) throw writerError;
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await action({ onProcess, checkActive });
  } catch (error) {
    checkActive();
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (killTimer) clearTimeout(killTimer);
  }
}

function runMediaTool(name, bin, args, env, cwd, { onProcess, checkActive }) {
  checkActive();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: !windows,
      windowsHide: true,
    });
    onProcess(child);
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      onProcess(null);
      try {
        checkActive();
      } catch (error) {
        reject(error);
        return;
      }
      if (spawnError) {
        reject(
          spawnError.code === "ENOENT"
            ? new CliError(`${copy.toolMissing(name)} ${copy.toolInstall}`)
            : spawnError,
        );
      } else if (signal) {
        reject(new CliError(copy.exitSignal(signal), 128 + (constants.signals[signal] ?? 0)));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new CliError(copy.exitCode(code)));
      }
    });
  });
}

async function restoreStaging(outDir, prefix, directory) {
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const owner = Number(entry.name.slice(prefix.length).split("-", 1)[0]);
    if (!Number.isSafeInteger(owner) || owner <= 0 || processIsAlive(owner)) continue;
    const previous = path.join(outDir, entry.name);
    try {
      const writerFile = path.join(previous, "writer");
      const details = await lstat(writerFile);
      if (!details.isFile() || details.size > 32) continue;
      const writer = Number(await readFile(writerFile, "utf8"));
      if (
        !Number.isSafeInteger(writer) ||
        writer <= 0 ||
        !(await waitForProcessExit(windows ? writer : -writer))
      ) {
        continue;
      }
      // Two processes can discover the same abandoned attempt. Only one can move it.
      await rename(path.join(previous, "transfer"), directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    await rm(previous, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
  return false;
}

const stagingMaxAge = 7 * 24 * 60 * 60 * 1000;
const stagingMaxBytes = 10 * 1024 ** 3;
const stagingName = /^\.luopian-(?:resume-([0-9a-f]{24})|work-([0-9a-f]{24})-(\d+)-[^/\\]*)$/;

async function stagingUsage(directory) {
  let bytes = 0;
  let modified = (await lstat(directory)).mtimeMs;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = await stagingUsage(item);
      bytes += inner.bytes;
      modified = Math.max(modified, inner.modified);
    } else {
      const details = await lstat(item);
      bytes += details.size;
      modified = Math.max(modified, details.mtimeMs);
    }
  }
  return { bytes, modified };
}

async function stagingOwnerAlive(directory, owner) {
  if (processIsAlive(owner)) return true;
  try {
    const writer = Number(await readFile(path.join(directory, "writer"), "utf8"));
    return Number.isSafeInteger(writer) && writer > 0 && processIsAlive(windows ? writer : -writer);
  } catch {
    return false;
  }
}

// Checkpoints for other links or settings are never looked up again. Remove the
// ones untouched for a week, then the oldest while they exceed the size cap.
async function pruneStaging(outDir, currentId) {
  const candidates = [];
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    const match = stagingName.exec(entry.name);
    if (!entry.isDirectory() || !match || (match[1] ?? match[2]) === currentId) continue;
    const directory = path.join(outDir, entry.name);
    try {
      if (match[3] && (await stagingOwnerAlive(directory, Number(match[3])))) continue;
      candidates.push({ directory, ...(await stagingUsage(directory)) });
    } catch {
      // Another process may have just moved or removed it.
    }
  }
  candidates.sort((a, b) => a.modified - b.modified);
  let total = candidates.reduce((sum, item) => sum + item.bytes, 0);
  const now = Date.now();
  for (const item of candidates) {
    if (now - item.modified < stagingMaxAge && total <= stagingMaxBytes) break;
    await rm(item.directory, { recursive: true, force: true }).catch(() => undefined);
    total -= item.bytes;
  }
}

async function withStaging(outDir, key, action, retain) {
  const id = createHash("sha256").update(key).digest("hex").slice(0, 24);
  await pruneStaging(outDir, id).catch(() => undefined);
  const checkpoint = path.join(outDir, `.luopian-resume-${id}`);
  const prefix = `.luopian-work-${id}-`;
  const temporary = await mkdtemp(path.join(outDir, `${prefix}${process.pid}-`));
  const directory = path.join(temporary, "transfer");
  const recordWriter = (pid) =>
    writeFileSync(path.join(temporary, "writer"), String(pid), { mode: 0o600 });
  try {
    try {
      await rename(checkpoint, directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!(await restoreStaging(outDir, prefix, directory))) {
        await mkdir(directory, { mode: 0o700 });
      }
    }
    if (!(await lstat(directory)).isDirectory()) throw new CliError(copy.noFile);
    return await action(directory, recordWriter);
  } catch (error) {
    if (await retain(directory, error).catch(() => false)) {
      // Two CLI processes may download the same URL independently. Keep the first saved checkpoint.
      await rename(directory, checkpoint).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function publishFile({ part, filename }, outDir) {
  const { name, ext } = path.parse(filename);
  for (let index = 0; index < 1000; index++) {
    const destination = path.join(outDir, index ? `${name} (${index})${ext}` : filename);
    try {
      await link(part, destination);
      return destination;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      if (!["ENOSYS", "ENOTSUP", "EXDEV", "EPERM"].includes(error.code)) throw error;
      // Staging is on the destination filesystem. Use a unique name when that
      // filesystem lacks hard links, so a copy never exposes an unfinished file.
      const unique = path.join(outDir, name + " (" + randomUUID() + ")" + ext);
      try {
        await lstat(unique);
        continue;
      } catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
      }
      await rename(part, unique);
      return unique;
    }
  }
  throw new CliError(copy.fileNameUnavailable);
}

async function downloadFile(url, out, accelerate) {
  const tools = resolveTools();
  const env = brewPathEnv();
  const outDir = path.resolve(out || tools.outDir);
  await mkdir(outDir, { recursive: true });
  let progressShown = false;
  try {
    const saved = await withStaging(
      outDir,
      `file:${url}`,
      (directory, recordWriter) =>
        withInterrupt(async (controls) => {
          const result = await downloadDirectFile({
            url,
            directory,
            env,
            curl: tools.curl,
            aria2: accelerate ? tools.aria2 : null,
            ...controls,
            onProgress: ({ percent }) => {
              if (!process.stderr.isTTY) return;
              progressShown = true;
              process.stderr.write(`\r${Math.floor(percent)}%   `);
            },
          });
          controls.checkActive();
          return publishFile(result, outDir);
        }, recordWriter),
      (directory) => hasDirectCheckpoint(directory, url),
    );
    if (progressShown) process.stderr.write("\n");
    console.log(copy.done(saved));
  } catch (error) {
    if (progressShown) process.stderr.write("\n");
    if (error.code === "ENOENT") throw new CliError(copy.toolMissing("curl"));
    if (error instanceof FileDownloadError) {
      if (error.kind === "webpage") throw new CliError(copy.fileWebpage);
      if (error.kind === "http") throw new CliError(copy.fileHttp(error.status));
      if (error.kind === "space") throw new CliError(copy.fileSpace);
      if (error.kind === "write") throw new CliError(copy.fileWrite);
      throw new CliError(copy.fileFailed);
    }
    throw error;
  }
}

async function completedFile(record, directory, output) {
  try {
    const lines = (await readFile(record, "utf8")).trim().split(/\r?\n/);
    if (lines.length !== 1) throw new CliError(copy.noFile);
    const file = path.resolve(directory, JSON.parse(lines[0]));
    const result = await lstat(file);
    if (path.dirname(await realpath(file)) !== (await realpath(directory))) {
      throw new CliError(copy.noFile);
    }
    if (path.extname(file).toLowerCase() !== `.${outputExtension(output)}`) {
      throw new CliError(copy.noFile);
    }
    if (result.isFile() && result.size > 0) return file;
  } catch {
    // No single, usable file was reported by the downloader.
  }
  throw new CliError(copy.noFile);
}

// Shares the desktop app's rule, so finished format streams survive an interruption too.
async function keepVideoParts(directory) {
  let hasPart = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isFile() && isVideoScratch(entry.name)) {
      hasPart ||= (await lstat(item)).size > 0;
    } else {
      await rm(item, { recursive: true, force: true });
    }
  }
  return hasPart;
}

async function download(url, quality, output, out) {
  const tools = resolveTools();
  const env = brewPathEnv();
  const outDir = path.resolve(out || tools.outDir);
  try {
    await readToolVersion(tools.ffmpeg, ["-version"], env);
  } catch {
    throw new CliError(`${copy.toolMissing("ffmpeg")} ${copy.toolInstall}`);
  }
  await mkdir(outDir, { recursive: true });

  const temp = await mkdtemp(path.join(tmpdir(), "luopian-cli-"));
  const record = path.join(temp, "result");
  try {
    const saved = await withStaging(
      outDir,
      `${output}:${quality}:${url}`,
      (directory, recordWriter) =>
        withInterrupt(async (controls) => {
          // A previous run can leave an unfinished conversion under its final name.
          await keepVideoParts(directory);
          await runMediaTool(
            "yt-dlp",
            tools.ytdlp,
            [
              ...videoArgs({ url, quality, output, ffmpeg: tools.ffmpeg, nodeBin: tools.nodeBin }),
              "--continue",
              "--output",
              videoFilename(output, quality),
              "--print-to-file",
              "after_move:%(filepath)j",
              record.replaceAll("%", "%%"),
              "--",
              url,
            ],
            env,
            directory,
            controls,
          );
          const file = await completedFile(record, directory, output);
          try {
            await runMediaTool(
              "ffmpeg",
              tools.ffmpeg,
              [
                "-nostdin",
                "-v",
                "error",
                "-xerror",
                "-f",
                outputExtension(output),
                "-protocol_whitelist",
                "file",
                "-i",
                file,
                ...(output === "mp3" ? [] : ["-map", "0:V:0"]),
                ...(output === "mp4-silent" ? [] : ["-map", "0:a:0"]),
                "-c",
                "copy",
                "-f",
                "null",
                "-",
              ],
              env,
              directory,
              controls,
            );
          } catch {
            controls.checkActive();
            throw new CliError(copy.noFile);
          }
          controls.checkActive();
          return publishFile({ part: file, filename: path.basename(file) }, outDir);
        }, recordWriter),
      async (directory, error) => {
        if (error instanceof CliError && error.exitCode >= 128) return false;
        return keepVideoParts(directory);
      },
    );
    console.log(copy.done(saved));
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const { values, positionals } = parseOptions();
  if (values.help) {
    console.log(copy.help);
    return;
  }
  if (values.version) {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    console.log(manifest.version);
    return;
  }

  const [command, language, ...rest] = positionals;
  if (command === "doctor" || command === "lang") {
    if (Object.keys(values).length || rest.length || (command === "doctor" && language)) {
      throw new CliError(copy.extraCommandArgs, 2);
    }
    if (command === "doctor") return doctor();
    if (!language) return console.log(`${copy.langNow}\n${copy.langUsage}`);
    const next = normalizeLang(language);
    if (!next) throw new CliError(copy.badLang, 2);
    saveLang(next);
    console.log(messages(next).langSaved);
    return;
  }

  if (positionals.length > 1) throw new CliError(copy.tooManyArgs, 2);
  const raw = command ?? (await readStdinUrl());
  const links = extractDownloadUrls(raw);
  if (links.length > 1) throw new CliError(copy.tooManyArgs, 2);
  const [normalized] = links;
  if (!normalized) throw new CliError(copy.invalidUrl, 2);
  if (!normalizeVideoUrl(normalized)) {
    if (values.format || values.quality || values.preset) throw new CliError(copy.fileOptions, 2);
    return downloadFile(normalized, values.out, values.aria2);
  }
  if (values.aria2) throw new CliError(copy.aria2Files, 2);
  const output = values.format ?? "mp4";
  if (!isOutput(output)) throw new CliError(copy.invalidFormat, 2);
  const resolution = output === "mp3" ? "best" : (values.quality ?? values.preset ?? "best");
  const quality = resolution === "1080" ? "hd1080" : resolution;
  if (!isQuality(quality)) throw new CliError(copy.invalidQuality, 2);
  const url = await resolveVideoUrl(normalized);
  if (!url) throw new CliError(copy.unresolvedUrl);
  await download(url, quality, output, values.out);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
