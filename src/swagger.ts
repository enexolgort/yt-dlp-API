import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// openapi.yaml lives at the project root, both in dev (src/) and build (dist/)
const SPEC_PATH = path.resolve(__dirname, "..", "openapi.yaml");

export function loadOpenApiSpec(): Record<string, unknown> {
  return yaml.load(fs.readFileSync(SPEC_PATH, "utf8")) as Record<string, unknown>;
}
