/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this hook as CommonJS */
// electron-builder afterPack hook.
// The desktop app runs the Vite dev server inside the package, which needs
// packages electron-builder prunes as devDependencies (e.g. nitro's `scule`).
// Copy every missing package (and pruned nested node_modules) back in,
// before the DMG / NSIS installer is created. Works on macOS and Windows.
const fs = require("node:fs");
const path = require("node:path");

const SKIP = new Set([
  "electron", "electron-builder", "electron-publish", "app-builder-bin",
  "app-builder-lib", "dmg-builder", "@electron", "7zip-bin", ".bin", ".cache",
]);

function listPackages(nm) {
  const out = [];
  if (!fs.existsSync(nm)) return out;
  for (const name of fs.readdirSync(nm)) {
    if (name.startsWith(".") || SKIP.has(name)) continue;
    if (name.startsWith("@")) {
      for (const sub of fs.readdirSync(path.join(nm, name))) out.push(`${name}/${sub}`);
    } else out.push(name);
  }
  return out;
}

function findNested(nm, rel = "", depth = 0, acc = []) {
  if (depth > 4) return acc;
  let entries;
  try { entries = fs.readdirSync(path.join(nm, rel), { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".bin") continue;
    if (depth === 0 && SKIP.has(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.name === "node_modules" && depth > 0) acc.push(r);
    else findNested(nm, r, depth + 1, acc);
  }
  return acc;
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: false });
}

exports.default = async function afterPack(context) {
  const projectDir = context.packager.projectDir;
  const srcNm = path.join(projectDir, "node_modules");
  const appDir = context.electronPlatformName === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "app")
    : path.join(context.appOutDir, "resources", "app");
  const destNm = path.join(appDir, "node_modules");
  fs.mkdirSync(destNm, { recursive: true });

  let top = 0, nested = 0;
  for (const pkg of listPackages(srcNm)) {
    const dest = path.join(destNm, pkg);
    if (!fs.existsSync(dest)) { copy(path.join(srcNm, pkg), dest); top++; }
  }
  for (const rel of findNested(srcNm)) {
    const dest = path.join(destNm, rel);
    if (!fs.existsSync(dest)) { copy(path.join(srcNm, rel), dest); nested++; }
  }
  // Sanity check: the dev server cannot start without these.
  for (const must of ["nitro/dist/node_modules/scule", "nitro", "vite", "nf3"]) {
    if (!fs.existsSync(path.join(destNm, must))) throw new Error(`afterPack: ${must} missing from packaged app`);
  }
  console.log(`  • afterPack vendored ${top} packages, ${nested} nested node_modules`);
};
