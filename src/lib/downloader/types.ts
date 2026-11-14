import type { Quality } from "../../../shared/youtube.mjs";

export type JobStatus = "running" | "canceling" | "done" | "error" | "canceled";

export type JobView = {
  id: string;
  url: string;
  quality: Quality;
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
};
