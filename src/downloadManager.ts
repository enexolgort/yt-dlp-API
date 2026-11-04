import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { config } from "./config";
import { buildDownloadArgs, extractError, killDownload, spawnDownload } from "./ytdlpClient";
import type { DownloadFile, DownloadJob, DownloadOptions } from "./types";

/**
 * In-memory download queue. Each job downloads into DOWNLOAD_DIR/<jobId>/.
 * At most MAX_CONCURRENT_DOWNLOADS yt-dlp processes run at once; the rest wait in the queue.
 * Job state is lost on restart (files on disk are kept).
 */

const jobs = new Map<string, DownloadJob>();
const processes = new Map<string, ChildProcess>();
const queue: string[] = [];

// Leftovers from interrupted downloads, not real output
const TEMP_FILE = /\.(part|ytdl|temp)(-Frag\d+)?$|\.part-Frag\d+/;

export function jobDir(id: string): string {
  return path.join(config.ytdlp.downloadDir, id);
}

function listFiles(dir: string, base = dir): DownloadFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    if (TEMP_FILE.test(entry.name)) return [];
    return [{ name: path.relative(base, full).split(path.sep).join("/"), size: fs.statSync(full).size }];
  });
}

function emptyProgress(): DownloadJob["progress"] {
  return {
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    speed: null,
    eta: null,
    currentTitle: null,
    playlistIndex: null,
    playlistCount: null,
  };
}

export function createDownload(options: DownloadOptions): DownloadJob {
  const id = randomUUID();
  // Validate before queueing so bad requests fail fast with a 400
  buildDownloadArgs(options, jobDir(id));

  const job: DownloadJob = {
    id,
    status: "queued",
    options,
    progress: emptyProgress(),
    files: [],
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return job;
}

function pump(): void {
  while (processes.size < config.ytdlp.maxConcurrent && queue.length) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (job?.status === "queued") start(job);
  }
}

function start(job: DownloadJob): void {
  const dir = jobDir(job.id);
  fs.mkdirSync(dir, { recursive: true });

  job.status = "downloading";
  job.startedAt = new Date().toISOString();

  const child = spawnDownload(buildDownloadArgs(job.options, dir), {
    onProgress(progress) {
      if (job.status === "processing") job.status = "downloading"; // next playlist item
      job.progress = progress;
    },
    onStage() {
      job.status = "processing";
    },
    onExit(code, stderr) {
      processes.delete(job.id);
      job.finishedAt = new Date().toISOString();
      job.files = listFiles(dir);
      if (job.status !== "cancelled") {
        if (code === 0) {
          job.status = "completed";
          if (job.progress.percent !== null) job.progress.percent = 100;
          job.progress.speed = null;
          job.progress.eta = null;
        } else {
          job.status = "failed";
          job.error = extractError(stderr);
        }
      }
      pump();
    },
  });
  processes.set(job.id, child);
}

export function listDownloads(): DownloadJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDownload(id: string): DownloadJob | undefined {
  const job = jobs.get(id);
  // Refresh file list while running so partial playlist results are visible
  if (job && (job.status === "downloading" || job.status === "processing")) job.files = listFiles(jobDir(id));
  return job;
}

export function cancelDownload(id: string): DownloadJob | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status === "queued" || job.status === "downloading" || job.status === "processing") {
    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    const child = processes.get(id);
    if (child) killDownload(child);
    const idx = queue.indexOf(id);
    if (idx !== -1) queue.splice(idx, 1);
  }
  return job;
}

/** Cancels if needed, forgets the job, and optionally deletes its folder */
export function removeDownload(id: string, deleteFiles: boolean): boolean {
  const job = cancelDownload(id);
  if (!job) return false;
  jobs.delete(id);
  if (deleteFiles) {
    const dir = jobDir(id);
    const child = processes.get(id);
    // Wait for the process to die so it doesn't recreate files after rm
    if (child && child.exitCode === null) child.once("close", () => fs.rmSync(dir, { recursive: true, force: true }));
    else fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

/** Resolves a file of a job, refusing anything outside the job folder */
export function resolveJobFile(id: string, name: string): string | undefined {
  const dir = jobDir(id);
  const full = path.resolve(dir, name);
  if (!full.startsWith(dir + path.sep)) return undefined;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return undefined;
  return full;
}
