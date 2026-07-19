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
// pass the JSON in an env var instead. Materialize it to disk once and point
// GOOGLE_APPLICATION_CREDENTIALS at it so google-auth-library works unchanged.
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const keyPath = path.join(root, ".gcp-key.json");
  try {
    writeFileSync(keyPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, { encoding: "utf8", mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  } catch (error) {
    console.warn(`Could not materialize GOOGLE_APPLICATION_CREDENTIALS_JSON: ${String(error)}`);
  }
}
