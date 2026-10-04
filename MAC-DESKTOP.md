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
- Saves to: `~/Downloads`
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

Spawns Vite `:8080` and opens a 落片 window.

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

Same app: paste a link, same numbered menus, `luopian lang zh|en`, save to that user's Downloads folder (not a 落片 subfolder).

Requirements: Node, plus `yt-dlp`, `ffmpeg`, and `gallery-dl` on PATH. Install with winget (`yt-dlp.yt-dlp`, `yt-dlp.FFmpeg`, `mikf.gallery-dl`) or scoop (`scoop install yt-dlp ffmpeg gallery-dl`).

```bash
node bin/luopian.mjs
npm run cli
node bin/luopian.mjs doctor
```

`package.json` has an electron-builder Windows target (`nsis`, x64) via `npm run dist:win`. That installer was not built on this Mac.
