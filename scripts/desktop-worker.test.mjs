import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const worker = new URL("../electron/server-worker.mjs", import.meta.url);
const token = "test-worker-token";

function startWorker(t, bundle, port) {
  const child = fork(worker, [bundle, String(port)], {
    env: { ...process.env, LUOPIAN_DESKTOP_TOKEN: token },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return child;
}

test("a broken desktop bundle reports a startup failure over IPC", { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luopian-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, "index.mjs");
  await writeFile(bundle, "export const middleware = false;\n");

  const child = startWorker(t, bundle, 0);
  const exit = once(child, "exit");
  const [message] = await once(child, "message");
  assert.deepEqual(message, { type: "failed", message: "The desktop bundle has no HTTP handler." });
  assert.deepEqual(await exit, [1, null]);
});

test(
  "the worker owns its reported port and gracefully shuts down",
  { timeout: 5000 },
  async (t) => {
    const occupied = createServer((_request, response) => response.end("unrelated process"));
    occupied.listen(0, "127.0.0.1");
    try {
      await once(occupied, "listening");
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.skip("Loopback listening is unavailable in this environment");
        return;
      }
      throw error;
    }
    t.after(() => occupied.close());

    const directory = await mkdtemp(path.join(os.tmpdir(), "luopian-worker-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bundle = path.join(directory, "index.mjs");
    await writeFile(
      bundle,
      `
globalThis[Symbol.for("luopian.shutdownDownloads")] = async () => process.send("downloads stopped");
export async function middleware(request, response) {
  const nonce = globalThis[Symbol.for("luopian.desktopRequest")].getStore();
  response.end(JSON.stringify({ headers: request.headers, nonce }));
}
`,
    );
    const child = startWorker(t, bundle, occupied.address().port);
    const exit = once(child, "exit");
    const [readiness] = await once(child, "message");
    assert.equal(readiness.type, "ready");
    assert.notEqual(readiness.port, occupied.address().port);

    const url = `http://127.0.0.1:${readiness.port}/`;
    assert.equal((await fetch(url)).status, 403);
    const response = await fetch(url, {
      headers: { "X-Luopian-Desktop": token, "X-Forwarded-Host": "unused.invalid" },
    });
    assert.equal(response.status, 200);
    const { headers, nonce } = await response.json();
    assert.equal(headers.host, `127.0.0.1:${readiness.port}`);
    assert.equal(headers["x-luopian-desktop"], undefined);
    assert.equal(headers["x-forwarded-host"], undefined);
    assert.match(nonce, /^[A-Za-z0-9+/]{24}$/);
    assert.ok(
      response.headers
        .get("content-security-policy")
        ?.includes("script-src 'self' 'nonce-" + nonce + "'"),
    );
    const next = await fetch(url, { headers: { "X-Luopian-Desktop": token } });
    assert.notEqual((await next.json()).nonce, nonce);

    const shutdown = once(child, "message");
    child.send({ type: "shutdown" });
    const [stopped] = await shutdown;
    assert.equal(stopped, "downloads stopped");
    assert.deepEqual(await exit, [0, null]);
  },
);
