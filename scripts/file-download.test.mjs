import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brewPathEnv, resolveTools } from "../cli/tools.mjs";
import {
  downloadDirectFile,
  hasDirectCheckpoint,
  safeFilename,
} from "../shared/direct-download.mjs";
import { processIsAlive } from "../shared/process-lifetime.mjs";
import { extractDownloadUrls, normalizeFileUrl } from "../shared/video.mjs";

const exec = promisify(execFile);
const tools = resolveTools();
const env = brewPathEnv({ LUOPIAN_CURL: tools.curl, LUOPIAN_LANG: "en" });
const curlMissing = spawnSync(tools.curl, ["--disable", "--version"]).status !== 0;
const cli = fileURLToPath(new URL("../bin/luopian.mjs", import.meta.url));
const engineModule = new URL("../src/lib/downloader/engine.server.ts", import.meta.url).href;

async function waitForValue(check) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  assert.fail("Timed out waiting for the transfer");
}

async function fixture(t, handler) {
  const server = createServer(handler);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
    t.skip("The environment does not allow loopback servers");
    return null;
  }
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "luopian-file-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, url: `http://127.0.0.1:${server.address().port}/get`, curl: tools.curl, env };
}

test("recognizes video and file URLs without treating known video playlists as files", () => {
  const file = "https://example.com/Report(2026).zip?a=1,2";
  const text =
    `「https://youtu.be/abcDEF123_9」\n${file}#fragment\n` +
    "https://www.youtube.com/playlist?list=PL123\nhttps://api.bilibili.com/playlist";
  assert.deepEqual(extractDownloadUrls(text), [
    "https://www.youtube.com/watch?v=abcDEF123_9",
    file,
  ]);
  assert.equal(normalizeFileUrl("https://name:password@example.com/file"), null);
  assert.equal(safeFilename("../aux.txt"), "_aux.txt");
  const unicode = "https://example.com/年度报告（2026）.zip";
  const nested = "https://example.com/export?source=https://example.net/one,two";
  assert.deepEqual(extractDownloadUrls(unicode), [normalizeFileUrl(unicode)]);
  assert.deepEqual(extractDownloadUrls(nested), [nested]);
  assert.deepEqual(extractDownloadUrls("下载 (https://example.com/Report(1).pdf)，试试看"), [
    "https://example.com/Report(1).pdf",
  ]);
});

test(
  "curl resumes an interrupted transfer without replacing the existing bytes",
  { skip: curlMissing },
  async (t) => {
    const complete = Buffer.concat([Buffer.alloc(128 * 1024, 5), Buffer.alloc(128 * 1024, 65)]);
    const ranges = [];
    let hit = 0;
    const server = await fixture(t, (req, res) => {
      res.setHeader("ETag", '"same-file"');
      res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.zip");
      res.setHeader("Accept-Ranges", "bytes");
      if (hit++ === 0) {
        res.setHeader("Content-Length", complete.length);
        res.write(complete.subarray(0, 128 * 1024));
        setTimeout(() => res.destroy(), 45);
        return;
      }
      const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1]);
      ranges.push([offset, req.headers["if-range"]]);
      if (!Number.isInteger(offset)) return res.writeHead(400).end();
      res.writeHead(206, {
        "Content-Range": `bytes ${offset}-${complete.length - 1}/${complete.length}`,
        "Content-Length": complete.length - offset,
      });
      res.end(complete.subarray(offset));
    });
    if (!server) return;

    await assert.rejects(downloadDirectFile(server), { kind: "transfer" });
    assert.equal(await hasDirectCheckpoint(server.directory, server.url), true);
    // A crash during a later retry can leave bytes beyond the verified offset.
    await appendFile(path.join(server.directory, "transfer.part"), "unverified bytes");
    const result = await downloadDirectFile(server);
    assert.equal(result.filename, "测试.zip");
    assert.deepEqual(await readFile(result.part), complete);
    assert.deepEqual(ranges, [[128 * 1024, '"same-file"']]);
  },
);

test(
  "curl restarts when the server replaces a file during an interruption",
  { skip: curlMissing },
  async (t) => {
    const complete = Buffer.alloc(128 * 1024, 97);
    const requests = [];
    const server = await fixture(t, (req, res) => {
      requests.push(req.headers.range ?? null);
      res.setHeader("Content-Length", complete.length);
      res.setHeader("ETag", requests.length === 1 ? '"old"' : '"new"');
      if (requests.length === 1) {
        res.write(Buffer.alloc(32 * 1024, 0));
        setTimeout(() => res.destroy(), 45);
      } else {
        res.end(complete);
      }
    });
    if (!server) return;
    await assert.rejects(downloadDirectFile(server), { kind: "transfer" });
    const result = await downloadDirectFile(server);
    assert.deepEqual(await readFile(result.part), complete);
    assert.deepEqual(requests, [null, "bytes=32768-", null]);
  },
);

test(
  "curl starts over when a redirect changes the effective URL query",
  { skip: curlMissing },
  async (t) => {
    const offset = 64 * 1024;
    const complete = Buffer.alloc(128 * 1024, 97);
    const requests = [];
    const server = await fixture(t, (req, res) => {
      if (req.url === "/get") {
        const version = requests.length ? 2 : 1;
        return res.writeHead(302, { Location: "/asset?version=" + version }).end();
      }
      requests.push([req.url, req.headers.range ?? null]);
      res.setHeader("ETag", '"same-etag"');
      if (requests.length === 1) {
        res.setHeader("Content-Length", complete.length);
        res.write(Buffer.alloc(offset, 18));
        setTimeout(() => res.destroy(), 45);
      } else if (req.headers.range) {
        res.writeHead(206, {
          "Content-Range": "bytes " + offset + "-" + (complete.length - 1) + "/" + complete.length,
          "Content-Length": complete.length - offset,
        });
        res.end(complete.subarray(offset));
      } else {
        res.end(complete);
      }
    });
    if (!server) return;
    await assert.rejects(downloadDirectFile(server), { kind: "transfer" });
    const result = await downloadDirectFile(server);
    assert.deepEqual(requests, [
      ["/asset?version=1", null],
      ["/asset?version=2", "bytes=" + offset + "-"],
      ["/asset?version=2", null],
    ]);
    assert.deepEqual(await readFile(result.part), complete);
  },
);

test(
  "CLI saves direct files by their final name and preserves an existing copy",
  { skip: curlMissing },
  async (t) => {
    const server = await fixture(t, (req, res) => {
      if (req.url === "/get") return res.writeHead(302, { Location: "/content.zip" }).end();
      if (req.url === "/content.zip") return res.end("same ZIP bytes");
      if (req.url === "/page")
        return res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Login</h1>");
      res.writeHead(404).end();
    });
    if (!server) return;
    const command = [cli, "-o", server.directory, server.url];
    const first = await exec(process.execPath, command, { env });
    const second = await exec(process.execPath, command, { env });
    assert.match(first.stdout, /content\.zip/);
    assert.match(second.stdout, /content \(1\)\.zip/);
    assert.equal(
      await readFile(path.join(server.directory, "content.zip"), "utf8"),
      "same ZIP bytes",
    );
    await assert.rejects(
      exec(process.execPath, [cli, "-o", server.directory, new URL("/page", server.url).href], {
        env,
      }),
      { stderr: /returned a webpage/ },
    );
    assert.deepEqual((await readdir(server.directory)).sort(), ["content (1).zip", "content.zip"]);
  },
);

test(
  "aria2 uses multiple ranges for an advertised large download",
  { skip: curlMissing || !tools.aria2 },
  async (t) => {
    const complete = Buffer.alloc(14 * 1024 ** 2, 17);
    const ranges = [];
    let heads = 0;
    const server = await fixture(t, async (req, res) => {
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("ETag", '"parallel"');
      res.setHeader("Content-Disposition", "attachment; filename=archive.zip");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) + 1 : complete.length;
      if (range) {
        ranges.push(start);
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end - 1}/${complete.length}`);
      }
      res.setHeader("Content-Length", end - start);
      if (req.method === "HEAD") {
        heads++;
        return res.end();
      }
      assert.equal(req.headers["if-match"], '"parallel"');
      for (let offset = start; offset < end && !res.destroyed; offset += 64 * 1024) {
        res.write(complete.subarray(offset, Math.min(end, offset + 64 * 1024)));
        await sleep(10);
      }
      res.end();
    });
    if (!server) return;
    const result = await downloadDirectFile({ ...server, aria2: tools.aria2 });
    assert.equal(heads, 1);
    assert(
      ranges.some((offset) => offset > 0),
      JSON.stringify(ranges),
    );
    assert.equal(result.filename, "archive.zip");
    assert.deepEqual(await readFile(result.part), complete);
  },
);

test(
  "aria2 falls back to a single transfer when file versions cannot be verified",
  { skip: curlMissing || !tools.aria2 },
  async (t) => {
    const complete = Buffer.alloc(8 * 1024 ** 2, 17);
    const requests = [];
    const server = await fixture(t, (req, res) => {
      requests.push([req.method, req.headers.range ?? null]);
      res.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Content-Length": complete.length,
        ETag: 'W/"weak"',
      });
      res.end(req.method === "HEAD" ? undefined : complete);
    });
    if (!server) return;
    const result = await downloadDirectFile({ ...server, aria2: tools.aria2 });
    assert.deepEqual(requests, [
      ["HEAD", null],
      ["GET", null],
    ]);
    assert.deepEqual(await readFile(result.part), complete);
  },
);

test(
  "aria2 discards segments from a different version even if the server ignores If-Match",
  { skip: curlMissing || !tools.aria2 },
  async (t) => {
    const complete = Buffer.alloc(12 * 1024 ** 2, 44);
    const requests = [];
    const server = await fixture(t, async (req, res) => {
      res.setHeader("Accept-Ranges", "bytes");
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) + 1 : complete.length;
      res.setHeader("ETag", range ? '"different"' : '"expected"');
      if (range) {
        res.statusCode = 206;
        res.setHeader("Content-Range", "bytes " + start + "-" + (end - 1) + "/" + complete.length);
      }
      res.setHeader("Content-Length", end - start);
      if (req.method === "HEAD") return res.end();
      requests.push([req.headers["if-match"] ?? null, start]);
      if (range) return res.end(Buffer.alloc(end - start, 35));
      if (!req.headers["if-match"]) return res.end(complete);
      for (let offset = 0; offset < end && !res.destroyed; offset += 64 * 1024) {
        res.write(complete.subarray(offset, Math.min(end, offset + 64 * 1024)));
        await sleep(10);
      }
      res.end();
    });
    if (!server) return;
    const result = await downloadDirectFile({ ...server, aria2: tools.aria2 });
    assert.ok(requests.some(([tag, start]) => tag === '"expected"' && start > 0));
    assert.deepEqual(requests.at(-1), [null, 0]);
    assert.deepEqual(await readFile(result.part), complete);
  },
);

test(
  "desktop resumes a direct file and serves it through the save endpoint",
  { skip: curlMissing },
  async (t) => {
    const complete = Buffer.alloc(128 * 1024, 56);
    const attempts = [];
    const server = await fixture(t, (req, res) => {
      res.setHeader("ETag", '"checkpoint"');
      res.setHeader("Content-Disposition", "attachment; filename=layout.pdf");
      attempts.push(req.headers.range ?? null);
      if (attempts.length === 1) {
        res.setHeader("Content-Length", complete.length);
        res.write(complete.subarray(0, 65536));
        setTimeout(() => res.destroy(), 45);
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes 65536-${complete.length - 1}/${complete.length}`,
        "Content-Length": 65536,
      });
      res.end(complete.subarray(65536));
    });
    if (!server) return;
    const code = `
    import assert from "node:assert/strict";
    import { setTimeout as sleep } from "node:timers/promises";
    const engine = await import(${JSON.stringify(engineModule)});
    const [job] = await engine.enqueueJobs({ urls: [process.env.LUOPIAN_TEST_FILE], output: "mp3", lang: "en" });
    const wait = async (status) => {
      for (let attempt = 0; attempt < 160; attempt++) {
        const next = await engine.getJob(job.id);
        if (next.status === status) return next;
        await sleep(20);
      }
      assert.fail(await engine.getJob(job.id));
    };
    assert.equal((await wait("error")).resumable, true);
    assert.equal((await engine.openJobFile(job.id)).status, 404);
    assert.equal((await engine.retryJob(job.id, "en")).id, job.id);
    assert.equal((await wait("done")).filename, "layout.pdf");
    const output = await engine.openJobFile(job.id);
    assert.equal(output.status, 200);
    assert.match(output.headers.get("content-disposition"), /layout\\.pdf/);
    assert.deepEqual(Buffer.from(await output.arrayBuffer()), Buffer.alloc(128 * 1024, 56));
    await engine.shutdownDownloads();
  `;
    await exec(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        env: {
          ...env,
          LUOPIAN_DESKTOP: "1",
          LUOPIAN_ROOT: path.join(server.directory, "jobs"),
          LUOPIAN_TEST_FILE: server.url,
          LUOPIAN_FFMPEG: path.join(server.directory, "no-ffmpeg"),
          LUOPIAN_YTDLP: path.join(server.directory, "no-yt-dlp"),
        },
      },
    );
    assert.deepEqual(attempts, [null, "bytes=65536-"]);
  },
);

for (const mode of ["CLI", "desktop"]) {
  test(
    mode + " recovers a version-checked direct file after a forced exit",
    { skip: curlMissing || process.platform === "win32", timeout: 18000 },
    async (t) => {
      const offset = 128 * 1024;
      const complete = Buffer.concat([Buffer.alloc(offset, 53), Buffer.alloc(offset, 89)]);
      const ranges = [];
      let activeResponse;
      const server = await fixture(t, (req, res) => {
        if (req.url === "/get") return res.writeHead(302, { Location: "/bundle?v=1" }).end();
        const range = req.headers.range ?? null;
        ranges.push(range);
        res.setHeader("ETag", '"crash-safe"');
        res.setHeader("Content-Disposition", "attachment; filename=bundle.zip");
        if (range) {
          assert.equal(req.headers["if-range"], '"crash-safe"');
          res.writeHead(206, {
            "Content-Range":
              "bytes " + offset + "-" + (complete.length - 1) + "/" + complete.length,
            "Content-Length": complete.length - offset,
          });
          return res.end(complete.subarray(offset));
        }
        activeResponse = res;
        res.writeHead(200, { "Content-Length": complete.length });
        res.write(complete.subarray(0, offset));
      });
      if (!server) return;
      const desktop = mode === "desktop";
      const workRoot = desktop ? path.join(server.directory, "jobs") : server.directory;
      const childEnv = {
        ...env,
        LUOPIAN_DESKTOP: "1",
        LUOPIAN_ROOT: workRoot,
        LUOPIAN_TEST_FILE: server.url,
      };
      const evalArgs = ["--experimental-strip-types", "--input-type=module", "-e"];
      const cliArgs = [cli, "-o", server.directory, server.url];
      const child = spawn(
        process.execPath,
        desktop
          ? [
              ...evalArgs,
              "const engine = await import(" +
                JSON.stringify(engineModule) +
                "); await engine.startJob({ url: process.env.LUOPIAN_TEST_FILE });",
            ]
          : cliArgs,
        { env: childEnv, stdio: "ignore" },
      );
      const exited = once(child, "exit");
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      const checkpoint = await waitForValue(async () => {
        try {
          const [job] = await readdir(workRoot);
          const transfer = path.join(workRoot, job, "transfer");
          const saved = JSON.parse(await readFile(path.join(transfer, "transfer.json"), "utf8"));
          const partial = await stat(path.join(transfer, "transfer.part"));
          return saved.bytes === null && partial.size === offset ? saved : null;
        } catch {
          return null;
        }
      });
      assert.equal(child.kill("SIGKILL"), true);
      assert.deepEqual(await exited, [null, "SIGKILL"]);
      activeResponse.destroy();
      await waitForValue(() => !processIsAlive(checkpoint.writer));

      if (desktop) {
        const code = `
          import assert from "node:assert/strict";
          import { setTimeout as sleep } from "node:timers/promises";
          const engine = await import(${JSON.stringify(engineModule)});
          const [job] = await engine.listJobs();
          assert.equal(job.status, "error");
          assert.equal(job.resumable, true);
          assert.equal((await engine.retryJob(job.id)).id, job.id);
          for (let attempt = 0; attempt < 240; attempt++) {
            if ((await engine.getJob(job.id)).status === "done") break;
            await sleep(25);
          }
          const saved = await engine.openJobFile(job.id);
          assert.equal(saved.status, 200);
          assert.deepEqual(
            Buffer.from(await saved.arrayBuffer()),
            Buffer.concat([Buffer.alloc(${offset}, 53), Buffer.alloc(${offset}, 89)]),
          );
          await engine.shutdownDownloads();
        `;
        await exec(process.execPath, [...evalArgs, code], { env: childEnv, timeout: 8000 });
      } else {
        await exec(process.execPath, cliArgs, { env: childEnv, timeout: 8000 });
        assert.deepEqual(await readFile(path.join(server.directory, "bundle.zip")), complete);
        assert.deepEqual(await readdir(server.directory), ["bundle.zip"]);
      }
      assert.deepEqual(ranges, [null, "bytes=" + offset + "-"]);
    },
  );
}
