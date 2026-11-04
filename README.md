# yt-dlp API

A small TypeScript/Express HTTP API around [yt-dlp](https://github.com/yt-dlp/yt-dlp).
Inspect media, queue background downloads, follow their progress, fetch the resulting files,
or push them to a remote server over SFTP — all through REST calls.

## How it works

- Every call spawns the `yt-dlp` executable directly (no shell), so request values are never interpreted as shell code.
- Downloads are **background jobs**: `POST /downloads` returns `202` with a job ID right away.
  A queue runs at most `MAX_CONCURRENT_DOWNLOADS` yt-dlp processes at once.
- Each job writes into its own folder, `DOWNLOAD_DIR/<jobId>/`, which makes listing, serving and deleting its files simple.
- Progress is read from yt-dlp's `--progress-template` output, and includes percent, speed, ETA and the playlist index.
- Cancelling a job kills yt-dlp's whole process group, which includes any ffmpeg child.
- Job state is **in memory**: it is lost on restart, but files on disk are kept.

## Setup

Requirements: Node.js ≥ 20, [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation), and `ffmpeg` (for merging formats and audio extraction).
For YouTube, yt-dlp also needs a JavaScript runtime such as [deno](https://deno.com).

```bash
npm install
cp .env.example .env   # edit as needed
npm run dev            # watch mode on http://localhost:3000
```

Production build:

```bash
npm run build
npm start
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `API_KEY` | – | If set, requests need an `X-API-Key` header (except `/health`, `/docs`) |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp executable |
| `DOWNLOAD_DIR` | `./downloads` | Root folder for job folders |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | Parallel yt-dlp processes |
| `YTDLP_COOKIES_FILE` | – | Netscape `cookies.txt` for age-restricted, private or members-only content |
| `YTDLP_EXTRA_ARGS` | – | Args added to every call, e.g. `--proxy socks5://host:1080` |
| `INFO_TIMEOUT_MS` | `60000` | Timeout for `/info` and `/formats` |
| `SFTP_HOST` / `SFTP_PORT` / `SFTP_USERNAME` | – / `22` / – | SFTP target |
| `SFTP_PRIVATE_KEY_PATH` | `./sftp-keys/id_ed25519` | SSH private key (key auth only) |
| `SFTP_PRIVATE_KEY_PASSPHRASE` | – | Key passphrase, if any |

## Running with Docker

The image bundles the standalone yt-dlp binary, ffmpeg and deno.

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f api
```

| Host path | Container path | Purpose |
| --- | --- | --- |
| `./downloads` | `/downloads` | Downloaded files, one folder per job |
| `./sftp-keys` | `/sftp-keys` (ro) | SSH key for SFTP pushes |
| `./cookies` | `/cookies` (ro) | Optional `cookies.txt` (uncomment in compose) |

To pin yt-dlp, set the build arg `YTDLP_VERSION` to a release tag such as `2026.10.22`.
To update it without rebuilding, call `POST /ytdlp/update`.
To route traffic through a VPN container, see the comment in `docker-compose.yml`.

## API documentation

Swagger UI is served at **`/docs`** and the raw spec at **`/openapi.json`**. The source is [`openapi.yaml`](openapi.yaml).

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Health check + yt-dlp version |
| GET | `/ytdlp/version` | Installed yt-dlp version |
| POST | `/ytdlp/update` | Self-update yt-dlp (`{"channel": "stable" \| "nightly" \| ...}`) |
| GET | `/info?url=` | Metadata (`&playlist=true` for flat playlist, `&raw=true` for the full info dict) |
| GET | `/formats?url=` | Available formats |
| GET | `/downloads` | List jobs (`?status=completed`) |
| POST | `/downloads` | Queue a download → `202` |
| GET | `/downloads/:id` | Job status, progress, files |
| POST | `/downloads/:id/cancel` | Cancel (keeps the job and partial files) |
| DELETE | `/downloads/:id` | Remove job (`?deleteFiles=true` also deletes its folder) |
| GET | `/downloads/:id/files` | List produced files |
| GET | `/downloads/:id/files/:name` | Download a file |
| POST | `/downloads/:id/push-sftp` | Upload a completed job's files over SFTP → `202` |
| GET | `/transfers` | List SFTP transfers |
| GET | `/transfers/:jobId` | SFTP transfer status |

Job status goes through `queued` → `downloading` → `processing` (merging or converting) → `completed`, and can end as `failed` or `cancelled` instead.

## Usage examples

**Inspect a video**

```bash
curl "http://localhost:3000/info?url=https://www.youtube.com/watch?v=jNQXAC9IVRw"
curl "http://localhost:3000/formats?url=https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

**Download best quality, capped at 1080p, as mp4**

```bash
curl -X POST http://localhost:3000/downloads \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","format":"bv*[height<=1080]+ba/b","mergeFormat":"mp4"}'
```

**Audio only, as mp3 with cover and tags**

```bash
curl -X POST http://localhost:3000/downloads \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","audioOnly":true,"audioFormat":"mp3","embedThumbnail":true,"embedMetadata":true}'
```

**Part of a playlist, into a subfolder**

```bash
curl -X POST http://localhost:3000/downloads \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/playlist?list=PL...","playlist":true,"playlistItems":"1-5",
       "outputTemplate":"%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s"}'
```

**Follow progress, then fetch the file**

```bash
curl http://localhost:3000/downloads/<id>
# {"status":"downloading","progress":{"percent":49.7,"speed":81836,"eta":3,...},...}

curl http://localhost:3000/downloads/<id>/files
curl -OJ "http://localhost:3000/downloads/<id>/files/Me%20at%20the%20zoo%20%5BjNQXAC9IVRw%5D.mp4"
```

**Push to a server over SFTP**

```bash
curl -X POST http://localhost:3000/downloads/<id>/push-sftp \
  -H "Content-Type: application/json" -d '{"remoteFolder":"/home/me/videos"}'
curl http://localhost:3000/transfers/<transferId>
```

**Download options**

| Field | Type | yt-dlp flag |
| --- | --- | --- |
| `url` | string (required) | |
| `format` | string | `-f` |
| `audioOnly` / `audioFormat` | bool / string | `-x` / `--audio-format` |
| `mergeFormat` | string | `--merge-output-format` |
| `playlist` / `playlistItems` | bool / string | `--yes-playlist` / `-I` |
| `subtitles` / `embedSubtitles` | string[] / bool | `--write-subs --sub-langs` / `--embed-subs` |
| `embedThumbnail` / `embedMetadata` | bool | `--embed-thumbnail` / `--embed-metadata` |
| `rateLimit` | string | `--limit-rate` |
| `outputTemplate` | string | `-o` (relative, no `..`) |

**Securing the API**

Set `API_KEY` in `.env`, then send it with every request:

```bash
curl -H "X-API-Key: $API_KEY" http://localhost:3000/downloads
```

Without `API_KEY`, anyone who can reach the port can download to your disk and update yt-dlp.
Don't expose the API publicly without a key.

## Troubleshooting

- **`502` on `/info` or failed downloads with "Sign in to confirm you're not a bot" or "unavailable"**: the site is blocking you. Provide `YTDLP_COOKIES_FILE` or use a proxy through `YTDLP_EXTRA_ARGS`.
- **Extraction suddenly fails for a site that used to work**: sites change often. Call `POST /ytdlp/update` (or try `{"channel":"nightly"}`).
- **YouTube warns about a missing JS runtime or only offers a few formats**: install deno. It is already in the Docker image.
- **Status stays `downloading` with no progress for a few seconds**: this is normal. yt-dlp is still extracting the media info before the transfer starts.
- **`/health` returns `503`**: yt-dlp is not on `PATH`, so set `YTDLP_PATH`.

## Project layout

```
src/
  config.ts           env var loading
  types.ts            job / media types
  ytdlpClient.ts      spawns yt-dlp: info, formats, download args, progress parsing, update
  downloadManager.ts  in-memory job queue, concurrency, cancel, file listing
  sftpClient.ts       SFTP upload with byte progress
  transferTracker.ts  in-memory SFTP job store
  routes.ts           Express routes + error mapping
  swagger.ts          loads openapi.yaml
  server.ts           bootstrap, API-key middleware, /docs
openapi.yaml          OpenAPI 3 spec
dockerfile            multi-stage image (node + yt-dlp + ffmpeg + deno)
docker-compose.yml
```

To add a new yt-dlp option, add the field to `DownloadOptions` in `types.ts`, map it to a flag in
`buildDownloadArgs()` in `ytdlpClient.ts`, and document it in `openapi.yaml`.
