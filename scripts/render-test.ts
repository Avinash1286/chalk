// End-to-end renderer test without APIs: compose a plan, compile with estimated
// timepoints, silent audio, then run the new dedup+parallel renderVideo.
import "../shared/fontconfig";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { composeSceneGraphPlan, sanitizeSceneGraphPlan } from "../shared/sceneGraph";
import { compileVideo } from "../shared/layout";
import { estimateTimepoints } from "../shared/ssml";
import { renderVideo } from "../worker/render";
import { createSilentAudio, probeDurationSeconds } from "../worker/ffmpeg";

const raw = {
  title: "Render Test",
  durationSeconds: 45,
  scenes: [
    {
      title: "CREDIT UTILIZATION",
      beats: [
        { narration: "Your card has a limit of $10,000." },
        { narration: "You carry a balance of $3,000." },
        { narration: "3,000 over 10,000 equals 30 percent utilization." },
      ],
      nodes: [
        { id: "card", concept: "creditCard", caption: "LIMIT", value: "$10,000", beat: 0 },
        { id: "wallet", concept: "wallet", caption: "BALANCE", value: "$3,000", beat: 1 },
        { id: "eq", kind: "note", caption: "3,000 / 10,000 = 30%", beat: 2 },
      ],
      zones: [{ arrange: "flow", nodes: ["card", "wallet"] }, { arrange: "row", nodes: ["eq"] }],
    },
    {
      title: "THE SCORE BANDS",
      beats: [
        { narration: "Scores fall into five bands." },
        { narration: "Below 580 is poor, 580 to 669 is fair." },
        { narration: "Over 800 is exceptional." },
      ],
      nodes: [
        { id: "b1", caption: "POOR", value: "BELOW 580", beat: 1 },
        { id: "b2", caption: "FAIR", value: "580-669", beat: 1 },
        { id: "b3", caption: "GOOD", value: "670-739", beat: 2 },
        { id: "b4", caption: "EXCELLENT", value: "800+", beat: 2 },
      ],
      zones: [{ arrange: "bands", nodes: ["b1", "b2", "b3", "b4"] }],
    },
    {
      title: "YOUR 90 DAY PLAN",
      beats: [
        { narration: "Pay on time, every time." },
        { narration: "Keep balances low." },
        { narration: "Real gains take 60 to 90 days." },
      ],
      nodes: [
        { id: "c1", concept: "calendar", caption: "PAY ON TIME", beat: 0 },
        { id: "c2", concept: "wallet", caption: "BALANCES LOW", beat: 1 },
        { id: "c3", concept: "chart", caption: "REAL GAINS", beat: 2 },
      ],
      zones: [{ arrange: "checklist", nodes: ["c1", "c2", "c3"] }],
    },
  ],
};

const plan = sanitizeSceneGraphPlan(raw);
if (!plan) throw new Error("plan failed to sanitize");
const storyboard = composeSceneGraphPlan(plan);
const { timepoints, durationSeconds } = estimateTimepoints(storyboard);
const compiled = compileVideo(storyboard, timepoints, durationSeconds, { width: 1920, height: 1080, fps: 12 });

const outDir = path.resolve("outputs", "render-test");
await mkdir(outDir, { recursive: true });
const audioPath = path.join(outDir, "silent.wav");
await createSilentAudio(audioPath, compiled.duration);

const t0 = performance.now();
const out = await renderVideo(compiled, audioPath, outDir, (p) => {
  if (p.stage === "encoding") console.log(`[${p.stage}] ${p.message}`);
});
const secs = (performance.now() - t0) / 1000;
const frameCount = Math.max(1, Math.floor(compiled.duration * compiled.fps));
console.log(`video: ${out}`);
console.log(`duration ${compiled.duration.toFixed(1)}s, ${frameCount} frames, wall ${secs.toFixed(1)}s`);
console.log(`mp4 duration: ${(await probeDurationSeconds(out)).toFixed(2)}s (expect ~${compiled.duration.toFixed(2)})`);
