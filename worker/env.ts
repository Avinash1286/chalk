import "../shared/fontconfig";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function parseEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

parseEnvFile(path.join(root, ".env.local"));
parseEnvFile(path.join(root, ".env"));

// Cloud hosts (Railway/Render/Fly) can't mount the GCP key as a file — they
// pass the JSON in an env var instead. google-auth-library treats
// GOOGLE_APPLICATION_CREDENTIALS as a FILE PATH, so JSON pasted there fails with
// ENAMETOOLONG. Materialize the JSON to disk once and repoint the path var,
// whether the JSON arrives in GOOGLE_APPLICATION_CREDENTIALS_JSON (intended) or
// pasted directly into GOOGLE_APPLICATION_CREDENTIALS (common mistake).
function looksLikeJson(value: string | undefined): value is string {
  return Boolean(value && value.trim().startsWith("{"));
}

const inlineKeyJson = looksLikeJson(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  : looksLikeJson(process.env.GOOGLE_APPLICATION_CREDENTIALS)
    ? process.env.GOOGLE_APPLICATION_CREDENTIALS
    : undefined;

if (inlineKeyJson) {
  const keyPath = path.join(root, ".gcp-key.json");
  try {
    writeFileSync(keyPath, inlineKeyJson, { encoding: "utf8", mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  } catch (error) {
    // Never echo the key material in the error path.
    console.warn("Could not materialize the inline GCP key JSON to disk.");
    void error;
  }
}

// Derive GOOGLE_CLOUD_PROJECT from the key's own project_id when it's missing or
// still the .env.example placeholder — Vertex 403s ("CONSUMER_INVALID") on a
// bogus project id, and the service-account key already names the right project.
const PROJECT_PLACEHOLDER = "your-gcp-project-id";
if (!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT === PROJECT_PLACEHOLDER) {
  let keyJson = inlineKeyJson;
  if (!keyJson) {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (keyPath && existsSync(keyPath)) {
      try {
        keyJson = readFileSync(keyPath, "utf8");
      } catch {
        keyJson = undefined;
      }
    }
  }
  if (keyJson) {
    try {
      const projectId = (JSON.parse(keyJson) as { project_id?: string }).project_id;
      if (projectId) {
        process.env.GOOGLE_CLOUD_PROJECT = projectId;
        console.log(`GOOGLE_CLOUD_PROJECT resolved from service-account key: ${projectId}`);
      }
    } catch {
      // malformed key JSON — leave the project unset; the API call fails loudly.
    }
  }
}
