const zh = {
  help: `落片 · 下载单条 YouTube 视频

  luopian [--quality best|1080] [-o 目录] [链接]
  luopian doctor
  luopian lang [zh|en]
  luopian --help
  luopian --version

直接传入链接，也可以通过标准输入传入。默认保存到「下载」文件夹。
用 -o 或 LUOPIAN_OUT 指定保存目录。`,
  prompt: "粘贴 YouTube 视频链接，按回车下载 › ",
  invalidUrl: "请输入单条 YouTube 视频链接。",
  invalidQuality: "画质请选择 best 或 1080。",
  tooManyArgs: "一次只能传入一条视频链接。",
  extraCommandArgs: "此命令不接受这些参数。",
  toolMissing: (name) => `无法运行 ${name}。`,
  toolInstall: "请安装或更新 yt-dlp 和 ffmpeg。安装后可运行 luopian doctor 检查。",
  doctorTitle: "落片 · 下载工具检查",
  done: (file) => `已保存到 ${file}`,
  noFile: "下载器未生成完整的视频文件。",
  exitCode: (code) => `下载失败（退出码 ${code}）。`,
  exitSignal: (signal) => `下载已停止（${signal}）。`,
  langUsage: "用法：luopian lang zh|en",
  badLang: "请选择中文 zh 或英文 en。",
  langSaved: "界面语言已设为中文。",
  langNow: "当前界面语言为中文。",
};

const en = {
  help: `Luopian · Download one YouTube video

  luopian [--quality best|1080] [-o DIRECTORY] [URL]
  luopian doctor
  luopian lang [zh|en]
  luopian --help
  luopian --version

Pass a URL as an argument or pipe it in. Files go to Downloads by default.
Set -o or LUOPIAN_OUT to choose a destination.`,
  prompt: "Paste a YouTube video link and press Enter › ",
  invalidUrl: "Enter a link to a single YouTube video.",
  invalidQuality: "Choose best or 1080 for video quality.",
  tooManyArgs: "Enter one video link at a time.",
  extraCommandArgs: "This command does not accept those arguments.",
  toolMissing: (name) => `Could not run ${name}.`,
  toolInstall: "Install or update yt-dlp and ffmpeg, then run luopian doctor to check them.",
  doctorTitle: "Luopian · Download tool check",
  done: (file) => `Saved to ${file}`,
  noFile: "The downloader did not produce a complete video file.",
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
