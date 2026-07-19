import * as textToSpeech from "@google-cloud/text-to-speech";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Timepoint } from "../shared/ssml";
import { scriptBeatId, type Storyboard } from "../shared/storyboard";
import { createAgenticStoryboard, type Outline } from "./agents";
import { probeDurationSeconds } from "./ffmpeg";

// Narration is synthesized PER BEAT: each beat is its own TTS clip, its duration
// is MEASURED from the returned PCM, and the master track is composed by placing
// every clip at exactly its beat's timeline offset. So the audio and the visual
// timeline agree BY CONSTRUCTION — no dependence on the voice returning SSML
// marks (Chirp3-HD doesn't), and no drift accumulating across a single-take
// estimate. Beat starts are exact; reveal sub-timing within a beat stays
// proportional (expandBeatTimepoints, using the designed beat's revealCues).

// Chirp3-HD returns LINEAR16 (16-bit mono PCM WAV) at 24 kHz.
const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;

// Timeline spacing (seconds). Per-clip synthesis drops the natural inter-sentence
// flow of a single take, so small gaps are re-inserted: a beat break, a larger
// scene break (lets the new title write in before its narration), plus lead-in
// and tail padding. All env-tunable.
const LEAD_SECONDS = Number(process.env.TTS_LEAD_SECONDS ?? 0.3);
const BEAT_GAP_SECONDS = Number(process.env.TTS_BEAT_GAP_SECONDS ?? 0.25);
const SCENE_GAP_SECONDS = Number(process.env.TTS_SCENE_GAP_SECONDS ?? 0.6);
const TAIL_SECONDS = Number(process.env.TTS_TAIL_SECONDS ?? 0.6);

export type AudioResult = {
  audioPath: string;
  timepoints: Timepoint[];
  durationSeconds: number;
  source: "google-tts";
};

// Early (pre-design) narration: the composed master track + EXACT per-beat
// timepoints (markName === scriptBeatId). The pipeline expands these to
// per-reveal timepoints once the designed storyboard is available.
export type ScriptAudioResult = {
  audioPath: string;
  beatTimepoints: Timepoint[];
  durationSeconds: number;
  source: "google-tts";
};

function hasGoogleCredentials(): boolean {
  // GOOGLE_USE_ADC=1: attached-service-account credentials (GCP VM metadata).
  return Boolean(
    process.env.GOOGLE_CLOUD_PROJECT &&
      (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_USE_ADC === "1"),
  );
}

export async function planStoryboard(prompt: string): Promise<{
  storyboard: Storyboard;
  source: "agents";
}> {
  // Every video is planned fresh by the AI director — no canned/case-study shortcuts.
  return createAgenticStoryboard(prompt);
}

function requireCredentials(): void {
  if (hasGoogleCredentials()) return;
  // No silent (literally silent) audio fallback: fail loudly so the job is
  // marked failed and the user can Resume/Regenerate, rather than shipping a
  // mute video that looks "completed".
  throw new Error(
    "Narration unavailable: Google Cloud Text-to-Speech credentials are not configured " +
      "(set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS).",
  );
}

function wavFromPcm(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

let ttsClient: textToSpeech.v1beta1.TextToSpeechClient | undefined;

// One beat → raw 16-bit PCM. Chirp3-HD is a literal TTS model (ignores SSML), so
// each clip is just the plain sentence; personality is voice + speaking rate.
async function synthesizeClip(text: string): Promise<Buffer> {
  ttsClient ??= new textToSpeech.v1beta1.TextToSpeechClient();
  const languageCode = process.env.GOOGLE_TTS_LANGUAGE || "en-US";
  const voiceName = process.env.GOOGLE_TTS_VOICE || "en-US-Chirp3-HD-Charon";
  const ttsTimeoutMs = Number(process.env.TTS_TIMEOUT_MS ?? 120000);
  // Reference explainers narrate at ~125-140 wpm (calm, instructional); the
  // voice default lands well above that.
  const speakingRate = Number(process.env.TTS_SPEAKING_RATE ?? 0.93);
  const audioConfig: Record<string, unknown> = {
    audioEncoding: "LINEAR16",
    sampleRateHertz: SAMPLE_RATE,
  };
  if (Number.isFinite(speakingRate) && speakingRate > 0) audioConfig.speakingRate = speakingRate;

  const [response] = await (ttsClient as any).synthesizeSpeech(
    {
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig,
    },
    { timeout: ttsTimeoutMs },
  );
  if (!response.audioContent) {
    throw new Error("Google TTS returned no audio content");
  }
  // LINEAR16 responses are WAV — strip the 44-byte header to raw PCM.
  return Buffer.from(response.audioContent as Uint8Array).subarray(WAV_HEADER_BYTES);
}

async function synthesizeClipWithRetries(text: string, id: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await synthesizeClip(text);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  throw new Error(`TTS failed for beat "${id}" after 3 attempts: ${String(lastError)}`);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

type ScriptUnit = { id: string; text: string; sceneIndex: number };

function extractScriptUnits(scenes: Outline["scenes"]): ScriptUnit[] {
  const units: ScriptUnit[] = [];
  scenes.forEach((scene, sceneIndex) => {
    scene.beats.forEach((beat, beatIndex) => {
      const text = (typeof beat === "string" ? beat : (beat as { narration: string }).narration).trim();
      if (text) units.push({ id: scriptBeatId(sceneIndex, beatIndex), text, sceneIndex });
    });
  });
  return units;
}

// Narrate the polished SCRIPT (before scene design exists) so TTS runs in
// parallel with the scene designers. Each beat is a separate clip; the timeline
// is built from measured durations and the master WAV is composed to match.
export async function synthesizeScriptNarration(
  script: Outline,
  outputDir: string,
): Promise<ScriptAudioResult> {
  requireCredentials();

  const units = extractScriptUnits(script.scenes);
  if (!units.length) {
    throw new Error("Narration has no spoken beats to synthesize.");
  }

  const concurrency = Number(process.env.TTS_CONCURRENCY ?? 12);
  const clips = await mapPool(units, concurrency, async (unit) => ({
    id: unit.id,
    pcm: await synthesizeClipWithRetries(unit.text, unit.id),
  }));
  const pcmById = new Map(clips.map((clip) => [clip.id, clip.pcm]));

  // Build the timeline from measured durations, then compose the master track by
  // placing each clip at exactly its beat's start offset (sample-aligned).
  const beatTimepoints: Timepoint[] = [];
  const placements: { offsetBytes: number; pcm: Buffer }[] = [];
  let cursor = LEAD_SECONDS;
  let prevScene = -1;
  for (const unit of units) {
    if (prevScene !== -1) cursor += unit.sceneIndex !== prevScene ? SCENE_GAP_SECONDS : BEAT_GAP_SECONDS;
    prevScene = unit.sceneIndex;
    beatTimepoints.push({ markName: unit.id, timeSeconds: cursor });
    const pcm = pcmById.get(unit.id) ?? Buffer.alloc(0);
    placements.push({ offsetBytes: Math.round(cursor * SAMPLE_RATE) * BYTES_PER_SAMPLE, pcm });
    cursor += pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  }
  const durationSeconds = cursor + TAIL_SECONDS;

  const master = Buffer.alloc(Math.ceil(durationSeconds * SAMPLE_RATE) * BYTES_PER_SAMPLE);
  for (const placement of placements) {
    const end = Math.min(placement.offsetBytes + placement.pcm.length, master.length);
    if (end > placement.offsetBytes) placement.pcm.copy(master, placement.offsetBytes, 0, end - placement.offsetBytes);
  }

  const audioPath = path.join(outputDir, "narration.wav");
  await writeFile(audioPath, wavFromPcm(master, SAMPLE_RATE));
  // Persist exact timing so a Resume that reuses the WAV keeps exact sync.
  await writeFile(
    path.join(outputDir, "narration-timing.json"),
    `${JSON.stringify({ version: 1, durationSeconds, beatTimepoints }, null, 2)}\n`,
    "utf8",
  );

  return { audioPath, beatTimepoints, durationSeconds, source: "google-tts" };
}

// Reuse a checkpoint's composed narration (Resume): the WAV plus the exact
// per-beat timing captured when it was first synthesized. Returns null when no
// usable checkpoint exists so the caller synthesizes fresh.
export async function loadNarrationCheckpoint(outputDir: string): Promise<ScriptAudioResult | null> {
  const audioPath = path.join(outputDir, "narration.wav");
  try {
    const durationSeconds = await probeDurationSeconds(audioPath);
    if (!(durationSeconds > 1)) return null;
    let beatTimepoints: Timepoint[] = [];
    try {
      const timing = JSON.parse(await readFile(path.join(outputDir, "narration-timing.json"), "utf8")) as {
        beatTimepoints?: Timepoint[];
      };
      if (Array.isArray(timing.beatTimepoints)) beatTimepoints = timing.beatTimepoints;
    } catch {
      // Timing sidecar missing/corrupt — reuse the audio, fall back to the
      // scaled estimate for timing (structure still matches the script).
    }
    return { audioPath, beatTimepoints, durationSeconds, source: "google-tts" };
  } catch {
    return null;
  }
}
