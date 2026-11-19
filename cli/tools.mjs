import { accessSync, constants, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** @param {string} candidate */
function isExecutable(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} cmd */
function which(cmd) {
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
      const full = path.resolve(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  return null;
}

/** @param {string} name */
function winToolCandidates(name) {
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
  ].filter(Boolean);
}

function winShimDirs() {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "";
  const programData = process.env.ProgramData || "";
  return [
    local && path.join(local, "Microsoft", "WinGet", "Links"),
    path.join(os.homedir(), "scoop", "shims"),
    programData && path.join(programData, "chocolatey", "bin"),
    pf && path.join(pf, "ffmpeg", "bin"),
    pf && path.join(pf, "nodejs"),
  ].filter((dir) => dir && existsSync(dir));
}

function resolveNodeBin() {
  const fromEnv = toolOverride(process.env.LUOPIAN_NODE);
  if (fromEnv) return fromEnv;
  // The packaged desktop worker already runs its Electron executable in Node mode.
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1")
    return process.execPath;
  return findTool("node");
}

/** @param {string} name */
function findTool(name) {
  const candidates =
    process.platform === "win32"
      ? winToolCandidates(name)
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((dir) => path.join(dir, name));
  return which(name) ?? candidates.find(isExecutable) ?? null;
}

/** @param {string | undefined} value */
function toolOverride(value) {
  if (!value) return null;
  return path.basename(value) === value ? (which(value) ?? value) : path.resolve(value);
}

export function resolveTools() {
  const ffmpeg = toolOverride(process.env.LUOPIAN_FFMPEG) ?? findTool("ffmpeg") ?? "ffmpeg";
  const ytdlp = toolOverride(process.env.LUOPIAN_YTDLP) ?? findTool("yt-dlp") ?? "yt-dlp";
  const curl = toolOverride(process.env.LUOPIAN_CURL) ?? findTool("curl") ?? "curl";
  const aria2 = toolOverride(process.env.LUOPIAN_ARIA2) ?? findTool("aria2c");
  const nodeBin = resolveNodeBin();
  const outDir = process.env.LUOPIAN_OUT || path.join(os.homedir(), "Downloads");
  return { ffmpeg, ytdlp, curl, aria2, nodeBin, outDir };
}

/** @param {NodeJS.ProcessEnv} [extra] */
export function brewPathEnv(extra = {}) {
  const fallbackDirs =
    process.platform === "win32"
      ? winShimDirs()
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    ...process.env,
    ...extra,
    PATH: [extra.PATH ?? process.env.PATH ?? process.env.Path, ...fallbackDirs]
      .filter(Boolean)
      .join(path.delimiter),
  };
}
