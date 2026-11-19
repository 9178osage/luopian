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
const interrupted = "Part0123456";
const audioVideo = "Aud01234567";
const silentVideo = "Sil01234567";
const wrongOutput = "Wrong012345";
const biliId = "BV1xx411c7mD";
const biliPart = `https://www.bilibili.com/video/${biliId}?p=2`;
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
import { readFile, rename, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
if (args.length === 1) {
  console.log("2026.11.14");
  process.exit(0);
}
if (!args.includes("--ignore-config") || !args.includes("--no-playlist")) {
  console.error("ERROR: Expected a single video");
  process.exit(6);
}
const dir = args[args.indexOf("-P") + 1];
const url = new URL(args.at(-1));
if (url.hostname === "www.bilibili.com" && (url.href !== "${biliPart}" || args.includes("--remote-components"))) {
  console.error("ERROR: Expected the original Bilibili part without YouTube-specific flags");
  process.exit(7);
}
const id = url.searchParams.get("v") ?? url.pathname.split("/").at(-1);
const audioFormat = args[args.indexOf("--audio-format") + 1];
const format = args[args.indexOf("--format") + 1];
if (id === "${audioVideo}" && (!args.includes("--extract-audio") || audioFormat !== "mp3")) {
  console.error("ERROR: Expected MP3 extraction arguments");
  process.exit(8);
}
if (id === "${silentVideo}" &&
  (!format.includes("height<=1080") || !args.some((arg) => arg.includes(":-an ")))) {
  console.error("ERROR: Expected capped video with no audio");
  process.exit(9);
}
const extension = id === "${wrongOutput}" ? "webm" : audioFormat === "mp3" ? "mp3" : "mp4";
const output = path.join(dir, "片段 [" + id + "]." + extension);
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
} else if (id === "${interrupted}") {
  const partial = output + ".part";
  const checkpoint = await readFile(partial, "utf8").catch(() => null);
  if (checkpoint === "original bytes" && args.includes("--continue")) {
    await rename(partial, output);
    console.log("luopian-file:" + JSON.stringify(output));
  } else {
    await writeFile(partial, "original bytes");
    console.error("ERROR: Connection reset by peer");
    process.exitCode = 1;
  }
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

portable("batches wait in FIFO order and queued jobs can be canceled", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const active = await engine.startJob(input(hanging));
  await waitFor(active, (item) => item.percent === 42);
  const queued = await engine.enqueueJobs({
    urls: [video(hanging), video(failure), video(good)],
    quality: "hd1080",
    output: "mp4",
    lang: "en",
  });
  assert.deepEqual(
    queued.map((job) => job.status),
    ["queued", "queued", "queued"],
  );
  const [first, removed, last] = queued;
  await assert.rejects(engine.startJob(input(good)), { status: 409 });
  assert.equal((await engine.cancelJob(removed.id)).status, "canceled");
  assert.equal((await engine.openJobFile(removed.id)).status, 404);
  assert.equal((await engine.getJob(last.id)).status, "queued");
  const canceled = await readFile(path.join(root, removed.id, jobManifest), "utf8");
  assert.equal(JSON.parse(canceled).view.status, "canceled");

  await engine.cancelJob(active.id);
  await waitFor(first, (item) => item.percent === 42);
  assert.equal((await engine.getJob(active.id)).status, "canceled");
  assert.equal((await engine.getJob(last.id)).status, "queued");
  assert.equal((await engine.getJob(removed.id)).status, "canceled");
  await engine.cancelJob(first.id);
  assert.equal((await waitFor(last, (item) => item.status === "done")).quality, "hd1080");
});

portable("an invalid input leaves the whole batch unqueued", async () => {
  await engine.listJobs();
  const entries = (await fs.readdir(root)).sort();
  const batch = { output: "mp4", lang: "en" };
  await assert.rejects(engine.enqueueJobs({ ...batch, urls: [] }), { status: 400 });
  await assert.rejects(engine.enqueueJobs({ ...batch, urls: Array(21).fill(video(good)) }), {
    status: 400,
  });
  await assert.rejects(engine.enqueueJobs({ ...batch, urls: [video(good), "invalid"] }), {
    status: 400,
  });
  assert.deepEqual((await fs.readdir(root)).sort(), entries);
});

portable("an expired short link only fails its own queued attempt", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const short = "https://b23.tv/missing";
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () =>
    attempts++ === 0
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 302, headers: { Location: biliPart } }),
  );
  const [first, next] = await engine.enqueueJobs({ urls: [short, video(good)], output: "mp4" });
  const failed = await waitFor(first, (item) => item.status === "error");
  assert.equal(failed.url, short);
  await waitFor(next, (item) => item.status === "done");
  const retry = await engine.retryJob(first.id, "en");
  assert.equal(retry.url, short);
  const completed = await waitFor(retry, (item) => item.status === "done");
  assert.equal(completed.url, biliPart);
});

portable("retry enqueues a new attempt with the original settings", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const job = await engine.startJob({
    ...input(failure),
    output: "mp4-silent",
    quality: "hd1080",
  });
  await waitFor(job, (item) => item.status === "error");
  const blocker = await engine.startJob(input(hanging));
  await waitFor(blocker, (item) => item.percent === 42);
  const [retry, repeated] = await Promise.all([
    engine.retryJob(job.id, "en"),
    engine.retryJob(job.id, "en"),
  ]);
  assert.equal(repeated.id, retry.id);
  assert.equal(retry.retryOf, job.id);
  assert.notEqual(retry.id, job.id);
  assert.equal(retry.url, job.url);
  assert.equal(retry.output, job.output);
  assert.equal(retry.quality, job.quality);
  assert.equal(retry.status, "queued");
  assert.equal((await engine.getJob(job.id)).status, "error");
  const manifest = JSON.parse(await readFile(path.join(root, retry.id, jobManifest), "utf8"));
  assert.equal(manifest.view.retryOf, job.id);
  await engine.cancelJob(blocker.id);
  await waitFor(retry, (item) => item.status === "error");

  const success = await engine.startJob(input(good));
  await waitFor(success, (item) => item.status === "done");
  await assert.rejects(engine.retryJob(success.id, "en"), { status: 409 });
  assert.equal(await engine.retryJob(randomUUID(), "en"), null);
});

portable("a hot reload can reuse a queue without the newer scheduling fields", async () => {
  const code = `
    import assert from "node:assert/strict";
    const state = { jobs: new Map(), pending: null, active: null, loading: null, pruning: null };
    globalThis.__luopianVideo = state;
    const engine = await import(${JSON.stringify(engineUrl)});
    const [job] = await engine.enqueueJobs({ urls: [${JSON.stringify(video(good))}], lang: "en" });
    assert.equal(globalThis.__luopianVideo, state);
    assert.ok(job.id);
    assert.equal(state.nextQueueOrder, 2);
    await engine.shutdownDownloads();
  `;
  await exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
    env: { ...process.env, LUOPIAN_ROOT: path.join(temp, "previous-store") },
    timeout: 10000,
  });
});

portable("graceful shutdown saves waiting tasks and a new process resumes in order", async () => {
  const options = {
    env: { ...process.env, LUOPIAN_ROOT: path.join(temp, "persistent-queue") },
    timeout: 15000,
  };
  const node = ["--experimental-strip-types", "--input-type=module", "-e"];
  const { stdout } = await exec(
    process.execPath,
    [
      ...node,
      `const engine = await import(${JSON.stringify(engineUrl)});
      const active = await engine.startJob(${JSON.stringify(input(hanging))});
      const waiting = await engine.enqueueJobs({
        urls: ${JSON.stringify([video(hanging), video(good)])},
        output: "mp4",
        lang: "en",
      });
      await engine.shutdownDownloads();
      console.log(JSON.stringify({ active, waiting }));`,
    ],
    options,
  );
  const { active, waiting } = JSON.parse(stdout);
  for (const job of waiting) {
    const saved = await readFile(path.join(options.env.LUOPIAN_ROOT, job.id, jobManifest), "utf8");
    assert.equal(JSON.parse(saved).view.status, "queued");
  }
  const restored = await exec(
    process.execPath,
    [
      ...node,
      `import assert from "node:assert/strict";
      import { setTimeout } from "node:timers/promises";
      const engine = await import(${JSON.stringify(engineUrl)});
      const [first, last] = ${JSON.stringify(waiting.map((job) => job.id))};
      async function waitFor(id, predicate) {
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const job = await engine.getJob(id);
          if (job && predicate(job)) return job;
          await setTimeout(25);
        }
        assert.fail("Job did not resume: " + id);
      }
      try {
        const jobs = await engine.listJobs();
        assert.equal(jobs.find((job) => job.id === "${active.id}").status, "error");
        await waitFor(first, (job) => job.percent === 42);
        assert.equal((await engine.getJob(last)).status, "queued");
        await engine.cancelJob(first);
        await waitFor(last, (job) => job.status === "done");
        console.log("resumed");
      } finally {
        await engine.shutdownDownloads();
      }`,
    ],
    options,
  );
  assert.equal(restored.stdout.trim(), "resumed");
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
  assert.match(failed.error, /complete file/);
  assert.equal(failed.filename, null);
});

portable("one complete video is streamed and can be restored by a fresh process", async () => {
  const job = await engine.startJob(input(good));
  const completed = await waitFor(job, (item) => item.status === "done");
  assert.equal(completed.output, "mp4");
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

portable(
  "MP3 extraction can be started without video quality and is served as audio",
  async (t) => {
    mockDisk(t, async () => ampleDisk);
    const job = await engine.startJob({ url: video(audioVideo), output: "mp3", lang: "en" });
    const completed = await waitFor(job, (item) => item.status !== "running");
    assert.equal(completed.status, "done", completed.error);
    assert.equal(completed.output, "mp3");
    assert.match(completed.filename, /\.mp3$/);

    const response = await engine.openJobFile(job.id);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.match(response.headers.get("content-disposition"), /\.mp3/);
    assert.equal(await response.text(), "synthetic video");

    const { stdout } = await exec(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const { getJob } = await import(${JSON.stringify(engineUrl)}); console.log(JSON.stringify(await getJob(${JSON.stringify(job.id)})));`,
    ]);
    assert.deepEqual(JSON.parse(stdout), completed);
  },
);

portable("silent MP4 forwards the quality and audio removal arguments", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const job = await engine.startJob({
    ...input(silentVideo),
    output: "mp4-silent",
    quality: "hd1080",
  });
  const completed = await waitFor(job, (item) => item.status !== "running");
  assert.equal(completed.status, "done", completed.error);
  assert.equal(completed.output, "mp4-silent");
  assert.equal(completed.quality, "hd1080");
  assert.match(completed.filename, /\.mp4$/);
});

portable("new jobs reject unexpected containers and invalid formats", async (t) => {
  await assert.rejects(engine.startJob({ ...input(good), output: "webm" }), { status: 400 });
  mockDisk(t, async () => ampleDisk);
  const job = await engine.startJob(input(wrongOutput));
  const failed = await waitFor(job, (item) => item.status !== "running");
  assert.equal(failed.status, "error");
  assert.match(failed.error, /selected format/);
  assert.equal((await engine.openJobFile(job.id)).status, 404);
});

portable(
  "existing WebM and MKV downloads remain available without a saved output mode",
  async () => {
    const previousRoot = path.join(temp, "previous-jobs");
    const oldJobIds = [];
    for (const extension of ["webm", "mkv"]) {
      const id = randomUUID();
      oldJobIds.push(id);
      const jobDir = path.join(previousRoot, id);
      const files = path.join(jobDir, "files");
      const filename = `Old.${extension}`;
      const now = Date.now();
      await mkdir(files, { recursive: true });
      await writeFile(path.join(files, filename), "old video");
      await writeFile(
        path.join(jobDir, jobManifest),
        JSON.stringify({
          schema: 1,
          ownerPid: process.pid,
          locale: "en",
          finishedAt: now,
          view: {
            ...input(good),
            id,
            status: "done",
            percent: 100,
            speed: null,
            eta: null,
            filename,
            bytes: 9,
            error: null,
            startedAt: now,
          },
        }),
      );
    }
    const { stdout } = await exec(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `const { openJobFile } = await import(${JSON.stringify(engineUrl)});
    for (const id of ${JSON.stringify(oldJobIds)}) {
      const response = await openJobFile(id);
      console.log(JSON.stringify([response.status, response.headers.get("content-type"), await response.text()]));
    }`,
      ],
      { env: { ...process.env, LUOPIAN_ROOT: previousRoot } },
    );
    assert.deepEqual(
      stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        [200, "video/webm", "old video"],
        [200, "video/x-matroska", "old video"],
      ],
    );
  },
);

portable("a Bilibili video keeps the selected part through download and restore", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const job = await engine.startJob({ ...input(good), url: `${biliPart}&spm_id_from=sharing` });
  const completed = await waitFor(job, (item) => item.status !== "running");
  assert.equal(completed.status, "done", completed.error);
  assert.equal(completed.url, biliPart);
  const response = await engine.openJobFile(job.id);
  assert.equal(await response.text(), "synthetic video");

  const { stdout } = await exec(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `const { getJob } = await import(${JSON.stringify(engineUrl)}); console.log(JSON.stringify(await getJob(${JSON.stringify(job.id)})));`,
  ]);
  assert.deepEqual(JSON.parse(stdout), completed);
});

portable(
  "a short link holds the download slot and the job stores the direct Bilibili URL",
  async (t) => {
    mockDisk(t, async () => ampleDisk);
    const shortUrl = "https://b23.tv/fake123";
    const redirect = Promise.withResolvers();
    t.mock.method(globalThis, "fetch", () => redirect.promise);
    const pending = engine.startJob({ ...input(good), url: shortUrl });
    try {
      await assert.rejects(engine.startJob(input(good)), { status: 409 });
    } finally {
      redirect.resolve(new Response(null, { status: 302, headers: { Location: biliPart } }));
    }
    const job = await pending;
    assert.equal(job.url, biliPart);
    const completed = await waitFor(job, (item) => item.status !== "running");
    assert.equal(completed.status, "done", completed.error);
  },
);

portable("an unresolvable short link leaves no staged files or job", async (t) => {
  await engine.listJobs();
  const entries = (await fs.readdir(root)).sort();
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  await assert.rejects(engine.startJob({ ...input(good), url: "https://b23.tv/missing" }), {
    status: 422,
    message: /Bilibili short link/,
  });
  assert.deepEqual((await fs.readdir(root)).sort(), entries);
});

portable("retry resumes a video from its original working directory", async (t) => {
  mockDisk(t, async () => ampleDisk);
  const started = await engine.startJob(input(interrupted));
  const failed = await waitFor(started, (job) => job.status === "error");
  assert.equal(failed.resumable, true);
  assert.equal((await engine.openJobFile(started.id)).status, 404);
  const retried = await engine.retryJob(started.id, "en");
  assert.equal(retried.id, started.id);
  await assert.rejects(engine.retryJob(started.id, "en"), { status: 409 });
  const done = await waitFor(retried, (job) => job.status === "done");
  assert.equal(done.resumable, undefined);
  assert.equal(await (await engine.openJobFile(done.id)).text(), "original bytes");
});

portable("restart keeps a usable checkpoint from an interrupted task", async () => {
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
  assert.equal(recovered.resumable, true);
  assert.equal(await readFile(path.join(files, "partial.mp4.part"), "utf8"), "partial");
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
    body: JSON.stringify({ url: "a".repeat(100_000) }),
  });
  assert.equal((await readDownloadRequest(large)).status, 413);
});
