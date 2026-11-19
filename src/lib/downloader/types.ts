import type { Output, Quality } from "../../../shared/video.mjs";

export type JobStatus = "queued" | "running" | "canceling" | "done" | "error" | "canceled";
export type FileDownloader = "curl" | "aria2";

export type JobView = {
  id: string;
  url: string;
  quality: Quality;
  // Absent from jobs saved before output selection was added.
  output?: Output;
  file?: FileDownloader;
  resumable?: boolean;
  retryOf?: string;
  status: JobStatus;
  percent: number | null;
  speed: string | null;
  eta: string | null;
  filename: string | null;
  bytes: number | null;
  error: string | null;
  startedAt: number;
};

export type EngineInfo = {
  ytdlp: boolean;
  ffmpeg: boolean;
  version: string | null;
  files: boolean;
  curl: boolean;
  aria2: boolean;
};
