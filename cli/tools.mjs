import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** PATH lookup. On Windows prefer real executables Node can spawn without a shell. */
export function which(cmd) {
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

export function winShimDirs() {
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

/**
 * Real node binary for yt-dlp --js-runtimes.
 * Mac: env, this process (when it is node), Homebrew/system paths, then PATH.
 * Windows: env, this process, PATH, then common install locations.
 * Returns null when nothing on disk exists — callers must omit --js-runtimes.
 */
export function resolveNodeBin() {
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
    const found = winToolCandidates("node").find((candidate) => isFile(candidate));
    if (found) return found;
  }
  return null;
}

/** Node used to launch Vite from Electron. Never uses Electron's own execPath. */
export function resolveLauncherNode() {
  if (process.platform === "darwin") {
    const mac = ["/usr/local/bin/node", "/opt/homebrew/bin/node"].find((bin) => isFile(bin));
    if (mac) return mac;
  }
  const fromPath = which("node");
  if (fromPath) return fromPath;
  if (process.platform === "win32") {
    const found = winToolCandidates("node").find((candidate) => isFile(candidate));
    if (found) return found;
  }
  if (process.platform === "darwin") {
    const mac = firstExisting(["/usr/bin/node"]);
    if (mac && isFile(mac)) return mac;
  }
  return "node";
}

function resolveCliTool(envKey, name, macPaths) {
  if (process.env[envKey]) return process.env[envKey];
  if (process.platform === "win32") {
    return which(name) || winToolCandidates(name).find((candidate) => isFile(candidate)) || name;
  }
  // Mac (and other Unix): Homebrew / system paths first, same order as before.
  return firstExisting(macPaths) || name;
}

export function resolveTools() {
  const ffmpeg = resolveCliTool("LUOPIAN_FFMPEG", "ffmpeg", [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]);
  const ytdlp = resolveCliTool("LUOPIAN_YTDLP", "yt-dlp", [
    "/opt/homebrew/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ]);
  const gallery = resolveCliTool("LUOPIAN_GALLERY", "gallery-dl", [
    "/opt/homebrew/bin/gallery-dl",
    "/usr/local/bin/gallery-dl",
    "/usr/bin/gallery-dl",
  ]);
  const python =
    process.env.LUOPIAN_PYTHON ||
    (process.platform === "win32"
      ? which("python") || which("python3") || which("py") || "python"
      : firstExisting(["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) ||
        "python3");
  const nodeBin = resolveNodeBin();
  const outDir = process.env.LUOPIAN_OUT || path.join(os.homedir(), "Downloads");
  return { ffmpeg, ytdlp, gallery, python, nodeBin, outDir };
}

export function brewPathEnv(extra = {}) {
  if (process.platform === "win32") {
    return {
      ...process.env,
      ...extra,
      PATH: [...winShimDirs(), process.env.PATH || process.env.Path || ""].filter(Boolean).join(";"),
    };
  }
  const brew = firstExisting(["/opt/homebrew/bin", "/usr/local/bin"]);
  return {
    ...process.env,
    ...extra,
    PATH: [brew, "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH].filter(Boolean).join(":"),
  };
}
