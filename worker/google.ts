import * as textToSpeech from "@google-cloud/text-to-speech";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateTimepoints, scaleTimepoints, scriptToSsml, storyboardToSsml, type Timepoint } from "../shared/ssml";
import type { Storyboard } from "../shared/storyboard";
import { createAgenticStoryboard, type Outline } from "./agents";
import { probeDurationSeconds } from "./ffmpeg";

export type AudioResult = {
  audioPath: string;
  timepoints: Timepoint[];
  durationSeconds: number;
  source: "google-tts";
};

// Early (pre-design) narration: audio + raw per-BEAT timepoints. Premium voices
// (e.g. Chirp3-HD) ignore SSML marks entirely, so beatTimepoints may be empty —
// the pipeline then falls back to the word-weighted estimate, exactly as before.
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

// Shared TTS core: synthesize SSML to narration.mp3 and return the measured
// duration plus whatever SSML-mark timepoints the voice actually reported.
async function synthesizeSsml(
  ssml: string,
  outputDir: string,
): Promise<{ audioPath: string; durationSeconds: number; timepoints: Timepoint[] }> {
  if (!hasGoogleCredentials()) {
    // No silent (literally silent) audio fallback: fail loudly so the job is
    // marked failed and the user can Resume/Regenerate, rather than shipping a
    // mute video that looks "completed".
    throw new Error(
      "Narration unavailable: Google Cloud Text-to-Speech credentials are not configured " +
        "(set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS).",
    );
  }

  const languageCode = process.env.GOOGLE_TTS_LANGUAGE || "en-US";
  const voiceName = process.env.GOOGLE_TTS_VOICE || "en-US-Chirp3-HD-Charon";
  const client = new textToSpeech.v1beta1.TextToSpeechClient() as any;
  // gax call timeout so a hung TTS request fails loudly instead of stalling the job.
  const ttsTimeoutMs = Number(process.env.TTS_TIMEOUT_MS ?? 120000);
  // Slightly slower than default — reference explainers narrate at ~125-140 wpm
  // (calm, instructional); the voice default lands well above that.
  const speakingRate = Number(process.env.TTS_SPEAKING_RATE ?? 0.93);
  const [response] = await client.synthesizeSpeech(
    {
      input: { ssml },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "MP3", speakingRate },
      enableTimePointing: ["SSML_MARK"],
    },
    { timeout: ttsTimeoutMs },
  );

  if (!response.audioContent) {
    throw new Error("Google TTS did not return audio content");
  }

  const mp3Path = path.join(outputDir, "narration.mp3");
  await writeFile(mp3Path, Buffer.from(response.audioContent as Uint8Array));
  const durationSeconds = await probeDurationSeconds(mp3Path);

  const timepoints = (response.timepoints ?? [])
    .map((point: { markName?: string; timeSeconds?: number }) => ({
      markName: point.markName ?? "",
      timeSeconds: Number(point.timeSeconds ?? 0),
    }))
    .filter((point: { markName: string }) => point.markName);

  return { audioPath: mp3Path, durationSeconds, timepoints };
}

// Narrate the polished SCRIPT (before scene design exists) so TTS runs in
// parallel with the scene designers. Marks are per beat; the pipeline expands
// them to per-reveal timepoints once the designed storyboard is available.
export async function synthesizeScriptNarration(
  script: Outline,
  outputDir: string,
): Promise<ScriptAudioResult> {
  const result = await synthesizeSsml(scriptToSsml(script.scenes), outputDir);
  return {
    audioPath: result.audioPath,
    beatTimepoints: result.timepoints,
    durationSeconds: result.durationSeconds,
    source: "google-tts",
  };
}

export async function synthesizeNarration(
  storyboard: Storyboard,
  outputDir: string,
): Promise<AudioResult> {
  const estimate = estimateTimepoints(storyboard);
  const result = await synthesizeSsml(storyboardToSsml(storyboard), outputDir);

  // Some premium voices (e.g. Chirp3-HD) ignore SSML marks and return no
  // timepoints. Fall back to the word-weighted estimate, scaled to the real
  // audio length, so beat and element reveals still track the narration.
  const timepoints =
    result.timepoints.length > 0
      ? result.timepoints
      : scaleTimepoints(estimate.timepoints, estimate.durationSeconds, result.durationSeconds);

  return {
    audioPath: result.audioPath,
    timepoints,
    durationSeconds: result.durationSeconds,
    source: "google-tts",
  };
}
