# 落片 · Luopian

## 安装

### Mac

1. 安装 Homebrew，在终端运行下面的命令。[Homebrew](https://brew.sh/)

   ```sh
   brew install yt-dlp ffmpeg
   ```

2. 打开 `.dmg` 安装包，把「落片」拖进「应用程序」，然后双击打开。

### Windows（x64）

1. 打开 PowerShell，安装下载工具。

   ```powershell
   winget install -e --id yt-dlp.yt-dlp
   winget install -e --id yt-dlp.FFmpeg
   ```

2. 双击 `落片 Setup` 开头的 `.exe` 安装包，安装后从「开始」菜单打开落片。

### 生成安装包

需要自行生成安装包时，安装 Node.js 22.12 或更新版本，下载并解压源码，在项目目录运行 `npm ci`。[下载 Node.js](https://nodejs.org/en/download)

- Mac 运行 `npm run dist:mac`。
- Windows 运行 `npm run dist:win`。

安装包在项目的 `release/` 文件夹里。

## 使用

1. 打开落片，粘贴 YouTube、哔哩哔哩视频链接、分享文案或文件直链。
2. 下载视频时选择有声 MP4、无声 MP4 或 MP3。MP4 可选画质。点击「加入下载队列」。
3. 下载完成后点击「保存」，选择存放位置。中断后可点击「继续下载」或「重试」。

**命令行**　装好 Node.js 后，在项目目录运行 `npm link`，再运行 `luopian "链接"`。默认保存到「下载」文件夹。
