// Boots a packaged desktop runtime the same way Electron does and checks the
// page it serves: a CSP header, and no script loaded from another origin.
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../electron/server-worker.mjs", import.meta.url));

/** Script sources in `html` that do not belong to `origin`. */
export function externalScripts(html, origin) {
  const sources = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!src) continue;
    const value = (src[1] ?? src[2] ?? src[3]).replaceAll("&amp;", "&");
    if (new URL(value, `${origin}/`).origin !== origin) sources.push(value);
  }
  return sources;
}

/** @returns {Promise<string[]>} Problems found; empty when the bundle passes. */
export async function checkDesktopBundle(runtimeDir) {
  const token = "luopian-bundle-check";
  const root = await mkdtemp(path.join(os.tmpdir(), "luopian-bundle-check-"));
  const child = fork(worker, [path.join(runtimeDir, "server", "index.mjs"), "0"], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      LUOPIAN_DESKTOP_TOKEN: token,
      LUOPIAN_ROOT: path.join(root, "jobs"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => [{ type: "failed", message: stderr.trim() }]),
    ]);
    if (message?.type !== "ready")
      return [`The desktop runtime did not start: ${message?.message}`];
    const origin = `http://127.0.0.1:${message.port}`;
    const response = await fetch(`${origin}/`, {
      headers: { "X-Luopian-Desktop": token },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await response.text();
    const problems = [];
    if (!response.ok) problems.push(`The start page returned HTTP ${response.status}.`);
    const csp = response.headers.get("content-security-policy") ?? "";
    if (!/(?:^|;)\s*script-src\s/.test(csp)) problems.push("The start page has no script CSP.");
    for (const source of externalScripts(html, origin)) {
      problems.push(`The start page loads an external script: ${source}`);
    }
    if (/grok-app-builder/i.test(html)) problems.push("The start page references the app builder.");
    if (!/<script\b/i.test(html)) problems.push("The start page has no application script.");
    return problems;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      if (child.connected) child.send({ type: "shutdown" });
      else child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000).unref())]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtimeDir = path.resolve(process.argv[2] ?? "dist/desktop");
  const problems = await checkDesktopBundle(runtimeDir);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`Desktop bundle check passed: ${runtimeDir}`);
}
