import { composeSceneGraphPlan, type SceneGraphPlan } from "./sceneGraph";
import type { Storyboard } from "./storyboard";

function cleanTopic(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return "A Simple System";
  return text
    .replace(/^explain\s+/i, "")
    .replace(/[?.!]+$/g, "")
    .slice(0, 54);
}

function titleCase(input: string): string {
  return input
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Deterministic, offline scene-graph plan used by dev tooling (e.g. the frame
 * preview script) to exercise the full layout + render path WITHOUT calling the
 * LLM director. It is NOT used by the production pipeline — that throws if the
 * director fails so the user gets a Resume/Regenerate, rather than canned content.
 * It deliberately uses every arrangement primitive so layout regressions surface.
 */
export function createFallbackStoryboard(prompt: string): Storyboard {
  const topic = titleCase(cleanTopic(prompt));
  const shortTopic = topic.length > 30 ? `${topic.slice(0, 27)}...` : topic;

  const plan: SceneGraphPlan = {
    title: shortTopic,
    durationSeconds: 96,
    scenes: [
      {
        title: "THE BIG PICTURE",
        beats: [
          { narration: `${topic} turns a raw input into a useful result.` },
          { narration: "First the raw signal is gathered and prepared." },
          { narration: "Then a core process transforms it step by step." },
          { narration: "Finally it produces a clear, usable outcome." },
        ],
        nodes: [
          { id: "in", kind: "icon", concept: "input", caption: "INPUT", role: "normal", beat: 0 },
          { id: "gather", kind: "icon", concept: "data", caption: "GATHER", role: "normal", beat: 1 },
          { id: "proc", kind: "icon", concept: "gear", caption: "PROCESS", role: "normal", beat: 2 },
          { id: "out", kind: "icon", concept: "output", caption: "RESULT", role: "normal", beat: 3 },
        ],
        zones: [{ arrange: "flow", nodes: ["in", "gather", "proc", "out"] }],
        edges: [],
      },
      {
        title: "TWO FORCES",
        beats: [
          { narration: "Every system like this balances two competing forces." },
          { narration: "One side wants to move fast and reach a result quickly." },
          { narration: "The other wants it to stay safe, stable, and correct." },
        ],
        nodes: [
          { id: "l1", kind: "icon", concept: "rocket", caption: "SPEED", role: "normal", beat: 0 },
          { id: "r1", kind: "icon", concept: "shield", caption: "SAFETY", role: "normal", beat: 0 },
          { id: "l2", kind: "icon", concept: "lightbulb", caption: "BOLD", role: "normal", beat: 1 },
          { id: "r2", kind: "icon", concept: "lock", caption: "CAREFUL", role: "normal", beat: 2 },
        ],
        zones: [
          { arrange: "column", nodes: ["l1", "l2"] },
          { arrange: "column", nodes: ["r1", "r2"] },
        ],
        edges: [],
      },
      {
        title: "THE CORE IDEA",
        beats: [
          { narration: "At the center sits one core idea everything connects to." },
          { narration: "It draws on data and a set of rules." },
          { narration: "And it learns from feedback to keep improving." },
        ],
        nodes: [
          { id: "core", kind: "icon", concept: "brain", caption: "CORE IDEA", role: "hero", beat: 0 },
          { id: "data", kind: "icon", concept: "database", caption: "DATA", role: "normal", beat: 1 },
          { id: "rules", kind: "icon", concept: "gear", caption: "RULES", role: "normal", beat: 1 },
          { id: "fb", kind: "icon", concept: "feedback", caption: "FEEDBACK", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "radial", nodes: ["core", "data", "rules", "fb"] }],
        edges: [],
      },
      {
        title: "THE KEY DECISION",
        beats: [
          { narration: "At each step the system reaches a decision point." },
          { narration: "It weighs the evidence and chooses a path." },
          { narration: "If confident it acts; if not, it waits for more." },
        ],
        nodes: [
          { id: "sig", kind: "icon", concept: "input", caption: "SIGNAL", role: "normal", beat: 0 },
          { id: "dec", kind: "icon", concept: "gear", caption: "CONFIDENT", role: "normal", beat: 1 },
          { id: "act", kind: "icon", concept: "check", caption: "ACT", role: "normal", beat: 2 },
          { id: "wait", kind: "icon", concept: "warning", caption: "WAIT", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "branch", nodes: ["sig", "dec", "act", "wait"] }],
        edges: [],
      },
      {
        title: "BY THE NUMBERS",
        beats: [
          { narration: "The impact of getting this right is striking." },
          { narration: "It already reaches a huge and growing audience." },
          { narration: "And the trend keeps climbing every quarter." },
        ],
        nodes: [
          { id: "n1", kind: "value", concept: "rocket", caption: "FASTER", value: "10X", role: "normal", beat: 0 },
          { id: "n2", kind: "value", concept: "person", caption: "REACHED", value: "2M", count: 6, role: "normal", beat: 1 },
          { id: "n3", kind: "value", concept: "chart", caption: "GROWTH", value: "+40%", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "row", nodes: ["n1", "n2", "n3"] }],
        edges: [],
      },
      {
        title: "THE QUALITY BANDS",
        beats: [
          { narration: "Results fall into quality bands." },
          { narration: "Low scores sit on the left, in the red." },
          { narration: "Great scores sit on the right, in the green." },
        ],
        nodes: [
          { id: "q1", kind: "icon", caption: "POOR", value: "BELOW 40", role: "normal", beat: 0 },
          { id: "q2", kind: "icon", caption: "FAIR", value: "40-60", role: "normal", beat: 1 },
          { id: "q3", kind: "icon", caption: "GOOD", value: "60-80", role: "normal", beat: 2 },
          { id: "q4", kind: "icon", caption: "GREAT", value: "80+", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "bands", nodes: ["q1", "q2", "q3", "q4"] }],
        edges: [],
      },
      {
        title: "WHAT IT BRINGS",
        beats: [
          { narration: "It brings a clear set of capabilities." },
          { narration: "Fast results and a simple interface." },
          { narration: "Strong guarantees, and one thing it never does." },
        ],
        nodes: [
          { id: "f1", kind: "icon", concept: "bolt", caption: "FAST RESULTS", value: "2X", role: "normal", beat: 0 },
          { id: "f2", kind: "icon", concept: "lightbulb", caption: "SIMPLE", role: "normal", beat: 1, badge: "check" },
          { id: "f3", kind: "icon", concept: "shield", caption: "GUARANTEED", role: "normal", beat: 2, badge: "star" },
          { id: "f4", kind: "icon", concept: "eye", caption: "NO TRACKING", role: "normal", beat: 2, badge: "no" },
        ],
        zones: [{ arrange: "list", nodes: ["f1", "f2", "f3", "f4"] }],
        edges: [],
      },
      {
        title: "THE TIMELINE",
        beats: [
          { narration: "It grew in three stages." },
          { narration: "A small start, then wide adoption." },
          { narration: "Today it is everywhere." },
        ],
        nodes: [
          { id: "t1", kind: "icon", concept: "seedling", caption: "THE START", value: "YEAR 1", role: "normal", beat: 0 },
          { id: "t2", kind: "icon", concept: "person", caption: "ADOPTION", value: "YEAR 3", role: "normal", beat: 1 },
          { id: "t3", kind: "icon", concept: "globe", caption: "EVERYWHERE", value: "TODAY", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "timeline", nodes: ["t1", "t2", "t3"] }],
        edges: [],
      },
      {
        title: "THE INGREDIENTS",
        beats: [
          { narration: "Four ingredients make up the whole." },
          { narration: "The core process dominates." },
          { narration: "The rest split the remainder." },
        ],
        nodes: [
          { id: "p1", kind: "icon", caption: "CORE PROCESS", value: "40%", role: "normal", beat: 0 },
          { id: "p2", kind: "icon", caption: "DATA", value: "30%", role: "normal", beat: 1 },
          { id: "p3", kind: "icon", caption: "RULES", value: "20%", role: "normal", beat: 2 },
          { id: "p4", kind: "icon", caption: "FEEDBACK", value: "10%", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "pie", nodes: ["p1", "p2", "p3", "p4"] }],
        edges: [],
      },
      {
        title: "UNDER THE HOOD",
        beats: [
          { narration: "One device, three labelled parts." },
          { narration: "The screen and the sensor." },
          { narration: "And the engine inside." },
        ],
        nodes: [
          { id: "h0", kind: "icon", concept: "laptop", caption: "THE DEVICE", role: "hero", beat: 0 },
          { id: "h1", kind: "note", caption: "CLEAR SCREEN", role: "normal", beat: 1 },
          { id: "h2", kind: "note", caption: "SHARP SENSOR", role: "normal", beat: 1 },
          { id: "h3", kind: "note", caption: "FAST ENGINE", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "annotate", nodes: ["h0", "h1", "h2", "h3"] }],
        edges: [],
      },
      {
        title: "THE TOOLKIT",
        beats: [
          { narration: "Three tools ship in the box." },
          { narration: "Each one handles a different job." },
        ],
        nodes: [
          { id: "k1", kind: "icon", concept: "magnifier", caption: "INSPECT", role: "normal", beat: 0 },
          { id: "k2", kind: "icon", concept: "gear", caption: "TUNE", role: "normal", beat: 1 },
          { id: "k3", kind: "icon", concept: "chart", caption: "MEASURE", role: "normal", beat: 1 },
        ],
        zones: [{ arrange: "cards", nodes: ["k1", "k2", "k3"] }],
        edges: [],
      },
      {
        title: "WHAT TO REMEMBER",
        beats: [
          { narration: "A few simple takeaways remain." },
          { narration: "It is a structured flow, not a single magic step." },
          { narration: "It balances opposing forces and keeps improving." },
        ],
        nodes: [
          { id: "c1", kind: "icon", concept: "lightbulb", caption: "CLEAR IDEA", role: "normal", beat: 0 },
          { id: "c2", kind: "icon", concept: "pipeline", caption: "STRUCTURED", role: "normal", beat: 1 },
          { id: "c3", kind: "icon", concept: "shield", caption: "BALANCED", role: "normal", beat: 2 },
          { id: "c4", kind: "icon", concept: "rocket", caption: "IMPROVING", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "checklist", nodes: ["c1", "c2", "c3", "c4"] }],
        edges: [],
      },
    ],
  };

  return composeSceneGraphPlan(plan);
}
