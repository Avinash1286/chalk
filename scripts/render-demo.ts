/**
 * Hand-authored demo video — NO LLM anywhere in this run.
 *
 * The script, narration and every scene graph below were written by hand and
 * fed straight into the deterministic pipeline: sanitize → compose → TTS
 * (Google Cloud, not Gemini) → compile → render. Every icon resolves from the
 * image-model-generated house library by EXACT concept match, so no embedding
 * or rerank model is touched either.
 *
 *   npx tsx scripts/render-demo.ts       → outputs/demo-bitcoin/final.mp4
 */
import "../worker/env";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeSceneGraphPlan, sanitizeSceneGraphPlan } from "../shared/sceneGraph";
import { compileVideo } from "../shared/layout";
import { expandBeatTimepoints } from "../shared/ssml";
import { findLibraryIcon } from "../shared/iconLibrary";
import { renderVideo } from "../worker/render";
import { synthesizeScriptNarration } from "../worker/google";
import type { Outline } from "../worker/agents";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// The plan. Written by hand, tuned for the house library's coverage:
// every `concept` below is an exact match for a generated icon.
// ---------------------------------------------------------------------------

const raw = {
  title: "How Bitcoin Actually Works",
  // Kept BELOW the real narration length on purpose: compileVideo takes
  // max(audio, this), so the video ends with the voice instead of a frozen tail.
  durationSeconds: 60,
  scenes: [
    {
      title: "THE MIDDLEMAN PROBLEM",
      beats: [
        { narration: "Send money abroad, and it crawls through a chain of banks." },
        { narration: "Each bank in the chain takes a cut and adds a delay." },
        { narration: "One hundred dollars can lose six to fees, and take five days to arrive." },
      ],
      nodes: [
        { id: "you", kind: "icon", concept: "person", caption: "YOU", beat: 0 },
        { id: "mid", kind: "icon", concept: "bank", caption: "MIDDLEMEN", beat: 0 },
        { id: "abroad", kind: "icon", concept: "globe", caption: "ABROAD", beat: 0 },
        { id: "fees", kind: "value", concept: "coin", caption: "LOST TO FEES", value: "$6", beat: 2 },
        { id: "wait", kind: "value", concept: "clock", caption: "WAITING", value: "5 DAYS", beat: 2 },
      ],
      zones: [
        { arrange: "flow", nodes: ["you", "mid", "abroad"] },
        { arrange: "row", nodes: ["fees", "wait"] },
      ],
      edges: [],
    },
    {
      title: "ONE SHARED NOTEBOOK",
      beats: [
        { narration: "Bitcoin removes the middleman with one shared notebook, called the blockchain." },
        { narration: "Thousands of computers around the world each hold a full copy." },
        { narration: "Everyone can read it." },
        { narration: "And no single company owns it." },
      ],
      nodes: [
        { id: "ledger", kind: "icon", concept: "database", caption: "THE LEDGER", role: "hero", beat: 0 },
        { id: "nodes", kind: "icon", concept: "server", caption: "1000s OF COPIES", beat: 1 },
        { id: "world", kind: "icon", concept: "globe", caption: "WORLDWIDE", beat: 1 },
        { id: "everyone", kind: "icon", concept: "group", caption: "OPEN TO ALL", beat: 2 },
        { id: "noowner", kind: "icon", concept: "bank", caption: "NO OWNER", badge: "no", beat: 3 },
      ],
      zones: [{ arrange: "radial", nodes: ["ledger", "nodes", "world", "everyone", "noowner"] }],
      edges: [],
    },
    {
      title: "SENDING A COIN",
      beats: [
        { narration: "Step one: your wallet holds a secret key that only you control." },
        { narration: "Step two: that key signs the payment, like an unforgeable signature." },
        { narration: "Step three: the signed payment is broadcast to the whole network." },
      ],
      nodes: [
        { id: "wallet", kind: "icon", concept: "wallet", caption: "YOUR WALLET", beat: 0 },
        { id: "key", kind: "icon", concept: "lock", caption: "SECRET KEY", beat: 0 },
        { id: "signed", kind: "icon", concept: "document", caption: "SIGNED", beat: 1 },
        { id: "net", kind: "icon", concept: "network", caption: "BROADCAST", beat: 2 },
      ],
      zones: [{ arrange: "flow", nodes: ["wallet", "key", "signed", "net"] }],
      edges: [],
    },
    {
      title: "MINERS SEAL THE DEAL",
      beats: [
        { narration: "Computers called miners collect the waiting payments." },
        { narration: "They bundle them into a block." },
        { narration: "And a new block is sealed onto the chain about every ten minutes." },
      ],
      nodes: [
        { id: "miners", kind: "icon", concept: "server", caption: "MINERS", beat: 0 },
        { id: "block", kind: "icon", concept: "layer", caption: "A BLOCK", beat: 1 },
        { id: "chain", kind: "icon", concept: "blockchain", caption: "THE CHAIN", beat: 2 },
        { id: "tempo", kind: "value", concept: "clock", caption: "PER BLOCK", value: "~10 MIN", beat: 2 },
      ],
      zones: [
        { arrange: "flow", nodes: ["miners", "block", "chain"] },
        { arrange: "row", nodes: ["tempo"] },
      ],
      edges: [],
    },
    {
      title: "WHY IT CAN'T BE FAKED",
      beats: [
        { narration: "Every block locks onto the block before it." },
        { narration: "Change one old payment, and its block no longer fits the chain." },
        { narration: "To cheat, you would have to redo every block after it, faster than the whole world." },
        { narration: "That is practically impossible." },
      ],
      nodes: [
        { id: "locked", kind: "icon", concept: "lock", caption: "EACH BLOCK LOCKED", beat: 0 },
        { id: "chain2", kind: "icon", concept: "blockchain", caption: "LINKED HISTORY", role: "hero", beat: 0 },
        { id: "tamper", kind: "icon", concept: "warning", caption: "TAMPERING", badge: "no", beat: 1 },
        { id: "secure", kind: "icon", concept: "shield", caption: "SECURE", badge: "check", beat: 3 },
      ],
      zones: [
        { arrange: "row", nodes: ["locked", "chain2", "secure"] },
        { arrange: "row", nodes: ["tamper"] },
      ],
      edges: [],
    },
    {
      title: "BANKS VS BITCOIN",
      beats: [
        { narration: "Now put them side by side." },
        { narration: "Banks: business hours, borders, and days of waiting." },
        { narration: "Bitcoin: always on, borderless, and about ten minutes." },
      ],
      nodes: [
        { id: "lbank", kind: "icon", concept: "bank", caption: "BANKS", side: "left", beat: 1 },
        { id: "lwait", kind: "value", concept: "clock", caption: "WAITING", value: "2-5 DAYS", side: "left", beat: 1 },
        { id: "lborder", kind: "icon", concept: "warning", caption: "BORDERS", badge: "x", side: "left", beat: 1 },
        { id: "rchain", kind: "icon", concept: "blockchain", caption: "BITCOIN", side: "right", beat: 2 },
        { id: "rwait", kind: "value", concept: "alarmClock", caption: "TO SETTLE", value: "~10 MIN", side: "right", beat: 2 },
        { id: "ropen", kind: "icon", concept: "check", caption: "ALWAYS ON", badge: "check", side: "right", beat: 2 },
      ],
      zones: [{ arrange: "comparison", nodes: ["lbank", "lwait", "lborder", "rchain", "rwait", "ropen"] }],
      edges: [],
    },
    {
      title: "REMEMBER THIS",
      beats: [
        { narration: "So remember: one shared ledger, held by everyone." },
        { narration: "Your keys sign your payments." },
        { narration: "Miners seal them into blocks." },
        { narration: "And the chain makes history permanent." },
        { narration: "That is Bitcoin: money that moves without a middleman." },
      ],
      nodes: [
        { id: "r1", kind: "icon", concept: "database", caption: "SHARED LEDGER", beat: 0 },
        { id: "r2", kind: "icon", concept: "lock", caption: "YOUR KEYS SIGN", beat: 1 },
        { id: "r3", kind: "icon", concept: "server", caption: "MINERS SEAL", beat: 2 },
        { id: "r4", kind: "icon", concept: "blockchain", caption: "PERMANENT", beat: 3 },
        { id: "r5", kind: "icon", concept: "coin", caption: "NO MIDDLEMAN", beat: 4 },
      ],
      zones: [{ arrange: "checklist", nodes: ["r1", "r2", "r3", "r4", "r5"] }],
      edges: [],
    },
  ],
};

async function main() {
  // Preflight: every concept must EXACT-match a generated library icon, so the
  // whole video is drawn by the image model's icons (no fallbacks, no lookups).
  const misses: string[] = [];
  for (const scene of raw.scenes) {
    for (const node of scene.nodes) {
      if (!node.concept) continue;
      if (!findLibraryIcon(node.concept, node.caption)) misses.push(`${scene.title}: ${node.concept}`);
    }
  }
  if (misses.length) {
    throw new Error(`Concepts missing from the icon library:\n  ${misses.join("\n  ")}`);
  }
  console.log("Preflight: every concept resolves to a house-library icon.");

  const plan = sanitizeSceneGraphPlan(raw);
  if (!plan) throw new Error("plan failed to sanitize");
  const storyboard = composeSceneGraphPlan(plan);

  const outputDir = path.join(root, "outputs", "demo-bitcoin");
  await mkdir(outputDir, { recursive: true });

  // Narration: Google Cloud TTS on the hand-written beats (Chirp ignores SSML
  // marks, so timing uses the word-weighted estimate scaled to real duration —
  // the same fallback the production pipeline uses).
  const outline: Outline = {
    title: storyboard.title,
    durationSeconds: raw.durationSeconds,
    scenes: raw.scenes.map((scene) => ({
      title: scene.title,
      intent: "",
      beats: scene.beats.map((beat) => ({ narration: beat.narration, cues: [] })),
    })),
  };
  console.log("Synthesizing narration (Google Cloud TTS, per-beat clips)...");
  const audio = await synthesizeScriptNarration(outline, outputDir);
  console.log(`Narration: ${audio.durationSeconds.toFixed(1)}s (${audio.beatTimepoints.length} exact beat marks)`);

  // Exact per-beat timing (the per-clip narrator measures each clip and composes
  // the master to match), expanded to per-reveal marks — the production path.
  const timepoints = expandBeatTimepoints(storyboard, audio.beatTimepoints, audio.durationSeconds);

  const compiled = compileVideo(storyboard, timepoints, audio.durationSeconds, {
    width: 1920,
    height: 1080,
    fps: 12,
  });

  console.log("Rendering...");
  const out = await renderVideo(compiled, audio.audioPath, outputDir, (p) => {
    if (p.progress === 1 || p.stage === "encoding") console.log(`[${p.stage}] ${p.message}`);
  });
  console.log(`\nDemo video: ${out}`);
  console.log(`Contact sheet: ${path.join(outputDir, "contact-sheet.jpg")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
