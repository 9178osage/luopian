import { app, BrowserWindow, dialog, session, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = app.isPackaged
  ? path.join(process.resourcesPath, "luopian")
  : path.resolve(appDir, "../dist/desktop");
const loopback = "127.0.0.1";

let worker = null;
let mainWindow = null;
let opening = false;
let quitting = false;
let failed = false;

function showFailure(error) {
  if (failed || quitting) return;
  failed = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error("[落片]", error);
  const zh = app.getLocale().toLowerCase().startsWith("zh");
  dialog.showErrorBox(zh ? "落片无法打开" : "Luopian could not open", message);
  app.quit();
}

async function openWorkerLog() {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    await mkdir(logDir, { recursive: true });
    const stream = createWriteStream(path.join(logDir, "server.log"), { flags: "a" });
    stream.on("error", (error) => console.error("[落片]", error.message));
    return stream;
  } catch (error) {
    console.error("[落片]", error.message);
    return null;
  }
}

function waitForWorker(child) {
  return new Promise((resolve, reject) => {
    function settle(error, port) {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(port);
    }
    function onMessage(message) {
      if (
        message?.type === "ready" &&
        Number.isInteger(message.port) &&
        message.port > 0 &&
        message.port < 65536
      ) {
        settle(null, message.port);
      } else if (message?.type === "failed") {
        settle(new Error(message.message));
      }
    }
    function onExit(code, signal) {
      settle(
        new Error(`下载服务提前退出 / Download service exited before startup (${signal ?? code}).`),
      );
    }
    function onError(error) {
      settle(error);
    }
    const timeout = setTimeout(() => {
      settle(new Error("下载服务启动超时。/ The download service timed out."));
    }, 30_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function configureSession(origin, token) {
  const desktopSession = session.fromPartition("persist:luopian");
  desktopSession.webRequest.onBeforeSendHeaders(
    { urls: [`http://${loopback}/*`] },
    (details, callback) => {
      if (new URL(details.url).origin === origin) {
        callback({ requestHeaders: { ...details.requestHeaders, "X-Luopian-Desktop": token } });
      } else {
        callback({ requestHeaders: details.requestHeaders });
      }
    },
  );
  desktopSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    return permission === "clipboard-read" && requestingOrigin === origin && details.isMainFrame;
  });
  desktopSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(
      permission === "clipboard-read" &&
        details.isMainFrame &&
        Boolean(details.requestingUrl?.startsWith(`${origin}/`)),
    );
  });
  desktopSession.on("will-download", (_event, item) => {
    const url = new URL(item.getURL());
    if (url.origin === origin && /^\/api\/jobs\/[0-9a-f-]+\/file$/.test(url.pathname)) {
      item.setSaveDialogOptions({
        defaultPath: path.join(app.getPath("downloads"), path.basename(item.getFilename())),
      });
    }
  });
  return desktopSession;
}

async function startWorker() {
  const bundle = path.join(runtimeDir, "server", "index.mjs");
  try {
    await access(bundle);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      app.isPackaged
        ? "安装文件不完整，请重新安装落片。/ Luopian is missing its download service. Reinstall the app."
        : "缺少桌面构建产物。/ Build the desktop app with npm run build:desktop.",
    );
  }
  const log = await openWorkerLog();
  if (quitting) {
    log?.end();
    return;
  }
  const token = randomBytes(32).toString("hex");
  log?.write(`\n---- ${new Date().toISOString()} start ----\n`);
  const child = spawn(
    process.execPath,
    [path.join(appDir, "server-worker.mjs"), bundle, process.env.LUOPIAN_PORT ?? "18080"],
    {
      cwd: runtimeDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        LUOPIAN_DESKTOP: "1",
        LUOPIAN_DESKTOP_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const current = { child, origin: null, desktopSession: null, stopped: false };
  worker = current;
  if (log) {
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("close", (code, signal) => log.end(`---- exit ${signal ?? code} ----\n`));
  } else {
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  child.on("error", (error) => {
    if (current.origin) showFailure(error);
  });
  child.once("close", () => {
    current.stopped = true;
  });
  child.once("exit", (code, signal) => {
    if (current.origin) {
      showFailure(new Error(`下载服务已停止。/ The download service stopped (${signal ?? code}).`));
    }
  });

  const port = await waitForWorker(child);
  if (quitting) return;
  current.origin = `http://${loopback}:${port}`;
  current.desktopSession = configureSession(current.origin, token);
}

function stopWorker() {
  if (!worker || worker.stopped) return Promise.resolve();
  const { child } = worker;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 8000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (child.connected) child.send({ type: "shutdown" }, () => {});
    else child.kill();
  });
}

function openExternal(url) {
  const { protocol } = new URL(url);
  if (protocol === "https:" || protocol === "http:") {
    void shell.openExternal(url).catch((error) => console.error("[落片]", error.message));
  }
}

async function openWindow() {
  if (quitting || opening) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  opening = true;
  try {
    if (!worker) await startWorker();
    if (quitting || !worker?.origin) return;
    const { origin, desktopSession } = worker;
    const window = new BrowserWindow({
      width: 1100,
      height: 780,
      minWidth: 460,
      minHeight: 520,
      title: "落片",
      backgroundColor: "#0e0f11",
      webPreferences: {
        session: desktopSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      show: false,
    });
    mainWindow = window;
    window.once("closed", () => {
      mainWindow = null;
    });
    window.once("ready-to-show", () => window.show());
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });
    for (const eventName of ["will-navigate", "will-redirect"]) {
      window.webContents.on(eventName, (event) => {
        if (new URL(event.url).origin === origin) return;
        event.preventDefault();
        if (eventName === "will-navigate") openExternal(event.url);
      });
    }
    await window.loadURL(`${origin}/`);
  } catch (error) {
    showFailure(error);
  } finally {
    opening = false;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) void openWindow();
  });
  app.on("activate", () => {
    if (app.isReady()) void openWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stopWorker().finally(() => app.quit());
  });
  void app.whenReady().then(openWindow, showFailure);
}
