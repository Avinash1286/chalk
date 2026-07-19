import { GoogleAuth } from "google-auth-library";

/**
 * Vertex AI Gemini image generation + vision calls for the icon library.
 * Mirrors the auth/timeout/error handling of callGeminiJson (worker/agents.ts),
 * but supports image parts in both directions: reference images IN (style
 * anchors) and generated images OUT (inlineData PNG).
 */

export const ICON_IMAGE_MODEL = () => process.env.ICON_IMAGE_MODEL || "gemini-3.1-flash-lite-image";

function hasGoogleCredentials(): boolean {
  // GOOGLE_USE_ADC=1: attached-service-account credentials (GCP VM metadata).
  return Boolean(
    process.env.GOOGLE_CLOUD_PROJECT &&
      (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_USE_ADC === "1"),
  );
}

export function imageGenAvailable(): boolean {
  return hasGoogleCredentials();
}

type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function vertexGenerateContent(
  agentName: string,
  model: string,
  parts: Part[],
  generationConfig: Record<string, unknown>,
): Promise<{ parts: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_LOCATION || "global";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const timeoutMs = Number(process.env.IMAGE_GEN_TIMEOUT_MS ?? 120000);
  const maxAttempts = Number(process.env.IMAGE_GEN_MAX_RETRIES ?? 10);
  // Image-gen quotas are per-minute and tight, and long batch runs hit transient
  // network/5xx errors too. Everything transient (429/5xx, timeouts, socket
  // errors, empty responses) retries with exponential backoff; only a definitive
  // client error (4xx other than 429) fails immediately.
  let backoff = 5000;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | null = null;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      lastError = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : `transport error: ${String(error)}`;
    } finally {
      clearTimeout(timer);
    }

    if (response) {
      if (response.ok) {
        try {
          const data = await response.json();
          const outParts = data.candidates?.[0]?.content?.parts;
          if (Array.isArray(outParts) && outParts.length) {
            return { parts: outParts };
          }
          lastError = "returned no content parts";
        } catch (error) {
          lastError = `response parse error: ${String(error)}`;
        }
      } else {
        const body = await response.text().catch(() => "");
        lastError = `${response.status} ${body.slice(0, 300)}`;
        const definitiveClientError = response.status >= 400 && response.status < 500 && response.status !== 429;
        if (definitiveClientError) {
          throw new Error(`${agentName} failed: ${lastError}`);
        }
      }
    }

    if (attempt < maxAttempts) {
      await sleep(backoff);
      backoff = Math.min(backoff * 1.8, 90000);
    }
  }
  throw new Error(`${agentName} failed after ${maxAttempts} attempts: ${lastError}`);
}

/**
 * Generate one image. Reference images (style anchors) are sent before the
 * prompt so the model locks onto the house style. Returns the PNG/JPEG bytes.
 */
export async function generateImage(input: {
  prompt: string;
  referenceImages?: Buffer[];
  model?: string;
}): Promise<Buffer> {
  const model = input.model || ICON_IMAGE_MODEL();
  const parts: Part[] = [
    ...(input.referenceImages ?? []).map((buf) => ({
      inlineData: { mimeType: "image/png", data: buf.toString("base64") },
    })),
    { text: input.prompt },
  ];

  // Some image models reject imageConfig — retry once without it.
  const configs: Record<string, unknown>[] = [
    { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } },
    { responseModalities: ["TEXT", "IMAGE"] },
  ];
  let lastError: unknown;
  for (const generationConfig of configs) {
    try {
      const { parts: outParts } = await vertexGenerateContent("IconImageGen", model, parts, generationConfig);
      const image = outParts.find((part) => part.inlineData?.data);
      if (!image?.inlineData?.data) {
        throw new Error("IconImageGen returned no image part");
      }
      return Buffer.from(image.inlineData.data, "base64");
    } catch (error) {
      lastError = error;
      // Only fall through to the reduced config on a clear 400 config rejection.
      if (!String(error).includes("400")) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Vision call returning JSON: images + prompt in, parsed JSON out. */
export async function callGeminiVisionJson(
  agentName: string,
  prompt: string,
  images: Buffer[],
  modelOverride?: string,
): Promise<unknown> {
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const parts: Part[] = [
    ...images.map((buf) => ({ inlineData: { mimeType: "image/png", data: buf.toString("base64") } })),
    { text: prompt },
  ];
  const { parts: outParts } = await vertexGenerateContent(agentName, model, parts, {
    temperature: 0.1,
    responseMimeType: "application/json",
  });
  const text = outParts.map((part) => part.text ?? "").join("\n");
  if (!text.trim()) throw new Error(`${agentName} did not return text`);
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to balanced-object extraction (models sometimes append prose
    // or a second object after the JSON).
  }
  const first = candidate.indexOf("{");
  if (first === -1) throw new Error(`${agentName} response did not contain a JSON object`);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = first; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(first, i + 1));
    }
  }
  throw new Error(`${agentName} response did not contain a complete JSON object`);
}
