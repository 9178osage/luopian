/* eslint-disable @typescript-eslint/no-require-imports -- Electron Builder loads this hook as CommonJS. */
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

module.exports = async function afterPack({ appOutDir, electronPlatformName, packager }) {
  if (electronPlatformName !== "darwin") return;
  const app = path.join(appOutDir, packager.appInfo.productFilename + ".app");
  // Finder attributes copied into the generated bundle prevent codesign.
  await promisify(execFile)("/usr/bin/xattr", ["-cr", app]);
};
