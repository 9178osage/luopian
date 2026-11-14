import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeYouTubeUrl, VIDEO_FILENAME, youtubeArgs } from "../shared/youtube.mjs";

const id = "abcDEF123_9";
const url = `https://www.youtube.com/watch?v=${id}`;
const cli = fileURLToPath(new URL("../bin/luopian.mjs", import.meta.url));

test("canonicalizes one video from watch, share, mobile, Shorts, live and embed links", () => {
  for (const input of [
    ` https://www.youtube.com/watch?v=${id}&list=PL123&t=120 `,
    `https://youtu.be/${id}?si=sample`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}`,
    `https://youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) {
    assert.equal(normalizeYouTubeUrl(input), url);
  }
});

test("rejects playlist-only, ambiguous, malformed and non-YouTube links", () => {
  for (const input of [
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/watch",
    `https://example.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&v=aBcdef12_34`,
    `https://www.youtube.com:8443/watch?v=${id}`,
    `https://name@www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}/another-path`,
    "https://youtu.be/not-a-video-id",
    "https://www.youtube.com/@channel",
  ]) {
    assert.equal(normalizeYouTubeUrl(input), null);
  }
});

test("caps both 1080p format branches and prevents skipped fragments from succeeding", () => {
  const common = { ffmpeg: "/tools/ffmpeg", nodeBin: "/tools/node" };
  const limited = youtubeArgs({ quality: "hd1080", ...common });
  assert.deepEqual(limited[limited.indexOf("--format") + 1].split("/"), [
    "bv*[height<=1080]+ba",
    "b[height<=1080]",
  ]);
  assert.ok(limited.includes("--abort-on-unavailable-fragments"));
  assert.ok(limited.includes("--ignore-config"));
  assert.ok(limited.includes("--no-playlist"));
  assert.ok(limited.includes("node:/tools/node"));
  const best = youtubeArgs({ quality: "best", ...common });
  assert.equal(best[best.indexOf("--format") + 1], "bv*+ba/b");
});

function runCli(args, { input = "", env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, LUOPIAN_LANG: "en", ...env },
  });
}

function fixture(t, folder = "Saved videos") {
  const root = mkdtempSync(path.join(tmpdir(), "luopian-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ytdlp = path.join(root, "yt-dlp");
  const ffmpeg = path.join(root, "ffmpeg");
  const argsFile = path.join(root, "arguments");
  const outDir = path.join(root, folder);
  writeFileSync(ffmpeg, "#!/bin/sh\nprintf 'ffmpeg test version\\n'\n", { mode: 0o755 });
  writeFileSync(
    ytdlp,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("yt-dlp test version");
  process.exit(0);
}
writeFileSync(process.env.LUOPIAN_TEST_ARGS, JSON.stringify(args));
if (process.env.LUOPIAN_TEST_MODE === "exit") process.exit(8);
if (process.env.LUOPIAN_TEST_MODE === "empty") process.exit(0);
if (process.env.LUOPIAN_TEST_MODE === "signal") {
  spawn(process.execPath, ["-e", [
    'process.on("SIGTERM", () => {});',
    'console.log("download process tree ready");',
    'setTimeout(() => console.log("FFmpeg survived cancellation"), 4000);',
  ].join("\\n")], { stdio: "inherit" });
} else {
  const pathIndex = args.indexOf("--paths");
  const dir = pathIndex === -1 ? "." : args[pathIndex + 1];
  const filename = process.env.LUOPIAN_TEST_MODE === "outside" ? "../outside.mp4" : "example.mp4";
  const out = path.join(dir, filename);
  writeFileSync(out, "sample video bytes");
  writeFileSync(args[args.indexOf("--print-to-file") + 2], JSON.stringify(out) + "\\n");
}
`,
    { mode: 0o755 },
  );
  return {
    argsFile,
    outDir,
    env: { LUOPIAN_YTDLP: ytdlp, LUOPIAN_FFMPEG: ffmpeg, LUOPIAN_TEST_ARGS: argsFile },
  };
}

test(
  "CLI saves a piped share link to the exact output directory",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const { argsFile, env, outDir } = fixture(t, "Saved videos | Review");
    const result = runCli(["--quality", "1080", "-o", outDir], {
      input: `https://youtu.be/${id}?list=PL123\n`,
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(outDir, "example.mp4")));
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.equal(args.at(-1), url);
    assert.ok(!args.includes(outDir));
    assert.equal(readFileSync(path.join(outDir, "example.mp4"), "utf8"), "sample video bytes");
    assert.equal(
      args[args.indexOf("--output") + 1],
      VIDEO_FILENAME.replace(".%(ext)s", " [1080p].%(ext)s"),
    );
    assert.ok(args.includes("bv*[height<=1080]+ba/b[height<=1080]"));
  },
);

test(
  "CLI fails when yt-dlp exits unsuccessfully or reports an invalid file",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const { env, outDir } = fixture(t);
    for (const [mode, expectedError] of [
      ["exit", /exit code 8/i],
      ["empty", /complete video file/i],
      ["outside", /complete video file/i],
    ]) {
      const result = runCli(["-p", "best", "-o", outDir, url], {
        env: { ...env, LUOPIAN_TEST_MODE: mode },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expectedError);
      assert.doesNotMatch(result.stdout, /saved to/i);
    }
  },
);

test(
  "Cancelling the CLI terminates downloader subprocesses",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const { env, outDir } = fixture(t);
    const child = spawn(process.execPath, [cli, "-o", outDir, url], {
      env: { ...process.env, LUOPIAN_LANG: "en", ...env, LUOPIAN_TEST_MODE: "signal" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const closed = once(child, "close");
    const [ready] = await Promise.race([once(child.stdout, "data"), closed.then(() => [""])]);
    assert.match(ready, /download process tree ready/, stderr);
    assert.ok(child.kill("SIGTERM"));

    const [exitCode, signal] = await closed;
    assert.equal(exitCode, 143, stderr);
    assert.equal(signal, null);
    assert.match(stderr, /SIGTERM/);
    assert.doesNotMatch(stdout, /FFmpeg survived cancellation|saved to/i);
  },
);

test("CLI rejects removed modes and links", () => {
  const video = runCli(["--preset", "mp3", url]);
  assert.equal(video.status, 2);
  assert.match(video.stderr, /video quality/i);
  const playlist = runCli(["https://www.youtube.com/playlist?list=PL123"]);
  assert.equal(playlist.status, 2);
  assert.match(playlist.stderr, /single YouTube video/i);
  const image = runCli(["https://example.com/watch"]);
  assert.equal(image.status, 2);
  assert.match(image.stderr, /single YouTube video/i);
});

test(
  "CLI doctor fails when a required tool cannot run",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const { env, outDir } = fixture(t);
    const good = runCli(["doctor"], { env });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /yt-dlp test version/);
    const failed = runCli(["doctor"], {
      env: { ...env, LUOPIAN_YTDLP: path.join(outDir, "missing") },
    });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /could not run yt-dlp/i);
  },
);
