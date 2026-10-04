/** User-facing CLI copy. Commands (q, 1–5, flags) stay the same in both languages. */

const zh = {
  brand: "落片",
  prefix: "[落片]",
  version: "落片 CLI 1.0.0",
  prompt: "落片> ",
  help: `落片 (luopian) — 终端下载器

用法:
  luopian                 进入交互模式（粘贴链接）
  luopian [选项] <url>
  echo <url> | luopian
  luopian doctor
  luopian lang zh|en      记住语言（写入配置文件）

选项:
  -p, --preset <id>   best|mp3|audio|hd1080|playlist|subs|thumb|tweet|media|artwork|illustrations|author|bookmarks|ranking  （默认自动）
  -o, --out <目录|模板>  输出目录；若含 % 则当作 yt-dlp 文件名模板
  -F, --list-formats  列出可用清晰度（yt-dlp -F）
  -e, --end <n>       播放列表 / 图片条数上限
  -f, --format <id>   yt-dlp 格式编号
  --video-only        所选视频格式 + bestaudio
  --cookies <file>    Netscape cookies.txt
  --cookies-from-browser <name>  从浏览器读 Cookie（chrome/safari/firefox/edge）
  --impersonate [t]   yt-dlp impersonate（需要 curl_cffi）
  -h, --help          显示帮助
  -v, --version       显示版本

语言:
  luopian lang zh     之后一直用中文
  luopian lang en     之后一直用英文
  LUOPIAN_LANG=zh     只影响这一次，优先于已保存的选择
  未设置时：LANG 或 LC_ALL 以 zh 开头用中文，否则英文

示例:
  luopian                              # 启动后粘贴链接
  luopian "视频链接"                    # 默认最高画质
  luopian -p hd1080 "视频链接"          # 1080p 以内 + 合成 mp4
  luopian -p mp3 "视频链接"             # 只要音频 → mp3
  luopian -F "视频链接"                 # 先看清晰度列表
  luopian -p playlist "播放列表链接"    # 下整个播放列表
  luopian -o "%(title)s.%(ext)s" "视频链接"  # 指定文件名模板

X / Twitter（gallery-dl）:
  luopian "https://x.com/用户/status/ID"          # 这条推文全部原图
  luopian --cookies-from-browser chrome "推特链接"
  luopian -p media --cookies-from-browser chrome "https://x.com/用户/media"
`,
  started: "落片已启动。粘贴链接后回车，再选 1–5；输入 q 退出。",
  savingTo: (dir) => `保存到：${dir}`,
  bye: "已退出。",
  pixivMenu: `
1) 这张作品（多图一起下）
2) 这位画师的全部投稿
3) 只要插画，不要漫画和动图
4) 我的收藏
`,
  xMenu: `
1) 这条推文里的全部原图
2) 需要登录：带上 Chrome Cookie 再下
3) 画师 Media 页全部图片（Chrome Cookie）
`,
  videoMenu: `
1) 默认最高画质
2) 1080p 以内最高画质（合成 mp4）
3) 只要音频 → mp3
4) 先看清晰度列表（-F）
5) 下整个播放列表
`,
  choosePixiv: "请选择 [1-4]: ",
  chooseX: "请选择 [1-3]: ",
  chooseVideo: "请选择 [1-5]: ",
  badPixiv: "无效选项，请输入 1–4。",
  badX: "无效选项，请输入 1–3。",
  badVideo: "无效选项，请输入 1–5。",
  unknownOption: (flag) => `未知选项：${flag}`,
  unknownPreset: (preset, list) => `未知规格：${preset}。可选：${list}`,
  done: (dir) => `完成 → ${dir}`,
  exitCode: (code) => `退出码 ${code}`,
  doctorTitle: "落片 doctor — Mac 工具路径",
  doctorTitleWin: "落片 doctor — 工具路径",
  cliEntry: (file) => `CLI 入口：${file}`,
  installNpm: "安装：     cd ~/Desktop/落片-mac && npm link",
  installLn: '或：       ln -sf "$PWD/bin/luopian.mjs" /usr/local/bin/luopian',
  installWinNode: "Windows：node bin/luopian.mjs    或    npm run cli",
  installWinNpm: "也可在项目目录 npm link，然后用 luopian（npm 全局目录需在 PATH 中）",
  toolMissing: (name) => `找不到 ${name}`,
  toolInstall() {
    return process.platform === "win32"
      ? "Windows 安装：winget install -e --id yt-dlp.yt-dlp，winget install -e --id yt-dlp.FFmpeg，winget install -e --id mikf.gallery-dl；或 scoop install yt-dlp ffmpeg gallery-dl。"
      : "Mac 安装：brew install yt-dlp ffmpeg gallery-dl。";
  },
  needUrl: "请提供 URL",
  badUrl: (text) => `无效 URL：${text}`,
  badProtocol: "只支持 http/https",
  noArtist: "链接里没有画师用户名",
  langUsage: "用法：luopian lang zh|en",
  badLang: "未知语言。请用 zh 或 en。",
  langSaved: (name) => `语言已保存为${name}。`,
  langNow: (name, via) => `当前语言：${name}（${via}）`,
  langName: "中文",
  viaEnv: "来自 LUOPIAN_LANG，优先于已保存的选择",
  viaFile: (file) => `已保存于 ${file}`,
  viaLocale: (which) => `来自 ${which}`,
  viaDefault: "未检测到中文环境，默认英文",
  langFiles: "已写入：",
  quitWord: "退出",
};

const en = {
  brand: "Luopian",
  prefix: "[Luopian]",
  version: "Luopian CLI 1.0.0",
  prompt: "luopian> ",
  help: `Luopian — terminal downloader

Usage:
  luopian                 Interactive mode (paste links)
  luopian [options] <url>
  echo <url> | luopian
  luopian doctor
  luopian lang zh|en      Remember the language

Options:
  -p, --preset <id>   best|mp3|audio|hd1080|playlist|subs|thumb|tweet|media|artwork|illustrations|author|bookmarks|ranking  (default: auto)
  -o, --out <dir|tpl> Output directory, or a yt-dlp filename template if it contains %
  -F, --list-formats  List available formats (yt-dlp -F)
  -e, --end <n>       Playlist / image post range end
  -f, --format <id>   yt-dlp format id
  --video-only        Prefer the selected video format + bestaudio
  --cookies <file>    Netscape cookies.txt
  --cookies-from-browser <name>  Read cookies from a browser (chrome/safari/firefox/edge)
  --impersonate [t]   yt-dlp impersonate target (needs curl_cffi)
  -h, --help          Show help
  -v, --version       Show version

Language:
  luopian lang zh     Keep using Chinese
  luopian lang en     Keep using English
  LUOPIAN_LANG=en     This run only; overrides the saved choice
  Otherwise: Chinese when LANG or LC_ALL starts with zh, else English

Examples:
  luopian                              # start, then paste links
  luopian "https://…"                  # best quality
  luopian -p hd1080 "https://…"        # up to 1080p, merged mp4
  luopian -p mp3 "https://…"           # audio only → mp3
  luopian -F "https://…"               # list formats first
  luopian -p playlist "https://…"      # whole playlist
  luopian -o "%(title)s.%(ext)s" "https://…"  # filename template

X / Twitter (gallery-dl):
  luopian "https://x.com/user/status/ID"       # every original image in that post
  luopian --cookies-from-browser chrome "https://x.com/…"
  luopian -p media --cookies-from-browser chrome "https://x.com/user/media"
`,
  started: "Luopian is ready. Paste a link and press Enter, then pick 1–5. Type q to quit.",
  savingTo: (dir) => `Saving to: ${dir}`,
  bye: "Bye.",
  pixivMenu: `
1) This artwork (all images)
2) Everything this artist posted
3) Illustrations only (skip manga and animations)
4) My bookmarks
`,
  xMenu: `
1) All original images in this post
2) Needs a login: download with Chrome cookies
3) Artist Media page (Chrome cookies)
`,
  videoMenu: `
1) Best quality (default)
2) Best up to 1080p (merge to mp4)
3) Audio only → mp3
4) List formats first (-F)
5) Whole playlist
`,
  choosePixiv: "Choose [1-4]: ",
  chooseX: "Choose [1-3]: ",
  chooseVideo: "Choose [1-5]: ",
  badPixiv: "Not a valid choice. Enter 1–4.",
  badX: "Not a valid choice. Enter 1–3.",
  badVideo: "Not a valid choice. Enter 1–5.",
  unknownOption: (flag) => `Unknown option: ${flag}`,
  unknownPreset: (preset, list) => `Unknown preset: ${preset}. Choose: ${list}`,
  done: (dir) => `done → ${dir}`,
  exitCode: (code) => `exited with code ${code}`,
  doctorTitle: "Luopian doctor — Mac tool paths",
  doctorTitleWin: "Luopian doctor — tool paths",
  cliEntry: (file) => `CLI entry: ${file}`,
  installNpm: "Install:   cd ~/Desktop/落片-mac && npm link",
  installLn: 'Or:        ln -sf "$PWD/bin/luopian.mjs" /usr/local/bin/luopian',
  installWinNode: "Windows: node bin/luopian.mjs    or    npm run cli",
  installWinNpm: "Or from this folder: npm link, then luopian (npm's global bin must be on PATH)",
  toolMissing: (name) => `Could not find ${name}`,
  toolInstall() {
    return process.platform === "win32"
      ? "On Windows: winget install -e --id yt-dlp.yt-dlp && winget install -e --id yt-dlp.FFmpeg && winget install -e --id mikf.gallery-dl — or scoop install yt-dlp ffmpeg gallery-dl."
      : "On Mac: brew install yt-dlp ffmpeg gallery-dl.";
  },
  needUrl: "Paste a URL",
  badUrl: (text) => `Invalid URL: ${text}`,
  badProtocol: "Only http/https links",
  noArtist: "No artist username in that link",
  langUsage: "Usage: luopian lang zh|en",
  badLang: "Unknown language. Use zh or en.",
  langSaved: (name) => `Language saved as ${name}.`,
  langNow: (name, via) => `Language: ${name} (${via})`,
  langName: "English",
  viaEnv: "from LUOPIAN_LANG, which overrides the saved choice",
  viaFile: (file) => `saved at ${file}`,
  viaLocale: (which) => `from ${which}`,
  viaDefault: "no Chinese locale detected, so English",
  langFiles: "Wrote:",
  quitWord: "quit",
};

export function messages(lang) {
  return lang === "zh" ? zh : en;
}
