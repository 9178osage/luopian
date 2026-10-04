import type { PresetId } from "@/lib/downloader/presets";

export type ProbeFormat = {
  id: string;
  ext: string;
  height: number | null;
  fps: number | null;
  vcodec: string;
  acodec: string;
  filesize: number | null;
  note: string;
  videoOnly: boolean;
  audioOnly: boolean;
};

export type ProbeResult = {
  kind: "video" | "playlist" | "images";
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  extractor: string | null;
  id: string | null;
  entryCount: number | null;
  formats: ProbeFormat[];
};

export type JobStatus = "running" | "done" | "error" | "canceled";

export type JobView = {
  id: string;
  url: string;
  preset: PresetId;
  title: string;
  status: JobStatus;
  percent: number | null;
  speed: string | null;
  eta: string | null;
  total: string | null;
  log: string[];
  filename: string | null;
  bytes: number | null;
  error: string | null;
  warning: string | null;
};

export type EngineInfo = {
  ytdlp: boolean;
  ffmpeg: boolean;
  gallerydl: boolean;
  version: string | null;
  galleryVersion: string | null;
};
