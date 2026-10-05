#!/usr/bin/env node
/**
 * 落片 CLI — paste/pass a URL, download via yt-dlp or gallery-dl.
 *
 * Usage:
 *   luopian <url>
 *   luopian -p mp3 <url>
 *   luopian --preset playlist --end 5 <url>
 *   luopian -o ~/Movies <url>
 *   echo <url> | luopian
 *   luopian doctor
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  ALL_PRESETS,
  inferPreset,
  toArtistMediaUrl,
  intentArgs,
  imagePostRange,
  isImagePreset,
  isYoutube,
  validateUrl,
} from "../cli/presets.mjs";
import { brewPathEnv, resolveTools } from "../cli/tools.mjs";
import { detectLang, normalizeLang, saveLang } from "../cli/locale.mjs";
import { messages } from "../cli/messages.mjs";

function t() {
  return messages(detectLang().lang);
}

function langVia(copy, detected) {
  if (detected.source === "LUOPIAN_LANG") return copy.viaEnv;
  if (detected.source === "default") return copy.viaDefault;
  if (detected.source === "LANG" || detected.source === "LC_ALL") return copy.viaLocale(detected.source);
  return copy.viaFile(detected.source);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function printHelp() {
  console.log(t().help);
}

function parseArgs(argv) {
  const opts = {
    preset: null,
    out: null,
    template: null,
    end: null,
    format: null,
    videoOnly: false,
    cookies: null,
    browser: null,
    filter: null,
    impersonate: null,
    url: null,
    doctor: false,
    help: false,
    version: false,
    listFormats: false,
    setLang: false,
    lang: "",
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "-F" || a === "--list-formats") opts.listFormats = true;
    else if (a === "doctor") opts.doctor = true;
    else if (a === "-p" || a === "--preset") opts.preset = argv[++i];
    else if (a === "-o" || a === "--out") {
      const v = argv[++i];
      if (v && v.includes("%")) opts.template = v;
      else opts.out = v;
    }
    else if (a === "-e" || a === "--end") opts.end = Number(argv[++i]);
    else if (a === "-f" || a === "--format") opts.format = argv[++i];
    else if (a === "--video-only") opts.videoOnly = true;
    else if (a === "--cookies") opts.cookies = argv[++i];
    else if (a === "--cookies-from-browser") opts.browser = argv[++i] || "chrome";
    else if (a === "--filter") opts.filter = argv[++i];
    else if (a === "--impersonate") opts.impersonate = argv[++i] || "chrome";
    else if (a.startsWith("-")) {
      console.error(t().unknownOption(a));
      process.exit(2);
    } else rest.push(a);
  }
  if (rest[0] === "lang") {
    opts.lang = rest[1] ?? "";
    opts.setLang = true;
  } else if (rest[0] && rest[0] !== "doctor") opts.url = rest[0];
  return opts;
}

async function readStdinUrl() {
  if (process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let text = "";
  for await (const line of rl) {
    text += line.trim();
    if (text) break;
  }
  return text || null;
}

function run(bin, args, env) {
  return new Promise((resolve, reject) => {
    const copy = t();
    console.error(`${copy.prefix} ${bin} ${args.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}`);
    const child = spawn(bin, args, {
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        reject(new Error(`${t().toolMissing(bin)} ${t().toolInstall()}`));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(t().exitCode(code)));
    });
  });
}

async function doctor() {
  const tools = resolveTools();
  const copy = t();
  const title = process.platform === "win32" ? copy.doctorTitleWin : copy.doctorTitle;
  console.log(`${title}\n`);
  for (const [k, v] of Object.entries(tools)) {
    const shown = v == null || v === "" ? "(not found)" : v;
    console.log(`  ${k.padEnd(10)} ${shown}`);
  }
  console.log("");
  let missing = false;
  for (const [name, bin, args] of [
    ["yt-dlp", tools.ytdlp, ["--version"]],
    ["gallery-dl", tools.gallery, ["--version"]],
    ["ffmpeg", tools.ffmpeg, ["-version"]],
  ]) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(bin, args, { env: brewPathEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out || String(code)))));
      }).then((out) => {
        const line = String(out).split("\n")[0].trim();
        console.log(`  ✓ ${name}: ${line}`);
      });
    } catch (err) {
      missing = true;
      const detail = err && err.code === "ENOENT" ? copy.toolMissing(name) : err.message?.slice(0, 120) || err;
      console.log(`  ✗ ${name}: ${detail}`);
    }
  }
  console.log(`\n${copy.cliEntry(path.resolve(__dirname, "luopian.mjs"))}`);
  if (process.platform === "win32") {
    console.log(copy.installWinNode);
    console.log(copy.installWinNpm);
  } else {
    console.log(copy.installNpm);
    console.log(copy.installLn);
  }
  if (missing) console.log(copy.toolInstall());
}

async function listFormatsFor(urlRaw) {
  const url = validateUrl(urlRaw);
  const tools = resolveTools();
  const args = ["-F", url];
  if (isYoutube(url)) {
    args.unshift("youtube:player_client=android,web");
    args.unshift("--extractor-args");
    args.unshift("-4");
  }
  await run(tools.ytdlp, args, brewPathEnv());
}

async function downloadOne(opts, urlRaw) {
  if (opts.listFormats) {
    await listFormatsFor(urlRaw);
    return;
  }
  const url = validateUrl(urlRaw);
  const preset = opts.preset || inferPreset(url);
  if (!ALL_PRESETS.includes(preset)) {
    throw new Error(t().unknownPreset(preset, ALL_PRESETS.join(", ")));
  }

  const tools = resolveTools();
  const outDir = opts.out || tools.outDir;
  mkdirSync(outDir, { recursive: true });
  const env = brewPathEnv();

  if (isImagePreset(preset)) {
    const args = ["--no-colors", "--dest", outDir, "--retries", "3"];
    if (!opts.browser) args.push("--no-input");
    if (opts.end != null) {
      const range = imagePostRange(preset, url, opts.end);
      if (range) args.push("--post-range", range);
    }
    if (opts.cookies) args.push("--cookies", opts.cookies);
    if (opts.browser) args.push("--cookies-from-browser", opts.browser);
    if (opts.filter) args.push("--filter", opts.filter);
    else if (preset === "illustrations") args.push("--filter", "type == 'illust'");
    args.push(url);
    await run(tools.gallery, args, env);
  } else {
    const args = [
      "--no-colors",
      "--ffmpeg-location",
      tools.ffmpeg,
      "--newline",
      "--no-mtime",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "-P",
      outDir,
      "-o",
      opts.template || "%(title)s.%(ext)s",
      "--merge-output-format",
      "mp4",
      ...intentArgs({
        preset,
        playlistEnd: opts.end ?? null,
        formatId: opts.format,
        videoOnly: opts.videoOnly,
      }),
    ];
    if (isYoutube(url)) {
      if (tools.nodeBin) {
        args.push("--js-runtimes", `node:${tools.nodeBin}`, "--remote-components", "ejs:github");
      } else {
        args.push("--remote-components", "ejs:github");
      }
      args.push("-4", "--extractor-args", "youtube:player_client=android,web");
      if (opts.impersonate) args.push("--impersonate", opts.impersonate);
    }
    if (opts.cookies) args.push("--cookies", opts.cookies);
    if (preset === "playlist") args.push("--ignore-errors");
    args.push(url);
    await run(tools.ytdlp, args, env);
  }

  console.error(`${t().prefix} ${t().done(outDir)}`);
}

async function askChoice(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(String(answer || "").trim()));
  });
}

async function interactiveLoop(opts) {
  const copy = t();
  const tools = resolveTools();
  const outDir = opts.out || tools.outDir;
  console.log(copy.started);
  console.log(`${copy.savingTo(outDir)}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const promptUrl = () =>
    askChoice(rl, copy.prompt).then(async (text) => {
      if (!text) return promptUrl();
      if (/^(q|quit|exit|退出)$/i.test(text)) {
        console.log(copy.bye);
        rl.close();
        return;
      }
      let host = null;
      try { host = new URL(text).hostname.toLowerCase().replace(/^www\./, ""); } catch { host = null; }
      const isX = host === "x.com" || host === "twitter.com" || (host && host.endsWith(".twitter.com"));
      const isPixiv = host === "pixiv.net" || (host && host.endsWith(".pixiv.net"));
      console.log(isPixiv ? copy.pixivMenu : isX ? copy.xMenu : copy.videoMenu);
      const choice = await askChoice(rl, isPixiv ? copy.choosePixiv : isX ? copy.chooseX : copy.chooseVideo);
      const next = { ...opts };
      try {
        if (isPixiv) {
          const u = new URL(text);
          const parts = u.pathname.split("/").filter(Boolean);
          const id = parts[1] || parts[0];
          if (choice === "1" || choice === "") {
            next.preset = "artwork";
            await downloadOne(next, text);
          } else if (choice === "2") {
            next.preset = "author";
            const userUrl = parts[0] === "users" ? `${u.origin}/users/${id}` : text;
            await downloadOne(next, userUrl);
          } else if (choice === "3") {
            next.preset = "illustrations";
            next.filter = "type == 'illust'";
            const userUrl = parts[0] === "users" ? `${u.origin}/users/${id}` : text;
            await downloadOne(next, userUrl);
          } else if (choice === "4") {
            next.preset = "bookmarks";
            let mark = text;
            if (parts[0] === "users" && parts[1] && !text.includes("/bookmarks")) {
              mark = `${u.origin}/users/${parts[1]}/bookmarks/artworks`;
            }
            await downloadOne(next, mark);
          } else {
            console.error(copy.badPixiv);
          }
        } else if (isX) {
          if (choice === "1" || choice === "") {
            next.preset = "tweet";
            await downloadOne(next, text);
          } else if (choice === "2") {
            next.preset = "tweet";
            next.browser = next.browser || "chrome";
            await downloadOne(next, text);
          } else if (choice === "3") {
            next.preset = "media";
            next.browser = next.browser || "chrome";
            await downloadOne(next, toArtistMediaUrl(text));
          } else {
            console.error(copy.badX);
          }
        } else if (choice === "1" || choice === "") {
          next.preset = "best";
          await downloadOne(next, text);
        } else if (choice === "2") {
          next.preset = "hd1080";
          await downloadOne(next, text);
        } else if (choice === "3") {
          next.preset = "mp3";
          await downloadOne(next, text);
        } else if (choice === "4") {
          next.listFormats = true;
          await downloadOne(next, text);
        } else if (choice === "5") {
          next.preset = "playlist";
          await downloadOne(next, text);
        } else {
          console.error(copy.badVideo);
        }
      } catch (err) {
        console.error(`${copy.prefix} ${err.message || err}`);
      }
      return promptUrl();
    });
  await promptUrl();
}

function handleLang(value) {
  const detected = detectLang();
  const copy = messages(detected.lang);
  if (!String(value || "").trim()) {
    console.log(copy.langNow(copy.langName, langVia(copy, detected)));
    console.log(copy.langUsage);
    return;
  }
  const next = normalizeLang(value);
  if (!next) {
    console.error(copy.badLang);
    console.error(copy.langUsage);
    process.exit(2);
  }
  const saved = saveLang(next);
  const savedCopy = messages(next);
  console.log(savedCopy.langSaved(savedCopy.langName));
  console.log(savedCopy.langFiles);
  for (const file of saved.files) console.log(`  ${file}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.setLang) {
    handleLang(opts.lang);
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.version) {
    console.log(t().version);
    return;
  }
  if (opts.doctor) {
    await doctor();
    return;
  }

  let urlRaw = opts.url || (await readStdinUrl());
  if (!urlRaw) {
    if (process.stdin.isTTY && !opts.listFormats) {
      await interactiveLoop(opts);
      return;
    }
    printHelp();
    process.exit(1);
  }

  if (opts.listFormats) {
    await listFormatsFor(urlRaw);
    return;
  }

  await downloadOne(opts, urlRaw);
}

main().catch((err) => {
  console.error(`${t().prefix} ${err.message || err}`);
  process.exit(1);
});
