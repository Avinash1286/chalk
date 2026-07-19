// Resume an interrupted local render WITHOUT re-calling the director or TTS.
// Needs <outputDir>/storyboard.json + narration.mp3 (both written early in the
// pipeline). Recomputes timing the same way the pipeline does for voices that
// return no SSML marks (word-weighted estimate scaled to the real audio length),
// recompiles deterministically, and renders the video.
// Usage: npx tsx scripts/resume-render.ts <outputDir>
import "../worker/env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileVideo } from "../shared/layout";
import { estimateTimepoints } from "../shared/ssml";
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
const audioPath = path.join(outputDir, "narration.mp3");
const audioDuration = await probeDurationSeconds(audioPath);
const estimate = estimateTimepoints(storyboard);
const factor = estimate.durationSeconds > 0 ? audioDuration / estimate.durationSeconds : 1;
const timepoints = estimate.timepoints.map((t) => ({ ...t, timeSeconds: t.timeSeconds * factor }));

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
