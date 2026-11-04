import { Router, type NextFunction, type Request, type Response } from "express";
import * as ytdlp from "./ytdlpClient";
import { ValidationError, YtDlpError } from "./ytdlpClient";
import * as downloads from "./downloadManager";
import { isSftpConfigured, pushToSftp, SftpConfigError } from "./sftpClient";
import * as transfers from "./transferTracker";
import type { DownloadOptions } from "./types";

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

// Forwards async errors to the error middleware
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

const bool = (value: unknown) => value === "true" || value === "1";

export function buildRouter(): Router {
  const router = Router();

  // ------------------------------------------------------------------ health
  router.get(
    "/health",
    wrap(async (_req, res) => {
      try {
        res.json({ status: "ok", ytdlp: await ytdlp.getVersion() });
      } catch (err) {
        res.status(503).json({ status: "error", error: (err as Error).message });
      }
    })
  );

  // ------------------------------------------------------------------ yt-dlp
  router.get("/ytdlp/version", wrap(async (_req, res) => res.json({ version: await ytdlp.getVersion() })));

  router.post(
    "/ytdlp/update",
    wrap(async (req, res) => {
      const channel = (req.body?.channel as string | undefined) ?? "stable";
      const output = await ytdlp.update(channel);
      res.json({ version: await ytdlp.getVersion(), output });
    })
  );

  // ------------------------------------------------------------------ metadata
  router.get(
    "/info",
    wrap(async (req, res) => {
      const info = await ytdlp.getInfo(req.query.url as string, {
        raw: bool(req.query.raw),
        playlist: bool(req.query.playlist),
      });
      res.json(info);
    })
  );

  router.get("/formats", wrap(async (req, res) => res.json(await ytdlp.getFormats(req.query.url as string))));

  // ------------------------------------------------------------------ downloads
  router.get("/downloads", (req, res) => {
    const status = req.query.status as string | undefined;
    const all = downloads.listDownloads();
    res.json(status ? all.filter((j) => j.status === status) : all);
  });

  router.post("/downloads", (req, res) => {
    const job = downloads.createDownload((req.body ?? {}) as DownloadOptions);
    res.status(202).location(`/downloads/${job.id}`).json(job);
  });

  router.get("/downloads/:id", (req, res) => {
    const job = downloads.getDownload(req.params.id);
    if (!job) return res.status(404).json({ error: "Download not found" });
    res.json(job);
  });

  router.post("/downloads/:id/cancel", (req, res) => {
    const job = downloads.cancelDownload(req.params.id);
    if (!job) return res.status(404).json({ error: "Download not found" });
    res.json(job);
  });

  router.delete("/downloads/:id", (req, res) => {
    const removed = downloads.removeDownload(req.params.id, bool(req.query.deleteFiles));
    if (!removed) return res.status(404).json({ error: "Download not found" });
    res.status(204).end();
  });

  router.get("/downloads/:id/files", (req, res) => {
    const job = downloads.getDownload(req.params.id);
    if (!job) return res.status(404).json({ error: "Download not found" });
    res.json(job.files);
  });

  // File name may contain "/" when the output template uses subfolders
  router.get("/downloads/:id/files/*", (req, res) => {
    const job = downloads.getDownload(req.params.id);
    if (!job) return res.status(404).json({ error: "Download not found" });
    const file = downloads.resolveJobFile(job.id, (req.params as Record<string, string>)[0]);
    if (!file) return res.status(404).json({ error: "File not found" });
    res.download(file);
  });

  // ------------------------------------------------------------------ SFTP
  router.post("/downloads/:id/push-sftp", (req, res) => {
    const job = downloads.getDownload(req.params.id);
    if (!job) return res.status(404).json({ error: "Download not found" });
    if (job.status !== "completed") {
      return res.status(409).json({ error: `Download is ${job.status}, it must be completed first` });
    }
    if (!isSftpConfigured()) {
      return res.status(503).json({ error: "SFTP is not configured (SFTP_HOST, SFTP_USERNAME, key file)" });
    }
    const remoteFolder = req.body?.remoteFolder;
    if (typeof remoteFolder !== "string" || !remoteFolder) {
      return res.status(400).json({ error: "remoteFolder is required" });
    }

    const files = job.files.map((f) => f.name);
    const totalBytes = job.files.reduce((sum, f) => sum + f.size, 0);
    const transfer = transfers.createTransfer(job.id, remoteFolder, totalBytes);

    transfers.updateTransfer(transfer.id, { status: "running" });
    pushToSftp(downloads.jobDir(job.id), files, remoteFolder, (p) =>
      transfers.updateTransfer(transfer.id, {
        bytesTransferred: p.bytesTransferred,
        currentFile: p.currentFile ?? null,
      })
    )
      .then(() => transfers.updateTransfer(transfer.id, { status: "completed", currentFile: null }))
      .catch((err: Error) => transfers.updateTransfer(transfer.id, { status: "failed", error: err.message }));

    res.status(202).location(`/transfers/${transfer.id}`).json(transfer);
  });

  router.get("/transfers", (_req, res) => res.json(transfers.listTransfers()));

  router.get("/transfers/:jobId", (req, res) => {
    const transfer = transfers.getTransfer(req.params.jobId);
    if (!transfer) return res.status(404).json({ error: "Transfer not found" });
    res.json(transfer);
  });

  return router;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof YtDlpError) {
    // yt-dlp ran but couldn't handle the URL (unsupported site, private video, geo-block...)
    res.status(502).json({ error: err.message, exitCode: err.exitCode });
  } else if (err instanceof SftpConfigError) {
    res.status(503).json({ error: err.message });
  } else if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Invalid JSON body" });
  } else {
    console.error(err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
