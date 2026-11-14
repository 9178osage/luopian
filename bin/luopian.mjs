#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, promisify } from "node:util";

import { detectLang, normalizeLang, saveLang } from "../cli/locale.mjs";
import { messages } from "../cli/messages.mjs";
import { brewPathEnv, resolveTools } from "../cli/tools.mjs";
import { isQuality, normalizeYouTubeUrl, VIDEO_FILENAME, youtubeArgs } from "../shared/youtube.mjs";

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
        quality: { type: "string", short: "q" },
        preset: { type: "string", short: "p" },
        out: { type: "string", short: "o" },
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
  try {
    for await (const line of reader) {
      const url = line.trim();
      if (url) return url;
      if (terminal) reader.prompt();
    }
  } finally {
    reader.close();
  }
  return null;
}

async function readToolVersion(bin, args, env) {
  const result = await exec(bin, args, { env, timeout: 8000, windowsHide: true, maxBuffer: 65536 });
  return result.stdout.trim().split(/\r?\n/, 1)[0] || result.stderr.trim().split(/\r?\n/, 1)[0];
}

async function doctor() {
  const tools = resolveTools();
  const env = brewPathEnv();
  const checks = [
    ["yt-dlp", tools.ytdlp, ["--ignore-config", "--no-plugin-dirs", "--version"]],
    ["ffmpeg", tools.ffmpeg, ["-version"]],
  ];
  const results = await Promise.allSettled(
    checks.map(([, bin, args]) => readToolVersion(bin, args, env)),
  );
  console.log(copy.doctorTitle);
  results.forEach((result, index) => {
    const [name, bin] = checks[index];
    if (result.status === "fulfilled") console.log(`  ✓ ${name} · ${result.value} · ${bin}`);
    else console.error(`  ✗ ${copy.toolMissing(name)} (${bin})`);
  });
  if (results.some((result) => result.status === "rejected")) {
    console.error(copy.toolInstall);
    process.exitCode = 1;
  }
}

function runDownload(bin, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    let stopping;
    const stop = (signal) => {
      stopping = signal;
      child.kill(signal);
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", (error) => {
      reject(
        error.code === "ENOENT"
          ? new CliError(`${copy.toolMissing("yt-dlp")} ${copy.toolInstall}`)
          : error,
      );
    });
    child.once("close", (code, signal) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      const stoppedBy = stopping ?? signal;
      if (stoppedBy) {
        reject(new CliError(copy.exitSignal(stoppedBy), 128 + (constants.signals[stoppedBy] ?? 0)));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new CliError(copy.exitCode(code)));
      }
    });
  });
}

async function completedFile(record, outDir) {
  try {
    const lines = (await readFile(record, "utf8")).trim().split(/\r?\n/);
    if (lines.length !== 1) throw new CliError(copy.noFile);
    const file = await realpath(JSON.parse(lines[0]));
    if (path.dirname(file) !== (await realpath(outDir))) throw new CliError(copy.noFile);
    const result = await stat(file);
    if (result.isFile() && result.size > 0) return file;
  } catch {
    // No single, usable file was reported by the downloader.
  }
  throw new CliError(copy.noFile);
}

async function download(url, quality, out) {
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
  // Keep attempts at different quality settings from reusing the same file.
  const filename =
    quality === "hd1080" ? VIDEO_FILENAME.replace(".%(ext)s", " [1080p].%(ext)s") : VIDEO_FILENAME;
  try {
    await runDownload(
      tools.ytdlp,
      [
        ...youtubeArgs({ quality, ffmpeg: tools.ffmpeg, nodeBin: tools.nodeBin }),
        "--paths",
        outDir,
        "--output",
        filename,
        "--print-to-file",
        "after_move:%(filepath)j",
        record.replaceAll("%", "%%"),
        "--",
        url,
      ],
      env,
    );
    const file = await completedFile(record, outDir);
    console.log(copy.done(file));
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
  const resolution = values.quality ?? values.preset ?? "best";
  const quality = resolution === "1080" ? "hd1080" : resolution;
  if (!isQuality(quality)) throw new CliError(copy.invalidQuality, 2);
  const raw = command ?? (await readStdinUrl());
  const url = raw && normalizeYouTubeUrl(raw);
  if (!url) throw new CliError(copy.invalidUrl, 2);
  await download(url, quality, values.out);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = error instanceof CliError ? error.exitCode : 1;
});
