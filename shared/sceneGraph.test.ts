import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeSceneGraphPlan,
  graphSceneQualityIssues,
  harvestValue,
  sanitizeGraphScene,
  sanitizeSceneGraphPlan,
  type SceneGraphPlan,
} from "./sceneGraph";
import { flattenBeats, type VisualElement } from "./storyboard";
import { compileVideo } from "./layout";
import { estimateTimepoints } from "./ssml";
import { renderFrameSvg } from "./svgFrame";

// A rich, multi-zone, multi-pattern plan exercising every arrangement + edges.
const PLAN: SceneGraphPlan = {
  title: "How It Works",
  durationSeconds: 110,
  scenes: [
    {
      title: "TWO APPROACHES",
      beats: [{ narration: "Old systems are slow." }, { narration: "New systems are fast." }],
      nodes: [
        { id: "a", kind: "icon", concept: "snail", caption: "OLD", role: "normal", beat: 0 },
        { id: "b", kind: "icon", concept: "rocket", caption: "NEW", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "row", nodes: ["a", "b"] }],
      edges: [],
    },
    {
      title: "THE PIPELINE",
      beats: [
        { narration: "Data comes in." },
        { narration: "It gets processed." },
        { narration: "Results come out, then repeat." },
      ],
      nodes: [
        { id: "in", kind: "icon", concept: "inbox", caption: "INPUT", role: "normal", beat: 0 },
        { id: "proc", kind: "icon", concept: "gear", caption: "PROCESS", role: "normal", beat: 1 },
        { id: "out", kind: "icon", concept: "outbox", caption: "OUTPUT", role: "normal", beat: 2 },
      ],
      zones: [{ arrange: "flow", nodes: ["in", "proc", "out"] }],
      edges: [{ from: "out", to: "in", kind: "loop", label: "REPEAT" }],
    },
    {
      title: "THE DECISION",
      beats: [
        { narration: "An action happens." },
        { narration: "It hits a check." },
        { narration: "Pass or fail." },
      ],
      nodes: [
        { id: "act", kind: "icon", concept: "play", caption: "ACT", role: "normal", beat: 0 },
        { id: "chk", kind: "icon", concept: "question", caption: "VALID", role: "normal", beat: 1 },
        { id: "yes", kind: "icon", concept: "check", caption: "PASS", role: "normal", beat: 2 },
        { id: "no", kind: "icon", concept: "cross", caption: "FAIL", role: "normal", beat: 2 },
      ],
      zones: [{ arrange: "branch", nodes: ["act", "chk", "yes", "no"] }],
      edges: [],
    },
    {
      title: "BY THE NUMBERS",
      beats: [{ narration: "The scale is huge." }, { narration: "Adoption is growing." }],
      nodes: [
        { id: "s1", kind: "value", concept: "chart", caption: "USERS", value: "3.1B", role: "normal", beat: 0 },
        { id: "s2", kind: "value", concept: "money", caption: "FUNDING", value: "$40B", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "row", nodes: ["s1", "s2"] }],
      edges: [],
    },
    {
      title: "THE ECOSYSTEM",
      beats: [
        { narration: "A core idea." },
        { narration: "Feeds many things." },
        { narration: "Across the board." },
      ],
      nodes: [
        { id: "core", kind: "icon", concept: "brain", caption: "CORE", role: "hero", beat: 0 },
        { id: "x1", kind: "icon", concept: "globe", caption: "GLOBAL", role: "normal", beat: 1 },
        { id: "x2", kind: "icon", concept: "lock", caption: "SECURE", role: "normal", beat: 1 },
        { id: "x3", kind: "icon", concept: "bolt", caption: "FAST", role: "normal", beat: 2 },
        { id: "note", kind: "note", caption: "ALL CONNECTED", role: "normal", beat: 2 },
      ],
      zones: [
        { arrange: "radial", nodes: ["core", "x1", "x2", "x3"] },
        { arrange: "row", nodes: ["note"] },
      ],
      edges: [],
    },
  ],
};

const RENDER_OPTS = { width: 1920, height: 1080, fps: 12 };

function allElements(storyboard: ReturnType<typeof composeSceneGraphPlan>): VisualElement[] {
  return flattenBeats(storyboard).flatMap((b) => b.elements ?? []);
}

test("composeSceneGraphPlan produces a schema-valid storyboard", () => {
  const sb = composeSceneGraphPlan(PLAN); // validateStoryboard throws on any violation
  assert.equal(sb.scenes.length, 5);
  assert.ok(sb.scenes.every((s) => s.beats.length >= 1));
});

test("every element id is globally unique", () => {
  const sb = composeSceneGraphPlan(PLAN);
  const ids = allElements(sb).map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate element id found");
});

test("every icon node yields an asset element resolvable to its concept", () => {
  const sb = composeSceneGraphPlan(PLAN);
  const assets = allElements(sb).filter((e) => e.type === "asset");
  for (const concept of ["snail", "rocket", "gear", "globe", "brain"]) {
    assert.ok(
      assets.some((e) => e.assetKey === concept),
      `expected an asset element for "${concept}"`,
    );
  }
});

test("imagery becomes a searchHint, captions are drawn", () => {
  const plan: SceneGraphPlan = {
    ...PLAN,
    scenes: [
      {
        title: "ABSTRACT",
        beats: [{ narration: "A qubit is like a spinning coin." }],
        nodes: [{ id: "q", kind: "icon", concept: "qubit", imagery: "spinning coin", caption: "QUBIT", role: "normal", beat: 0 }],
        zones: [{ arrange: "row", nodes: ["q"] }],
        edges: [],
      },
      ...PLAN.scenes.slice(1),
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const q = allElements(sb).find((e) => e.assetKey === "qubit");
  assert.ok(q, "qubit element missing");
  assert.equal(q?.searchHint, "spinning coin");
  assert.equal(q?.label, "QUBIT");
});

test("all reveal steps are within [0,7]", () => {
  const sb = composeSceneGraphPlan(PLAN);
  for (const e of allElements(sb)) {
    if (typeof e.revealStep === "number") {
      assert.ok(e.revealStep >= 0 && e.revealStep <= 7, `revealStep ${e.revealStep} out of range`);
    }
  }
});

test("branch zone draws a diamond (4 lines) plus connectors", () => {
  const sb = composeSceneGraphPlan(PLAN);
  const scene = sb.scenes.find((s) => s.title.includes("DECISION"))!;
  const els = scene.beats.flatMap((b) => b.elements ?? []);
  const diamondLines = els.filter((e) => e.type === "line" && e.id.includes("_chk_"));
  assert.equal(diamondLines.length, 4, "decision diamond should be 4 line segments");
  const arrows = els.filter((e) => e.type === "arrow");
  assert.ok(arrows.length >= 3, "branch should have action->decision and two outcome arrows");
});

test("loop edge produces connector segments ending in an arrow", () => {
  const sb = composeSceneGraphPlan(PLAN);
  const scene = sb.scenes.find((s) => s.title.includes("PIPELINE"))!;
  const els = scene.beats.flatMap((b) => b.elements ?? []);
  const loopArrow = els.find((e) => e.type === "arrow" && e.id.includes("_c"));
  assert.ok(loopArrow, "loop connector should end in an arrow segment");
});

test("zones stack vertically (zone 2 sits below zone 1)", () => {
  const sb = composeSceneGraphPlan(PLAN);
  const scene = sb.scenes.find((s) => s.title.includes("ECOSYSTEM"))!;
  const els = scene.beats.flatMap((b) => b.elements ?? []);
  const radialYs = els.filter((e) => e.type === "asset").map((e) => e.y);
  const note = els.find((e) => e.type === "text" && (e.text ?? "").includes("CONNECTED"))!;
  const avgRadial = radialYs.reduce((s, y) => s + y, 0) / radialYs.length;
  assert.ok(note.y > avgRadial, "note zone should be below the radial zone");
});

test("composition is deterministic", () => {
  const a = JSON.stringify(composeSceneGraphPlan(PLAN));
  const b = JSON.stringify(composeSceneGraphPlan(PLAN));
  assert.equal(a, b);
});

test("scene numbering is removed from rendered titles", () => {
  const numbered = structuredClone(PLAN);
  numbered.scenes[0].title = "SCENE 4: THE PIPELINE";
  const storyboard = composeSceneGraphPlan(numbered);

  assert.equal(storyboard.scenes[0].title, "THE PIPELINE");
  assert.equal(storyboard.scenes[0].beats[0].visual.label, "THE PIPELINE");
});

test("compiles + renders a frame without throwing (no TTS)", () => {
  const sb = composeSceneGraphPlan(PLAN);
  const est = estimateTimepoints(sb);
  const compiled = compileVideo(sb, est.timepoints, est.durationSeconds, RENDER_OPTS);
  // No "error" severity diagnostics => everything fits the safe area.
  const errors = compiled.layoutDiagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 0, `layout errors: ${JSON.stringify(errors.slice(0, 2))}`);
  // Render a frame mid-way through the second scene.
  const t = compiled.scenes[1].start + 1.5;
  const svg = renderFrameSvg(compiled, t);
  assert.ok(svg.includes("<svg"), "frame should be an SVG");
  assert.ok(svg.includes("THE PIPELINE"), "frame should show the scene title");
});

test("compiled duration and scene boundaries follow narration audio", () => {
  const sb = composeSceneGraphPlan(PLAN);
  const audioDuration = 17.25;
  const compiled = compileVideo(sb, [], audioDuration, RENDER_OPTS);

  assert.equal(compiled.duration, audioDuration);
  assert.equal(compiled.timeline.duration, audioDuration);
  assert.ok(compiled.beats.every((beat) => beat.start <= audioDuration && beat.end <= audioDuration));
  assert.ok(compiled.scenes.every((scene) => scene.start <= audioDuration && scene.end <= audioDuration));
});

test("rich layout diagnostics flag relational scenes without connectors", () => {
  const plan = structuredClone(PLAN);
  plan.scenes[0] = {
    title: "SCATTERING",
    beats: [{ narration: "Blue light collides with gas and scatters everywhere." }],
    nodes: [
      { id: "light", kind: "icon", role: "normal", concept: "light", caption: "BLUE LIGHT", beat: 0 },
      { id: "gas", kind: "icon", role: "normal", concept: "molecule", caption: "GAS", beat: 0 },
    ],
    zones: [{ arrange: "row", nodes: ["light", "gas"] }],
    edges: [],
  };
  const storyboard = composeSceneGraphPlan(plan);
  const estimate = estimateTimepoints(storyboard);
  const compiled = compileVideo(storyboard, estimate.timepoints, estimate.durationSeconds, RENDER_OPTS);

  assert.ok(
    compiled.layoutDiagnostics.some(
      (diagnostic) =>
        diagnostic.sceneId === "scene_1" && diagnostic.code === "rich_relation_without_connector",
    ),
  );
});

test("graph quality requires connector structure for relational narration", () => {
  const weak = sanitizeGraphScene({
    title: "SCATTERING",
    beats: [{ narration: "Blue light collides with gas and scatters everywhere." }],
    nodes: [
      { id: "light", concept: "light", caption: "BLUE LIGHT" },
      { id: "gas", concept: "molecule", caption: "GAS" },
      { id: "sky", concept: "sky", caption: "SKY" },
    ],
    zones: [{ arrange: "row", nodes: ["light", "gas", "sky"] }],
    edges: [],
  });
  assert.ok(weak);
  assert.deepEqual(graphSceneQualityIssues(weak!).map((issue) => issue.code), ["relation_without_connector"]);

  const repaired = { ...weak!, zones: [{ arrange: "flow" as const, nodes: ["light", "gas", "sky"] }] };
  assert.deepEqual(graphSceneQualityIssues(repaired), []);
});

test("explicit node cues become phrase-level reveal steps", () => {
  const scene = sanitizeGraphScene({
    title: "CUES",
    beats: [{ narration: "First the source reaches the result.", cues: ["source", "result"] }],
    nodes: [
      { id: "source", concept: "source", caption: "SOURCE", beat: 0, cue: 0 },
      { id: "result", concept: "result", caption: "RESULT", beat: 0, cue: 1 },
    ],
    zones: [{ arrange: "flow", nodes: ["source", "result"] }],
    edges: [],
  });
  assert.ok(scene);
  const storyboard = composeSceneGraphPlan({
    title: "Cues",
    durationSeconds: 60,
    scenes: [scene!, { ...scene!, title: "CUES TWO" }, { ...scene!, title: "CUES THREE" }],
  });
  const assets = storyboard.scenes[0].beats[0].elements?.filter((element) => element.type === "asset") ?? [];

  assert.deepEqual(assets.map((element) => element.revealStep), [0, 1]);
  assert.deepEqual(storyboard.scenes[0].beats[0].revealCues, ["source", "result"]);
});

// ----- sanitizer -----

test("sanitizer coerces partial/garbage director JSON", () => {
  const raw = {
    title: "x".repeat(200),
    durationSeconds: 9999,
    scenes: [
      {
        title: "  Messy Scene  ",
        beats: [{ narration: "One." }, "Two as a bare string."],
        nodes: [
          { id: "n 1!", kind: "icon", concept: "Rocket!!", caption: "GO", beat: 99 },
          { id: "n2", kind: "note", caption: "just text" },
          { id: "n3", kind: "icon" }, // no concept/caption -> dropped
        ],
        zones: [{ arrange: "nonsense", nodes: ["n1", "n2", "missing"] }],
        edges: [{ from: "n1", to: "n2", kind: "weird" }, { from: "n1", to: "n1" }],
      },
      { title: "S2", beats: [{ narration: "Hi" }], nodes: [{ id: "a", concept: "brain", caption: "A" }], zones: [{ arrange: "row", nodes: ["a"] }] },
      { title: "S3", beats: [{ narration: "Hi" }], nodes: [{ id: "a", concept: "globe", caption: "B" }], zones: [{ arrange: "row", nodes: ["a"] }] },
    ],
  };
  const plan = sanitizeSceneGraphPlan(raw);
  assert.ok(plan, "should sanitize to a usable plan");
  assert.ok(plan!.title.length <= 64);
  assert.ok(plan!.durationSeconds <= 210);
  const s0 = plan!.scenes[0];
  assert.equal(s0.title, "Messy Scene");
  // bare-string beat coerced; node id cleaned ("n 1!" -> "n1"); bad beat clamped.
  const n1 = s0.nodes.find((n) => n.id === "n1");
  assert.ok(n1, "node id should be cleaned to n1");
  assert.ok(n1!.beat <= s0.beats.length - 1, "beat clamped into range");
  assert.equal(n1!.concept, "Rocket"); // punctuation stripped
  // arrange "nonsense" -> "row"; missing/dropped node ids excluded.
  assert.equal(s0.zones[0].arrange, "row");
  assert.ok(s0.zones[0].nodes.every((id) => id === "n1" || id === "n2"));
  // self-edge and unknown ids dropped; weird kind -> arrow.
  assert.ok(s0.edges.every((e) => e.from !== e.to));
  // composes cleanly end to end.
  composeSceneGraphPlan(plan!);
});

test("named patterns: comparison/fanout/convergence/loopback render correctly", () => {
  const plan: SceneGraphPlan = {
    title: "Patterns",
    durationSeconds: 90,
    scenes: [
      {
        title: "COMPARISON",
        beats: [{ narration: "Old vs new." }],
        nodes: [
          { id: "l1", kind: "icon", concept: "snail", caption: "OLD", side: "left", role: "normal", beat: 0 },
          { id: "r1", kind: "icon", concept: "rocket", caption: "NEW", side: "right", role: "normal", beat: 0 },
        ],
        zones: [{ arrange: "comparison", nodes: ["l1", "r1"] }],
        edges: [],
      },
      {
        title: "FAN OUT",
        beats: [{ narration: "One source, many outputs." }],
        nodes: [
          { id: "s", kind: "icon", concept: "server", caption: "SOURCE", role: "normal", beat: 0 },
          { id: "a", kind: "icon", concept: "phone", caption: "A", role: "normal", beat: 0 },
          { id: "b", kind: "icon", concept: "laptop", caption: "B", role: "normal", beat: 0 },
          { id: "c", kind: "icon", concept: "tablet", caption: "C", role: "normal", beat: 0 },
        ],
        zones: [{ arrange: "fanout", nodes: ["s", "a", "b", "c"] }],
        edges: [],
      },
      {
        title: "CONVERGENCE",
        beats: [{ narration: "Many inputs, one result." }],
        nodes: [
          { id: "i1", kind: "icon", concept: "house", caption: "FAMILY", role: "normal", beat: 0 },
          { id: "i2", kind: "icon", concept: "people", caption: "FRIENDS", role: "normal", beat: 0 },
          { id: "i3", kind: "icon", concept: "globe", caption: "WORLD", role: "normal", beat: 0 },
          { id: "out", kind: "icon", concept: "person", caption: "YOU", role: "normal", beat: 0 },
        ],
        zones: [{ arrange: "convergence", nodes: ["i1", "i2", "i3", "out"] }],
        edges: [],
      },
      {
        title: "LOOPBACK",
        beats: [{ narration: "It cycles." }],
        nodes: [
          { id: "g", kind: "icon", concept: "warning", caption: "GUESS", role: "normal", beat: 0 },
          { id: "m", kind: "icon", concept: "ruler", caption: "MEASURE", role: "normal", beat: 0 },
          { id: "u", kind: "icon", concept: "gear", caption: "UPDATE", role: "normal", beat: 0 },
        ],
        zones: [{ arrange: "loopback", nodes: ["g", "m", "u"] }],
        edges: [],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan); // validateStoryboard throws on any error

  const els = (title: string) => sb.scenes.find((s) => s.title === title)!.beats.flatMap((b) => b.elements ?? []);

  // comparison: a divider line + left icon x < right icon x.
  const cmp = els("COMPARISON");
  assert.ok(cmp.some((e) => e.type === "line" && e.id.includes("_div")), "comparison needs a divider");
  const leftX = cmp.find((e) => e.type === "asset" && e.assetKey === "snail")!.x;
  const rightX = cmp.find((e) => e.type === "asset" && e.assetKey === "rocket")!.x;
  assert.ok(leftX < rightX, "left-side node should sit left of right-side node");

  // fanout: 3 arrows out of the single source.
  const fan = els("FAN OUT");
  assert.equal(fan.filter((e) => e.type === "arrow").length, 3, "fanout: source -> 3 targets");

  // convergence: 3 arrows into the target.
  const conv = els("CONVERGENCE");
  assert.equal(conv.filter((e) => e.type === "arrow").length, 3, "convergence: 3 sources -> target");

  // loopback: 2 sequence arrows + a loop-back (which ends in an arrow segment).
  const loop = els("LOOPBACK");
  assert.ok(loop.filter((e) => e.type === "arrow").length >= 3, "loopback: sequence arrows + loop arrow");
  assert.ok(loop.some((e) => e.type === "text" && (e.text ?? "").includes("REPEAT")), "loopback shows REPEAT");
});

test("text de-overlap separates colliding connector labels", () => {
  const plan: SceneGraphPlan = {
    title: "T",
    durationSeconds: 90,
    scenes: [
      {
        title: "COLLIDE",
        beats: [{ narration: "a to b twice." }],
        nodes: [
          { id: "a", kind: "icon", concept: "rocket", caption: "A", role: "normal", beat: 0 },
          { id: "b", kind: "icon", concept: "brain", caption: "B", role: "normal", beat: 0 },
        ],
        zones: [{ arrange: "row", nodes: ["a", "b"] }],
        // two edges between the same pair -> both labels want the same midpoint.
        edges: [
          { from: "a", to: "b", kind: "arrow", label: "ALPHA" },
          { from: "a", to: "b", kind: "arrow", label: "BETA" },
        ],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const els = sb.scenes[0].beats.flatMap((b) => b.elements ?? []);
  const alpha = els.find((e) => e.type === "text" && e.text === "ALPHA")!;
  const beta = els.find((e) => e.type === "text" && e.text === "BETA")!;
  assert.ok(alpha && beta, "both labels present");
  assert.ok(Math.abs(alpha.y - beta.y) >= 22, `labels must be separated vertically, got dy=${Math.abs(alpha.y - beta.y)}`);
});

test("connector labels never overlap icon captions", () => {
  // Reproduces "THE MIDNIGHT PANIC": a top flow + a node below with a labelled
  // edge whose label could land on a flow caption.
  const plan: SceneGraphPlan = {
    title: "T",
    durationSeconds: 90,
    scenes: [
      {
        title: "PANIC",
        beats: [{ narration: "a." }, { narration: "b." }],
        nodes: [
          { id: "t", kind: "icon", concept: "clock", caption: "2 AM", role: "normal", beat: 0 },
          { id: "h", kind: "icon", concept: "warning", caption: "HIJACKED", role: "normal", beat: 0 },
          { id: "c", kind: "icon", concept: "wheel", caption: "THE CONTROL", role: "normal", beat: 0 },
          { id: "a", kind: "icon", concept: "astronaut", caption: "ASTRONAUT", role: "normal", beat: 1 },
        ],
        zones: [
          { arrange: "flow", nodes: ["t", "h", "c"] },
          { arrange: "row", nodes: ["a"] },
        ],
        edges: [{ from: "a", to: "c", kind: "arrow", label: "STEER" }],
      },
    ],
  };
  const els = composeSceneGraphPlan(plan).scenes[0].beats.flatMap((b) => b.elements ?? []);
  const capBoxes = els
    .filter((e) => (e.type === "asset" || e.type === "logo") && e.label && e.width && e.height)
    .map((e) => {
      const w = (e.label as string).length * 26 * 0.6 + 10;
      return { x: e.x + (e.width ?? 0) / 2 - w / 2, y: e.y + (e.height ?? 0) + 4, w, h: 32 };
    });
  const overlap = (a: any, b: any) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  for (const t of els.filter((e) => e.type === "text")) {
    const tw = (t.text ?? "").length * 24 * 0.6 + 10;
    const tb = { x: t.x - tw / 2, y: t.y - 24, w: tw, h: 30 };
    for (const cb of capBoxes) {
      assert.ok(!overlap(tb, cb), `text "${t.text}" overlaps an icon caption`);
    }
  }
});

test("comparison drops arrows that cross the divider", () => {
  const plan: SceneGraphPlan = {
    title: "T",
    durationSeconds: 90,
    scenes: [
      {
        title: "CONTRAST",
        beats: [{ narration: "left vs right." }],
        nodes: [
          { id: "l", kind: "icon", concept: "snail", caption: "OLD", side: "left", role: "normal", beat: 0 },
          { id: "r", kind: "icon", concept: "rocket", caption: "NEW", side: "right", role: "normal", beat: 0 },
        ],
        zones: [{ arrange: "comparison", nodes: ["l", "r"] }],
        edges: [{ from: "l", to: "r", kind: "arrow", label: "BECOMES" }],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const els = sb.scenes[0].beats.flatMap((b) => b.elements ?? []);
  // The cross-divider edge (el_s1_e0...) must be dropped; only the divider line remains.
  assert.ok(!els.some((e) => e.id.startsWith("el_s1_e0")), "cross-divider edge should be dropped");
  assert.ok(!els.some((e) => e.type === "text" && e.text === "BECOMES"), "its label should be gone too");
  assert.ok(els.some((e) => e.type === "line" && e.id.includes("_div")), "divider still present");
});

test("explicit edges that duplicate automatic pattern connectors are dropped", () => {
  const plan: SceneGraphPlan = {
    title: "T",
    durationSeconds: 90,
    scenes: [
      {
        title: "FLOW",
        beats: [{ narration: "a." }, { narration: "b." }, { narration: "c." }],
        nodes: [
          { id: "a", kind: "icon", concept: "wallet", caption: "A", role: "normal", beat: 0 },
          { id: "b", kind: "icon", concept: "database", caption: "B", role: "normal", beat: 1 },
          { id: "c", kind: "icon", concept: "lock", caption: "C", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "flow", nodes: ["a", "b", "c"] }],
        edges: [
          { from: "a", to: "b", kind: "arrow" },
          { from: "b", to: "c", kind: "arrow" },
        ],
      },
    ],
  };
  const els = composeSceneGraphPlan(plan).scenes[0].beats.flatMap((b) => b.elements ?? []);
  assert.equal(els.filter((e) => e.type === "arrow").length, 2, "flow should draw each connector once");
  assert.ok(!els.some((e) => e.id.startsWith("el_s1_e")), "duplicate explicit edges should be omitted");
});

test("convergence side labels keep arrows clear of vertical source assets", () => {
  const plan: SceneGraphPlan = {
    title: "T",
    durationSeconds: 90,
    scenes: [
      {
        title: "CROWD",
        beats: [{ narration: "many inputs become one result." }],
        nodes: [
          { id: "earth", kind: "icon", concept: "network", caption: "EARTH COMPUTERS", role: "normal", beat: 0 },
          { id: "light", kind: "icon", concept: "lightbulb", caption: "TOTAL EXPOSURE", role: "normal", beat: 0 },
          { id: "math", kind: "icon", concept: "shield", caption: "MATHEMATICS", role: "normal", beat: 0 },
          { id: "trust", kind: "icon", concept: "gear", caption: "TRUST ENGINE", role: "normal", beat: 0 },
        ],
        zones: [{ arrange: "convergence", nodes: ["earth", "light", "math", "trust"] }],
        edges: [],
      },
    ],
  };
  const els = composeSceneGraphPlan(plan).scenes[0].beats.flatMap((b) => b.elements ?? []);
  const sourceAssets = ["earth", "light", "math"].map((id) => els.find((e) => e.id === `el_s1_${id}`)!);
  const target = els.find((e) => e.id === "el_s1_trust")!;
  const sourceLabels = ["earth", "light", "math"].map((id) => els.find((e) => e.id === `el_s1_${id}_c`)!);
  assert.ok(sourceAssets.every((e) => e.type === "asset" && !e.label), "vertical source labels should be separate side text");
  sourceLabels.forEach((label, i) => {
    assert.ok(label.type === "text" && label.x < sourceAssets[i].x, "source caption should sit left of its icon");
  });
  const arrows = els.filter((e) => e.type === "arrow");
  assert.equal(arrows.length, 3, "convergence should still draw three arrows");
  arrows.forEach((arrow, i) => {
    const source = sourceAssets[i];
    // Horizontal projection of a DIAGONAL arrow (it's >= CONNECTOR_CLEARANCE clear
    // along its own direction, which is what actually prevents overlap).
    assert.ok(arrow.x - (source.x + (source.width ?? 0)) >= 12, "arrow should leave a clear gap after the source asset");
    assert.ok(target.x - (arrow.x2 ?? 0) >= 12, "arrow should stop before the target asset");
  });
});

test("a lone node is centred (never stranded)", () => {
  const plan: SceneGraphPlan = {
    title: "T",
    durationSeconds: 90,
    scenes: [
      {
        title: "SOLO",
        beats: [{ narration: "one thing." }],
        nodes: [{ id: "n", kind: "icon", concept: "brain", caption: "IDEA", role: "hero", beat: 0 }],
        zones: [{ arrange: "row", nodes: ["n"] }],
        edges: [],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const icon = sb.scenes[0].beats.flatMap((b) => b.elements ?? []).find((e) => e.type === "asset")!;
  const cx = icon.x + (icon.width ?? 0) / 2;
  assert.ok(Math.abs(cx - 600) < 2, `lone node should be horizontally centred, got cx=${cx}`);
});

test("sanitizer keeps named patterns + node.side", () => {
  const plan = sanitizeSceneGraphPlan({
    title: "T",
    durationSeconds: 90,
    scenes: Array.from({ length: 3 }, (_, i) => ({
      title: `S${i}`,
      beats: [{ narration: "hi" }],
      nodes: [
        { id: "a", concept: "snail", caption: "A", side: "left" },
        { id: "b", concept: "rocket", caption: "B", side: "right" },
      ],
      zones: [{ arrange: "comparison", nodes: ["a", "b"] }],
    })),
  })!;
  assert.equal(plan.scenes[0].zones[0].arrange, "comparison");
  assert.equal(plan.scenes[0].nodes[0].side, "left");
});

test("sanitizer rejects fewer than 3 scenes", () => {
  assert.equal(sanitizeSceneGraphPlan({ scenes: [] }), null);
  assert.equal(sanitizeSceneGraphPlan("nope"), null);
});

test("orphan nodes (not in any zone) are placed, not dropped", () => {
  const raw = {
    title: "T",
    durationSeconds: 90,
    scenes: Array.from({ length: 3 }, (_, i) => ({
      title: `S${i}`,
      beats: [{ narration: "hi" }],
      nodes: [
        { id: "a", concept: "brain", caption: "A" },
        { id: "b", concept: "globe", caption: "B" },
      ],
      zones: [{ arrange: "row", nodes: ["a"] }], // b is orphaned
    })),
  };
  const plan = sanitizeSceneGraphPlan(raw)!;
  const referenced = new Set(plan.scenes[0].zones.flatMap((z) => z.nodes));
  assert.ok(referenced.has("b"), "orphan node b should be added to a fallback zone");
});

test("sanitizer assigns a repeated node to only its first zone", () => {
  const scene = sanitizeGraphScene({
    title: "NO DUPLICATES",
    beats: [{ narration: "One object supports two ideas." }],
    nodes: [
      { id: "shared", concept: "brain", caption: "SHARED" },
      { id: "other", concept: "globe", caption: "OTHER" },
    ],
    zones: [
      { arrange: "hero", nodes: ["shared"] },
      { arrange: "row", nodes: ["shared", "other"] },
    ],
    edges: [],
  });
  assert.ok(scene);
  assert.deepEqual(scene!.zones.map((zone) => zone.nodes), [["shared"], ["other"]]);
  assert.doesNotThrow(() =>
    composeSceneGraphPlan({
      title: "No duplicates",
      durationSeconds: 60,
      scenes: [scene!, { ...scene!, title: "TWO" }, { ...scene!, title: "THREE" }],
    }),
  );
});

// ---------------------------------------------------------------------------
// New content primitives (bands / list / checklist / timeline / pie / annotate
// / cards / badges / value-in-caption)
// ---------------------------------------------------------------------------

const PRIMITIVES_PLAN: SceneGraphPlan = {
  title: "Primitives",
  durationSeconds: 120,
  scenes: [
    {
      title: "THE BANDS",
      beats: [{ narration: "Scores fall into bands." }, { narration: "Higher is better." }],
      nodes: [
        { id: "b1", kind: "icon", caption: "POOR", value: "BELOW 580", role: "normal", beat: 0 },
        { id: "b2", kind: "icon", caption: "FAIR", value: "580-669", role: "normal", beat: 0 },
        { id: "b3", kind: "icon", caption: "GOOD", value: "670-739", role: "normal", beat: 1 },
        { id: "b4", kind: "icon", caption: "GREAT", value: "800+", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "bands", nodes: ["b1", "b2", "b3", "b4"] }],
      edges: [],
    },
    {
      title: "THE LIST",
      beats: [{ narration: "It brings four things." }, { narration: "Each one matters." }],
      nodes: [
        { id: "f1", kind: "icon", concept: "bolt", caption: "FAST", value: "2X", role: "normal", beat: 0 },
        { id: "f2", kind: "icon", concept: "shield", caption: "SAFE", role: "normal", beat: 0, badge: "check" },
        { id: "f3", kind: "icon", concept: "star", caption: "FEATURED", role: "normal", beat: 1, badge: "star" },
        { id: "f4", kind: "icon", concept: "eye", caption: "NO TRACKING", role: "normal", beat: 1, badge: "no" },
      ],
      zones: [{ arrange: "list", nodes: ["f1", "f2", "f3", "f4"] }],
      edges: [],
    },
    {
      title: "THE RECAP",
      beats: [{ narration: "Remember these." }, { narration: "And this one." }],
      nodes: [
        { id: "c1", kind: "icon", caption: "PAY ON TIME", role: "normal", beat: 0 },
        { id: "c2", kind: "icon", concept: "lock", caption: "KEEP IT LOW", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "checklist", nodes: ["c1", "c2"] }],
      edges: [],
    },
    {
      title: "THE TIMELINE",
      beats: [{ narration: "Three stages." }, { narration: "Over the years." }],
      nodes: [
        { id: "t1", kind: "icon", concept: "seedling", caption: "START", value: "YEAR 1", role: "normal", beat: 0 },
        { id: "t2", kind: "icon", concept: "person", caption: "GROWTH", value: "YEAR 3", role: "normal", beat: 1 },
        { id: "t3", kind: "icon", concept: "globe", caption: "TODAY", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "timeline", nodes: ["t1", "t2", "t3"] }],
      edges: [],
    },
    {
      title: "THE PIE",
      beats: [{ narration: "Parts of a whole." }, { narration: "The core dominates." }],
      nodes: [
        { id: "p1", kind: "icon", caption: "CORE", value: "40%", role: "normal", beat: 0 },
        { id: "p2", kind: "icon", caption: "DATA", value: "35%", role: "normal", beat: 1 },
        { id: "p3", kind: "icon", caption: "REST", value: "25%", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "pie", nodes: ["p1", "p2", "p3"] }],
      edges: [],
    },
    {
      title: "THE DEVICE",
      beats: [{ narration: "One object, labelled." }, { narration: "Each part named." }],
      nodes: [
        { id: "h0", kind: "icon", concept: "laptop", caption: "THE DEVICE", role: "hero", beat: 0 },
        { id: "h1", kind: "note", caption: "CLEAR SCREEN", role: "normal", beat: 1 },
        { id: "h2", kind: "note", caption: "FAST ENGINE", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "annotate", nodes: ["h0", "h1", "h2"] }],
      edges: [],
    },
    {
      title: "THE CARDS",
      beats: [{ narration: "Three tools." }, { narration: "Each in its box." }],
      nodes: [
        { id: "k1", kind: "icon", concept: "magnifier", caption: "INSPECT", role: "normal", beat: 0 },
        { id: "k2", kind: "icon", concept: "gear", caption: "TUNE", role: "normal", beat: 1 },
        { id: "k3", kind: "icon", concept: "chart", caption: "MEASURE", role: "normal", beat: 1 },
      ],
      zones: [{ arrange: "cards", nodes: ["k1", "k2", "k3"] }],
      edges: [],
    },
  ],
};

function sceneEls(sb: ReturnType<typeof composeSceneGraphPlan>, title: string): VisualElement[] {
  return sb.scenes.find((s) => s.title === title)!.beats.flatMap((b) => b.elements ?? []);
}

test("bands: ramped color rects + captions + direction arrow", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const els = sceneEls(sb, "THE BANDS");
  const rects = els.filter((e) => e.type === "rect");
  assert.equal(rects.length, 4);
  assert.equal(rects[0].fill, "#e25b4a", "first band is red");
  assert.equal(rects[rects.length - 1].fill, "#5cb85c", "last band is green");
  // All bands share a row; an arrow runs underneath them.
  const arrow = els.find((e) => e.type === "arrow");
  assert.ok(arrow, "direction arrow exists");
  assert.ok(arrow!.y > rects[0].y + (rects[0].height ?? 0), "arrow sits below the bands");
  // Range values are drawn as text.
  assert.ok(els.some((e) => e.type === "text" && e.text?.includes("580")));
});

test("list: side captions sit to the right of small icons; values drawn", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const els = sceneEls(sb, "THE LIST");
  const icons = els.filter((e) => e.type === "asset");
  assert.equal(icons.length, 4);
  for (const icon of icons) {
    assert.ok(!icon.label, "list icons carry no below-caption (side captions instead)");
    assert.ok((icon.width ?? 0) <= 112, "list icons are compact");
  }
  const texts = els.filter((e) => e.type === "text");
  for (const icon of icons) {
    assert.ok(
      texts.some((t) => t.x > icon.x + (icon.width ?? 0)),
      "a caption sits right of each icon",
    );
  }
  assert.ok(texts.some((t) => t.text?.includes("2X")), "icon value is drawn");
  // Badges pass through to the asset elements.
  assert.ok(icons.some((i) => i.badge === "no"));
  assert.ok(icons.some((i) => i.badge === "star"));
});

test("checklist: rows default to check icons / check badges", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const els = sceneEls(sb, "THE RECAP");
  const icons = els.filter((e) => e.type === "asset");
  assert.equal(icons.length, 2);
  const noConcept = icons.find((i) => i.assetKey === "check");
  assert.ok(noConcept, "caption-only checklist row draws a literal check icon");
  const withConcept = icons.find((i) => i.assetKey === "lock");
  assert.ok(withConcept?.badge === "check", "concept checklist row gets a green check badge");
});

test("timeline: base line spans the row, markers + captions per point", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const els = sceneEls(sb, "THE TIMELINE");
  const line = els.find((e) => e.type === "line" && Math.abs((e.x2 ?? 0) - e.x) > 600);
  assert.ok(line, "long base line exists");
  const markers = els.filter((e) => e.type === "node");
  assert.equal(markers.length, 3, "one marker per point");
  const icons = els.filter((e) => e.type === "asset");
  assert.equal(icons.length, 3);
  for (const icon of icons) {
    assert.ok(icon.y + (icon.height ?? 0) <= (line!.y ?? 0), "icons sit above the line");
  }
});

test("pie: slices close the circle and labels carry values", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const els = sceneEls(sb, "THE PIE");
  const slices = els.filter((e) => e.type === "pieSlice");
  assert.equal(slices.length, 3);
  assert.equal(slices[0].a1, 0);
  const last = slices[slices.length - 1];
  assert.ok(Math.abs((last.a2 ?? 0) - 360) < 1, "slices close the circle");
  // 40% of 100 -> 144 degrees.
  assert.ok(Math.abs((slices[0].a2 ?? 0) - 144) < 2, "slice size follows its share");
  assert.ok(els.some((e) => e.type === "text" && e.text?.includes("40%")), "labels include the value");
});

test("annotate: hero icon plus leader lines to text labels", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const els = sceneEls(sb, "THE DEVICE");
  const icons = els.filter((e) => e.type === "asset");
  assert.equal(icons.length, 1, "only the hero draws an icon");
  const labels = els.filter((e) => e.type === "text" && e.text !== undefined && e.text.includes("SCREEN"));
  assert.equal(labels.length, 1);
  const leaders = els.filter((e) => e.type === "line");
  assert.ok(leaders.length >= 2, "each label gets a leader line");
});

test("cards: each icon is wrapped in a card rect", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const els = sceneEls(sb, "THE CARDS");
  const icons = els.filter((e) => e.type === "asset");
  const rects = els.filter((e) => e.type === "rect");
  assert.equal(rects.length, icons.length);
  for (const icon of icons) {
    assert.ok(
      rects.some((r) => r.x < icon.x && r.x + (r.width ?? 0) > icon.x + (icon.width ?? 0)),
      "a card rect encloses each icon",
    );
  }
});

test("primitives plan compiles + renders a frame", () => {
  const sb = composeSceneGraphPlan(PRIMITIVES_PLAN);
  const estimate = estimateTimepoints(sb);
  const compiled = compileVideo(sb, estimate.timepoints, estimate.durationSeconds, {
    width: 1280,
    height: 720,
    fps: 12,
  });
  for (const t of [1, 16, 32, 48, 64, 80, 100]) {
    const svg = renderFrameSvg(compiled, t);
    assert.ok(svg.includes("<svg"), `frame at ${t}s renders`);
  }
  const errors = compiled.layoutDiagnostics.filter((d: { severity: string }) => d.severity === "error");
  assert.equal(errors.length, 0, "no error-severity layout diagnostics");
});

test("hero + checklist recap: zones never overlap vertically", () => {
  const plan: SceneGraphPlan = {
    title: "Recap",
    durationSeconds: 60,
    scenes: [
      {
        title: "THE MARKET RECAP",
        beats: [
          { narration: "Let us review." },
          { narration: "Point one." },
          { narration: "Point two." },
          { narration: "Point three." },
        ],
        nodes: [
          { id: "hero", kind: "icon", concept: "bank", caption: "STOCK MARKET", role: "hero", beat: 0 },
          { id: "c1", kind: "icon", concept: "factory", caption: "ISSUE SHARES", role: "normal", beat: 1 },
          { id: "c2", kind: "icon", concept: "handshake", caption: "CONNECT BUYERS", role: "normal", beat: 2 },
          { id: "c3", kind: "icon", concept: "scale", caption: "SUPPLY DEMAND", role: "normal", beat: 3 },
          { id: "c4", kind: "icon", concept: "money", caption: "DIVIDENDS", role: "normal", beat: 3 },
        ],
        zones: [
          { arrange: "hero", nodes: ["hero"] },
          { arrange: "checklist", nodes: ["c1", "c2", "c3", "c4"] },
        ],
        edges: [],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const els = sb.scenes[0].beats.flatMap((b) => b.elements ?? []);
  const icons = els.filter((e) => e.type === "asset");
  const hero = icons.find((e) => e.assetKey === "bank")!;
  const rows = icons.filter((e) => e !== hero);
  assert.equal(rows.length, 4);
  // The hero (lone node in a multi-zone scene) takes a side caption, so its icon
  // can use the band; every checklist row starts below the hero's box.
  assert.ok(!hero.label, "multi-zone lone hero uses a side caption");
  for (const row of rows) {
    assert.ok(row.y >= hero.y + (hero.height ?? 0) - 2, "checklist rows sit below the hero");
  }
  // Rows do not overlap each other.
  const sorted = [...rows].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(
      sorted[i].y >= sorted[i - 1].y + (sorted[i - 1].height ?? 0) - 2,
      "checklist rows do not overlap",
    );
  }
});

test("connectors reveal with the LATER endpoint (no dangling arrows)", () => {
  const plan: SceneGraphPlan = {
    title: "Edges",
    durationSeconds: 60,
    scenes: [
      {
        title: "LATE SOURCE",
        beats: [{ narration: "Target first." }, { narration: "Filler." }, { narration: "Source arrives." }],
        nodes: [
          { id: "target", kind: "icon", concept: "bank", caption: "EXCHANGE", role: "normal", beat: 0 },
          { id: "src", kind: "icon", concept: "person", caption: "SELLER", role: "normal", beat: 2 },
        ],
        zones: [{ arrange: "row", nodes: ["src", "target"] }],
        edges: [{ from: "src", to: "target", kind: "arrow" }],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  // The arrow must live in beat 2 (the source's beat), not beat 0 (the target's).
  const beatEls = sb.scenes[0].beats.map((b) => b.elements ?? []);
  assert.ok(!beatEls[0].some((e) => e.type === "arrow"), "no arrow before its source exists");
  assert.ok(beatEls[2].some((e) => e.type === "arrow"), "arrow appears with the later endpoint");
});

test("multi-zone scenes keep ONE consistent icon size (no tiny-flow regression)", () => {
  // Shape of the broken "TRADITIONAL MONEY" scene: a captioned flow row plus a
  // lone hub node in a second zone. All icons must stay big and uniform.
  const plan: SceneGraphPlan = {
    title: "Money",
    durationSeconds: 60,
    scenes: [
      {
        title: "TRADITIONAL MONEY",
        beats: [
          { narration: "You pay with money." },
          { narration: "The coffee shop calls the bank." },
          { narration: "A private server checks the ledger." },
        ],
        nodes: [
          { id: "m", kind: "icon", concept: "money", caption: "TRADITIONAL MONEY", role: "normal", beat: 0 },
          { id: "c", kind: "icon", concept: "coffee", caption: "BUY COFFEE", role: "normal", beat: 0 },
          { id: "b", kind: "icon", concept: "bank", caption: "BANK", role: "normal", beat: 1 },
          { id: "s", kind: "icon", concept: "server", caption: "PRIVATE SERVER", role: "normal", beat: 2 },
        ],
        zones: [
          { arrange: "flow", nodes: ["m", "c", "b"] },
          { arrange: "row", nodes: ["s"] },
        ],
        edges: [{ from: "b", to: "s", kind: "arrow", label: "CHECKS" }],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const icons = sb.scenes[0].beats.flatMap((b) => b.elements ?? []).filter((e) => e.type === "asset");
  assert.equal(icons.length, 4);
  const sizes = icons.map((e) => e.width ?? 0);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);
  assert.ok(minSize >= 110, `icons stay big (got min ${minSize})`);
  assert.ok(maxSize / minSize <= 1.2, `sizes stay uniform (got ${sizes.join(",")})`);
  // The lone server (side caption) and the flow captions never overlap another
  // zone: every flow icon's caption block ends above the server's box.
  const server = icons.find((e) => e.assetKey === "server")!;
  for (const icon of icons) {
    if (icon === server) continue;
    assert.ok(icon.y + (icon.height ?? 0) + 60 <= server.y + 8, "flow captions clear the server zone");
  }
});

test("dense comparisons (5+) switch to outward side captions", () => {
  const plan: SceneGraphPlan = {
    title: "Supply",
    durationSeconds: 60,
    scenes: [
      {
        title: "LIMITED SUPPLY",
        beats: [{ narration: "Banks print endlessly." }, { narration: "Bitcoin has a hard cap." }],
        nodes: [
          { id: "l1", kind: "icon", concept: "bank", caption: "BANKS", side: "left", role: "normal", beat: 0 },
          { id: "l2", kind: "icon", concept: "printer", caption: "ENDLESS", side: "left", role: "normal", beat: 0 },
          { id: "l3", kind: "icon", concept: "money", caption: "INFLATION", side: "left", role: "normal", beat: 0 },
          { id: "r1", kind: "icon", concept: "lock", caption: "HARD LIMIT", side: "right", role: "normal", beat: 1 },
          { id: "r2", kind: "icon", concept: "coin", caption: "TOTAL SUPPLY", side: "right", role: "normal", beat: 1, value: "21M" },
          { id: "r3", kind: "icon", concept: "diamond", caption: "SCARCITY", side: "right", role: "normal", beat: 1 },
        ],
        zones: [{ arrange: "comparison", nodes: ["l1", "l2", "l3", "r1", "r2", "r3"] }],
        edges: [],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const els = sb.scenes[0].beats.flatMap((b) => b.elements ?? []);
  const icons = els.filter((e) => e.type === "asset");
  assert.equal(icons.length, 6);
  for (const icon of icons) {
    assert.ok(!icon.label, "dense comparison icons use side captions");
  }
  const texts = els.filter((e) => e.type === "text");
  // Left-column captions sit LEFT of their icons; right-column captions RIGHT.
  const leftIcons = icons.filter((e) => e.x < 600 - 100);
  const rightIcons = icons.filter((e) => e.x > 600 - 100);
  assert.ok(leftIcons.length === 3 && rightIcons.length === 3);
  for (const icon of leftIcons) {
    assert.ok(texts.some((t) => Math.abs(t.y - (icon.y + (icon.height ?? 0) / 2)) < 60 && t.x < icon.x), "left captions point outward");
  }
  for (const icon of rightIcons) {
    assert.ok(texts.some((t) => Math.abs(t.y - (icon.y + (icon.height ?? 0) / 2)) < 60 && t.x > icon.x + (icon.width ?? 0)), "right captions point outward");
  }
});

test("comparison + timeline scene: bands never compress into overlap", () => {
  // Shape of the broken "DIGITAL SCARCITY" scene: a 2v2 badged comparison with
  // values stacked above a timeline. Bands must get their full required height
  // (overflowing the canvas if needed) so no icon lands on another's caption.
  const plan: SceneGraphPlan = {
    title: "Scarcity",
    durationSeconds: 60,
    scenes: [
      {
        title: "DIGITAL SCARCITY",
        beats: [
          { narration: "Banks print endless amounts." },
          { narration: "Bitcoin is capped at 21 million." },
          { narration: "Every 4 years the reward halves." },
        ],
        nodes: [
          { id: "l1", kind: "icon", concept: "bank", caption: "TRADITIONAL BANKS", side: "left", role: "normal", beat: 0 },
          { id: "l2", kind: "icon", concept: "money", caption: "ENDLESS AMOUNTS", side: "left", badge: "x", role: "normal", beat: 0 },
          { id: "r1", kind: "icon", concept: "lock", caption: "DIGITAL SCARCITY", side: "right", badge: "check", role: "normal", beat: 1 },
          { id: "r2", kind: "icon", concept: "coin", caption: "COIN CAP", side: "right", value: "21M", role: "normal", beat: 1 },
          { id: "t1", kind: "icon", concept: "chart", caption: "REDUCED CREATION", role: "normal", beat: 2 },
          { id: "t2", kind: "icon", concept: "gear", caption: "REWARD HALVED", value: "4 YEARS", role: "normal", beat: 2 },
          { id: "t3", kind: "icon", concept: "diamond", caption: "RARE BY DESIGN", role: "normal", beat: 2 },
        ],
        zones: [
          { arrange: "comparison", nodes: ["l1", "l2", "r1", "r2"] },
          { arrange: "timeline", nodes: ["t1", "t2", "t3"] },
        ],
        edges: [],
      },
    ],
  };
  const sb = composeSceneGraphPlan(plan);
  const els = sb.scenes[0].beats.flatMap((b) => b.elements ?? []);
  const icons = els.filter((e) => e.type === "asset");
  assert.equal(icons.length, 7);
  // 2v2 comparison uses side captions, so no below-labels in the comparison.
  const comparisonIcons = icons.filter((e) => ["bank", "money", "lock", "coin"].includes(e.assetKey ?? ""));
  for (const icon of comparisonIcons) {
    assert.ok(!icon.label, `comparison icon ${icon.assetKey} uses a side caption`);
  }
  // No asset box overlaps any other asset box (with a small badge margin).
  const boxes = icons.map((e) => ({ k: e.assetKey, x: e.x, y: e.y, w: e.width ?? 0, h: e.height ?? 0 }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      assert.ok(!overlap, `icons ${a.k} and ${b.k} must not overlap`);
    }
  }
  // No asset box overlaps any text (captions/values) of the scene.
  const texts = els.filter((e) => e.type === "text");
  for (const t of texts) {
    const fs = Math.max(24, t.fontSize ?? 24);
    const lines = (t.text ?? "").split("\n");
    const tw = Math.max(...lines.map((l) => l.length)) * fs * 0.6;
    const th = lines.length * fs * 1.2;
    const tb = { x: t.x - tw / 2, y: t.y - fs, w: tw, h: th };
    for (const b of boxes) {
      const overlap = !(b.x + b.w <= tb.x || tb.x + tb.w <= b.x || b.y + b.h <= tb.y || tb.y + tb.h <= b.y);
      assert.ok(!overlap, `icon ${b.k} must not sit on text "${t.text}"`);
    }
  }
});

test("sanitizer keeps badges and new arranges", () => {
  const raw = {
    title: "T",
    durationSeconds: 120,
    scenes: Array.from({ length: 3 }, () => ({
      title: "S",
      beats: [{ narration: "hi" }],
      nodes: [
        { id: "a", concept: "shield", caption: "A", badge: "no" },
        { id: "b", caption: "B", value: "35%" },
      ],
      zones: [{ arrange: "list", nodes: ["a", "b"] }],
    })),
  };
  const plan = sanitizeSceneGraphPlan(raw)!;
  assert.ok(plan, "plan sanitizes");
  assert.equal(plan.scenes[0].zones[0].arrange, "list");
  assert.equal(plan.scenes[0].nodes.find((n) => n.id === "a")!.badge, "no");
  composeSceneGraphPlan(plan);
});

test("harvestValue extracts salient figures from narration", () => {
  const cases: [string, string | undefined][] = [
    ["Your limit is $10,000 on this card.", "$10,000"],
    ["Scores run from 300 to 850.", "300-850"],
    ["Payment history is 35 percent of your score.", "35%"],
    ["It weighs about 35% of the total.", "35%"],
    ["Bitcoin is capped at 21 million coins.", "21M"],
    ["A late mark stays for 7 years.", "7 YEARS"],
    ["The winner seals the block in about 10 minutes.", "10 MIN"],
    ["That is a 10x improvement.", "10X"],
    ["Step one, open the app.", undefined],
    ["One tap buys a slice.", undefined],
    ["You catch a falling cup.", undefined],
  ];
  for (const [narration, expected] of cases) {
    assert.equal(harvestValue(narration), expected, `harvest "${narration}"`);
  }
});

test("sanitizer harvests narration numbers onto value-less beat nodes", () => {
  const raw = {
    title: "T",
    durationSeconds: 120,
    scenes: Array.from({ length: 3 }, () => ({
      title: "S",
      beats: [
        { narration: "Your credit limit might be $10,000." },
        { narration: "A late payment can cost about 100 points." },
        { narration: "The designer already set this one at 50%." },
      ],
      nodes: [
        { id: "a", concept: "creditCard", caption: "LIMIT", beat: 0 },
        { id: "b", concept: "calendar", caption: "LATE", beat: 1 },
        { id: "c", concept: "chart", caption: "SET", value: "50%", beat: 2 },
      ],
      zones: [{ arrange: "flow", nodes: ["a", "b", "c"] }],
    })),
  };
  const plan = sanitizeSceneGraphPlan(raw)!;
  assert.ok(plan, "plan sanitizes");
  const nodes = plan.scenes[0].nodes;
  assert.equal(nodes.find((n) => n.id === "a")!.value, "$10,000", "harvested currency");
  assert.equal(nodes.find((n) => n.id === "b")!.value, "100 POINTS", "harvested unit figure");
  assert.equal(nodes.find((n) => n.id === "c")!.value, "50%", "designer value untouched");
});

test("harvester never writes into pie zones or duplicate values", () => {
  const raw = {
    title: "T",
    durationSeconds: 120,
    scenes: Array.from({ length: 3 }, () => ({
      title: "S",
      beats: [{ narration: "Payment history is 35 percent." }, { narration: "Amounts owed is 35 percent." }],
      nodes: [
        { id: "p1", concept: "history", caption: "HISTORY", value: "35%", beat: 0 },
        { id: "p2", concept: "wallet", caption: "OWED", beat: 1 },
      ],
      zones: [{ arrange: "pie", nodes: ["p1", "p2"] }],
    })),
  };
  const plan = sanitizeSceneGraphPlan(raw)!;
  assert.ok(plan, "plan sanitizes");
  // p2 is a pie slice: the harvester must not inject a value (it would resize the slice).
  assert.equal(plan.scenes[0].nodes.find((n) => n.id === "p2")!.value, undefined);
});
