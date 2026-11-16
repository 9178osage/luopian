# 落片 · Luopian

落片是一款适用于 macOS 和 Windows 的单条 YouTube 视频下载工具，提供桌面版和命令行版。支持普通视频链接、短链接、Shorts 和直播回放，可选「最高画质」或「最高 1080p」。只下载你有权保存的内容。

## 安装下载工具

macOS 使用 Homebrew 安装。

```sh
brew install yt-dlp ffmpeg
```

Windows 使用 winget 安装。

```powershell
winget install -e --id yt-dlp.yt-dlp
winget install -e --id yt-dlp.FFmpeg
```

安装后，在桌面版点「重新检查」，或按下文运行命令行自检。

## 桌面版

已打包的桌面应用自带 Node.js 运行时。从源码启动见下方「从源码运行与打包」。

1. 粘贴 YouTube 视频链接，选择画质，点「下载视频」。
2. 在「下载任务」中查看进度或取消任务。
3. 出现「可以保存」后，点「保存」选择存放位置。

在 macOS 上，关闭窗口后下载会继续。退出应用会停止正在进行的下载，Windows 上关闭窗口也会退出应用。程序最多保留最近 8 项已结束的任务，保留期约 3 小时。重新打开应用后，仍可在保留期内保存已下载的视频。

桌面版会在开始下载前以及下载和合并期间检查暂存盘的可用空间。若剩余空间低于 512 MiB，程序会阻止新下载，或停止当前下载并清理未完成的文件。合并时，视频轨、音轨和成片可能同时占用磁盘空间。

## 命令行

命令行需要 Node.js 22 或更新版本。以下命令在项目根目录运行。

```sh
node bin/luopian.mjs doctor
node bin/luopian.mjs "https://www.youtube.com/watch?v=VIDEO_ID"
node bin/luopian.mjs --quality 1080 -o "./我的视频" "https://youtu.be/VIDEO_ID"
```

默认下载最高画质，保存到用户的「下载」文件夹。用 `--quality 1080` 将分辨率限制在 1080p 以内，用 `-o` 或环境变量 `LUOPIAN_OUT` 指定保存目录。目录名含空格时，用引号包住路径。macOS 上含 `|` 的目录名也可用同样的写法。按 `Ctrl+C` 取消时，落片会一并终止正在运行的 FFmpeg。

也可以在项目根目录运行 `npm link` 注册 `luopian` 命令，再用 `luopian doctor` 自检。链接可以作为参数传入，也可以通过标准输入传入。若下载工具先前可用但开始报错，可先更新 `yt-dlp` 再试。

## 从源码运行与打包

使用 Node.js 22.12 或更新版本，在项目根目录运行 `npm ci` 安装依赖。

- `npm run electron:dev` 构建并运行桌面应用。
- `npm run dist:mac` 生成 macOS 应用和 DMG。
- `npm run dist:win` 生成 Windows x64 安装包。
- `npm test`、`npm run typecheck` 和 `npm run lint` 检查项目。

提交 `6c89a4c` 的 265 项测试、类型检查和 Lint 均已通过。在 macOS 上，桌面版和命令行版均实测下载了带音轨的 1920×1080 MP4。[查看代码提交](https://github.com/9178osage/luopian/commit/6c89a4c)
