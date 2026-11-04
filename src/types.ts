export type DownloadStatus =
  | "queued"
  | "downloading"
  | "processing" // post-processing: merging, extracting audio, embedding...
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadOptions {
  url: string;
  /** yt-dlp format selector, e.g. "bestvideo[height<=1080]+bestaudio/best" */
  format?: string;
  /** Extract audio only (-x) */
  audioOnly?: boolean;
  /** Audio codec for audioOnly: mp3, m4a, opus, flac, wav, best... */
  audioFormat?: string;
  /** Remux/merge container for video: mp4, mkv, webm... */
  mergeFormat?: string;
  /** Download every entry when the URL is a playlist (default false) */
  playlist?: boolean;
  /** Playlist items selection, e.g. "1-5,8" */
  playlistItems?: string;
  /** Download subtitles in these languages, e.g. ["en", "fr"] */
  subtitles?: string[];
  embedSubtitles?: boolean;
  embedThumbnail?: boolean;
  embedMetadata?: boolean;
  /** Rate limit, e.g. "2M" */
  rateLimit?: string;
  /** yt-dlp output template, relative to the job folder */
  outputTemplate?: string;
}

export interface DownloadProgress {
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speed: number | null; // bytes/s
  eta: number | null; // seconds
  currentTitle: string | null;
  /** 1-based index of the item being downloaded for playlists */
  playlistIndex: number | null;
  playlistCount: number | null;
}

export interface DownloadFile {
  name: string; // path relative to the job folder
  size: number;
}

export interface DownloadJob {
  id: string;
  status: DownloadStatus;
  options: DownloadOptions;
  progress: DownloadProgress;
  files: DownloadFile[];
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type TransferStatus = "pending" | "running" | "completed" | "failed";

export interface TransferJob {
  id: string;
  downloadId: string;
  remoteFolder: string;
  status: TransferStatus;
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
  currentFile: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Subset of yt-dlp's info dict we expose by default */
export interface MediaFormat {
  formatId: string;
  ext: string;
  resolution: string | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  tbr: number | null;
  note: string | null;
}

export interface MediaInfo {
  id: string;
  type: "video" | "playlist";
  title: string;
  url: string;
  extractor: string;
  uploader: string | null;
  channel: string | null;
  duration: number | null;
  uploadDate: string | null;
  viewCount: number | null;
  isLive: boolean | null;
  thumbnail: string | null;
  description: string | null;
  formats?: MediaFormat[];
  entries?: Array<{ id: string; title: string | null; url: string | null; duration: number | null }>;
}
