import fs from "node:fs";
import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import { config } from "./config";

export class SftpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SftpConfigError";
  }
}

export interface PushProgress {
  bytesTransferred: number;
  totalBytes: number;
  currentFile?: string;
}

export function isSftpConfigured(): boolean {
  const { host, username, privateKeyPath } = config.sftp;
  return Boolean(host && username && privateKeyPath && fs.existsSync(privateKeyPath));
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Uploads a list of local files (relative to baseDir) into remoteFolder, keeping subfolders.
 * Byte-level progress is reported through onProgress.
 */
export async function pushToSftp(
  baseDir: string,
  files: string[],
  remoteFolder: string,
  onProgress?: (p: PushProgress) => void
): Promise<void> {
  const { host, port, username, privateKeyPath, passphrase } = config.sftp;
  if (!host || !username) throw new SftpConfigError("SFTP_HOST and SFTP_USERNAME must be set");
  if (!fs.existsSync(privateKeyPath)) throw new SftpConfigError(`SFTP private key not found at ${privateKeyPath}`);

  const localFiles = files.length ? files.map((f) => path.join(baseDir, f)) : walk(baseDir);
  const totalBytes = localFiles.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  let done = 0;

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host,
      port,
      username,
      privateKey: fs.readFileSync(privateKeyPath),
      passphrase,
    });

    const ensured = new Set<string>();
    const ensureDir = async (dir: string) => {
      if (ensured.has(dir)) return;
      // Only mkdir when missing: restricted servers often refuse recursive mkdir on existing parents
      if (!(await sftp.exists(dir))) await sftp.mkdir(dir, true);
      ensured.add(dir);
    };

    for (const local of localFiles) {
      const rel = path.relative(baseDir, local).split(path.sep).join("/");
      const remote = path.posix.join(remoteFolder, rel);
      await ensureDir(path.posix.dirname(remote));

      const before = done;
      await sftp.fastPut(local, remote, {
        step: (transferred) => {
          onProgress?.({ bytesTransferred: before + transferred, totalBytes, currentFile: rel });
        },
      });
      done = before + fs.statSync(local).size;
      onProgress?.({ bytesTransferred: done, totalBytes, currentFile: rel });
    }
  } finally {
    await sftp.end().catch(() => undefined);
  }
}
