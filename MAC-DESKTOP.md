# 落片 macOS 桌面版

1. 安装下载工具 `brew install yt-dlp ffmpeg`，也可以使用项目的 `npm run mac:tools`。
2. 打开「落片」，粘贴单条 YouTube 视频链接，选择最高画质或最高 1080p。
3. 下载完成后，在「下载任务」点「保存」。保存对话框默认打开系统「下载」目录。

关闭窗口时下载会继续。在 Dock 点落片可恢复任务列表。退出应用会停止正在运行的下载，已完成的任务可以在保留期内重新打开应用保存。

桌面版的临时任务位于 `~/Library/Application Support/Luopian/jobs`。程序会定期清理自己创建的任务目录，保留最近 8 个结束的任务，保留期约 3 小时。请及时把文件保存到自己选择的目录。

从源码运行使用 `npm run electron:dev`。打包使用 `npm run dist:mac`，产物位于 `release/`。开发和打包需要 Node.js，安装完成的桌面应用使用 Electron 自带的 Node 环境。
