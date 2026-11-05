import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config";
import type { DownloadOptions, DownloadProgress, MediaFormat, MediaInfo, MetadataTags } from "./types";

/** yt-dlp exited with an error (bad URL, unsupported site, video unavailable...) */
export class YtDlpError extends Error {
  constructor(message: string, public readonly exitCode: number | null) {
    super(message);
    this.name = "YtDlpError";
  }
}

/** The request itself is invalid (we refuse to pass it to yt-dlp) */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
}

function baseArgs(): string[] {
  const args = [...config.ytdlp.extraArgs];
  if (config.ytdlp.cookiesFile) args.push("--cookies", config.ytdlp.cookiesFile);
  return args;
}

/** Pulls the "ERROR: ..." lines out of yt-dlp stderr, falling back to the last line */
export function extractError(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => l.startsWith("ERROR:"));
  if (errors.length) return errors.map((l) => l.replace(/^ERROR:\s*/, "")).join("\n");
  return lines.at(-1) ?? "yt-dlp failed";
}

function run(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlp.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new YtDlpError(`yt-dlp timed out after ${timeoutMs}ms`, null));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new YtDlpError(`Could not start yt-dlp (${config.ytdlp.binary}): ${err.message}`, null));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new YtDlpError(extractError(stderr), code));
    });
  });
}

export function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || !url) throw new ValidationError("url is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError("url must use http or https");
  }
}

// ---------------------------------------------------------------------------
// Version / update
// ---------------------------------------------------------------------------

export async function getVersion(): Promise<string> {
  const { stdout } = await run(["--version"], 10_000);
  return stdout.trim();
}

/** Runs `yt-dlp --update-to <channel>`. Only works for the standalone binary (as in the Docker image). */
export async function update(channel = "stable"): Promise<string> {
  if (!/^[\w.@/-]+$/.test(channel)) throw new ValidationError("invalid update channel");
  const { stdout, stderr } = await run(["--update-to", channel], 120_000);
  return (stdout + stderr).trim();
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function toFormat(f: any): MediaFormat {
  return {
    formatId: f.format_id,
    ext: f.ext,
    resolution: f.resolution ?? null,
    fps: f.fps ?? null,
    vcodec: f.vcodec && f.vcodec !== "none" ? f.vcodec : null,
    acodec: f.acodec && f.acodec !== "none" ? f.acodec : null,
    filesize: f.filesize ?? f.filesize_approx ?? null,
    tbr: f.tbr ?? null,
    note: f.format_note ?? null,
  };
}

function toMediaInfo(raw: any): MediaInfo {
  const isPlaylist = raw._type === "playlist";
  const info: MediaInfo = {
    id: raw.id,
    type: isPlaylist ? "playlist" : "video",
    title: raw.title ?? raw.id,
    url: raw.webpage_url ?? raw.original_url,
    extractor: raw.extractor_key ?? raw.extractor,
    uploader: raw.uploader ?? null,
    channel: raw.channel ?? null,
    duration: raw.duration ?? null,
    uploadDate: raw.upload_date ?? null,
    viewCount: raw.view_count ?? null,
    isLive: raw.is_live ?? null,
    thumbnail: raw.thumbnail ?? null,
    description: raw.description ?? null,
  };
  if (isPlaylist) {
    info.entries = (raw.entries ?? []).map((e: any) => ({
      id: e.id,
      title: e.title ?? null,
      url: e.webpage_url ?? e.url ?? null,
      duration: e.duration ?? null,
    }));
  } else if (Array.isArray(raw.formats)) {
    info.formats = raw.formats.map(toFormat);
  }
  return info;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Fetches metadata without downloading.
 * Playlists are resolved flat (entries are not individually extracted) to keep it fast.
 */
export async function getInfo(url: string, opts: { raw?: boolean; playlist?: boolean } = {}): Promise<unknown> {
  assertHttpUrl(url);
  const args = [
    ...baseArgs(),
    "--dump-single-json",
    "--no-warnings",
    "--skip-download",
    opts.playlist ? "--flat-playlist" : "--no-playlist",
    "--",
    url,
  ];
  const { stdout } = await run(args, config.ytdlp.infoTimeoutMs);
  const raw = JSON.parse(stdout);
  return opts.raw ? raw : toMediaInfo(raw);
}

export async function getFormats(url: string): Promise<MediaFormat[]> {
  const info = (await getInfo(url)) as MediaInfo;
  return info.formats ?? [];
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const PROGRESS_TAG = "__PROGRESS__";
const STAGE_TAG = "__STAGE__";
const ORIGINAL_TAG = "__ORIGINAL__";

// Fields separated by "|"; title goes last since it may itself contain "|"
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_TAG}|%(progress.downloaded_bytes)s|%(progress.total_bytes)s` +
  `|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s` +
  `|%(info.playlist_index)s|%(info.n_entries)s|%(info.title)s`;

// Args are passed straight to the process (no shell), so we only reject non-strings and control chars
function checkValue(name: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 500 || /[\x00-\x1f]/.test(value)) {
    throw new ValidationError(`${name} must be a plain string`);
  }
}

function checkTemplate(name: string, template: unknown): asserts template is string {
  if (typeof template !== "string" || !template || template.startsWith("/") || template.startsWith("~") || template.includes("..")) {
    throw new ValidationError(`${name} must be a relative path without '..'`);
  }
  checkValue(name, template);
}

const DEFAULT_OUTPUT_TEMPLATE = "%(title)s [%(id)s].%(ext)s";
// One folder per source file, chapters numbered inside it
const DEFAULT_CHAPTER_TEMPLATE = "%(title)s [%(id)s]/%(section_number)02d - %(section_title)s.%(ext)s";

/** API tag name -> ffmpeg metadata key (set through yt-dlp's meta_<key> fields) */
const METADATA_KEYS: Record<keyof MetadataTags, string> = {
  title: "title",
  artist: "artist",
  album: "album",
  albumArtist: "album_artist",
  genre: "genre",
  date: "date",
  track: "track",
  composer: "composer",
  comment: "comment",
};

/**
 * Turns a literal value into a --parse-metadata FROM part.
 * FROM is an output template, so "%" is escaped, and ":" must be escaped as it separates FROM from TO.
 * A bare word would be read as a field name, so it is wrapped as the default of a missing field.
 */
function literalFrom(value: string): string {
  if (/^[A-Za-z_]+$/.test(value)) return `%(__literal|${value})s`;
  return value.replace(/%/g, "%%").replace(/:/g, "\\:");
}

function metadataArgs(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    throw new ValidationError("metadata must be an object");
  }
  const args: string[] = [];
  for (const [field, value] of Object.entries(tags)) {
    const key = METADATA_KEYS[field as keyof MetadataTags];
    if (!key) {
      throw new ValidationError(`metadata.${field} is not supported (allowed: ${Object.keys(METADATA_KEYS).join(", ")})`);
    }
    if (value === undefined || value === null) continue;
    const text = typeof value === "number" ? String(value) : value;
    checkValue(`metadata.${field}`, text);
    if (!(text as string).trim()) throw new ValidationError(`metadata.${field} must not be empty`);
    args.push("--parse-metadata", `pre_process:${literalFrom(text as string)}:%(meta_${key})s`);
  }
  return args;
}

export function buildDownloadArgs(o: DownloadOptions, jobDir: string): string[] {
  assertHttpUrl(o.url);
  checkValue("format", o.format);
  checkValue("audioFormat", o.audioFormat);
  checkValue("mergeFormat", o.mergeFormat);
  checkValue("playlistItems", o.playlistItems);
  checkValue("rateLimit", o.rateLimit);

  if (o.type !== undefined && o.type !== "video" && o.type !== "audio") {
    throw new ValidationError('type must be "video" or "audio"');
  }
  const audio = o.type ? o.type === "audio" : Boolean(o.audioOnly);

  const template = o.outputTemplate ?? DEFAULT_OUTPUT_TEMPLATE;
  checkTemplate("outputTemplate", template);

  const args = [
    ...baseArgs(),
    "--paths", jobDir,
    "--output", template,
    "--newline",
    "--progress",
    "--no-simulate",
    "--progress-template", PROGRESS_TEMPLATE,
    "--print", `post_process:${STAGE_TAG}processing`,
    o.playlist ? "--yes-playlist" : "--no-playlist",
  ];

  if (audio) {
    // Without a selector yt-dlp would fetch the full video just to throw the picture away
    args.push("--format", o.format ?? "bestaudio/best", "--extract-audio");
    if (o.audioFormat) args.push("--audio-format", o.audioFormat);
  } else {
    if (o.format) args.push("--format", o.format);
    if (o.mergeFormat) args.push("--merge-output-format", o.mergeFormat);
  }

  if (o.splitChapters) {
    const chapterTemplate = o.chapterTemplate ?? DEFAULT_CHAPTER_TEMPLATE;
    checkTemplate("chapterTemplate", chapterTemplate);
    args.push("--split-chapters", "--output", `chapter:${chapterTemplate}`);
    // Reports each final unsplit file, and whether it had chapters, so the manager can drop it
    args.push("--print", `after_move:${ORIGINAL_TAG}%(chapters.0.start_time|)s|%(filepath)s`);
  }
  if (o.playlistItems) args.push("--playlist-items", o.playlistItems);
  if (o.subtitles !== undefined && !Array.isArray(o.subtitles)) {
    throw new ValidationError("subtitles must be an array of language codes");
  }
  if (o.subtitles?.length) {
    const langs = o.subtitles.join(",");
    checkValue("subtitles", langs);
    args.push("--write-subs", "--sub-langs", langs);
    if (o.embedSubtitles) args.push("--embed-subs");
  }
  if (o.embedThumbnail) args.push("--embed-thumbnail");
  const tagArgs = metadataArgs(o.metadata);
  args.push(...tagArgs);
  if (o.embedMetadata || tagArgs.length) args.push("--embed-metadata");
  if (o.rateLimit) args.push("--limit-rate", o.rateLimit);

  args.push("--", o.url);
  return args;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === "NA" || value === "None" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface DownloadHandlers {
  onProgress(progress: DownloadProgress): void;
  onStage(stage: "processing"): void;
  /** Final path of a file that went through --split-chapters, and whether it actually had chapters */
  onOriginalFile?(filepath: string, hadChapters: boolean): void;
  onExit(code: number | null, stderr: string): void;
}

/**
 * Starts yt-dlp in its own process group so cancelling also kills ffmpeg children.
 */
export function spawnDownload(args: string[], handlers: DownloadHandlers): ChildProcess {
  const child = spawn(config.ytdlp.binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stderr = "";
  let buffer = "";

  const handleLine = (line: string) => {
    if (line.startsWith(PROGRESS_TAG)) {
      const [, downloaded, total, estimate, speed, eta, index, count, ...title] = line.split("|");
      const downloadedBytes = num(downloaded);
      const totalBytes = num(total) ?? num(estimate);
      handlers.onProgress({
        downloadedBytes,
        totalBytes,
        percent:
          downloadedBytes !== null && totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 1000) / 10) : null,
        speed: num(speed),
        eta: num(eta),
        playlistIndex: num(index),
        playlistCount: num(count),
        currentTitle: title.join("|") || null,
      });
    } else if (line.startsWith(STAGE_TAG)) {
      handlers.onStage("processing");
    } else if (line.startsWith(ORIGINAL_TAG)) {
      const [firstChapterStart, ...filepath] = line.slice(ORIGINAL_TAG.length).split("|");
      handlers.onOriginalFile?.(filepath.join("|"), num(firstChapterStart) !== null);
    }
  };

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach((l) => handleLine(l.trim()));
  });
  child.stderr!.on("data", (chunk) => {
    // Keep only the tail; long playlists can produce a lot of warnings
    stderr = (stderr + chunk).slice(-20_000);
  });
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    handlers.onExit(code, stderr);
  };
  child.on("error", (err) => {
    stderr += `\nERROR: Could not start yt-dlp (${config.ytdlp.binary}): ${err.message}`;
    exit(null);
  });
  child.on("close", exit);

  return child;
}

export function killDownload(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM"); // whole process group
  } catch {
    child.kill("SIGTERM");
  }
}
