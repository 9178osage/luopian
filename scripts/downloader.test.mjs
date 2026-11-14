import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { guardStudioMutation, readDownloadRequest } from "../src/lib/downloader/request-guard.ts";

const exec = promisify(execFile);
const engineUrl = new URL("../src/lib/downloader/engine.server.ts", import.meta.url).href;
const windows = process.platform === "win32";
const good = "AbCdEf01234";
const failure = "Fail0123456";
const ambiguous = "Ambi0123456";
const hanging = "Wait0123456";
const largeVideo = "Large012345";
const diskError = "Disk0123456";
const largeBytes = 2 * 1024 ** 3 + 1;
const ampleDisk = { bavail: 1_000_000n, bsize: 4096n };
const lowDisk = { bavail: 100_000n, bsize: 4096n };
const video = (id) => `https://www.youtube.com/watch?v=${id}`;
const input = (id) => ({ url: video(id), quality: "best", lang: "en" });
const jobManifest = ".luopian-job.json";

let engine;
let temp;
let root;
let unknownDirs;
let expired;

const fixture = `#!/usr/bin/env node
import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
if (args.length === 1) {
  console.log("2026.11.14");
  process.exit(0);
}
if (!args.includes("--ignore-config") || !args.includes("--no-playlist")) {
  console.error("ERROR: Expected a single YouTube video");
  process.exit(6);
}
const dir = args[args.indexOf("-P") + 1];
const id = new URL(args.at(-1)).searchParams.get("v");
const output = path.join(dir, "片段 [" + id + "].mp4");
if (id === "${hanging}") {
  await writeFile(output + ".part", "partial");
  process.on("SIGTERM", () => setTimeout(() => process.exit(1), 180));
  console.log("luopian-progress:42%|4 MiB/s|00:01");
  setInterval(() => {}, 1000);
} else if (id === "${diskError}") {
  await writeFile(output + ".part", "partial");
  console.error("Error writing trailer: No space left on device");
  console.error("ERROR: Postprocessing failed");
  process.exitCode = 1;
} else {
  await writeFile(output, "synthetic video");
  if (id === "${largeVideo}") await truncate(output, ${largeBytes});
  console.log("luopian-progress:55%|3 MiB/s|00:01");
  console.log("luopian-file:" + JSON.stringify(output));
  if (id === "${failure}") {
    console.error("ERROR: Conversion failed");
    process.exitCode = 1;
  }
  if (id === "${ambiguous}") {
    const extra = path.join(dir, "extra.mp4");
    await writeFile(extra, "unexpected second file");
    console.log("luopian-file:" + JSON.stringify(extra));
  }
}
`;

before(async () => {
  if (windows) return;
  temp = await mkdtemp(path.join(os.tmpdir(), "luopian-downloader-test-"));
  root = path.join(temp, "jobs");
  await mkdir(root);
  const tool = path.join(temp, "fixture.mjs");
  await writeFile(tool, fixture, { mode: 0o700 });
  Object.assign(process.env, {
    LUOPIAN_ROOT: root,
    LUOPIAN_YTDLP: tool,
    LUOPIAN_FFMPEG: tool,
    LUOPIAN_DESKTOP: "1",
  });

  const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
  unknownDirs = ["Keep these files", randomUUID(), randomUUID()].map((name) =>
    path.join(root, name),
  );
  for (const dir of unknownDirs) {
    await mkdir(dir);
    await writeFile(path.join(dir, "keep.txt"), "untouched");
    await utimes(dir, old, old);
  }
  await writeFile(path.join(unknownDirs.at(-1), jobManifest), '{"schema":0}');
  await utimes(unknownDirs.at(-1), old, old);

  const id = randomUUID();
  expired = path.join(root, id);
  await mkdir(expired);
  await writeFile(
    path.join(expired, jobManifest),
    JSON.stringify({
      schema: 1,
      ownerPid: process.pid,
      locale: "en",
      finishedAt: old.getTime(),
      view: {
        ...input(good),
        id,
        status: "done",
        percent: 100,
        speed: null,
        eta: null,
        filename: "Old.mp4",
        bytes: 1,
        error: null,
        startedAt: old.getTime() - 1000,
      },
    }),
  );
  engine = await import(engineUrl);
});

after(async () => {
  if (engine) await engine.shutdownDownloads();
  if (temp) await rm(temp, { recursive: true, force: true });
});

function portable(testName, fn) {
  test(testName, { skip: windows ? "uses an executable Node fixture on Unix" : false }, fn);
}

function mockDisk(t, check) {
  const mocked = t.mock.method(fs, "statfs", check);
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return mocked;
}

async function waitFor(job, predicate) {
  const until = Date.now() + 5000;
  for (;;) {
    const snapshot = await engine.getJob(job.id);
    if (snapshot && predicate(snapshot)) return snapshot;
    if (Date.now() >= until)
      throw new Error(`Job never reached expected state: ${JSON.stringify(snapshot)}`);
    await sleep(25);
  }
}

portable("only owned and expired jobs are pruned", async () => {
  assert.deepEqual(await engine.listJobs(), []);
  await assert.rejects(access(expired), { code: "ENOENT" });
  for (const dir of unknownDirs) {
    assert.equal(await readFile(path.join(dir, "keep.txt"), "utf8"), "untouched");
  }
});

portable("server holds a single download slot through startup and cancellation", async () => {
  const pending = engine.startJob(input(hanging));
  await assert.rejects(engine.startJob(input(good)), { status: 409 });
  const job = await pending;
  await waitFor(job, (item) => item.percent === 42);
  assert.equal((await engine.cancelJob(job.id)).status, "canceling");
  await assert.rejects(engine.startJob(input(good)), { status: 409 });
  await waitFor(job, (item) => item.status === "canceled");
  assert.equal((await engine.openJobFile(job.id)).status, 404);
});

portable(
  "desktop checks its staging volume for free space before starting a download",
  async (t) => {
    const entries = (await fs.readdir(root)).sort();
    const check = mockDisk(t, async () => lowDisk);
    await assert.rejects(engine.startJob(input(good)), {
      status: 507,
      message: /low on free space/,
    });
    assert.equal(check.mock.callCount(), 1);
    assert.equal(path.basename(check.mock.calls[0].arguments[0]), "files");
    assert.deepEqual((await fs.readdir(root)).sort(), entries);
  },
);

portable("desktop stops and clears a download when free space drops", async (t) => {
  const volumes = [ampleDisk, lowDisk];
  mockDisk(t, async () => volumes.shift() ?? lowDisk);
  const job = await engine.startJob(input(hanging));
  await waitFor(job, (item) => item.percent === 42);
  const failed = await waitFor(job, (item) => item.status === "error");
  assert.match(failed.error, /low on free space/);
  await assert.rejects(access(path.join(root, job.id, "files")), { code: "ENOENT" });
  assert.equal((await engine.openJobFile(job.id)).status, 404);
});

portable("a desktop file over 2 GiB can be saved when the volume has free space", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const job = await engine.startJob(input(largeVideo));
  const completed = await waitFor(job, (item) => item.status !== "running");
  assert.equal(completed.status, "done");
  assert.equal(completed.bytes, largeBytes);
  const response = await engine.openJobFile(job.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(largeBytes));
  await response.body.cancel();
});

portable("desktop preserves the disk write error when postprocessing also fails", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const job = await engine.startJob(input(diskError));
  const failed = await waitFor(job, (item) => item.status === "error");
  assert.match(failed.error, /low on free space/);
  await assert.rejects(access(path.join(root, job.id, "files")), { code: "ENOENT" });
});

portable("an unsuccessful downloader exit never publishes a leftover file", async () => {
  const job = await engine.startJob(input(failure));
  const failed = await waitFor(job, (item) => item.status === "error");
  assert.equal(failed.error, "Conversion failed");
  assert.equal(failed.filename, null);
  assert.equal((await engine.openJobFile(job.id)).status, 404);
});

portable("ambiguous output fails even when the downloader exits successfully", async () => {
  const job = await engine.startJob(input(ambiguous));
  const failed = await waitFor(job, (item) => item.status === "error");
  assert.match(failed.error, /complete video file/);
  assert.equal(failed.filename, null);
});

portable("one complete video is streamed and can be restored by a fresh process", async () => {
  const job = await engine.startJob(input(good));
  const completed = await waitFor(job, (item) => item.status === "done");
  assert.equal(completed.filename, `片段 [${good}].mp4`);
  assert.equal(completed.bytes, Buffer.byteLength("synthetic video"));
  const response = await engine.openJobFile(job.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''%E7%89%87/);
  assert.equal(await response.text(), "synthetic video");

  const { stdout } = await exec(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `const { listJobs } = await import(${JSON.stringify(engineUrl)}); console.log(JSON.stringify(await listJobs()));`,
  ]);
  assert.deepEqual(
    JSON.parse(stdout).find((item) => item.id === job.id),
    completed,
  );

  await rm(path.join(root, job.id, "files", completed.filename));
  const unavailable = (await engine.listJobs()).find((item) => item.id === job.id);
  assert.equal(unavailable.status, "error");
  assert.equal(unavailable.filename, null);
  assert.match(unavailable.error, /expired or could not be read/);
  assert.equal((await engine.openJobFile(job.id)).status, 404);
});

portable("restart recovers interrupted tasks and removes their partial files", async () => {
  const { stdout: pid } = await exec(process.execPath, ["-p", "process.pid"]);
  const id = randomUUID();
  const directory = path.join(root, id);
  const files = path.join(directory, "files");
  await mkdir(files, { recursive: true });
  await writeFile(path.join(files, "partial.mp4.part"), "partial");
  await writeFile(
    path.join(directory, jobManifest),
    JSON.stringify({
      schema: 1,
      ownerPid: Number(pid),
      locale: "en",
      finishedAt: null,
      view: {
        ...input(good),
        id,
        status: "running",
        percent: 42,
        speed: null,
        eta: null,
        filename: null,
        bytes: null,
        error: null,
        startedAt: Date.now(),
      },
    }),
  );
  const { stdout } = await exec(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `const { listJobs } = await import(${JSON.stringify(engineUrl)}); console.log(JSON.stringify(await listJobs()));`,
  ]);
  const recovered = JSON.parse(stdout).find((item) => item.id === id);
  assert.equal(recovered.status, "error");
  assert.match(recovered.error, /interrupted/);
  await assert.rejects(access(files), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(directory, jobManifest), "utf8").then(
      (data) => JSON.parse(data).view.status,
    ),
    "error",
  );
});

test("mutations accept the same browser origin and bound JSON request bodies", async () => {
  const url = "http://127.0.0.1:8080/api/jobs?lang=en";
  const headers = { "content-type": "application/json", origin: "http://127.0.0.1:8080" };
  const request = new Request(url, { method: "POST", headers, body: '{"quality":"best"}' });
  assert.equal(guardStudioMutation(request), null);
  assert.deepEqual(await readDownloadRequest(request), { quality: "best" });

  const other = new Request(url, {
    method: "POST",
    headers: { ...headers, origin: "http://127.0.0.1:8081" },
  });
  assert.equal(guardStudioMutation(other).status, 403);

  const large = new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "a".repeat(9000) }),
  });
  assert.equal((await readDownloadRequest(large)).status, 413);
});
