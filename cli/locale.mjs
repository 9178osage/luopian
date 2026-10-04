import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** XDG-style and macOS Application Support. Either file is enough. */
export function langFilePaths() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      path.join(home, ".config", "luopian", "lang"),
      path.join(home, "Library", "Application Support", "Luopian", "lang"),
    ];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(home, ".config", "luopian", "lang"), path.join(appData, "Luopian", "lang")];
  }
  return [
    path.join(home, ".config", "luopian", "lang"),
    path.join(home, "Library", "Application Support", "Luopian", "lang"),
  ];
}

/** Accept zh / en and common locale tags (zh_CN, en_US.UTF-8). */
export function normalizeLang(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "");
  if (!text) return null;
  const head = text.split(/[\s.@]/)[0];
  if (head === "en" || head.startsWith("en_") || head === "english") return "en";
  if (head === "zh" || head.startsWith("zh_") || head.startsWith("zh-") || head === "chinese") return "zh";
  return null;
}

function readSaved() {
  for (const file of langFilePaths()) {
    try {
      const lang = normalizeLang(readFileSync(file, "utf8"));
      if (lang) return { lang, source: file };
    } catch {
      /* missing or unreadable */
    }
  }
  return null;
}

/**
 * LUOPIAN_LANG wins, then a saved file, then LANG/LC_ALL.
 * LC_ALL overrides LANG when it is set. Anything that does not start with zh is English.
 */
export function detectLang() {
  const fromEnv = normalizeLang(process.env.LUOPIAN_LANG);
  if (fromEnv) return { lang: fromEnv, source: "LUOPIAN_LANG" };

  const saved = readSaved();
  if (saved) return saved;

  const lcAll = process.env.LC_ALL;
  const langEnv = process.env.LANG;
  const picked = lcAll && lcAll.trim() ? lcAll : langEnv || "";
  const source = lcAll && lcAll.trim() ? "LC_ALL" : langEnv ? "LANG" : "default";
  if (/^zh/i.test(picked.trim())) return { lang: "zh", source };
  return { lang: "en", source };
}

export function saveLang(lang) {
  const value = normalizeLang(lang);
  if (value !== "zh" && value !== "en") {
    const err = new Error("bad-lang");
    err.code = "BAD_LANG";
    throw err;
  }
  const written = [];
  let lastError = null;
  for (const file of langFilePaths()) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${value}\n`, "utf8");
      written.push(file);
    } catch (err) {
      lastError = err;
    }
  }
  if (!written.length) throw lastError || new Error("Could not save language");
  return { lang: value, files: written };
}
