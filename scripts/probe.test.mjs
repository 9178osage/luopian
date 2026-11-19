import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test(
  "previews metadata without downloading media and preserves the selected Bilibili part",
  {
    skip: process.platform === "win32" ? "uses an executable Node fixture on Unix" : false,
  },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "luopian-probe-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tool = path.join(root, "fixture.mjs");
    await writeFile(
      tool,
      `#!/usr/bin/env node
import assert from "node:assert/strict";
const args = process.argv.slice(2);
if (args.length === 1) {
  console.log("2026.11.14");
  process.exit(0);
}
assert(args.includes("--simulate"));
assert(args.includes("--no-playlist"));
const url = new URL(args.at(-1));
const isBilibili = url.hostname === "www.bilibili.com";
assert.equal(args.includes("--remote-components"), !isBilibili);
console.log(JSON.stringify({
  title: "Preview title",
  thumbnail: isBilibili ? "http://i1.hdslb.com/cover.jpg" : "http://127.0.0.1/secret.jpg",
  duration: 61.25,
  height: 1080,
  vcodec: "avc1",
}));
console.log(JSON.stringify([
  {height: 720, vcodec: "avc1"},
  {height: 1080, vcodec: "avc1"},
  {height: 2160, vcodec: "none"},
  {height: 1500, vcodec: "mjpeg", protocol: "mhtml"},
]));
`,
      { mode: 0o700 },
    );
    const env = { LUOPIAN_YTDLP: tool, LUOPIAN_FFMPEG: tool, LUOPIAN_DESKTOP: "1" };
    for (const [key, value] of Object.entries(env)) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    const direct = "https://www.bilibili.com/video/BV1xx411c7mD?p=2";
    const fetched = t.mock.method(globalThis, "fetch", async (input, options) => {
      const url = new URL(input);
      if (url.hostname === "b23.tv") {
        assert.equal(options.redirect, "manual");
        return new Response(null, { status: 302, headers: { location: direct } });
      }
      assert.equal(url.href, "https://api.bilibili.com/x/player/pagelist?bvid=BV1xx411c7mD");
      assert.equal(options.redirect, "error");
      return Response.json({
        code: 0,
        data: [{ page: 2, part: "Second" }, { page: 0 }, { page: 1, part: "First" }],
      });
    });
    const { probeVideo } = await import("../src/lib/downloader/probe.server.ts");
    assert.deepEqual(await probeVideo("https://b23.tv/part2", "en"), {
      url: direct,
      title: "Preview title",
      thumbnail: "https://i1.hdslb.com/cover.jpg",
      duration: 61.25,
      maxHeight: 1080,
      heights: [1080, 720],
      parts: [
        { number: 1, title: "First" },
        { number: 2, title: "Second" },
      ],
      selectedPart: 2,
    });
    const youtube = await probeVideo("https://youtu.be/jNQXAC9IVRw", "en");
    assert.equal(youtube.thumbnail, null);
    assert.equal(youtube.selectedPart, null);
    assert.deepEqual(youtube.parts, []);
    await assert.rejects(probeVideo("http://127.0.0.1/private", "en"), { status: 400 });
    assert.equal(fetched.mock.callCount(), 2);
  },
);
