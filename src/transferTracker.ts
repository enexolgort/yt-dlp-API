import { randomUUID } from "node:crypto";
import type { TransferJob } from "./types";

/** In-memory store for background SFTP pushes. Lost on restart. */
const transfers = new Map<string, TransferJob>();

export function createTransfer(downloadId: string, remoteFolder: string, totalBytes: number): TransferJob {
  const job: TransferJob = {
    id: randomUUID(),
    downloadId,
    remoteFolder,
    status: "pending",
    bytesTransferred: 0,
    totalBytes,
    percent: 0,
    currentFile: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  transfers.set(job.id, job);
  return job;
}

export function updateTransfer(id: string, patch: Partial<TransferJob>): void {
  const job = transfers.get(id);
  if (!job) return;
  Object.assign(job, patch);
  if (job.totalBytes > 0) {
    job.percent = Math.round((job.bytesTransferred / job.totalBytes) * 1000) / 10;
  }
  if (job.status === "completed" || job.status === "failed") {
    job.finishedAt ??= new Date().toISOString();
  }
}

export function getTransfer(id: string): TransferJob | undefined {
  return transfers.get(id);
}

export function listTransfers(): TransferJob[] {
  return [...transfers.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
