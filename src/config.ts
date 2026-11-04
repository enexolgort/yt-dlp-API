import "dotenv/config";
import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
  return value;
}

export const config = {
  port: int("PORT", 3000),

  // Optional: when set, every request (except /docs, /openapi.json and /health) needs X-API-Key
  apiKey: process.env.API_KEY || undefined,

  ytdlp: {
    binary: process.env.YTDLP_PATH || "yt-dlp",
    downloadDir: path.resolve(process.env.DOWNLOAD_DIR || "./downloads"),
    maxConcurrent: Math.max(1, int("MAX_CONCURRENT_DOWNLOADS", 2)),
    // Netscape-format cookies file, used for age-restricted / members-only content
    cookiesFile: process.env.YTDLP_COOKIES_FILE || undefined,
    // Extra args appended to every yt-dlp call, space separated (e.g. "--proxy socks5://vpn:1080")
    extraArgs: (process.env.YTDLP_EXTRA_ARGS || "").split(" ").filter(Boolean),
    infoTimeoutMs: int("INFO_TIMEOUT_MS", 60_000),
  },

  sftp: {
    host: process.env.SFTP_HOST || "",
    port: int("SFTP_PORT", 22),
    username: process.env.SFTP_USERNAME || "",
    privateKeyPath: process.env.SFTP_PRIVATE_KEY_PATH || "./sftp-keys/id_ed25519",
    passphrase: process.env.SFTP_PRIVATE_KEY_PASSPHRASE || undefined,
  },
};
