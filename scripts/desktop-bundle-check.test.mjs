import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkDesktopBundle, externalScripts } from "./desktop-bundle-check.mjs";

test("finds scripts served from another origin", () => {
  const origin = "http://127.0.0.1:18080";
  const html = [
    '<script type="module" src="/assets/index.js"></script>',
    "<script nonce=abc>window.x = 1</script>",
    `<script src='${origin}/assets/other.js'></script>`,
    '<script async src="https://grok.com/grok-app-builder/extensions.js"></script>',
    "<SCRIPT SRC=//cdn.example.com/a.js></SCRIPT>",
  ].join("");
  assert.deepEqual(externalScripts(html, origin), [
    "https://grok.com/grok-app-builder/extensions.js",
    "//cdn.example.com/a.js",
  ]);
});

async function bundle(t, page) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "luopian-bundle-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "server"));
  await writeFile(
    path.join(directory, "server", "index.mjs"),
    `export async function middleware(_request, response) {
  response.setHeader("content-type", "text/html");
  response.end(${JSON.stringify(page)});
}
`,
  );
  return directory;
}

test(
  "passes a runtime that serves local scripts under the worker CSP",
  { timeout: 20000 },
  async (t) => {
    const directory = await bundle(
      t,
      '<html><script type="module" src="/assets/app.js"></script></html>',
    );
    assert.deepEqual(await checkDesktopBundle(directory), []);
  },
);

test("rejects a runtime that loads a remote script", { timeout: 20000 }, async (t) => {
  const directory = await bundle(
    t,
    '<html><script src="https://grok.com/grok-app-builder/extensions.js"></script></html>',
  );
  const problems = await checkDesktopBundle(directory);
  assert.ok(
    problems.some((problem) => problem.includes("external script")),
    problems.join("\n"),
  );
});
