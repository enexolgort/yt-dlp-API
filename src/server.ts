import fs from "node:fs";
import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { config } from "./config";
import { buildRouter, errorHandler } from "./routes";
import { loadOpenApiSpec } from "./swagger";

fs.mkdirSync(config.ytdlp.downloadDir, { recursive: true });

const app = express();
const spec = loadOpenApiSpec();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Docs and health stay public so they can be browsed / probed without a key
app.get("/openapi.json", (_req, res) => res.json(spec));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));

if (config.apiKey) {
  app.use((req, res, next) => {
    if (req.path === "/health" || req.get("X-API-Key") === config.apiKey) return next();
    res.status(401).json({ error: "Missing or invalid X-API-Key header" });
  });
}

app.use(buildRouter());
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`yt-dlp API listening on http://localhost:${config.port}`);
  console.log(`Docs: http://localhost:${config.port}/docs`);
  console.log(`Downloads: ${config.ytdlp.downloadDir} (max ${config.ytdlp.maxConcurrent} concurrent)`);
  if (!config.apiKey) console.warn("API_KEY is not set: the API is open to anyone who can reach it");
});
