/**
 * 落片 (Luopian) — Electron main process.
 * Spawns the existing Vite + TanStack Start stack and loads it in a BrowserWindow.
 */
import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";


function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function which(cmd) {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.COM;.CMD;.BAT")
          .split(";")
          .map((ext) => ext.trim())
          .filter((ext) => ext && !/^\.(cmd|bat)$/i.test(ext))
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
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

function winNodeCandidates() {
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const profile = process.env.USERPROFILE || os.homedir();
  const programData = process.env.ProgramData || "C:\\ProgramData";
  return [
    local && path.join(local, "Programs", "nodejs", "node.exe"),
    path.join(pf, "nodejs", "node.exe"),
    local && path.join(local, "Microsoft", "WinGet", "Links", "node.exe"),
    path.join(profile, "scoop", "shims", "node.exe"),
    path.join(programData, "chocolatey", "bin", "node.exe"),
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

/** Mac: Homebrew node first (Launchpad PATH is thin). Else PATH, then common Windows installs. */
function resolveLauncherNode() {
  if (process.platform === "darwin") {
    const mac = ["/usr/local/bin/node", "/opt/homebrew/bin/node"].find((bin) => isFile(bin));
    if (mac) return mac;
  }
  const fromPath = which("node");
  if (fromPath) return fromPath;
  if (process.platform === "win32") {
    const found = winNodeCandidates().find((candidate) => isFile(candidate));
    if (found) return found;
  }
  if (process.platform === "darwin" && isFile("/usr/bin/node")) return "/usr/bin/node";
  return "node";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.LUOPIAN_PORT || 8080);
const HOST = "127.0.0.1";
const URL = `http://${HOST}:${PORT}/`;

let serverProc = null;
let mainWindow = null;

function logDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", "Luopian");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Luopian", "Logs");
  }
  return path.join(os.homedir(), "Library", "Logs", "Luopian");
}

async function waitForServer(timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(URL, (res) => {
        res.resume();
        resolve(res.statusCode && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Server did not become ready at ${URL} within ${timeoutMs}ms`);
}

async function startServer() {
  await mkdir(logDir(), { recursive: true });
  const logPath = path.join(logDir(), "server.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  logStream.write(`\n---- ${new Date().toISOString()} start ----\n`);

  const usePreview = process.env.LUOPIAN_MODE === "preview";
  const nodeBin = resolveLauncherNode();
  const extraPath =
    process.platform === "win32"
      ? winShimDirs().join(";")
      : ["/usr/local/bin", "/opt/homebrew/bin"].join(":");
  const viteMode = usePreview ? "preview" : "dev";
  serverProc = spawn(
    nodeBin,
    ["scripts/with-app-env.mjs", nodeBin, "node_modules/vite/bin/vite.js", viteMode, "--host", HOST, "--port", String(PORT)],
    {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH:
        process.platform === "win32"
          ? [extraPath, process.env.PATH || process.env.Path || ""].filter(Boolean).join(";")
          : `${extraPath}:${process.env.PATH || ""}`,
      BROWSER: "none",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  serverProc.stdout?.pipe(logStream, { end: false });
  serverProc.stderr?.pipe(logStream, { end: false });
  serverProc.on("exit", (code, signal) => {
    logStream.write(`---- server exit code=${code} signal=${signal} ----\n`);
  });

  await waitForServer();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    title: "落片",
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadURL(URL);
}

function killProcessTree(child) {
  if (!child?.pid) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
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
  }, 2000);
}

function stopServer() {
  if (!serverProc || serverProc.killed) return;
  const child = serverProc;
  serverProc = null;
  killProcessTree(child);
}

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error("[luopian-electron]", err);
    try {
      const boot = path.join(logDir(), "boot-error.log");
      createWriteStream(boot, { flags: "a" }).end(String(err?.stack || err) + "\n");
    } catch { /* ignore */ }
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // macOS: closing the window keeps the app (and any running download) alive,
  // so clicking the Dock icon can reopen it. Other platforms quit for real.
  if (process.platform !== "darwin") {
    stopServer();
    app.quit();
  }
});

app.on("before-quit", () => stopServer());

let reopening = false;
app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length > 0 || reopening || !app.isReady()) return;
  reopening = true;
  try {
    if (!serverProc || serverProc.exitCode !== null || serverProc.killed) await startServer();
    createWindow();
  } catch (err) {
    console.error("[luopian-electron] reopen failed", err);
  } finally {
    reopening = false;
  }
});
