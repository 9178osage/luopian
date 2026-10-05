# 落片 (Luopian)

Paste a link to download, from the terminal or as a desktop app.

落片是「粘贴链接就下载」：终端走 `luopian`，桌面窗口走同一套界面。两条路保存位置不同。

- **终端**：直接存到系统的「下载」文件夹（`~/Downloads`）。可用 `LUOPIAN_OUT` 或 `-o` 改。
- **桌面**：先下到应用数据里的任务目录（Mac：`~/Library/Application Support/Luopian/jobs`；Windows：`%LOCALAPPDATA%\Luopian\jobs`），完成后点「保存到电脑」，由 `/api/jobs/…/file` 把文件交出去。Electron 没有写死保存位置，系统对话框一般会落到「下载」，但代码没有保证这一点。任务目录大约 3 小时后清理，最多留 8 个已结束任务，不是最终存放处。

## 能下什么

- YouTube（yt-dlp）：1 默认最高画质，2 1080p 以内并合成 mp4，3 只要音频 mp3，4 列出清晰度（`yt-dlp -F`），5 整个播放列表。文件名 `%(title)s.%(ext)s`。
- X / Twitter（gallery-dl）：1 这条推文的全部原图，2 带上 Chrome Cookie 再试，3 画师 Media 页（`https://x.com/<用户>/media`，同样用 Chrome Cookie）。
- Pixiv（gallery-dl）：1 这一张作品的全部图片，2 画师的全部投稿，3 只要插画，4 收藏。图片任务默认不截成 40 条。
- Chrome `--impersonate` 默认关闭，需要时再加 `luopian --impersonate chrome` 或 `LUOPIAN_IMPERSONATE=chrome`。

## 语言

终端：`luopian lang zh` 或 `luopian lang en`（会记住）。桌面窗口有「中文 / EN」切换。

## Mac

依赖 Homebrew：`yt-dlp`、`ffmpeg`、`gallery-dl`，以及 Node。

```bash
luopian doctor
luopian
luopian "https://www.youtube.com/watch?v=..."
```

桌面：`npm run electron:dev`，或已安装的「落片」应用（Launchpad）。文件先下到任务目录，再点「保存到电脑」。

## Windows

用法和 Mac 相同（同样的菜单、语言开关）。终端直接存当前用户的 Downloads；桌面同样先下到任务目录，再点「保存到电脑」。差别只在于怎么找到工具：先查 PATH，再看 winget / scoop / chocolatey 的常见安装位置。

需要已安装 Node、`yt-dlp`、`ffmpeg`、`gallery-dl`。例如：

```bash
winget install -e --id yt-dlp.yt-dlp
winget install -e --id yt-dlp.FFmpeg
winget install -e --id mikf.gallery-dl
```

或 `scoop install yt-dlp ffmpeg gallery-dl`。

```bash
node bin/luopian.mjs
npm run cli
node bin/luopian.mjs doctor
```

`npm run electron:dev` 打开桌面窗口。`package.json` 里已有 Windows 安装包目标（nsis，x64，`npm run dist:win`）。这个安装包没有在这台 Mac 上构建。
