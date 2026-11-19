# 落片 · Luopian

落片在 macOS 和 Windows 上下载 YouTube、哔哩哔哩视频和 HTTP(S) 文件直链。视频可保存为有声 MP4、无声 MP4 或 MP3 音频。只下载你有权保存的内容。

- **YouTube**支持普通链接、短链接、Shorts 和直播回放。
- **哔哩哔哩**支持普通投稿的 BV、av 链接和跳转到投稿的 `b23.tv` 短链接。用含 `?p=2` 的链接可指定第 2 P，未指定分 P 时下载第 1 P。实际画质取决于视频和平台在未登录时提供的格式。

## 桌面版

1. 粘贴视频链接、文件直链或完整的分享文案。点「查看视频信息」可看标题、封面、时长和可用画质。B 站投稿有多个分 P 时，可在这里选 P。
2. 选好视频格式及画质后，点「加入下载队列」。视频和直链可混合排队，按粘贴顺序逐条下载。每批最多 20 条，视频使用本批的格式和画质，直链保留原文件名和格式。
3. 出现「可以保存」后，点「保存」选择存放位置。

可以在「下载任务」里取消等待中或正在下载的任务。遇到网络中断或程序被强制退出时，经过文件版本校验的直链进度可在重新打开后继续。服务器拒绝续传或文件已变更时，文件直链会从头下载。点击「重试」可沿用原设置重新排队，重试排队或运行时会复用同一次尝试。

文件直链默认用 curl。系统装有 aria2 时，可以勾选「优先用 aria2 加速大文件」。达到 8 MiB、支持分段且提供强 ETag 的文件可使用最多 4 条连接。文件版本无法核对时使用 curl 完整下载。

在「应用程序」中双击已安装的「落片」即可打开窗口。从源码启动时，在项目目录运行 `npm run electron:dev`。打包后的桌面版自带 Node.js 运行时，系统需安装 `yt-dlp` 和 `ffmpeg`。下载时不另外获取字幕。

应用会保留近期下载供稍后保存，最多 100 项，最长约 3 小时。在 macOS 上关闭窗口后下载会继续。退出应用会停止当前下载，等待中的任务会在下次打开时继续排队。Windows 上关闭窗口会退出应用。

桌面版下载和合并音视频时会检查暂存目录所在磁盘的可用空间。低于 512 MiB 时会停止并清除未完成的文件。大型视频合并时可能需要同时存放中间文件和成品。

## 命令行

命令行需要 Node.js 22 或更新版本。`luopian` 后面跟视频链接即可下载。默认保存最高画质的有声 MP4 到用户的「下载」文件夹。`--format` 可选 `mp4`、`mp4-silent` 或 `mp3`。`--quality 1080` 适用于 MP4。`-o` 或 `LUOPIAN_OUT` 可以指定保存目录。

```sh
luopian doctor
luopian 'https://www.youtube.com/watch?v=VIDEO_ID'
luopian --format mp4-silent --quality 1080 -o ./videos 'https://www.bilibili.com/video/BV1bK411W797?p=2'
luopian --format mp3 'https://www.youtube.com/watch?v=VIDEO_ID'
luopian 'https://example.com/report.pdf'
luopian --aria2 'https://example.com/archive.zip'
```

如果终端找不到 `luopian`，在项目目录中运行 `npm link` 注册命令，或把示例中的 `luopian` 换成 `node bin/luopian.mjs`。也可以通过标准输入传入一条链接，或含一条视频链接的分享文案。

终端里重新运行同一条下载命令，可复用保留的下载进度。

## 安装下载工具

macOS（Homebrew）

```sh
brew install yt-dlp ffmpeg
```

macOS 的文件直链使用系统提供的 curl。要开启可选的多连接加速，可运行 `brew install aria2`。

Windows（winget）

```powershell
winget install -e --id yt-dlp.yt-dlp
winget install -e --id yt-dlp.FFmpeg
```

Windows 的文件直链需要 `curl.exe`，多连接加速需要在 PATH 中提供 `aria2c.exe`。

安装后，在桌面版点「重新检查」或运行 `luopian doctor`。如果下载工具先前可用但开始报错，可先更新 yt-dlp 再试。

## 开发与打包

使用 Node.js 22.12 或更新版本，在项目目录运行 `npm ci` 安装依赖。

- `npm run electron:dev` 构建并运行桌面应用。
- 已运行 `npm run build:desktop` 时，用 `npm run electron:start` 打开桌面构建。网页预览先运行 `npm run build`，再运行 `npm run preview`。网页提供项目说明，下载功能在桌面版和命令行中可用。
- `npm run dist:mac` 在 `release/` 生成本机测试 DMG，镜像内的应用使用临时签名。公开分发运行 `npm run dist:mac:release`，需要 Developer ID Application 签名身份和由 `APPLE_KEYCHAIN_PROFILE` 指定的公证凭据。发布命令会在 `release/signed` 生成 DMG 并检查签名、公证和 Gatekeeper 验证。
- `npm run dist:win` 生成 Windows x64 安装包。
- `npm test`、`npm run typecheck`、`npm run lint` 检查项目。

Windows 工作流会在 Windows 上运行上述检查并构建安装包。迁移 GitLab 镜像时，在 GitHub 仓库变量 `GITLAB_MIRROR_PROJECT` 中指定 `命名空间/项目`，并配置对应项目的 `GITLAB_TOKEN` 密钥。主仓库默认使用原镜像，其他仓库由该变量启用镜像。
