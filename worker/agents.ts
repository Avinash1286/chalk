import { GoogleAuth } from "google-auth-library";
import sharp from "sharp";
import { assetCatalogPrompt } from "../shared/assetCatalog";
import { compileVideo } from "../shared/layout";
import { sanitizeSceneAudit } from "../shared/sceneAudit";
import {
  composeSceneGraphPlan,
  graphSceneQualityIssues,
  sanitizeGraphScene,
  sanitizeSceneGraphPlan,
} from "../shared/sceneGraph";
import type { Storyboard } from "../shared/storyboard";
import { estimateTimepoints } from "../shared/ssml";
import { renderFrameSvg } from "../shared/svgFrame";
import {
  defaultVisualBrief,
  sanitizeVisualBrief,
  visualBriefPatterns,
  type SceneVisualBrief,
  type VideoVisualBrief,
} from "../shared/visualBrief";

type AgentPlannerSource = "agents";
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: "image/jpeg" | "image/png"; data: string } };

function hasGoogleCredentials(): boolean {
  // GOOGLE_USE_ADC=1: rely on Application Default Credentials (e.g. a GCP VM's
  // attached service account via the metadata server) — no key file needed.
  return Boolean(
    process.env.GOOGLE_CLOUD_PROJECT &&
      (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_USE_ADC === "1"),
  );
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Gemini response did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(first, last + 1));
}

async function callGeminiJsonParts(
  agentName: string,
  parts: GeminiPart[],
  temperature = 0.25,
  modelOverride?: string,
): Promise<unknown> {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.VERTEX_LOCATION || "global";
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const endpoint = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  // Hard timeout so a hung/slow Vertex response can NEVER block the job forever
  // (which left it silently stuck at "planning"). On timeout we abort and throw,
  // the director retries, and after 2 attempts the job is marked failed.
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 90000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts,
          },
        ],
        generationConfig: {
          temperature,
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${agentName} timed out after ${timeoutMs}ms (no response from Vertex)`);
    }
    throw new Error(`${agentName} request failed: ${String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`${agentName} failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("\n");
  if (!text) {
    throw new Error(`${agentName} did not return text`);
  }
  return extractJson(text);
}

export async function callGeminiJson(
  agentName: string,
  prompt: string,
  temperature = 0.25,
  modelOverride?: string,
): Promise<unknown> {
  return callGeminiJsonParts(agentName, [{ text: prompt }], temperature, modelOverride);
}

// Stage 1 — the SCRIPTWRITER: plan the whole video as a structure + spoken SCRIPT.
// A dedicated designer turns each scene into visuals later.
function outlinePrompt(prompt: string): string {
  return `You write the SCRIPT for a hand-drawn whiteboard explainer video. The screen shows icons,
captions, arrows and big numbers being drawn IN SYNC with the narration — so the script IS the
storyboard. Every sentence you write is turned into something drawn on screen the moment it is
spoken. You write structure + narration only (a separate designer chooses the visuals).

Return ONLY JSON:
{
  "title": string,              // <= 60 chars, plain + specific (what the video explains)
  "durationSeconds": integer,   // 100-190 — about 15 seconds per scene
  "scenes": [                   // 6 to 10 scenes; ONE idea each
    {
      "title": "SHORT SCENE TITLE",   // <= 36 chars, concrete, printed on the board
      "intent": "one line: what the viewer must UNDERSTAND + the visual treatment to draw",
      "beats": [
        {
          "narration": "One short spoken sentence.",
          "cues": ["exact spoken noun phrase", "next exact phrase"]
        }
      ]   // 3 to 6 beats, in spoken order
    }
  ]
}

NARRATION DNA — these rules are what make the video feel professional. Follow ALL of them:
- SHORT DECLARATIVE SENTENCES. Max ~14 words. One fact per sentence. Calm, confident, plain.
- EVERY SENTENCE IS DRAWABLE. Each sentence names 1-3 concrete nouns (things an icon can show)
  and one relation (becomes, flows into, splits into, blocks, beats, repeats). If a sentence
  cannot be drawn, rewrite it until it can.
- NO RHETORICAL QUESTIONS. State facts. The hook is a surprising concrete fact or a vivid
  everyday moment, stated plainly ("Open your phone. One tap buys a slice of a company.").
- SCENE SHAPE: open with a TOPIC SENTENCE stating the scene's one idea, then ENUMERATE the
  details ("Scores fall into bands." -> "Below 580 is poor." -> "580 to 669 is fair." ...).
- SIGNPOST OUT LOUD: "Step one... Step two...", "Benefit one...", "First... Then... Finally",
  "Now flip it around." The structure must be hearable AND drawable.
- NUMBERS ARE STARS: use real, widely-known figures (ranges, percentages, counts, durations) —
  each becomes a big on-screen number. Round figures are fine ("about 100 points"). NEVER invent
  a precise statistic you are not sure of — use a scale word instead ("most", "a fraction").
- FACT QUOTA: when the topic has real numbers (a range, a %, a count, a duration, a price), at
  LEAST half the scenes must be built around one. A scene with a figure beats a scene with a
  metaphor. Each scene should name 4+ concrete drawable nouns across its beats.
- CONCRETE MICRO-EXAMPLES beat abstractions ("You catch a falling cup with System One.").
- An analogy is welcome ONLY where it is MORE drawable than the literal thing — and name the
  literal thing in the same scene. Never let a metaphor replace the subject for the whole video.
- LAST SCENE = RECAP: re-enumerate the video's spine as 3-5 short actionable/summary lines (the
  designer draws them as a checklist), then one plain closing line.
- ONE idea per scene. No filler, no restating the title, no "in this video".
- CUES are 1-4 short, concrete phrases copied EXACTLY from that beat's narration, in spoken order.
  Each cue marks when a distinct icon, value, label, or relationship should appear. Never paraphrase a cue.

"intent" = what the viewer must understand + the clearest treatment to DRAW, chosen from what the
idea ACTUALLY is: a step-by-step pipeline, a side-by-side contrast, a feature/factor LIST, one hub
with parts, a set/grid of examples, striking numbers (stats), a SPECTRUM of bands/levels, a
repeating loop, a TIMELINE, a composition PIE (parts of a whole with percentages), a CHECKLIST
recap, one annotated hero object (labelled parts), a decision branch, one-to-many fan-out, or
many-to-one convergence. MIX treatments — at most ~2 scenes share one.

User prompt:
${prompt}`;
}

// Stage 1b — the DRAWABILITY EDITOR: a second pass over the whole draft that
// rewrites every line to be short, concrete and drawable (the opposite of a
// literary polish — the narration must map 1:1 onto things drawn on screen).
function scriptEditorPrompt(draft: Outline): string {
  return `You are the DRAWABILITY EDITOR for a whiteboard explainer script. The narration is drawn
on screen as it is spoken — icons, captions, arrows, big numbers. Rewrite the draft so every line
is short, concrete and drawable:
- SPLIT any sentence over ~14 words into two. One fact per sentence.
- CONVERT every rhetorical question into a plain statement.
- REPLACE undrawable abstractions and metaphor-stacks with the concrete literal thing (or one
  simple drawable image, named explicitly). At most one light analogy, only where it clarifies.
- Each scene OPENS with its topic sentence, then ENUMERATES the details in spoken order.
- INJECT audible signposts where natural ("Step one", "First... Then... Finally", "Benefit two").
- SURFACE NUMBERS: keep every real figure and phrase it so it can be a big on-screen number. Add
  widely-known real figures where they obviously belong; never invent precise statistics.
- FACT CHECK every claim against established knowledge. Remove false precision (for example, do not
  call a continuous spectrum "exactly seven colors"). If a number is uncertain, make it approximate
  or omit it. Never preserve a catchy statement that is materially misleading.
- For every revised beat, rebuild "cues" as 1-4 exact phrases copied from its revised narration,
  ordered by when the corresponding visual should appear.
- ENSURE the final scene is a RECAP re-enumerating the video's key moves as 3-5 short lines.
- Voice: calm, warm, plain; second person is fine. Cut filler and any sentence restating a title.
Keep the same JSON shape; keep or increase the scene count (6-10); 3-6 beats per scene; update
each "intent" to match the revised beats.

Return ONLY the improved JSON: { "title": string, "durationSeconds": integer, "scenes": [{ "title",
"intent", "beats": [...] }] }.

Draft:
${JSON.stringify({ title: draft.title, durationSeconds: draft.durationSeconds, scenes: draft.scenes })}`;
}

// Shared visual design language used by every per-scene designer.
const DESIGN_LANGUAGE = `You DESIGN the scene's diagram as a GRAPH of nodes + connections — you never
choose pixel coordinates; a deterministic layout engine places nodes, routes connectors, sizes icons
and prevents overlaps. Your job is to choose the RIGHT structure and the RIGHT icons.

Scene JSON shape:
{
  "title": "SHORT SCENE TITLE",            // <= 36 chars
  "beats": [ { "narration": "One spoken sentence." } ],   // keep/refine the given narration; 3-6 beats
  "nodes": [
    {
      "id": "n1",                          // short unique id within THIS scene
      "kind": "icon" | "value" | "note",   // icon=drawn symbol, value=big number, note=text callout
      "concept": "rocket",                 // assetKey-style noun (what to draw) — for icon/value
      "imagery": "concrete drawable object",// OPTIONAL: a literal object to depict an ABSTRACT idea
      "caption": "1-3 WORDS",              // the visible label
      "value": "$10,000",                  // a big number drawn with the node ("35%", "300-850", "10X")
      "count": 4,                          // OPTIONAL 2-9: draw the icon as a grid (quantity)
      "side": "left" | "right",            // comparison zones only
      "badge": "check"|"x"|"star"|"no"|"strike", // OPTIONAL judgment overlay on the icon (see BADGES)
      "role": "hero" | "normal",           // hero = drawn large (the focal element)
      "beat": 0,                           // which beat (0-based) reveals this node
      "cue": 0                             // OPTIONAL phrase cue within that beat
    }
  ],
  "zones": [ { "arrange": "flow", "nodes": ["n1","n2","n3"] } ],  // 1-3 bands stacked TOP->BOTTOM
  "edges": [ { "from": "n3", "to": "n1", "kind": "loop", "label": "REPEAT" } ]  // OPTIONAL
}

DESIGN THE DIAGRAM for THIS idea — choose the ONE clean pattern that makes it INSTANTLY clear. FIRST,
REALIZE THE VISUAL TREATMENT in the scene's "intent": a contrast -> "comparison"; a feature/factor
list -> "list"; a recap/action plan -> "checklist"; a core idea with parts -> "radial"; a set of
examples -> "grid" or "cards"; numbers -> value nodes; a spectrum/levels -> "bands"; history/stages ->
"timeline"; parts-of-a-whole percentages -> "pie"; one labelled object -> "annotate"; a loop ->
"cycle"; a single concept -> "hero"; one-to-many -> "fanout"; many-to-one -> "convergence"; a real
decision -> "branch". Use a left-to-right "flow" ONLY for a genuine step-by-step SEQUENCE — do NOT
default to flow. A single clean named pattern (one zone) is usually best; stack a 2nd zone when the
idea truly has two parts — a clean diagram always beats a clever-but-busy one.
COMPOSITE SCENES (the premium look): when the narration carries BOTH a structure AND a
verdict/figure, stack TWO zones — the main pattern on top and a compact verdict strip beneath:
a "bands" meter (good->bad ramp), a "note" equation ("3,000 / 10,000 = 30%"), a short
"checklist"/"row" of outcomes, or a value node. A flow that ends in a threshold, a comparison
that resolves to a winner, a list with a total — all deserve the second zone.

Your toolkit (pick the ONE that fits, occasionally combine two):
- "pipeline"/"flow": left-to-right sequence (auto-arrows). Processes, "how it works", steps.
- "comparison": two sides split by a divider. Give each node side:"left"/"right". For a genuine
  side-by-side CONTRAST only (two systems, before vs after, pros vs cons). Give the two sides a
  BALANCED, PAIRED count (2 vs 2, or 3 vs 3) so each left item lines up with a right item — never
  3 vs 1. NEVER put arrows/edges between the two sides. If one thing TURNS INTO another (a
  transformation/sequence), that's a "flow", not a comparison.
- "list": rows of a small icon + caption to its right — THE go-to for feature lists, factors,
  properties, capabilities (3-8 items). Denser and cleaner than a row of big icons.
- "checklist": list rows with green check badges — the RECAP/action-plan scene, do's, requirements.
  (Use badge:"x" rows inside a list for don'ts.)
- "cards": a row of icon nodes each boxed in a rounded card (2-4) — parallel mini-summaries/tools.
- "bands": colored spectrum rectangles left->right (red->green ramp) + an arrow underneath — score
  ranges, severity levels, tiers. Give each band caption (the level name) + value (the range).
- "timeline": points along a horizontal line, icon above, caption + value below — history, stages,
  oldest->newest, "step N of M" journeys.
- "pie": parts of a whole. Give each node value "35%" + caption; slices + leader labels are drawn.
- "annotate": ONE hero object with leader-line text labels around it (node 0 = the object, the rest
  = label nodes, caption only) — labelled parts of a single thing (product callouts, anatomy).
- "fanout": one SOURCE (first node) -> many targets (auto-arrows). One thing produces many; scaling.
- "convergence": many sources -> one TARGET (last node). Many inputs -> one result; aggregation.
- "loopback": a LINEAR sequence that cycles back (auto "REPEAT" arc over the top). Feedback loops, iteration.
- "cycle": nodes arranged in a RING with arrows flowing around it — a circular process (the water cycle,
  a 3-4 stage repeating loop). Prefer this over loopback when the steps form a true circle. Vary which
  loop style you use across videos.
- "branch": [action, decision, positiveOutcome, negativeOutcome] -> diamond + 2 outcomes. ONLY a real yes/no.
- "radial": hub-and-spoke; FIRST node is the centre. One core idea + drivers; an ecosystem.
- "ladder": ascending steps. Tiers, levels, growth (great with value nodes).
- "grid": tidy grid of cards. Summaries / sets of examples.
- "hero": one big focal node (role:"hero") + optional small row beneath. A single dramatic object/definition.
- "row"/"column"/"stack": plain line / vertical list (no connectors) — building blocks for composition.

BADGES — color-coded judgment drawn ON an icon (use them; they make verdicts instantly readable):
- "check" (green) = good/correct/allowed; "x" (red) = bad/wrong; "star" (gold) = best/featured;
- "no" = red prohibition ring + slash over the icon ("no accounts", "no tracking", "never do this");
- "strike" = red diagonal through the icon ("not just a logo" — the thing it ISN'T).

LAYOUT QUALITY (make it CLEAN, DENSE and readable every time):
- 4 to 8 nodes per scene (a list/checklist/bands scene carries 5-8 comfortably; only a deliberate
  hero/annotate scene goes below 4). Keep it to 1-2 zones. Every beat should reveal something.
- FILL THE FRAME like a premium whiteboard video: prefer one MORE example/factor/step over empty
  board. If a scene has only 1-2 ideas, use "hero" or "annotate" so the object is drawn LARGE and
  labelled — never a small lonely icon in empty space.
- Numbers belong ON SCREEN: any figure in the narration becomes a node "value" ("$10,000", "35%",
  "60-90 DAYS") or a value node. A trend spoken ("rises"/"drops") -> concept "chart increasing" /
  "chart decreasing" with a check/x badge when it's good/bad.
- An equation or formula in the narration -> a "note" node with the equation as its caption
  ("3,000 / 10,000 = 30%").
- Use "value" nodes only for a real headline number; otherwise use a plain "icon" node.
- For sequences/processes use flow/pipeline so arrows show direction (don't use a plain row).
- Keep at most ONE loop per scene; don't add a loop edge AND a loopback/cycle zone.
- Flow, ladder, fanout, convergence, branch, cycle and loopback zones draw their own connectors. Do NOT add
  duplicate explicit edges between nodes already connected by the chosen zone pattern.
- Don't add stray cross-zone "edges" unless they're essential — they're the main source of clutter.
- LABEL the arrows that carry meaning (edge "label", <= 16 chars, a word the narration says: "VOICE",
  "REPEAT", "BLOCKS") — a labelled arrow explains itself.

ICONS:
- captions: a 1-3 word LABEL pulled FROM THIS BEAT'S NARRATION — the on-screen words should be words
  the viewer actually HEARS (e.g. narration "your score rises" -> caption "SCORE RISES"; "pay on time"
  -> "ON TIME"). UPPERCASE-friendly, no punctuation. NEVER the scene title or a full phrase (it
  truncates). Never reuse one concept for two nodes in a scene.
- Use SIMPLE, ICONIC, single-object concepts that read at a glance — prefer the plain noun ("database",
  "server", "key", "clock") over a busy/compound one ("redisDatabaseServer"). A clean recognisable
  symbol beats a detailed scene. Don't depict an abstract count as blank boxes — pick a real object
  (requests -> "envelope", users -> "person", tasks -> "checklist").
- PICK ICONS THAT ARE THE METAPHOR: fast -> "rabbit", slow -> "turtle", strong history -> "oak tree",
  prediction -> "crystal ball", a guarded thing -> "padlock". A semantically loaded icon beats a
  generic one — it's what makes the diagram memorable.
- ABSTRACT ideas have no literal icon, so ALSO give "imagery": a concrete object a child could draw
  (classical bit -> "light switch", superposition -> "spinning coin", parameter -> "control knob",
  bandwidth -> "water pipe", latency -> "snail", encryption -> "padlock"). Concrete nouns need no imagery.
- AMBIGUOUS words (bank, cell, mouse, virus, crane, spring, current, bug, web, cloud) mean different
  things in different contexts — set "imagery" to lock in the INTENDED sense for THIS scene:
  bank(finance) -> "piggy bank"; cell(biology) -> "microscope cell"; mouse(computer) -> "computer mouse";
  virus(software) -> "skull warning"; cloud(weather) -> "rain cloud" vs cloud(computing) -> "server cloud".
- value nodes: give "value" + a caption of what it measures. "count" (2-9) draws an icon grid for quantity.
- Do NOT invent facts/numbers not in the narration.

Concept vocabulary (key: meaning) — or invent your own lowerCamelCase concept:
${assetCatalogPrompt()}`;

// Stage 2 — design ONE scene in full detail (runs in parallel per scene).
function designScenePrompt(
  videoTitle: string,
  scene: OutlineScene,
  brief: SceneVisualBrief,
  repairFeedback: string[] = [],
): string {
  return `${DESIGN_LANGUAGE}

You are designing ONE scene of the video "${videoTitle}". Focus entirely on making THIS scene clear,
intuitive and visually balanced. Return ONLY the scene JSON object (no wrapper).

Scene title: ${scene.title}
Visual intent: ${scene.intent}
GLOBAL ART DIRECTION FOR THIS SCENE:
- Primary pattern: ${brief.pattern}. Use this for the first/main zone unless the narration makes it impossible.
- Density: ${brief.density}.
- Emphasize: ${brief.emphasis}
- Continuity: ${brief.continuity}
- Avoid: ${brief.avoid.join(", ")}
${repairFeedback.length ? `REPAIR FEEDBACK FROM THE RENDERED STILL:\n- ${repairFeedback.join("\n- ")}\nFix these issues without changing narration.` : ""}
The narration below is FIXED (already written and timed) — design the VISUALS that bring it to life;
use "beat" for the sentence and "cue" for the exact spoken phrase that reveals a node:
${scene.beats
  .map(
    (beat, i) =>
      `  beat ${i}: ${beat.narration}\n    cues: ${beat.cues.map((cue, cueIndex) => `${cueIndex}="${cue}"`).join(", ") || "automatic"}`,
  )
  .join("\n")}`;
}

export type OutlineBeat = { narration: string; cues: string[] };
type OutlineScene = { title: string; intent: string; beats: OutlineBeat[] };
export type Outline = { title: string; durationSeconds: number; scenes: OutlineScene[] };

function clampStr(v: unknown, max: number, fallback = ""): string {
  const s = typeof v === "string" ? v.trim() : "";
  return (s || fallback).slice(0, max);
}

function sanitizeOutlineBeat(raw: any): OutlineBeat | null {
  const narration = clampStr(typeof raw === "string" ? raw : raw?.narration, 240);
  if (!narration) return null;
  const lower = narration.toLowerCase();
  let cursor = 0;
  const cues: string[] = [];
  for (const candidate of Array.isArray(raw?.cues) ? raw.cues : []) {
    const cue = clampStr(candidate, 80);
    if (!cue) continue;
    const index = lower.indexOf(cue.toLowerCase(), cursor);
    if (index < cursor) continue;
    cues.push(narration.slice(index, index + cue.length));
    cursor = index + cue.length;
    if (cues.length >= 4) break;
  }
  return { narration, cues };
}

export function sanitizeOutline(raw: any): Outline | null {
  if (!raw || typeof raw !== "object") return null;
  const scenesRaw = Array.isArray(raw.scenes) ? raw.scenes : [];
  const scenes: OutlineScene[] = [];
  for (const s of scenesRaw) {
    if (!s || typeof s !== "object") continue;
    const title = clampStr(s.title, 36);
    if (!title) continue;
    const beats = (Array.isArray(s.beats) ? s.beats : [])
      .map(sanitizeOutlineBeat)
      .filter((beat: OutlineBeat | null): beat is OutlineBeat => beat !== null)
      .slice(0, 6);
    if (!beats.length) continue;
    scenes.push({ title, intent: clampStr(s.intent, 200, "explain this clearly"), beats });
  }
  if (scenes.length < 3) return null;
  return {
    title: clampStr(raw.title, 64, "Explainer"),
    durationSeconds: Math.max(60, Math.min(200, Math.round(Number(raw.durationSeconds) || 130))),
    scenes: scenes.slice(0, 10),
  };
}

// Run async tasks with a bounded concurrency pool (so N scene designers fire in
// parallel without exceeding Vertex rate limits).
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

// Honest minimal scene if a designer fails twice: keep the AI's narration and show
// the scene's idea as a single hero icon — degraded layout, NOT canned content.
function fallbackSceneFromOutline(scene: OutlineScene): any {
  const concept = scene.title.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40) || "idea";
  return {
    title: scene.title,
    beats: scene.beats.map((beat) => ({ narration: beat.narration, cues: beat.cues })),
    nodes: [{ id: "n1", kind: "icon", concept, caption: scene.title.split(/\s+/).slice(0, 2).join(" "), role: "hero", beat: 0 }],
    zones: [{ arrange: "hero", nodes: ["n1"] }],
    edges: [],
  };
}

async function createOutline(prompt: string): Promise<Outline> {
  let detail = "no attempts ran";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callGeminiJson("Outline", outlinePrompt(prompt), 0.5);
      const outline = sanitizeOutline(raw);
      if (outline) return outline;
      detail = `outline did not match schema (attempt ${attempt + 1})`;
      console.warn(`Outline ${detail}; raw head: ${JSON.stringify(raw).slice(0, 200)}`);
    } catch (error) {
      detail = `call failed (attempt ${attempt + 1}): ${String(error)}`;
      console.warn(`Outline ${detail}`);
    }
  }
  throw new Error(`Outline director could not produce a valid outline — ${detail}`);
}

// Editor pass over the whole draft script. Pure enhancement: if it fails or yields
// fewer scenes, we keep the original draft (never degrade or block the job).
async function polishScript(draft: Outline): Promise<Outline> {
  try {
    const raw = await callGeminiJson("ScriptEditor", scriptEditorPrompt(draft), 0.6);
    const polished = sanitizeOutline(raw);
    if (polished && polished.scenes.length >= Math.min(draft.scenes.length, 4)) return polished;
    console.warn("Script editor output unusable; keeping the draft script.");
  } catch (error) {
    console.warn(`Script editor failed; keeping the draft script. ${String(error)}`);
  }
  return draft;
}

function visualDirectorPrompt(outline: Outline): string {
  return `You are the GLOBAL ART DIRECTOR for one whiteboard explainer. Coordinate all scenes before
specialist scene designers work in parallel. Assign one primary diagram pattern per scene, vary adjacent
patterns, and make density fit the narration. Use only: ${visualBriefPatterns.join(", ")}.

Return ONLY JSON: {"scenes":[{"pattern":string,"density":"focused"|"balanced"|"dense",
"emphasis":string,"continuity":string,"avoid":[string]}]}. Return exactly ${outline.scenes.length} rows.

Scenes:
${outline.scenes.map((scene, index) => `${index + 1}. ${scene.title} — ${scene.intent} — ${scene.beats.map((beat) => beat.narration).join(" ")}`).join("\n")}`;
}

async function createVisualBrief(outline: Outline): Promise<VideoVisualBrief> {
  const scenes = outline.scenes.map((scene) => ({
    ...scene,
    beats: scene.beats.map((beat) => beat.narration),
  }));
  try {
    const raw = await callGeminiJson("VisualDirector", visualDirectorPrompt(outline), 0.25);
    return sanitizeVisualBrief(raw, scenes);
  } catch (error) {
    console.warn(`Visual director failed; using deterministic scene briefs. ${String(error)}`);
    return defaultVisualBrief(scenes);
  }
}

async function designScene(
  videoTitle: string,
  scene: OutlineScene,
  brief: SceneVisualBrief,
  repairFeedback: string[] = [],
): Promise<any> {
  let bestCandidate: { scene: any; issueCount: number } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await callGeminiJson(
        `Scene:${scene.title}`,
        designScenePrompt(videoTitle, scene, brief, repairFeedback),
        0.55,
      );
      const merged = {
        title: scene.title,
        // The (polished) script is authoritative — the designer only chooses VISUALS,
        // so keep the narration verbatim and don't let it be rewritten.
        beats: scene.beats.map((beat) => ({ narration: beat.narration, cues: beat.cues })),
        nodes: (raw as any)?.nodes,
        zones: (raw as any)?.zones,
        edges: (raw as any)?.edges,
      };
      const sane = sanitizeGraphScene(merged);
      if (sane) {
        const issues = graphSceneQualityIssues(sane);
        if (!issues.length) return sane;
        if (!bestCandidate || issues.length < bestCandidate.issueCount) {
          bestCandidate = { scene: sane, issueCount: issues.length };
        }
        console.warn(
          `Scene designer "${scene.title}" needs repair (attempt ${attempt + 1}): ` +
            issues.map((issue) => issue.message).join(" "),
        );
        continue;
      }
      console.warn(`Scene designer "${scene.title}" output unusable (attempt ${attempt + 1}).`);
    } catch (error) {
      console.warn(`Scene designer "${scene.title}" failed (attempt ${attempt + 1}): ${String(error)}`);
    }
  }
  if (bestCandidate) {
    console.warn(`Scene designer "${scene.title}" kept its best sanitized candidate after two attempts.`);
    return bestCandidate.scene;
  }
  console.warn(`Scene designer "${scene.title}" fell back to a minimal hero scene.`);
  return fallbackSceneFromOutline(scene);
}

async function auditStoryboardStills(storyboard: Storyboard): Promise<Map<number, string[]>> {
  if ((process.env.SCENE_VISUAL_QA ?? "on").trim().toLowerCase() === "off") return new Map();
  try {
    const estimate = estimateTimepoints(storyboard);
    const compiled = compileVideo(storyboard, estimate.timepoints, estimate.durationSeconds, {
      width: 1280,
      height: 720,
      fps: 12,
    });
    const parts: GeminiPart[] = [
      {
        text: `You are the final visual QA reviewer for a whiteboard explainer. The following images are
completed scene stills in order. Judge only: whether the diagram communicates the narration's relationships,
whether labels are readable, whether composition is balanced, and whether objects feel intentionally grouped.
Do NOT fail a scene solely because an icon is missing or represented by text; asset generation runs later.
Fail disconnected symbol collections when narration describes a flow, collision, transformation, or cause.

Return ONLY JSON: {"scenes":[{"sceneId":string,"pass":boolean,"score":0-100,
"issues":["specific repair instruction"]}]}. Use every scene id exactly once.

${storyboard.scenes.map((scene) => `${scene.id}: ${scene.title} — ${scene.beats.map((beat) => beat.narration).join(" ")}`).join("\n")}`,
      },
    ];
    for (const scene of compiled.scenes) {
      const time = Math.max(scene.start, Math.min(compiled.duration - 0.01, scene.end - 0.01));
      const svg = renderFrameSvg(compiled, time);
      const image = await sharp(Buffer.from(svg)).resize(960, 540, { fit: "fill" }).jpeg({ quality: 82 }).toBuffer();
      parts.push({ text: `Scene image: ${scene.id}` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: image.toString("base64") } });
    }

    const model = process.env.SCENE_QA_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const raw = await callGeminiJsonParts("SceneVisualQA", parts, 0.1, model);
    const audit = sanitizeSceneAudit(raw, storyboard.scenes.map((scene) => scene.id));
    const feedback = new Map<number, string[]>();
    audit.forEach((result, sceneIndex) => {
      if (!result.pass) {
        feedback.set(
          sceneIndex,
          result.issues.length ? result.issues : [`Raise visual clarity above the current score of ${result.score}.`],
        );
      }
    });
    if (feedback.size) console.warn(`Scene visual QA requested repairs for ${feedback.size} scene(s).`);
    return feedback;
  } catch (error) {
    console.warn(`Scene visual QA failed; keeping deterministic quality checks. ${String(error)}`);
    return new Map();
  }
}

// Stage 1 (+1b): write and polish the SCRIPT. After this the narration is
// FINAL — scene designers keep beats verbatim — so the caller can start TTS
// in parallel with scene design.
export async function draftScript(prompt: string): Promise<Outline> {
  if (!hasGoogleCredentials()) {
    throw new Error(
      "Director unavailable: Google Cloud credentials are not configured " +
        "(set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS).",
    );
  }

  // Draft the script (fast, reliable). Throws if it can't — no canned
  // fallback, so the job fails cleanly and the user can Resume/Regenerate.
  const draft = await createOutline(prompt);
  // An editor pass that sees the WHOLE script and polishes flow/voice.
  return polishScript(draft);
}

// Stage 2: design every scene IN PARALLEL — each agent focuses on ONE scene.
export async function designStoryboardFromScript(outline: Outline): Promise<{
  storyboard: Storyboard;
  source: AgentPlannerSource;
  visualBrief: VideoVisualBrief;
  repairedSceneIds: string[];
}> {
  const concurrency = Number(process.env.SCENE_DESIGN_CONCURRENCY ?? 5);
  const visualBrief = await createVisualBrief(outline);
  let designed = await mapWithConcurrency(outline.scenes, concurrency, (scene, index) =>
    designScene(outline.title, scene, visualBrief.scenes[index]),
  );

  const composeDesigned = (): Storyboard => {
    const plan = sanitizeSceneGraphPlan({
      title: outline.title,
      durationSeconds: outline.durationSeconds,
      scenes: designed,
    });
    if (!plan) throw new Error("Assembled scene-graph plan was unusable after designing all scenes.");
    return composeSceneGraphPlan(plan);
  };

  let storyboard = composeDesigned();
  const repairFeedback = await auditStoryboardStills(storyboard);
  const failed = [...repairFeedback.entries()];
  if (failed.length) {
    const repaired = await mapWithConcurrency(failed, Math.min(concurrency, failed.length), ([sceneIndex, issues]) =>
      designScene(outline.title, outline.scenes[sceneIndex], visualBrief.scenes[sceneIndex], issues),
    );
    designed = [...designed];
    failed.forEach(([sceneIndex], index) => {
      designed[sceneIndex] = repaired[index];
    });
    storyboard = composeDesigned();
  }

  return {
    storyboard,
    source: "agents",
    visualBrief,
    repairedSceneIds: failed.map(([sceneIndex]) => storyboard.scenes[sceneIndex]?.id).filter(Boolean),
  };
}

export async function createAgenticStoryboard(prompt: string): Promise<{
  storyboard: Storyboard;
  source: AgentPlannerSource;
}> {
  return designStoryboardFromScript(await draftScript(prompt));
}
