# 落片 · Luopian

落片在 macOS 和 Windows 上下载单条 YouTube 视频。支持常规链接、短链接、Shorts 和已有回放的视频，可选择最高画质或最高 1080p。只下载你有权保存的内容。

## 桌面版

1. 粘贴 YouTube 视频链接，选择画质，点「下载视频」。
2. 在「下载任务」中查看进度或取消任务。
3. 出现「可以保存」后，点「保存」选择存放位置。

下载完成后可重新打开窗口继续保存。在临时目录中保留近期的已完成文件，最多 8 项，最长约 3 小时。保存到自选位置后可长期保留。桌面版自带运行界面所需的 Node 环境，需要系统安装 `yt-dlp` 和 `ffmpeg`。

桌面版下载和合并音视频时会检查暂存目录所在磁盘的可用空间。低于 512 MiB 时会停止并清除未完成的文件。大型视频合并时可能需要同时存放中间文件和成品。

## 命令行

CLI 需要 Node.js 22 或更新版本。默认保存至用户的 Downloads 文件夹，`-o` 或 `LUOPIAN_OUT` 可以指定目录。

```sh
npm run cli:doctor
node bin/luopian.mjs 'https://www.youtube.com/watch?v=VIDEO_ID'
node bin/luopian.mjs --quality 1080 -o ./videos 'https://youtu.be/VIDEO_ID'
```

也可用 `npm link` 注册 `luopian` 命令，或通过标准输入传入一条链接。

## 安装下载工具

macOS（Homebrew）

```sh
brew install yt-dlp ffmpeg
```

Windows（winget）

```powershell
winget install -e --id yt-dlp.yt-dlp
winget install -e --id yt-dlp.FFmpeg
```

安装后，在桌面版点「重新检查」或运行 `luopian doctor`。如果下载工具先前可用但开始报错，可先更新 yt-dlp 再试。

## 开发与打包

- `npm run electron:dev` 构建并运行桌面应用。
- `npm run dist:mac` 生成 macOS 应用和 DMG，`npm run dist:win` 生成 Windows x64 安装包。
- `npm test`、`npm run typecheck`、`npm run lint` 检查项目。
