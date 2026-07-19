// Resume an interrupted local render WITHOUT re-calling the director or TTS.
// Needs <outputDir>/storyboard.json + narration.wav (both written early in the
// pipeline). Prefers the exact per-beat timing sidecar (narration-timing.json)
// written by the per-clip narrator — expanding it to per-reveal timepoints —
// and falls back to the word-weighted estimate scaled to the real audio length.
// Recompiles deterministically, then renders the video.
// Usage: npx tsx scripts/resume-render.ts <outputDir>
import "../worker/env";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileVideo } from "../shared/layout";
import { estimateTimepoints, expandBeatTimepoints, type Timepoint } from "../shared/ssml";
import { storyboardSchema } from "../shared/storyboard";
import { probeDurationSeconds } from "../worker/ffmpeg";
import { renderVideo } from "../worker/render";

const outputDir = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("Usage: npx tsx scripts/resume-render.ts <outputDir>");
  process.exit(1);
}

const storyboard = storyboardSchema.parse(
  JSON.parse(readFileSync(path.join(outputDir, "storyboard.json"), "utf8")),
);

// Prefer the per-clip WAV; support legacy .mp3 checkpoints too.
const wavPath = path.join(outputDir, "narration.wav");
const audioPath = existsSync(wavPath) ? wavPath : path.join(outputDir, "narration.mp3");
const audioDuration = await probeDurationSeconds(audioPath);

// Exact per-beat timing sidecar → expand to per-reveal timepoints. Otherwise the
// word-weighted estimate scaled to the real audio length.
let beatTimepoints: Timepoint[] | null = null;
try {
  const timing = JSON.parse(readFileSync(path.join(outputDir, "narration-timing.json"), "utf8")) as {
    beatTimepoints?: Timepoint[];
  };
  if (Array.isArray(timing.beatTimepoints) && timing.beatTimepoints.length) beatTimepoints = timing.beatTimepoints;
} catch {
  // no sidecar — estimate below
}

const estimate = estimateTimepoints(storyboard);
const timepoints = beatTimepoints
  ? expandBeatTimepoints(storyboard, beatTimepoints, audioDuration)
  : estimate.timepoints.map((t) => ({
      ...t,
      timeSeconds: t.timeSeconds * (estimate.durationSeconds > 0 ? audioDuration / estimate.durationSeconds : 1),
    }));

const compiled = compileVideo(storyboard, timepoints, audioDuration, {
  width: Number(process.env.VIDEO_WIDTH ?? 1920),
  height: Number(process.env.VIDEO_HEIGHT ?? 1080),
  fps: Number(process.env.VIDEO_FPS ?? 12),
});

const outputPath = await renderVideo(compiled, audioPath, outputDir, (p) => {
  if (p.progress === 1 || Math.round(p.progress * 100) % 10 === 0) {
    console.log(`[${Math.round(p.progress * 100)}%] ${p.stage}: ${p.message}`);
  }
});
console.log(`Video: ${path.resolve(outputPath)}`);
