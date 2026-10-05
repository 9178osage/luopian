# 落片 Mac — CLI + Desktop GUI

Work dir: `~/Desktop/落片-mac` (original `~/Downloads/落片源码` untouched)

## Terminal CLI (primary — working)

Open **Terminal.app** (new tab picks up PATH from `~/.zshrc`):

```bash
luopian doctor
luopian "https://www.youtube.com/watch?v=..."
luopian -p mp3 "https://..."
luopian -p playlist -e 3 "https://.../playlist?list=..."
echo "https://..." | luopian
```

- Binary: `~/.local/bin/luopian` → `~/Desktop/落片-mac/bin/luopian.mjs`
- Also: `~/bin/luopian`
- Saves to: `~/Downloads` (override with `LUOPIAN_OUT` or `-o`)
- Uses Homebrew: `yt-dlp`, `ffmpeg`, `gallery-dl`

If `luopian` not found:

```bash
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
# or
cd ~/Desktop/落片-mac && npm link
```

## Electron GUI (secondary — working in this session)

```bash
cd ~/Desktop/落片-mac
npm run electron:dev
```

Spawns Vite on `127.0.0.1:8080` (loopback only) and opens a 落片 window.

Downloads first land in the job directory (`~/Library/Application Support/Luopian/jobs` on Mac; `%LOCALAPPDATA%\Luopian\jobs` on Windows). Click 「保存到电脑」 to take the file out via `/api/jobs/…/file`. Electron does not hardcode a save folder; the system dialog usually offers Downloads, but that is not guaranteed in code. Job dirs are cleaned after about 3 hours (max 8 finished jobs; pruned on startup across restarts) and are not permanent storage. Cookies written for a job are deleted when the job finishes.

Unsigned build (optional):

```bash
npm run dist:mac
# → release/…/落片.app
```

## Notes

- Chrome `--impersonate` disabled by default (brew yt-dlp lacks curl_cffi). Opt-in: `luopian --impersonate chrome …` or `LUOPIAN_IMPERSONATE=chrome`.
- Engine Mac paths in `src/lib/downloader/engine.server.ts`.
- Tools missing? `npm run mac:tools`

## Windows

Same menus and language switch as Mac. Terminal saves to that user's Downloads. Desktop still uses the job directory first, then 「保存到电脑」.

Requirements: Node, plus `yt-dlp`, `ffmpeg`, and `gallery-dl` on PATH. Install with winget (`yt-dlp.yt-dlp`, `yt-dlp.FFmpeg`, `mikf.gallery-dl`) or scoop (`scoop install yt-dlp ffmpeg gallery-dl`).

```bash
node bin/luopian.mjs
npm run cli
node bin/luopian.mjs doctor
```

`package.json` has an electron-builder Windows target (`nsis`, x64) via `npm run dist:win`. That installer was not built on this Mac.
