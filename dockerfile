# Must be declared before the first FROM to be usable in FROM lines
ARG DENO_VERSION=2.5.6

# ---- build ----
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deno (JS runtime yt-dlp needs for YouTube) ----
FROM denoland/deno:bin-${DENO_VERSION} AS deno

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    DOWNLOAD_DIR=/downloads
WORKDIR /app

# ffmpeg: merging video+audio, audio extraction, embedding thumbnails/subs
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deno /deno /usr/local/bin/deno

RUN groupadd --system --gid 1001 nodeuser \
 && useradd --system --uid 1001 --gid nodeuser --create-home nodeuser

# Standalone yt-dlp binary, owned by nodeuser so POST /ytdlp/update can replace it
ARG YTDLP_VERSION=latest
RUN if [ "$YTDLP_VERSION" = "latest" ]; then \
      url=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux; \
    else \
      url=https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux; \
    fi \
 && curl -fsSL "$url" -o /usr/local/bin/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp \
 && chown nodeuser:nodeuser /usr/local/bin/yt-dlp \
 && mkdir -p /downloads && chown nodeuser:nodeuser /downloads

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY openapi.yaml ./

USER nodeuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s \
  CMD curl -fs http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
