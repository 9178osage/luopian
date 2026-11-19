import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";

import { processIsAlive } from "./process-lifetime.mjs";

const partialName = "transfer.part";
const stateName = "transfer.json";
const curlOptions = [
  "--disable",
  "--globoff",
  "--proto",
  "=http,https",
  "--proto-redir",
  "=http,https",
  "--suppress-connect-headers",
  "--no-buffer",
  "--connect-timeout",
  "15",
  "--speed-limit",
  "1",
  "--speed-time",
  "60",
  "--fail",
  "--header",
  "Accept-Encoding: identity",
  "--dump-header",
  "-",
  "--write-out",
  "\nluopian-url:%{url_effective}\n",
];

/** @typedef {{ percent: number, speed?: string, eta?: string }} Progress */
/** @typedef {{ url: string, directory: string, curl: string, aria2?: string | null, env: NodeJS.ProcessEnv, onProcess?: (child: import('node:child_process').ChildProcess | null) => void, onProgress?: (progress: Progress) => void, checkActive?: () => void }} Transfer */
/** @typedef {{ length: number | null, resource: string | null, validator: string | null, filename: string, ranges: boolean, html: boolean }} Metadata */
/** @typedef {{ url: string, meta: Metadata } & ({ backend: 'curl', bytes: number } | { backend: 'curl', bytes: null, writer: number } | { backend: 'aria2' })} Recovery */

export class FileDownloadError extends Error {
  /** @param {'webpage' | 'http' | 'transfer' | 'space' | 'write'} kind @param {number} [status] */
  constructor(kind, status) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

/** @param {string} value */
export function safeFilename(value) {
  let name = (value.split(/[/\\]/).at(-1) ?? "")
    .replace(/[<>:"|?*\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (!name || name === partialName) return "download";
  if (/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  if (Buffer.byteLength(name) <= 180) return name;
  const extension = path.extname(name);
  const suffix = Buffer.byteLength(extension) <= 24 ? extension : "";
  let shortened = "";
  for (const character of suffix ? name.slice(0, -suffix.length) : name) {
    if (Buffer.byteLength(shortened + character + suffix) > 180) break;
    shortened += character;
  }
  return shortened.replace(/[. ]+$/, "") + suffix;
}

/** @param {string} value */
function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** @param {string} value */
function strongETag(value) {
  return /^"[!#-~]*"$/.test(value);
}

/** @param {string} value */
function byteCount(value) {
  const size = /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(size) ? size : null;
}

/** @param {string} output @param {string} originalUrl @param {boolean} singleRequest */
function responseInfo(output, originalUrl, singleRequest = false) {
  const headers = new Map();
  let status = 0;
  let collecting = false;
  let effective = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^HTTP\/\S+ (\d{3})(?:\s|$)/.exec(line);
    if (match) {
      status = Number(match[1]);
      headers.clear();
      collecting = true;
    } else if (line.startsWith("luopian-url:") && line.length > 12) {
      effective = line.slice(12);
    } else if (!line) {
      collecting = false;
    } else if (collecting) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
  }
  const url = new URL(effective ?? originalUrl);
  url.hash = "";
  const disposition = headers.get("content-disposition") ?? "";
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i.exec(disposition)?.[1];
  const basic = /(?:^|;)\s*filename\s*=\s*(?:"([^"\r\n]*)"|([^;]+))/i.exec(disposition);
  const title = extended ? decode(extended.trim()) : (basic?.[1] ?? basic?.[2]);
  const etag = headers.get("etag") ?? "";
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(headers.get("content-range") ?? "");
  const meta = {
    length:
      status === 206 && range
        ? byteCount(range[3])
        : byteCount(headers.get("content-length") ?? ""),
    // Validators are scoped to the effective URI, including its query.
    resource:
      effective || singleRequest ? createHash("sha256").update(url.href).digest("hex") : null,
    validator: strongETag(etag) ? etag : null,
    filename: safeFilename(title || decode(url.pathname.split("/").filter(Boolean).at(-1) ?? "")),
    ranges: /^bytes$/i.test(headers.get("accept-ranges") ?? ""),
    html:
      /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(
        headers.get("content-type") ?? "",
      ) && !/^attachment(?:\s*;|$)/i.test(disposition),
  };
  return {
    status,
    effectiveUrl: url.href,
    location: headers.get("location"),
    start: range ? byteCount(range[1]) : null,
    end: range ? byteCount(range[2]) : null,
    meta,
  };
}

/** @param {string} validator */
function verifyAriaResponses(validator) {
  let waitingForStatus = false;
  let status = 0;
  let etag = "";
  let verified = false;
  let changed = false;
  return {
    /** @param {string} raw */
    read(raw) {
      const line = raw.trimEnd();
      // aria2's info log reports the complete response head for each connection.
      if (/\bCUID#\d+ - Response received:$/.test(line)) {
        waitingForStatus = true;
        return;
      }
      if (waitingForStatus) {
        waitingForStatus = false;
        status = Number(/^HTTP\/\S+ (\d{3})(?:\s|$)/.exec(line)?.[1] ?? 0);
        etag = "";
      } else if (status && !line) {
        if (status === 200 || status === 206) {
          if (etag === validator) verified = true;
          else changed = true;
        } else if (status >= 300 && status < 400) {
          // A redirect can select a different resource with the same ETag.
          changed = true;
        }
        status = 0;
      } else if (status && /^etag:/i.test(line)) {
        etag = etag ? "invalid" : line.slice(5).trim();
      }
    },
    result() {
      return { verified: verified && !changed && !status && !waitingForStatus, changed };
    },
  };
}

/** @param {string} filename */
async function fileSize(filename) {
  try {
    const details = await lstat(filename);
    if (!details.isFile()) throw new Error("Unexpected transfer path");
    return details.size;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

/** @param {Transfer} options @param {string} command @param {string[]} args @param {'curl' | 'aria2'} backend @param {{ validator?: string, onHeaders?: (head: string, pid: number) => Promise<void> }} controls */
function run(options, command, args, backend, { validator, onHeaders } = {}) {
  options.checkActive?.();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let tail = "";
    let responseTail = "";
    /** @type {Promise<void> | undefined} */
    let headerSaved;
    const responses = validator ? verifyAriaResponses(validator) : null;
    /** @type {NodeJS.ErrnoException | undefined} */
    let error;
    const progress = (/** @type {string} */ chunk) => {
      const lines = (tail + chunk).split(/[\r\n]/);
      tail = (lines.pop() ?? "").slice(-2000);
      for (const line of lines) {
        const info =
          backend === "aria2"
            ? /\((\d+)%\).*?\bDL:([^\s\]]+)(?:\s+ETA:([^\s\]]+))?/.exec(line)
            : /(\d+(?:\.\d+)?)%\s*$/.exec(line);
        if (info) options.onProgress?.({ percent: Number(info[1]), speed: info[2], eta: info[3] });
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (responses) {
        const lines = (responseTail + chunk).split("\n");
        responseTail = (lines.pop() ?? "").slice(-128 * 1024);
        for (const line of lines) responses.read(line);
      }
      if (backend === "aria2") progress(chunk);
      else {
        stdout = (stdout + chunk).slice(-128 * 1024);
        if (onHeaders && !headerSaved && child.pid) {
          const heads = stdout.split(/\r?\n\r?\n/);
          const head = heads.slice(0, -1).find((part) => /^HTTP\/\S+ [2-5]\d\d\b/.test(part));
          if (head) headerSaved = onHeaders(head, child.pid).catch(() => undefined);
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
      progress(chunk);
    });
    child.once("error", (cause) => {
      error = cause;
    });
    child.once("close", async (code) => {
      options.onProcess?.(null);
      await headerSaved;
      const diskFull =
        (backend === "aria2" && code === 9) ||
        (code === 23 && /no space left|disk quota exceeded|disk is full/i.test(stderr));
      resolve({
        code,
        stdout,
        error,
        responses: responses?.result(),
        writeFailure: diskFull ? "space" : backend === "curl" && code === 23 ? "write" : null,
      });
    });
    options.onProcess?.(child);
  });
}

/** @param {string} directory @param {string} url */
async function recovery(directory, url) {
  try {
    const filename = path.join(directory, stateName);
    const size = await fileSize(filename);
    if (size === null || size > 8192) return null;
    const state = /** @type {Recovery} */ (JSON.parse(await readFile(filename, "utf8")));
    const meta = state.meta;
    const v = meta?.validator;
    if (
      state.url === url &&
      ["curl", "aria2"].includes(state.backend) &&
      typeof meta?.resource === "string" &&
      /^[a-f0-9]{64}$/.test(meta.resource) &&
      typeof meta.filename === "string" &&
      meta.filename === safeFilename(meta.filename) &&
      (meta.length === null || (Number.isSafeInteger(meta.length) && meta.length >= 0)) &&
      typeof v === "string" &&
      strongETag(v) &&
      (state.backend !== "curl" ||
        (state.bytes === null
          ? Number.isSafeInteger(state.writer) && state.writer > 0
          : Number.isSafeInteger(state.bytes) &&
            state.bytes > 0 &&
            (meta.length === null || state.bytes < meta.length)))
    )
      return state;
  } catch {
    /* A missing or invalid checkpoint means starting fresh. */
  }
  return null;
}

/** @param {string} directory @param {Recovery} state */
async function checkpoint(directory, state) {
  const temporary = path.join(directory, stateName + ".tmp");
  await rm(temporary, { force: true });
  await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  await rename(temporary, path.join(directory, stateName));
}

/** @param {string} directory */
async function clearPartial(directory) {
  for (const name of [stateName, partialName, `${partialName}.aria2`]) {
    await rm(path.join(directory, name), { force: true });
  }
}

/** @param {Recovery} state @param {number} size */
function recoverableBytes(state, size) {
  if (state.backend !== "curl") return 0;
  const bytes = state.bytes ?? size;
  return bytes <= size && (state.meta.length === null || bytes < state.meta.length) ? bytes : 0;
}

/** @param {ReturnType<typeof responseInfo>} info @param {Metadata} resume @param {number} offset */
function matchesResume({ status, meta, start, end }, resume, offset) {
  return (
    status === 206 &&
    start === offset &&
    meta.length !== null &&
    end === meta.length - 1 &&
    meta.resource === resume.resource &&
    (resume.length === null || meta.length === resume.length) &&
    meta.validator === resume.validator
  );
}

/** @param {Transfer} options @param {string} part @param {Recovery | null} state */
async function curlDownload(options, part, state) {
  const existing = state?.backend === "curl" ? ((await fileSize(part)) ?? 0) : 0;
  if (state?.backend === "curl" && state.bytes === null && processIsAlive(state.writer)) {
    throw new FileDownloadError("transfer");
  }
  const offset = state ? recoverableBytes(state, existing) : 0;
  const resume = offset ? state?.meta : null;
  if (!resume) await clearPartial(options.directory);
  else {
    // Freeze the verified prefix until this request's headers validate any new bytes.
    await checkpoint(options.directory, {
      url: options.url,
      backend: "curl",
      meta: resume,
      bytes: offset,
    });
    if (existing > offset) await truncate(part, offset);
  }
  const args = [
    ...curlOptions,
    "--progress-bar",
    ...(resume ? ["--continue-at", "-", "--header", `If-Range: ${resume.validator}`] : []),
    "--output",
    part,
    "--",
  ];
  let url = options.url;
  let result;
  let info;
  // Request each redirect target explicitly, so an in-flight checkpoint knows
  // the exact URI even if curl never reaches its final --write-out.
  for (let redirects = 0; ; redirects++) {
    result = await run(options, options.curl, [...args, url], "curl", {
      async onHeaders(head, writer) {
        const info = responseInfo(head, url, true);
        const { meta } = info;
        if (meta.html || !meta.validator || meta.length === 0) return;
        if (resume ? !matchesResume(info, resume, offset) : info.status !== 200) return;
        await checkpoint(options.directory, {
          url: options.url,
          backend: "curl",
          meta: { ...meta, filename: resume?.filename ?? meta.filename },
          bytes: null,
          writer,
        });
      },
    });
    if (result.writeFailure) {
      await clearPartial(options.directory);
      throw new FileDownloadError(result.writeFailure);
    }
    info = responseInfo(result.stdout, url, true);
    if (info.status < 300 || info.status >= 400 || !info.location) break;
    const next = new URL(info.location, url);
    if (
      redirects >= 10 ||
      !["http:", "https:"].includes(next.protocol) ||
      next.username ||
      next.password
    ) {
      if (!resume) await clearPartial(options.directory);
      throw new FileDownloadError("transfer");
    }
    if (resume) {
      const size = await fileSize(part);
      if (size === null || size < offset) return curlDownload(options, part, null);
      if (size > offset) await truncate(part, offset);
    } else {
      await rm(part, { force: true });
    }
    url = next.href;
  }
  const { status, meta } = info;
  if (
    resume &&
    (status === 200 ||
      status === 204 ||
      status === 412 ||
      status === 416 ||
      (status === 206 && !matchesResume(info, resume, offset)))
  ) {
    await clearPartial(options.directory);
    return curlDownload(options, part, null);
  }
  if (meta.html && status < 400) {
    await clearPartial(options.directory);
    throw new FileDownloadError("webpage");
  }
  const expected = resume ? status === 206 : status === 200 || status === 204;
  let size = await fileSize(part);
  if (expected && result.code === 0 && size === null) {
    await writeFile(part, "", { flag: "wx", mode: 0o600 });
    size = 0;
  }
  if (
    expected &&
    result.code === 0 &&
    size !== null &&
    (meta.length === null || meta.length === size)
  ) {
    return { part, filename: resume?.filename ?? meta.filename };
  }
  // Keep only bytes from a response that can be checked on the next attempt.
  if (
    expected &&
    size &&
    meta.resource &&
    meta.validator &&
    (meta.length === null || size < meta.length)
  ) {
    await checkpoint(options.directory, {
      url: options.url,
      backend: "curl",
      meta: { ...meta, filename: resume?.filename ?? meta.filename },
      bytes: size,
    });
  } else if (!resume || expected) {
    await clearPartial(options.directory);
  }
  if (result.error) throw result.error;
  throw new FileDownloadError(status >= 400 ? "http" : "transfer", status);
}

/** @param {Transfer} options @param {string} part @param {Recovery | null} state */
async function ariaDownload(options, part, state) {
  const result = await run(
    options,
    options.curl,
    [
      ...curlOptions,
      "--location",
      "--max-redirs",
      "10",
      "--head",
      "--silent",
      "--show-error",
      "--max-time",
      "15",
      "--",
      options.url,
    ],
    "curl",
  );
  const { status, meta, effectiveUrl } = responseInfo(result.stdout, options.url);
  if (
    result.code !== 0 ||
    status !== 200 ||
    !meta.resource ||
    !meta.validator ||
    meta.html ||
    !meta.ranges ||
    meta.length === null ||
    meta.length < 8 * 1024 ** 2
  ) {
    return curlDownload(options, part, null);
  }
  const previous = state?.meta;
  if (
    !previous?.validator ||
    previous.validator !== meta.validator ||
    previous.resource !== meta.resource ||
    previous.length !== meta.length ||
    (await fileSize(`${part}.aria2`)) === null
  ) {
    await clearPartial(options.directory);
  }
  // Save recovery metadata only after checking the headers from this attempt.
  await rm(path.join(options.directory, stateName), { force: true });
  const download = await run(
    options,
    options.aria2 ?? "aria2c",
    [
      "--no-conf=true",
      "--no-netrc=true",
      "--follow-torrent=false",
      "--follow-metalink=false",
      "--allow-overwrite=true",
      "--auto-file-renaming=false",
      "--file-allocation=none",
      "--continue=true",
      "--max-connection-per-server=4",
      "--split=4",
      "--min-split-size=2M",
      "--connect-timeout=15",
      "--timeout=60",
      "--max-tries=3",
      "--retry-wait=1",
      "--summary-interval=0",
      "--log=-",
      "--log-level=info",
      "--auto-save-interval=1",
      "--enable-color=false",
      "--header=Accept-Encoding: identity",
      `--header=If-Match: ${meta.validator}`,
      `--dir=${options.directory}`,
      `--out=${partialName}`,
      "--",
      effectiveUrl,
    ],
    "aria2",
    { validator: meta.validator },
  );
  if (download.writeFailure) {
    await clearPartial(options.directory);
    throw new FileDownloadError(download.writeFailure);
  }
  if (
    download.code === 0 &&
    download.responses?.verified &&
    (await fileSize(part)) === meta.length &&
    (await fileSize(`${part}.aria2`)) === null
  ) {
    return { part, filename: meta.filename };
  }
  // A server that declines range requests can still be downloaded with curl.
  if (
    download.code === 0 ||
    download.code === 8 ||
    download.code === 22 ||
    download.responses?.changed ||
    download.error?.code === "ENOENT"
  )
    return curlDownload(options, part, null);
  if (download.responses?.verified && (await fileSize(`${part}.aria2`)) !== null) {
    await checkpoint(options.directory, { url: options.url, backend: "aria2", meta });
  } else {
    await clearPartial(options.directory);
  }
  if (download.error) throw download.error;
  throw new FileDownloadError("transfer");
}

/** @param {Transfer} options */
export async function downloadDirectFile(options) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(options.directory)).isDirectory())
    throw new Error("Unexpected transfer directory");
  const part = path.join(options.directory, partialName);
  const saved = await recovery(options.directory, options.url);
  return options.aria2 && saved?.backend !== "curl"
    ? ariaDownload(options, part, saved)
    : curlDownload(options, part, saved);
}

/** @param {string} directory @param {string} url */
export async function hasDirectCheckpoint(directory, url) {
  const saved = await recovery(directory, url);
  if (!saved) return false;
  const part = path.join(directory, partialName);
  const size = await fileSize(part);
  if (!size) return false;
  return saved.backend === "curl"
    ? recoverableBytes(saved, size) > 0
    : (await fileSize(`${part}.aria2`)) !== null;
}
