import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractVideoUrls,
  isVideoScratch,
  MAX_SHARE_TEXT,
  normalizeVideoUrl,
  OUTPUTS,
  resolveVideoUrl,
  videoArgs,
} from "../shared/video.mjs";

const bvid = "BV1bK411W797";
const direct = `https://www.bilibili.com/video/${bvid}`;
const short = "https://b23.tv/aB12x";

test("extracts ordered links from share text and drops canonical duplicates", () => {
  const text =
    `【分享】「${short}?share_source=copy_web」，${direct}?p=2&from=share。\n` +
    `(https://youtu.be/abcDEF123_9). ${short}\n` +
    `${direct}?p=3 https://www.youtube.com/watch?v=abcDEF123_9&list=PL123`;
  assert.deepEqual(extractVideoUrls(text), [
    short,
    `${direct}?p=2`,
    "https://www.youtube.com/watch?v=abcDEF123_9",
    `${direct}?p=3`,
  ]);
});

test("ignores unsupported URLs, ambiguous parts and oversized share text", () => {
  assert.deepEqual(extractVideoUrls(`${direct}?p=1&p=2 https://b23.tv.example/aB12x`), []);
  assert.deepEqual(extractVideoUrls(`${short}${" ".repeat(MAX_SHARE_TEXT)}`), []);
});

test("canonicalizes Bilibili video links and preserves the selected part", () => {
  assert.equal(
    normalizeVideoUrl(`http://m.bilibili.com/video/${bvid}/?spm_id_from=abc&p=2#t=5`),
    `${direct}?p=2`,
  );
  assert.equal(
    normalizeVideoUrl("https://bilibili.com/video/AV1074402/"),
    "https://www.bilibili.com/video/av1074402",
  );
  assert.equal(normalizeVideoUrl(`${short}/?share_source=copy_web`), short);
});

test("rejects Bilibili links that do not select one ordinary video or part", () => {
  for (const url of [
    `${direct}?p=0`,
    `${direct}?p=-1`,
    `${direct}?p=1&p=2`,
    `${direct}/other`,
    "https://www.bilibili.com/bangumi/play/ss123",
    "https://space.bilibili.com/123/lists",
    "https://live.bilibili.com/1",
    "https://www.bilibili.com.evil.test/video/BV1bK411W797",
    "https://www.bilibili.com:8443/video/BV1bK411W797",
    "https://someone@b23.tv/aB12x",
    "https://b23.tv/aB12x/extra",
  ]) {
    assert.equal(normalizeVideoUrl(url), null, url);
  }
});

test("resolves a b23.tv share link without requesting the redirect destination", async () => {
  const hops = [];
  const result = await resolveVideoUrl(short, async (url, options) => {
    hops.push(url);
    assert.equal(options.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: url === short ? "/bC23y" : `${direct}/?p=2&spm_id_from=abc` },
    });
  });
  assert.equal(result, `${direct}?p=2`);
  assert.deepEqual(hops, [short, "https://b23.tv/bC23y"]);
  assert.equal(
    await resolveVideoUrl(direct, () => assert.fail("direct links make no request")),
    direct,
  );
});

test("stops short-link redirects at non-video destinations or cycles", async () => {
  for (const location of [
    "http://127.0.0.1/internal",
    "https://www.bilibili.com/bangumi/play/ss123",
    "https://www.youtube.com/watch?v=abcDEF123_9",
    short,
  ]) {
    const hops = [];
    assert.equal(
      await resolveVideoUrl(short, async (url) => {
        hops.push(url);
        return new Response(null, { status: 302, headers: { location } });
      }),
      null,
    );
    assert.deepEqual(hops, [short]);
  }
});

test("all output formats disable subtitle downloads and embedding", () => {
  for (const output of OUTPUTS) {
    const args = videoArgs({ url: direct, quality: "best", ffmpeg: null, nodeBin: null, output });
    for (const flag of ["--no-write-subs", "--no-write-auto-subs", "--no-embed-subs"]) {
      assert.ok(args.includes(flag), `${output} is missing ${flag}`);
    }
  }
});

test("recognizes resumable yt-dlp leftovers but not finished files", () => {
  for (const name of [
    "片段 [abcDEF123_9].mp4.part",
    "片段 [abcDEF123_9].mp4.part-Frag12",
    "片段 [abcDEF123_9].mp4.ytdl",
    "片段 [abcDEF123_9].f137.mp4",
    "片段 [abcDEF123_9] [1080p].f140.m4a",
  ]) {
    assert.equal(isVideoScratch(name), true, name);
  }
  for (const name of ["片段 [abcDEF123_9].mp4", "Track.f1 [abcDEF123_9].mp3", "notes.txt"]) {
    assert.equal(isVideoScratch(name), false, name);
  }
});
