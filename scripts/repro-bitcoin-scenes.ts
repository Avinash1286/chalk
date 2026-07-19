// Deterministic repro of the broken scenes from the user's Bitcoin video
// (f7fb9472): tiny multi-zone flow icons, padlock-over-caption, scattered
// miners scene, dense comparison crowding. Renders settled full frames.
import "../shared/fontconfig";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { compileVideo } from "../shared/layout";
import { estimateTimepoints } from "../shared/ssml";
import { renderFrameSvg } from "../shared/svgFrame";
import { composeSceneGraphPlan, type SceneGraphPlan } from "../shared/sceneGraph";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const plan: SceneGraphPlan = {
  title: "Bitcoin Repro",
  durationSeconds: 80,
  scenes: [
    {
      title: "TRADITIONAL MONEY",
      beats: [
        { narration: "You tap your card to buy coffee." },
        { narration: "The bank approves it." },
        { narration: "A private server checks the ledger, locked away." },
      ],
      nodes: [
        { id: "m", kind: "icon", concept: "money", caption: "TRADITIONAL MONEY", role: "normal", beat: 0 },
        { id: "c", kind: "icon", concept: "coffee", caption: "BUY COFFEE", role: "normal", beat: 0 },
        { id: "b", kind: "icon", concept: "bank", caption: "BANK", role: "normal", beat: 1 },
        { id: "s", kind: "icon", concept: "server", caption: "PRIVATE SERVER", role: "normal", beat: 2 },
        { id: "lock", kind: "icon", concept: "lock", caption: "LOCKED", role: "normal", beat: 2 },
      ],
      zones: [
        { arrange: "flow", nodes: ["m", "c", "b"] },
        { arrange: "row", nodes: ["s", "lock"] },
      ],
      edges: [{ from: "b", to: "s", kind: "arrow", label: "CHECKS" }],
    },
    {
      title: "MINERS VERIFY TRANSACTIONS",
      beats: [
        { narration: "Pending transactions wait in a pool." },
        { narration: "Miners race to solve a math puzzle." },
        { narration: "The winner seals the block in about 10 minutes." },
        { narration: "They earn new bitcoin, and it repeats." },
      ],
      nodes: [
        { id: "tx", kind: "icon", concept: "document", caption: "TRANSACTIONS", count: 3, role: "normal", beat: 0 },
        { id: "puz", kind: "icon", concept: "puzzle", caption: "MATH PUZZLE", role: "normal", beat: 1 },
        { id: "seal", kind: "icon", concept: "lock", caption: "SEALED BLOCK", badge: "check", role: "normal", beat: 2 },
        { id: "clock", kind: "icon", concept: "clock", caption: "REPEATS", value: "10 MIN", role: "normal", beat: 2 },
        { id: "btc", kind: "icon", concept: "coin", caption: "NEW BITCOIN", badge: "star", role: "normal", beat: 3 },
      ],
      zones: [{ arrange: "flow", nodes: ["tx", "puz", "seal", "btc"] }, { arrange: "row", nodes: ["clock"] }],
      edges: [],
    },
    {
      title: "DIGITAL SCARCITY",
      beats: [
        { narration: "Banks print endless amounts." },
        { narration: "Bitcoin is capped at 21 million coins." },
        { narration: "Every 4 years the mining reward halves." },
      ],
      nodes: [
        { id: "d1", kind: "icon", concept: "bank", caption: "TRADITIONAL BANKS", side: "left", role: "normal", beat: 0 },
        { id: "d2", kind: "icon", concept: "money", caption: "ENDLESS AMOUNTS", side: "left", badge: "x", role: "normal", beat: 0 },
        { id: "d3", kind: "icon", concept: "lock", caption: "DIGITAL SCARCITY", side: "right", badge: "check", role: "normal", beat: 1 },
        { id: "d4", kind: "icon", concept: "coin", caption: "COIN CAP", side: "right", value: "21M", role: "normal", beat: 1 },
        { id: "t1", kind: "icon", concept: "chart", caption: "REDUCED CREATION", role: "normal", beat: 2 },
        { id: "t2", kind: "icon", concept: "gear", caption: "REWARD HALVED", value: "4 YEARS", role: "normal", beat: 2 },
        { id: "t3", kind: "icon", concept: "diamond", caption: "RARE BY DESIGN", badge: "star", role: "normal", beat: 2 },
      ],
      zones: [
        { arrange: "comparison", nodes: ["d1", "d2", "d3", "d4"] },
        { arrange: "timeline", nodes: ["t1", "t2", "t3"] },
      ],
      edges: [],
    },
    {
      title: "LIMITED SUPPLY",
      beats: [
        { narration: "Banks can print endlessly." },
        { narration: "Bitcoin has a hard limit of 21 million coins." },
      ],
      nodes: [
        { id: "l1", kind: "icon", concept: "bank", caption: "BANKS", side: "left", role: "normal", beat: 0 },
        { id: "l2", kind: "icon", concept: "printer", caption: "ENDLESS", side: "left", badge: "x", role: "normal", beat: 0 },
        { id: "l3", kind: "icon", concept: "hammer", caption: "REWARD CUT", side: "left", value: "50%", role: "normal", beat: 0 },
        { id: "r1", kind: "icon", concept: "lock", caption: "HARD LIMIT", side: "right", badge: "check", role: "normal", beat: 1 },
        { id: "r2", kind: "icon", concept: "coin", caption: "TOTAL SUPPLY", side: "right", value: "21M", role: "normal", beat: 1 },
        { id: "r3", kind: "icon", concept: "diamond", caption: "SCARCITY", side: "right", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "comparison", nodes: ["l1", "l2", "l3", "r1", "r2", "r3"] }],
      edges: [],
    },
  ],
};

const storyboard = composeSceneGraphPlan(plan);
const { timepoints, durationSeconds } = estimateTimepoints(storyboard);
const compiled = compileVideo(storyboard, timepoints, durationSeconds, { width: 1920, height: 1080, fps: 12 });

const outputDir = path.join(root, "video_analysis", "compare");
await mkdir(outputDir, { recursive: true });
for (const [si, scene] of compiled.scenes.entries()) {
  const svg = renderFrameSvg(compiled, Math.max(scene.start, scene.end - 0.25));
  await sharp(Buffer.from(svg)).png().toFile(path.join(outputDir, `repro_s${si + 1}.png`));
}
console.log(`diagnostics: ${compiled.layoutDiagnostics.length}`);
console.log("wrote repro_s1..s3.png");
