/* eslint-disable @typescript-eslint/no-require-imports -- Electron Builder loads this hook as CommonJS. */
const { access } = require("node:fs/promises");
const path = require("node:path");

module.exports = async function beforeBuild({ appDir }) {
  const entry = path.resolve(appDir, "../dist/desktop/server/index.mjs");
  try {
    await access(entry);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error("Build the desktop runtime with npm run build:desktop before packaging.");
  }
  // Nitro has already bundled runtime dependencies. Skip Electron Builder's
  // npm rebuild and fallback search through the development workspace.
  return false;
};
