const zh = {
  help: `落片 · 下载 YouTube、B 站视频或文件直链

  luopian [-f|--format mp4|mp4-silent|mp3] [--quality best|1080] [-o 目录] [链接]
  luopian [--aria2] [-o 目录] 文件直链
  luopian doctor
  luopian lang [zh|en]
  luopian --help
  luopian --version

默认输出带声音的 MP4。用 mp4-silent 保存无声 MP4，用 mp3 仅保存音频。
--quality 适用于两种 MP4，MP3 会忽略它。
文件直链保存为原格式。--aria2 在支持分段的服务器上优先使用多连接。
直接传入链接或含单条链接的分享文案，也可以通过标准输入传入。默认保存到「下载」文件夹。
用 -o 或 LUOPIAN_OUT 指定保存目录。`,
  prompt: "粘贴视频链接或文件直链，按回车下载 › ",
  invalidUrl: "请输入单条 YouTube、B 站视频链接或 HTTP(S) 文件直链。",
  unresolvedUrl: "无法打开 B 站短链接。请试试直接粘贴 B 站视频页面的链接。",
  invalidFormat: "输出格式请选择 mp4、mp4-silent 或 mp3。",
  invalidQuality: "画质请选择 best 或 1080。",
  tooManyArgs: "一次只能传入一条下载链接。",
  fileOptions: "文件直链保留原格式，画质和格式选项用于视频链接。",
  aria2Files: "aria2 加速用于文件直链。",
  fileWebpage: "这个链接打开的是网页。请复制文件的下载地址。",
  fileHttp: (status) => `服务器返回 HTTP ${status}，请检查文件链接。`,
  fileFailed: "文件下载中断。可重新运行同一条命令重试。",
  fileSpace: "下载磁盘空间不足。释放空间后请重试。",
  fileWrite: "无法写入下载文件。请检查目录权限和磁盘空间。",
  fileNameUnavailable: "保存目录里有太多同名文件。请选择其他目录。",
  extraCommandArgs: "此命令不接受这些参数。",
  toolMissing: (name) => `无法运行 ${name}。`,
  toolInstall: "请安装或更新 yt-dlp 和 ffmpeg。安装后可运行 luopian doctor 检查。",
  doctorTitle: "落片 · 下载工具检查",
  done: (file) => `已保存到 ${file}`,
  noFile: "下载器未生成所选格式的完整文件。",
  exitCode: (code) => `下载失败（退出码 ${code}）。`,
  exitSignal: (signal) => `下载已停止（${signal}）。`,
  langUsage: "用法：luopian lang zh|en",
  badLang: "请选择中文 zh 或英文 en。",
  langSaved: "界面语言已设为中文。",
  langNow: "当前界面语言为中文。",
};

const en = {
  help: `Luopian · Download YouTube and Bilibili videos or direct files

  luopian [-f|--format mp4|mp4-silent|mp3] [--quality best|1080] [-o DIRECTORY] [URL]
  luopian [--aria2] [-o DIRECTORY] FILE_URL
  luopian doctor
  luopian lang [zh|en]
  luopian --help
  luopian --version

The default is MP4 with sound. Use mp4-silent for silent video or mp3 for audio only.
--quality applies to both MP4 formats and is ignored for MP3.
Direct files keep their original format. --aria2 prefers multiple connections when supported.
Pass a URL or a share message with one link as an argument or via standard input.
Files go to Downloads by default.
Set -o or LUOPIAN_OUT to choose a destination.`,
  prompt: "Paste a video URL or direct file link and press Enter › ",
  invalidUrl: "Enter a single YouTube or Bilibili video URL or a direct HTTP(S) file link.",
  unresolvedUrl: "Could not open the Bilibili short link. Try the video page URL.",
  invalidFormat: "Choose mp4, mp4-silent or mp3 for the output format.",
  invalidQuality: "Choose best or 1080 for video quality.",
  tooManyArgs: "Enter one download link at a time.",
  fileOptions:
    "Direct files keep their original format. Format and quality options are for video URLs.",
  aria2Files: "aria2 acceleration is for direct file links.",
  fileWebpage: "This URL returned a webpage. Paste the direct file link.",
  fileHttp: (status) => `The server returned HTTP ${status}. Check the file link.`,
  fileFailed: "The file download was interrupted. Run the same command again to retry.",
  fileSpace: "The download disk is full. Free up space and try again.",
  fileWrite: "Could not write the download. Check folder permissions and free space.",
  fileNameUnavailable: "Choose another folder. Too many files with this name already exist.",
  extraCommandArgs: "This command does not accept those arguments.",
  toolMissing: (name) => `Could not run ${name}.`,
  toolInstall: "Install or update yt-dlp and ffmpeg, then run luopian doctor to check them.",
  doctorTitle: "Luopian · Download tool check",
  done: (file) => `Saved to ${file}`,
  noFile: "The downloader did not produce a complete file in the requested format.",
  exitCode: (code) => `Download failed with exit code ${code}.`,
  exitSignal: (signal) => `Download stopped by ${signal}.`,
  langUsage: "Usage: luopian lang zh|en",
  badLang: "Choose zh for Chinese or en for English.",
  langSaved: "The interface language is now English.",
  langNow: "The interface language is English.",
};

export function messages(lang) {
  return lang === "zh" ? zh : en;
}
