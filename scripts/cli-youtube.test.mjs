import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeVideoUrl, VIDEO_FILENAME, videoArgs } from "../shared/video.mjs";

const id = "abcDEF123_9";
const url = `https://www.youtube.com/watch?v=${id}`;
const cli = fileURLToPath(new URL("../bin/luopian.mjs", import.meta.url));

test("canonicalizes one YouTube video from watch, share, mobile, Shorts, live and embed links", () => {
  for (const input of [
    ` https://www.youtube.com/watch?v=${id}&list=PL123&t=120 `,
    `https://youtu.be/${id}?si=sample`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}`,
    `https://youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) {
    assert.equal(normalizeVideoUrl(input), url);
  }
});

test("rejects playlist-only, ambiguous, malformed and unsupported links", () => {
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
    assert.equal(normalizeVideoUrl(input), null);
  }
});

test("caps both 1080p format branches and prevents skipped fragments from succeeding", () => {
  const common = { url, ffmpeg: "/tools/ffmpeg", nodeBin: "/tools/node" };
  const limited = videoArgs({ quality: "hd1080", ...common });
  assert.deepEqual(limited[limited.indexOf("--format") + 1].split("/"), [
    "bv*[height<=1080]+ba",
    "b[height<=1080]",
  ]);
  assert.ok(limited.includes("--abort-on-unavailable-fragments"));
  assert.ok(limited.includes("--ignore-config"));
  assert.ok(limited.includes("--no-playlist"));
  assert.ok(limited.includes("node:/tools/node"));
  const best = videoArgs({ quality: "best", ...common });
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
  const curl = path.join(root, "curl");
  const argsFile = path.join(root, "arguments");
  const outDir = path.join(root, folder);
  writeFileSync(
    ffmpeg,
    '#!/bin/sh\nif [ "$1" = -version ]; then printf "ffmpeg test version\\n"; exit 0; fi\n[ "$LUOPIAN_TEST_MODE" != corrupt ]\n',
    { mode: 0o755 },
  );
  writeFileSync(curl, "#!/bin/sh\nprintf 'curl test version\\n'\n", { mode: 0o755 });
  writeFileSync(
    ytdlp,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("yt-dlp test version");
  process.exit(0);
}
writeFileSync(process.env.LUOPIAN_TEST_ARGS, JSON.stringify(args));
if (process.env.LUOPIAN_TEST_MODE === "exit") process.exit(8);
if (process.env.LUOPIAN_TEST_MODE === "empty") process.exit(0);
const extension = args.includes("--audio-format") && process.env.LUOPIAN_TEST_MODE !== "wrong-format"
  ? "mp3"
  : "mp4";
const output = "example." + extension;
if (process.env.LUOPIAN_TEST_MODE === "interrupted-conversion") {
  writeFileSync(output, "truncated conversion");
  writeFileSync("stream.part", "resumable bytes");
  process.exit(8);
}
if (process.env.LUOPIAN_TEST_MODE === "signal") {
  writeFileSync(output, "unfinished conversion");
  spawn(process.execPath, ["-e", [
    'process.on("SIGTERM", () => {});',
    'console.log("download process tree ready");',
    'setTimeout(() => console.log("FFmpeg survived cancellation"), 4000);',
  ].join("\\n")], { stdio: "inherit" });
} else {
  const out = process.env.LUOPIAN_TEST_MODE === "outside" ? "../outside.mp4" : output;
  if (process.env.LUOPIAN_TEST_MODE === "resume" && !existsSync("stream.part")) process.exit(12);
  if (!existsSync(out)) writeFileSync(out, "sample video bytes");
  writeFileSync(args[args.indexOf("--print-to-file") + 2], JSON.stringify(out) + "\\n");
}
`,
    { mode: 0o755 },
  );
  return {
    argsFile,
    outDir,
    env: {
      LUOPIAN_YTDLP: ytdlp,
      LUOPIAN_FFMPEG: ffmpeg,
      LUOPIAN_CURL: curl,
      LUOPIAN_TEST_ARGS: argsFile,
    },
  };
}

test(
  "CLI saves a video from piped share text to the exact output directory",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const { argsFile, env, outDir } = fixture(t, "Saved videos | Review");
    const result = runCli(["--quality", "1080", "-o", outDir], {
      input: `Video shared with you\n「https://youtu.be/${id}?list=PL123」\nOpen the app to watch`,
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

test("CLI rejects a share message containing multiple different videos", () => {
  const result = runCli([`Watch ${url} and https://www.bilibili.com/video/BV1bK411W797`]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /one download link/i);
});

test(
  "CLI downloads the selected Bilibili part with the requested quality",
  { skip: process.platform === "win32" },
  (t) => {
    const { argsFile, env, outDir } = fixture(t);
    const video = "https://www.bilibili.com/video/BV1bK411W797?p=2";
    const result = runCli(["--quality", "1080", "-o", outDir, `${video}&spm_id_from=333.1007`], {
      env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(outDir, "example.mp4")));
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.deepEqual(args.slice(-2), ["--", video]);
    assert.equal(args[args.indexOf("--format") + 1], "bv*[height<=1080]+ba/b[height<=1080]");
    assert.equal(args[args.indexOf("--use-extractors") + 1], "BiliBili");
    assert.equal(args[args.indexOf("--break-match-filters") + 1], "!playlist_index");
    assert.ok(args.includes("--no-playlist"));
    assert.ok(!args.includes("--js-runtimes"));
    assert.ok(!args.includes("--remote-components"));
  },
);

test(
  "CLI selects silent MP4 and applies the requested quality",
  { skip: process.platform === "win32" },
  (t) => {
    const { argsFile, env, outDir } = fixture(t);
    const result = runCli(["-f", "mp4-silent", "-q", "1080", "-o", outDir, url], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(outDir, "example.mp4")));
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    const format = args[args.indexOf("--format") + 1];
    assert.equal(format, "bv[height<=1080]/b[height<=1080]");
    assert.equal(args[args.indexOf("--remux-video") + 1], "mp4");
    assert.match(args[args.indexOf("--postprocessor-args") + 1], /^Metadata\+ffmpeg_o:.*-an/);
    assert.ok(!args.includes("--paths"));
    assert.match(args[args.indexOf("--output") + 1], /\[silent\]/);
    assert.ok(!args.includes("--extract-audio"));
    assert.deepEqual(readdirSync(outDir), ["example.mp4"]);
  },
);

test(
  "CLI selects MP3, ignores video quality and verifies the output extension",
  { skip: process.platform === "win32" },
  (t) => {
    const { argsFile, env, outDir } = fixture(t);
    const command = ["--format", "mp3", "-q", "1080", "-o", outDir, url];
    const result = runCli(command, { env });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(outDir, "example.mp3")));
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--audio-format") + 1], "mp3");
    assert.ok(args.includes("--extract-audio"));
    assert.doesNotMatch(args[args.indexOf("--format") + 1], /height/);
    assert.equal(args[args.indexOf("--output") + 1], VIDEO_FILENAME);

    const invalid = runCli(command, { env: { ...env, LUOPIAN_TEST_MODE: "wrong-format" } });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /complete file in the requested format/i);
    assert.doesNotMatch(invalid.stdout, /saved to/i);
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
      ["empty", /complete file in the requested format/i],
      ["outside", /complete file in the requested format/i],
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
  "CLI retains download fragments and replaces interrupted conversions for every format",
  { skip: process.platform === "win32" },
  (t) => {
    for (const format of ["mp4", "mp4-silent", "mp3"]) {
      const { env, outDir } = fixture(t, "Saved | videos");
      const args = ["-f", format, "-o", outDir, url];
      const interrupted = runCli(args, {
        env: { ...env, LUOPIAN_TEST_MODE: "interrupted-conversion" },
      });
      assert.equal(interrupted.status, 1);
      assert.equal(readdirSync(outDir).length, 1);
      assert.match(readdirSync(outDir)[0], /^\.luopian-resume-/);
      const filename = format === "mp3" ? "example.mp3" : "example.mp4";
      writeFileSync(path.join(outDir, filename), "previous download");

      const recovered = runCli(args, { env: { ...env, LUOPIAN_TEST_MODE: "resume" } });
      assert.equal(recovered.status, 0, recovered.stderr);
      const recoveredName = filename.replace(/\.(mp3|mp4)$/, " (1).$1");
      assert.deepEqual(readdirSync(outDir).sort(), [recoveredName, filename]);
      assert.equal(readFileSync(path.join(outDir, filename), "utf8"), "previous download");
      assert.equal(readFileSync(path.join(outDir, recoveredName), "utf8"), "sample video bytes");
    }
  },
);

test(
  "CLI rejects a completed path that fails media validation",
  { skip: process.platform === "win32" },
  (t) => {
    const { env, outDir } = fixture(t);
    const result = runCli(["-f", "mp3", "-o", outDir, url], {
      env: { ...env, LUOPIAN_TEST_MODE: "corrupt" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /complete file in the requested format/i);
    assert.deepEqual(readdirSync(outDir), []);
  },
);

test(
  "Cancelling the CLI terminates downloader subprocesses and removes silent staging files",
  { skip: process.platform === "win32", timeout: 10000 },
  async (t) => {
    const { env, outDir } = fixture(t);
    const child = spawn(process.execPath, [cli, "-f", "mp4-silent", "-o", outDir, url], {
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
    assert.deepEqual(readdirSync(outDir), []);
  },
);

test("CLI rejects removed modes and links", () => {
  const video = runCli(["--preset", "mp3", url]);
  assert.equal(video.status, 2);
  assert.match(video.stderr, /video quality/i);
  const playlist = runCli(["https://www.youtube.com/playlist?list=PL123"]);
  assert.equal(playlist.status, 2);
  assert.match(playlist.stderr, /single YouTube or Bilibili video/i);
  const image = runCli(["ftp://example.com/image.jpg"]);
  assert.equal(image.status, 2);
  assert.match(image.stderr, /single YouTube or Bilibili video/i);
});

test("CLI rejects unsupported output formats", () => {
  const result = runCli(["--format", "webm", url]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /mp4, mp4-silent or mp3/i);
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
    const missingCurl = runCli(["doctor"], {
      env: { ...env, LUOPIAN_CURL: path.join(outDir, "missing-curl") },
    });
    assert.equal(missingCurl.status, 1);
    assert.match(missingCurl.stderr, /could not run curl/i);
    const missingAria = runCli(["doctor"], {
      env: { ...env, LUOPIAN_ARIA2: path.join(outDir, "missing-aria2") },
    });
    assert.equal(missingAria.status, 0, missingAria.stderr);
    assert.match(missingAria.stderr, /could not run aria2c/i);
  },
);
