import type { Locale } from "../i18n.ts";

const zh = {
  badUrl: "请输入单条 YouTube 视频链接。",
  badQuality: "请选择有效的画质。",
  busy: "已有下载任务，请等当前任务结束。",
  closing: "下载服务正在关闭。",
  missingTools: "请安装 yt-dlp 和 FFmpeg，再重试。",
  storage: "无法写入任务目录。请检查磁盘空间和目录权限。",
  missingJob: "任务已过期或无法恢复。",
  missingFile: "文件已过期或无法读取。",
  forbidden: "此页面不能操作下载任务。",
  invalidJson: "请求必须使用 JSON 格式。",
  requestTooLarge: "请求内容太长。",
  failed: "视频下载失败。",
  missingOutput: "下载器没有产出完整的视频文件。",
  unavailable: "视频不可用，可能已删除、设为私人或受地区限制。",
  restricted: "YouTube 要求登录或验证，无法下载此视频。",
  format: "这个画质暂不可用，请换一个画质重试。",
  size: "任务文件超过 2 GiB，下载已停止。",
  timeout: "下载超时，请稍后重试。",
  interrupted: "上次下载在服务关闭时中断，请重新下载。",
};

const en: typeof zh = {
  badUrl: "Enter a link to a single YouTube video.",
  badQuality: "Choose a valid video quality.",
  busy: "Wait for the current download to finish.",
  closing: "The download service is shutting down.",
  missingTools: "Install yt-dlp and FFmpeg, then try again.",
  storage: "The job folder could not be written. Check free space and folder permissions.",
  missingJob: "This job expired or could not be recovered.",
  missingFile: "The video expired or could not be read.",
  forbidden: "This page cannot access the download task.",
  invalidJson: "The request must use JSON.",
  requestTooLarge: "The request is too large.",
  failed: "The video could not be downloaded.",
  missingOutput: "The downloader did not produce a complete video file.",
  unavailable:
    "The video is unavailable. It may have been removed, made private, or restricted in your region.",
  restricted: "YouTube requires a sign-in or verification for this video.",
  format: "This quality is unavailable. Try another quality.",
  size: "The job exceeded 2 GiB, so the download stopped.",
  timeout: "The download timed out. Try again later.",
  interrupted: "The download was interrupted when the service stopped. Start it again to continue.",
};

export function downloadMessages(locale: Locale) {
  return locale === "en" ? en : zh;
}
