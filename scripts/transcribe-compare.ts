// One-off: transcribe the comparison videos' narration via Vertex Gemini.
// Usage: npx tsx scripts/transcribe-compare.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleAuth } from "google-auth-library";

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
    const hash = value.indexOf(" #");
    if (hash !== -1) value = value.slice(0, hash).trim();
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

const DIR = path.join(root, "video_analysis", "compare3");
const FILES = ["mine", "mine2", "lam_main", "lam_gen", "lam_tx", "lam_baj", "lam_4db"];

async function transcribe(name: string, token: string): Promise<void> {
  const outPath = path.join(DIR, `${name}.txt`);
  if (existsSync(outPath)) {
    console.log(`skip ${name} (exists)`);
    return;
  }
  const audio = readFileSync(path.join(DIR, `${name}.mp3`)).toString("base64");
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_LOCATION || "global";
  const model = "gemini-3.5-flash";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Transcribe this narration verbatim, as plain text. Insert a blank line where the speaker clearly starts a new topic/section. Output ONLY the transcript text.",
            },
            { inlineData: { mimeType: "audio/mpeg", data: audio } },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  writeFileSync(outPath, text.trim() + "\n", "utf8");
  console.log(`done ${name} (${text.length} chars)`);
}

async function main() {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  if (!token) throw new Error("no access token");
  for (const f of FILES) {
    await transcribe(f, token);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
