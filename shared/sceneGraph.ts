import { z } from "zod";
import { assetKeySchema } from "./assetCatalog";
import { scriptBeatId, validateStoryboard, type Beat, type Scene, type Storyboard, type VisualElement } from "./storyboard";

/**
 * Free-form scene-graph layout system (the Lamina-style alternative to fixed
 * templates).
 *
 * The director emits a GRAPH per scene: nodes (icons / big numbers / notes) with
 * a role, grouped into vertically-stacked ZONES that each pick an arrangement
 * primitive (row, flow, column, grid, radial, branch, ladder, hero), plus EDGES
 * (content-aware connectors) between any two nodes. A deterministic solver places
 * every node from the graph — not from fixed pixel slots — and routes connectors
 * from the nodes' actual positions. The output is a normal `Storyboard` whose
 * beats carry positioned `elements[]`, so the existing compile + render path
 * (scene-wide collision repair + fit-to-frame scaling) is reused unchanged.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const nodeKindSchema = z.enum(["icon", "value", "note"]);
export const nodeRoleSchema = z.enum(["hero", "normal"]);
export const zoneArrangeSchema = z.enum([
  "row",
  "flow",
  "column",
  "stack",
  "grid",
  "radial",
  "branch",
  "ladder",
  "hero",
  // Named canonical patterns (clean, polished presets the director can pick when a
  // scene maps to one of them; otherwise it composes freely with multiple zones).
  "comparison", // two sides split by a divider (use node.side)
  "fanout", // one source -> many targets
  "convergence", // many sources -> one target
  "loopback", // a linear sequence that cycles back to the start (arc over the top)
  "cycle", // nodes arranged in a RING with arrows flowing around it
  // Lamina-style content primitives.
  "list", // rows of small icon + side caption (feature/factor lists)
  "checklist", // list rows with green check badges (recaps, action plans)
  "cards", // a row of icon nodes, each boxed in a rounded card
  "bands", // colored spectrum rectangles + range captions + direction arrow
  "timeline", // points along a horizontal line (icon above, caption below)
  "annotate", // one hero object with leader-line text labels around it
  "pie", // composition pie: slices from node values ("35%") + leader labels
]);
export const edgeKindSchema = z.enum(["arrow", "line", "loop"]);

export const graphNodeSchema = z.object({
  id: z.string().min(1).max(24),
  kind: nodeKindSchema.default("icon"),
  // assetKey-style concept (what to draw). Optional for note/value-only nodes.
  concept: assetKeySchema.optional(),
  // Concrete imagery metaphor used purely to FIND the icon (never shown).
  imagery: z.string().max(40).optional(),
  // The visible caption under/next to the node.
  caption: z.string().max(28).optional(),
  // Big headline number for `value` nodes (e.g. "10X", "3.1B").
  value: z.string().max(24).optional(),
  // Render the icon as a grid of N copies to convey quantity.
  count: z.number().int().min(1).max(9).optional(),
  // Which side of a `comparison` zone this node belongs to.
  side: z.enum(["left", "right"]).optional(),
  // Judgment overlay drawn ON the icon: corner badge (check = good, x = bad,
  // star = best) or full-icon negation (no = red ring+slash, strike = red diagonal).
  badge: z.enum(["check", "x", "star", "no", "strike"]).optional(),
  role: nodeRoleSchema.default("normal"),
  // Which beat (narration sentence index) reveals this node.
  beat: z.number().int().min(0).max(7).default(0),
  // Optional phrase-level cue within that beat. Omit it to preserve automatic
  // reveal ordering based on composition order.
  cue: z.number().int().min(0).max(8).optional(),
});

export const graphZoneSchema = z.object({
  arrange: zoneArrangeSchema,
  // Node ids placed in this zone, in reveal/reading order. For `radial` the first
  // node is the centre; for `branch` the order is [action, decision, ...outcomes].
  nodes: z.array(z.string().min(1)).min(1).max(8),
});

export const graphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: edgeKindSchema.default("arrow"),
  label: z.string().max(16).optional(),
});

export const graphBeatSchema = z.object({
  narration: z.string().min(1).max(240),
  cues: z.array(z.string().min(1).max(80)).max(9).optional(),
});

export const graphSceneSchema = z.object({
  title: z.string().min(1).max(40),
  beats: z.array(graphBeatSchema).min(1).max(8),
  nodes: z.array(graphNodeSchema).min(1).max(14),
  zones: z.array(graphZoneSchema).min(1).max(4),
  edges: z.array(graphEdgeSchema).max(20).default([]),
});

export const sceneGraphPlanSchema = z.object({
  title: z.string().min(1).max(64),
  durationSeconds: z.number().int().min(40).max(210),
  scenes: z.array(graphSceneSchema).min(3).max(12),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphZone = z.infer<typeof graphZoneSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type GraphScene = z.infer<typeof graphSceneSchema>;
export type SceneGraphPlan = z.infer<typeof sceneGraphPlanSchema>;
export type ZoneArrange = z.infer<typeof zoneArrangeSchema>;

export type GraphSceneQualityIssue = {
  code: "too_sparse" | "relation_without_connector";
  message: string;
};

const CONNECTOR_ARRANGES = new Set<ZoneArrange>([
  "flow",
  "radial",
  "branch",
  "ladder",
  "fanout",
  "convergence",
  "loopback",
  "cycle",
  "bands",
  "timeline",
  "annotate",
]);

export function graphSceneQualityIssues(scene: GraphScene): GraphSceneQualityIssue[] {
  const issues: GraphSceneQualityIssue[] = [];
  const intentionallySparse = scene.zones.some(
    (zone) => zone.arrange === "hero" || zone.arrange === "annotate",
  );
  if (!intentionallySparse && scene.nodes.length < 3) {
    issues.push({
      code: "too_sparse",
      message: "Use at least three meaningful nodes, or choose a deliberate hero/annotate composition.",
    });
  }

  const relationWords =
    /\b(?:becomes?|blocks?|collides?|connects?|converts?|flows?|moves?|passes?|returns?|scatters?|sends?|splits?|turns? into)\b/i;
  const narration = scene.beats.map((beat) => beat.narration).join(" ");
  const hasConnectorStructure =
    scene.edges.length > 0 || scene.zones.some((zone) => CONNECTOR_ARRANGES.has(zone.arrange));
  if (scene.nodes.length >= 2 && relationWords.test(narration) && !hasConnectorStructure) {
    issues.push({
      code: "relation_without_connector",
      message: "Narration describes a relationship, so use a connector pattern or explicit edge.",
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Design canvas
// ---------------------------------------------------------------------------

const CENTER_X = 600;
// Wider usable band (was 200..1000): compositions can reach closer to the frame
// edges, so the fit-to-frame zoom renders everything larger (Lamina-scale).
const X_MIN = 140;
const X_MAX = 1060;
const Y_TOP = 185;
const Y_BOT = 650;
// Saturated flat fills matching the generated icon library's palette
// (shared/iconLibrary.ts ICON_PALETTE) so bands/pies/nodes and icons agree.
const PALETTE = ["#4da3ff", "#ffd43b", "#ff6b6b", "#51cf66", "#ffa94d", "#9775fa", "#66d9e8", "#f783ac"];
const CONNECTOR_CLEARANCE = 30;
const MIN_CONNECTOR_SPAN = 34;

type Pt = { x: number; y: number };
type Placed = { node: GraphNode; cx: number; cy: number; size: number; r: number; step: number; captionH: number };
type Band = { cy: number; height: number; top: number };
type Placement = { beatIndex: number; element: VisualElement };

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function upper(s: string, max = 28): string {
  return s.toUpperCase().slice(0, max);
}

// Wrap a multi-word caption onto two balanced lines (narrower, Lamina-style
// stacked labels) so adjacent captions don't run into each other.
function wrapCaption(caption: string): string {
  const up = caption.toUpperCase().trim().slice(0, 28);
  if (up.length <= 9 || !up.includes(" ")) return up;
  const words = up.split(/\s+/);
  let best = up;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

// Longest line length of a (possibly wrapped) caption — for spacing math.
function captionMaxChars(caption?: string): number {
  if (!caption) return 0;
  return Math.max(...wrapCaption(caption).split("\n").map((l) => l.length));
}

function iconSizeFor(node: GraphNode, base: number): number {
  if (node.role === "hero") return Math.round(base * 1.5);
  return base;
}

function captionTextWidth(caption: string, fontSize: number): number {
  const lines = caption.includes("\n") ? caption.split("\n") : wrapCaption(caption).split("\n");
  const maxLen = Math.max(...lines.map((line) => line.length));
  return maxLen * fontSize * 0.6 + 10;
}

// ---------------------------------------------------------------------------
// Element builders (same VisualElement model the renderer already understands)
// ---------------------------------------------------------------------------

function iconElement(id: string, node: GraphNode, cx: number, cy: number, size: number, withCaption: boolean, step: number, fillIdx: number, micro = 0): VisualElement {
  return {
    id,
    type: "asset",
    assetKey: node.concept ?? "generic",
    x: Math.round(cx - size / 2),
    y: Math.round(cy - size / 2),
    width: size,
    height: size,
    ...(withCaption && node.caption ? { label: wrapCaption(node.caption) } : {}),
    ...(node.imagery?.trim() ? { searchHint: node.imagery.trim().slice(0, 80) } : {}),
    ...(node.badge ? { badge: node.badge } : {}),
    fill: PALETTE[fillIdx % PALETTE.length],
    delay: micro,
    revealStep: step,
  };
}

function textElement(id: string, text: string, cx: number, cy: number, fontSize: number, step: number, micro = 0): VisualElement {
  return {
    id,
    type: "text",
    text: upper(text, 56),
    x: Math.round(cx),
    y: Math.round(cy),
    fontSize,
    delay: micro,
    revealStep: step,
  };
}

function lineElement(id: string, a: Pt, b: Pt, kind: "arrow" | "line", step: number, micro = 0, strokeWidth?: number): VisualElement {
  return {
    id,
    type: kind,
    x: Math.round(a.x),
    y: Math.round(a.y),
    x2: Math.round(b.x),
    y2: Math.round(b.y),
    ...(strokeWidth ? { strokeWidth } : {}),
    delay: micro,
    revealStep: step,
  };
}

function gridIconElements(idBase: string, node: GraphNode, cx: number, cy: number, footprint: number, step: number, fillIdx: number): VisualElement[] {
  const n = Math.min(Math.max(1, node.count ?? 1), 9);
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const cell = footprint / Math.max(cols, rows);
  const iconSize = Math.max(26, Math.round(cell * 0.82));
  const x0 = cx - (cols * cell) / 2 + cell / 2;
  const y0 = cy - (rows * cell) / 2 + cell / 2;
  const out: VisualElement[] = [];
  for (let i = 0; i < n; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push(iconElement(`${idBase}_g${i}`, node, x0 + col * cell, y0 + row * cell, iconSize, false, step, fillIdx, Math.min(0.45, i * 0.04)));
  }
  return out;
}

function diamondElements(idBase: string, cx: number, cy: number, hw: number, hh: number, step: number): VisualElement[] {
  const t: Pt = { x: cx, y: cy - hh };
  const r: Pt = { x: cx + hw, y: cy };
  const b: Pt = { x: cx, y: cy + hh };
  const l: Pt = { x: cx - hw, y: cy };
  return [
    lineElement(`${idBase}_t`, t, r, "line", step),
    lineElement(`${idBase}_r`, r, b, "line", step),
    lineElement(`${idBase}_b`, b, l, "line", step),
    lineElement(`${idBase}_l`, l, t, "line", step),
  ];
}

// ---------------------------------------------------------------------------
// Zone vertical allocation
// ---------------------------------------------------------------------------

// Vertical px a below-icon caption block occupies (up to 2 wrapped lines + gap).
const CAPTION_PX = 104;

// How much vertical space a zone ACTUALLY needs at a given icon size — icons +
// caption blocks + pattern extras (loop arcs, ring diameter, branch spread…).
// Band allocation distributes real needs, so a caption can never spill into the
// zone below, and a one-row flow is never starved by a tall neighbour.
function zoneRequiredPx(zone: GraphZone, size: number): number {
  const n = zone.nodes.length;
  switch (zone.arrange) {
    case "column":
    case "stack":
      return n * (size + 64) + 30;
    case "list":
    case "checklist": {
      const rows = n >= 6 ? Math.ceil(n / 2) : n;
      return rows * (Math.min(size, 112) + 26) + 30;
    }
    case "comparison":
      // 4+ nodes use compact side-caption rows; smaller comparisons caption below.
      return Math.max(1, Math.ceil(n / 2)) * (size + (n >= 4 ? 36 : CAPTION_PX)) + 10;
    case "grid": {
      const cols = n <= 3 ? n : n === 4 ? 2 : 3;
      return Math.ceil(n / cols) * (size + CAPTION_PX) + 10;
    }
    case "radial":
      return Math.round(size * 2.2 + 150);
    case "branch":
      return size + CAPTION_PX + 140;
    case "fanout":
    case "convergence":
      return Math.max(2, n - 1) * Math.round(size * 0.9 + 40) + CAPTION_PX;
    case "hero":
      return n === 1 ? Math.round(size * 1.25) + CAPTION_PX : Math.round(size * 2.3) + CAPTION_PX + 60;
    case "loopback":
      return size + CAPTION_PX + 88;
    case "cycle":
      return Math.round(size * 2.4 + CAPTION_PX);
    case "cards":
      return size + CAPTION_PX + 80;
    case "bands":
      return 330;
    case "timeline":
      return Math.max(300, size + 190);
    case "annotate":
      return 350;
    case "pie":
      return 480;
    case "row":
    case "flow":
    default:
      return size + CAPTION_PX + 16;
  }
}

function allocateBands(reqs: number[], available: number, gap: number): Band[] {
  const total = reqs.reduce((s, r) => s + r, 0) || 1;
  // Distribute any leftover proportionally (zones keep their relative needs).
  // A band is NEVER allocated less than its content requires — if the scene is
  // genuinely too tall, bands overflow the design canvas and the global
  // fit-to-frame transform scales the whole CLEAN layout down uniformly.
  // (Compressing bands below need is how icons end up on captions.)
  const factor = Math.max(1, available / total);
  const bands: Band[] = [];
  let cursor = Y_TOP;
  for (const req of reqs) {
    const h = req * factor;
    bands.push({ top: cursor, height: h, cy: cursor + h / 2 });
    cursor += h + gap;
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Arrangement primitives -> local node centres within a band
// ---------------------------------------------------------------------------

function spread(n: number, min: number, max: number): number[] {
  if (n <= 1) return [(min + max) / 2];
  const step = (max - min) / (n - 1);
  return Array.from({ length: n }, (_, i) => min + step * i);
}

// Horizontal positions that CLUSTER toward the centre when there are few nodes —
// so 2-3 big icons sit close together (short arrows, full board) instead of being
// stranded at the far edges with a giant arrow spanning the gap.
function adaptiveXs(n: number, ideal = 380): number[] {
  const half = Math.min((X_MAX - X_MIN) / 2, ((n - 1) * ideal) / 2);
  return spread(n, CENTER_X - half, CENTER_X + half);
}

function arrangeRow(nodes: GraphNode[], band: Band): Pt[] {
  // Space by the widest CAPTION (wrapped) so adjacent labels never run together.
  const maxCap = Math.max(0, ...nodes.map((nd) => captionMaxChars(nd.caption)));
  const ideal = Math.max(360, maxCap * 23 + 80);
  return adaptiveXs(nodes.length, ideal).map((x) => ({ x, y: band.cy }));
}

function arrangeColumn(nodes: GraphNode[], band: Band): Pt[] {
  const ys = spread(nodes.length, band.top + 60, band.top + band.height - 60);
  return ys.map((y) => ({ x: CENTER_X, y }));
}

function arrangeGrid(nodes: GraphNode[], band: Band): Pt[] {
  const n = nodes.length;
  const cols = n <= 3 ? n : n === 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const xs = spread(cols, X_MIN + 80, X_MAX - 80);
  const ys = rows > 1 ? spread(rows, band.top + 70, band.top + band.height - 70) : [band.cy];
  return nodes.map((_, i) => ({ x: xs[i % cols], y: ys[Math.floor(i / cols)] }));
}

function arrangeRadial(nodes: GraphNode[], band: Band): Pt[] {
  if (!nodes.length) return [];
  const cx = CENTER_X;
  const cy = band.cy;
  const spokes = nodes.length - 1;
  const R = Math.min(230, band.height / 2 - 24, 260);
  const pts: Pt[] = [{ x: cx, y: cy }];
  for (let i = 0; i < spokes; i += 1) {
    const a = (-90 + (360 / Math.max(1, spokes)) * i) * (Math.PI / 180);
    pts.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  }
  return pts;
}

function arrangeBranch(nodes: GraphNode[], band: Band): Pt[] {
  // [action, decision, positive, negative, ...extras]
  const pts: Pt[] = [];
  const actionX = X_MIN + 80;
  const decX = CENTER_X - 30;
  const outX = X_MAX - 90;
  const cy = band.cy;
  pts.push({ x: actionX, y: cy }); // action
  pts.push({ x: decX, y: cy }); // decision (diamond)
  const outcomes = nodes.slice(2);
  outcomes.forEach((_, i) => {
    const dir = i === 0 ? -1 : i === 1 ? 1 : 0;
    pts.push({ x: outX, y: cy + dir * Math.min(120, band.height / 2 - 40) });
  });
  return pts;
}

function arrangeLadder(nodes: GraphNode[], band: Band): Pt[] {
  const n = nodes.length;
  const xs = spread(n, X_MIN + 80, X_MAX - 90);
  // Ascend bottom-left -> top-right.
  const ys = n > 1 ? spread(n, band.top + band.height - 60, band.top + 60) : [band.cy];
  return nodes.map((_, i) => ({ x: xs[i], y: ys[i] }));
}

function arrangeHero(nodes: GraphNode[], band: Band): Pt[] {
  if (nodes.length === 1) return [{ x: CENTER_X, y: band.cy }];
  // Hero centred, the rest as a small row beneath.
  const pts: Pt[] = [{ x: CENTER_X, y: band.top + band.height * 0.38 }];
  const rest = nodes.slice(1);
  const xs = spread(rest.length, X_MIN + 90, X_MAX - 90);
  rest.forEach((_, i) => pts.push({ x: xs[i], y: band.top + band.height * 0.82 }));
  return pts;
}

// Two sides split by a centre divider. Nodes carry side:"left"|"right"; if a node
// has no side, fall back to first-half-left / second-half-right.
function arrangeComparison(nodes: GraphNode[], band: Band): Pt[] {
  const half = Math.ceil(nodes.length / 2);
  const leftIdx: number[] = [];
  const rightIdx: number[] = [];
  nodes.forEach((n, i) => {
    const side = n.side ?? (i < half ? "left" : "right");
    (side === "right" ? rightIdx : leftIdx).push(i);
  });
  const pts: Pt[] = new Array(nodes.length);
  const place = (idxs: number[], x: number) => {
    const ys = spread(idxs.length, band.top + 60, band.top + band.height - 60);
    idxs.forEach((ni, r) => (pts[ni] = { x, y: ys[r] }));
  };
  place(leftIdx, CENTER_X - 232);
  place(rightIdx, CENTER_X + 232);
  return pts;
}

// One source (node 0) on the left fanning out to many targets on the right.
function arrangeFanout(nodes: GraphNode[], band: Band): Pt[] {
  const pts: Pt[] = [{ x: X_MIN + 110, y: band.cy }];
  const targets = nodes.length - 1;
  const ys = spread(targets, band.top + 42, band.top + band.height - 42);
  for (let i = 1; i < nodes.length; i += 1) pts.push({ x: X_MAX - 110, y: ys[i - 1] });
  return pts;
}

// Many sources on the left converging into one target (the LAST node) on the right.
function arrangeConvergence(nodes: GraphNode[], band: Band): Pt[] {
  const sources = nodes.length - 1;
  const ys = spread(sources, band.top + 42, band.top + band.height - 42);
  const pts: Pt[] = [];
  for (let i = 0; i < sources; i += 1) pts.push({ x: X_MIN + 110, y: ys[i] });
  pts.push({ x: X_MAX - 110, y: band.cy }); // target
  return pts;
}

// A sequence that loops back to the start (the loop arc is drawn above the row).
function arrangeLoopback(nodes: GraphNode[], band: Band): Pt[] {
  return adaptiveXs(nodes.length, 360).map((x) => ({ x, y: band.cy + band.height * 0.16 }));
}

// Compact rows of small icon + side caption (the reference style for feature /
// factor lists). 6+ items split into two columns. The whole block is centred by
// the widest caption so it never hugs the left edge.
function arrangeList(nodes: GraphNode[], band: Band, iconSize: number): Pt[] {
  const n = nodes.length;
  const twoCol = n >= 6;
  const rows = twoCol ? Math.ceil(n / 2) : n;
  const maxCap = Math.max(6, ...nodes.map((nd) => captionMaxChars(nd.caption)));
  const blockW = iconSize + 18 + maxCap * 24 * 0.6 + 10;
  const colXs = twoCol
    ? [CENTER_X - blockW / 2 - 60, CENTER_X + blockW / 2 + 60].map((cx) => cx - blockW / 2 + iconSize / 2)
    : [CENTER_X - blockW / 2 + iconSize / 2];
  const pad = Math.min(38, band.height * 0.1);
  const ys = spread(rows, band.top + pad, band.top + band.height - pad);
  return nodes.map((_, i) => {
    const col = twoCol ? i % 2 : 0;
    const row = twoCol ? Math.floor(i / 2) : i;
    return { x: colXs[col], y: ys[row] };
  });
}

// Nodes evenly on a ring (a real cycle), arrows flow around it. A distinct loop
// visual from the linear loopback.
function arrangeCycle(nodes: GraphNode[], band: Band): Pt[] {
  const n = nodes.length;
  const cx = CENTER_X;
  const cy = band.cy;
  const R = Math.min(band.height / 2 - 30, 230);
  return nodes.map((_, i) => {
    const a = (-90 + (360 / n) * i) * (Math.PI / 180);
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });
}

function arrangeNodes(zone: GraphZone, nodes: GraphNode[], band: Band, iconSize = 150): Pt[] {
  // A lone node always sits dead-centre of its band (never stranded in a corner).
  if (nodes.length === 1) return [{ x: CENTER_X, y: band.cy }];

  switch (zone.arrange) {
    case "column":
    case "stack":
      return arrangeColumn(nodes, band);
    case "list":
    case "checklist":
      return arrangeList(nodes, band, iconSize);
    case "cards":
      return arrangeRow(nodes, band);
    case "grid":
      return arrangeGrid(nodes, band);
    case "radial":
      return nodes.length >= 3 ? arrangeRadial(nodes, band) : arrangeRow(nodes, band);
    case "branch":
      // A real branch needs action+decision+2 outcomes; otherwise lay out as a flow.
      return nodes.length >= 4 ? arrangeBranch(nodes, band) : arrangeRow(nodes, band);
    case "ladder":
      return arrangeLadder(nodes, band);
    case "hero":
      return arrangeHero(nodes, band);
    case "comparison":
      return arrangeComparison(nodes, band);
    case "fanout":
    case "convergence":
      // Need at least one source AND one target; else a plain row reads better.
      return nodes.length >= 2 ? (zone.arrange === "fanout" ? arrangeFanout(nodes, band) : arrangeConvergence(nodes, band)) : arrangeRow(nodes, band);
    case "loopback":
      return arrangeLoopback(nodes, band);
    case "cycle":
      return nodes.length >= 3 ? arrangeCycle(nodes, band) : arrangeLoopback(nodes, band);
    case "row":
    case "flow":
    default:
      return arrangeRow(nodes, band);
  }
}

// Whether a zone's auto-connectors should run (the arrange actually placed nodes
// in its canonical shape rather than degrading to a row).
function patternActive(zone: GraphZone): boolean {
  const n = zone.nodes.length;
  if (n <= 1) return false;
  switch (zone.arrange) {
    case "radial":
      return n >= 3;
    case "branch":
      return n >= 4;
    case "fanout":
    case "convergence":
      return n >= 2;
    case "cycle":
      return n >= 3;
    default:
      return true;
  }
}

function sideCaptionSide(zone: GraphZone, node: GraphNode, index: number, count: number): "left" | "right" | null {
  if (zone.arrange === "stack" || zone.arrange === "column") return "right";
  if (zone.arrange === "list" || zone.arrange === "checklist") return "right";
  if (zone.arrange === "convergence" && index < count - 1) return "left";
  if (zone.arrange === "fanout" && index > 0) return "right";
  // Dense comparison columns read as compact side-caption rows (captions point
  // OUTWARD, away from the divider) — below-captions would stack too tall.
  if (zone.arrange === "comparison" && count >= 4) {
    return node.side ?? (index < Math.ceil(count / 2) ? "left" : "right");
  }
  return null;
}

function sideCaptionElement(
  id: string,
  caption: string,
  pt: Pt,
  size: number,
  side: "left" | "right",
  step: number,
  // A value ("$10,000", "2X") renders as a BIGGER line under the side caption —
  // compact rows have no room for a below-icon number, but the number should
  // still pop like a headline figure.
  value?: string,
): VisualElement[] {
  const captionText = wrapCaption(caption);
  const fontSize = 24;
  const valueFontSize = 31;
  const width = Math.max(
    captionTextWidth(captionText, fontSize),
    value ? captionTextWidth(value, valueFontSize) : 0,
  );
  const gap = 18;
  const x =
    side === "left"
      ? pt.x - size / 2 - gap - width / 2
      : pt.x + size / 2 + gap + width / 2;
  // Centre the block (caption + value) on the icon so multi-line blocks extend
  // both ways instead of stacking down into the next row.
  const captionLines = captionText.split("\n").length;
  const totalLines = captionLines + (value ? 1.25 : 0);
  const y = pt.y + 8 - (totalLines - 1) * fontSize * 0.55;
  const out = [textElement(id, captionText, x, y, fontSize, step, 0.1)];
  if (value) {
    out.push(textElement(`${id}v`, value, x, y + captionLines * fontSize * 1.18 + 6, valueFontSize, step, 0.18));
  }
  return out;
}

// Big, Lamina-scale icons that fill the board (the fit transform keeps them
// roughly consistent across scenes).
function baseSizeFor(zone: GraphZone, count: number): number {
  switch (zone.arrange) {
    case "grid":
      return count > 4 ? 170 : 195;
    case "radial":
      return 155;
    case "branch":
      return 170;
    case "ladder":
      return 170;
    case "hero":
      return 280;
    case "stack":
    case "column":
      return 170;
    case "comparison":
      return count <= 4 ? 168 : count <= 6 ? 152 : 135;
    case "fanout":
    case "convergence":
      return 170;
    case "cycle":
      return 148;
    case "cards":
      return count <= 3 ? 178 : 152;
    case "row":
    case "flow":
    case "loopback":
    default:
      return count <= 2 ? 235 : count === 3 ? 205 : count === 4 ? 180 : 155;
  }
}

// Zones whose internal element sizes are intentionally different from normal
// icon zones (compact list rows, band rects, a pie, an annotated hero…). They
// neither contribute to nor inherit the scene-wide uniform icon size.
const SPECIAL_SIZING = new Set<ZoneArrange>(["list", "checklist", "bands", "timeline", "annotate", "pie"]);

// ---------------------------------------------------------------------------
// Connector routing (content-aware, from real node centres)
// ---------------------------------------------------------------------------

function connectorKey(from: Placed, to: Placed, kind: "arrow" | "line" | "loop"): string {
  return `${from.node.id}->${to.node.id}:${kind}`;
}

// A connector must appear with the LATER of its two endpoints — revealing it
// with `to` while `from` arrives in a later beat leaves an arrow dangling from
// empty board.
function laterEndpoint(from: Placed, to: Placed): { beat: number; step: number } {
  if (from.node.beat !== to.node.beat) {
    return from.node.beat > to.node.beat ? { beat: from.node.beat, step: from.step } : { beat: to.node.beat, step: to.step };
  }
  return { beat: to.node.beat, step: Math.max(from.step, to.step) };
}

function connect(idBase: string, from: Placed, to: Placed, kind: "arrow" | "line", label: string | undefined): Placement[] {
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  // Captions sit BELOW each node, so a line leaving downward (uy>0) or arriving
  // from below (uy<0) must clear that caption instead of piercing it.
  const fromGap = from.r + CONNECTOR_CLEARANCE + (uy > 0.35 ? from.captionH : 0);
  const toGap = to.r + CONNECTOR_CLEARANCE + (uy < -0.35 ? to.captionH : 0);
  const start: Pt = { x: from.cx + ux * fromGap, y: from.cy + uy * fromGap };
  const end: Pt = { x: to.cx - ux * toGap, y: to.cy - uy * toGap };
  // If the two nodes are so close there's no clear gap, a connector would just
  // overlap them — skip it rather than draw a stub through the icons.
  const span = (end.x - start.x) * ux + (end.y - start.y) * uy;
  if (span < MIN_CONNECTOR_SPAN) return [];
  const at = laterEndpoint(from, to);
  const out: Placement[] = [
    { beatIndex: at.beat, element: lineElement(idBase, start, end, kind, at.step, 0.16) },
  ];
  if (label) {
    out.push({
      beatIndex: at.beat,
      element: textElement(`${idBase}_l`, label, (start.x + end.x) / 2, (start.y + end.y) / 2 - 16, 20, at.step, 0.2),
    });
  }
  return out;
}

// A loop-back connector routed up and over the two nodes (e.g. a "REPEAT" cycle).
function loopConnect(idBase: string, from: Placed, to: Placed, label: string | undefined): Placement[] {
  const topY = Math.min(from.cy, to.cy) - Math.max(from.r, to.r) - 46;
  const a: Pt = { x: from.cx, y: from.cy - from.r - 6 };
  const b: Pt = { x: from.cx, y: topY };
  const c: Pt = { x: to.cx, y: topY };
  const d: Pt = { x: to.cx, y: to.cy - to.r - 6 };
  const at = laterEndpoint(from, to);
  const out: Placement[] = [
    { beatIndex: at.beat, element: lineElement(`${idBase}_a`, a, b, "line", at.step, 0.16) },
    { beatIndex: at.beat, element: lineElement(`${idBase}_b`, b, c, "line", at.step, 0.18) },
    { beatIndex: at.beat, element: lineElement(`${idBase}_c`, c, d, "arrow", at.step, 0.2) },
  ];
  if (label) {
    out.push({
      beatIndex: at.beat,
      element: textElement(`${idBase}_l`, label, (from.cx + to.cx) / 2, topY - 12, 20, at.step, 0.22),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text de-overlap (so labels/captions never stack into an unreadable blob)
// ---------------------------------------------------------------------------

function textBox(el: VisualElement): { x: number; y: number; w: number; h: number } {
  const fs = Math.max(24, el.fontSize ?? 24);
  const lines = (el.text ?? "").split("\n");
  const maxLen = Math.max(1, ...lines.map((l) => l.length));
  const w = maxLen * fs * 0.6 + 10;
  const h = lines.length * fs * 1.25;
  return { x: el.x - w / 2, y: el.y - h + fs * 0.2, w, h };
}

function boxesOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, pad = 4): boolean {
  return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
}

// Earlier text holds its place (captions are added before connector labels), and
// each later overlapping text is nudged away vertically — up if it sits in the top
// half of the board, down if in the bottom half — so nothing lands toward content.
function deoverlapText(placements: Placement[]): void {
  const mid = (Y_TOP + Y_BOT) / 2;
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  // Seed obstacles with ICONS and their captions. Asset labels are drawn inside
  // the asset element, so movable text labels would otherwise be blind to them.
  for (const p of placements) {
    const el = p.element;
    if ((el.type === "asset" || el.type === "logo") && el.width && el.height) {
      placed.push({ x: el.x - 8, y: el.y - 8, w: el.width + 16, h: el.height + 16 });
      if (el.label) {
        // Mirror of the renderer's richAssetLabelFontSize.
        const fs = Math.max(23, Math.min(30, Math.round(el.width * 0.15)));
        const lines = el.label.split("\n");
        const w = Math.max(...lines.map((l) => l.length)) * fs * 0.6 + 10;
        placed.push({ x: el.x + el.width / 2 - w / 2, y: el.y + el.height + 8, w, h: lines.length * fs * 1.2 });
      }
    }
  }
  for (const p of placements) {
    const el = p.element;
    if (el.type !== "text") continue;
    const origY = el.y;
    // Try the natural direction first (up in the top half, down below); if that
    // would strand the text far from what it labels, retry the other way; if
    // both displace too far, keep the original spot — a slight overlap reads
    // better than an orphaned label floating by the title.
    const MAX_SHIFT = 120;
    const directions: boolean[] = textBox(el).y < mid ? [true, false] : [false, true];
    let resolved = false;
    for (const up of directions) {
      el.y = origY;
      let box = textBox(el);
      let ok = true;
      for (let iter = 0; iter < 16; iter += 1) {
        const hit = placed.find((b) => boxesOverlap(box, b));
        if (!hit) break;
        const shift = up ? hit.y - 8 - (box.y + box.h) : hit.y + hit.h + 8 - box.y;
        el.y += shift;
        box = { ...box, y: box.y + shift };
        if (Math.abs(el.y - origY) > MAX_SHIFT) {
          ok = false;
          break;
        }
      }
      if (ok) {
        resolved = true;
        placed.push(box);
        break;
      }
    }
    if (!resolved) {
      el.y = origY;
      placed.push(textBox(el));
    }
  }
}

// ---------------------------------------------------------------------------
// Compose one scene graph into positioned elements
// ---------------------------------------------------------------------------

function composeGraphScene(scene: GraphScene, sceneIndex: number): Scene {
  const sid = sceneIndex + 1;
  const sceneTitle = cleanSceneTitle(scene.title) ?? scene.title;
  const nodeById = new Map(scene.nodes.map((n) => [n.id, n]));
  const beatCount = scene.beats.length;
  const clampBeat = (b: number) => clampInt(b, 0, beatCount - 1);

  const placedById = new Map<string, Placed>();
  const placements: Placement[] = [];
  const autoConnectorKeys = new Set<string>();

  // Per-beat running reveal-step counter (so nodes appear in narration order).
  const stepByBeat = new Map<number, number>();
  const nextStep = (beat: number): number => {
    const cur = stepByBeat.get(beat) ?? 0;
    stepByBeat.set(beat, cur + 1);
    return Math.min(cur, 7);
  };
  const stepForNode = (node: GraphNode, beat: number): number => {
    if (node.cue === undefined) return nextStep(beat);
    const step = clampInt(node.cue, 0, 8);
    stepByBeat.set(beat, Math.max(stepByBeat.get(beat) ?? 0, step + 1));
    return step;
  };

  let fillIdx = 0;

  // ONE consistent icon size for the whole scene (the smallest any zone needs),
  // so icons don't jump between tiny and huge within a scene. Heroes get a modest
  // bump; value/grid icons derive from this too. Special-content zones (lists,
  // bands, pie…) size their own elements and don't drag the shared size down.
  const sizingZones = scene.zones.filter((z) => !SPECIAL_SIZING.has(z.arrange));
  const baseSceneSize = sizingZones.length
    ? clampInt(Math.min(...sizingZones.map((z) => baseSizeFor(z, z.nodes.length))), 148, 215)
    : 176;

  // If the zones' true height needs exceed the canvas, shrink the shared icon
  // size by ONE uniform factor — every zone scales together (no single zone
  // collapsing into tiny icons next to full-size neighbours). No artificial
  // floor: a dense scene gets uniformly smaller icons, never overlap.
  const bandGap = scene.zones.length > 1 ? 34 : 0;
  const bandAvailable = Y_BOT - Y_TOP - bandGap * (scene.zones.length - 1);
  const baseReq = scene.zones.reduce((s, z) => s + zoneRequiredPx(z, baseSceneSize), 0) || 1;
  const shrink = Math.min(1, bandAvailable / baseReq);
  const sceneSize = clampInt(baseSceneSize * shrink, 64, 215);
  const bands = allocateBands(
    scene.zones.map((z) => zoneRequiredPx(z, sceneSize)),
    bandAvailable,
    bandGap,
  );
  const addAutoConnector = (
    idBase: string,
    from: Placed,
    to: Placed,
    kind: "arrow" | "line",
    label: string | undefined,
  ) => {
    autoConnectorKeys.add(connectorKey(from, to, kind));
    placements.push(...connect(idBase, from, to, kind, label));
  };
  const addAutoLoop = (idBase: string, from: Placed, to: Placed, label: string | undefined) => {
    autoConnectorKeys.add(connectorKey(from, to, "loop"));
    placements.push(...loopConnect(idBase, from, to, label));
  };

  // --- Special content zones (drawn entirely here, not via the icon path) ---

  // Colored spectrum bands + range captions + a direction arrow underneath
  // (score bands, severity levels, tiers).
  const BAND_RAMP = ["#e25b4a", "#ef8c3b", "#f2cf4a", "#8fce6f", "#5cb85c"];
  const composeBands = (zi: number, band: Band, nodes: GraphNode[]) => {
    const n = nodes.length;
    const gap = 22;
    const bandW = (X_MAX - X_MIN - gap * (n - 1)) / n;
    const bandH = clampInt(band.height * 0.34, 64, 108);
    const bandY = band.top + Math.min(26, band.height * 0.08);
    let lastPlaced: Placed | null = null;
    nodes.forEach((node, i) => {
      const beat = clampBeat(node.beat);
      const step = stepForNode(node, beat);
      const x = X_MIN + i * (bandW + gap);
      const cx = x + bandW / 2;
      const color = BAND_RAMP[n <= 1 ? 2 : Math.round((i * (BAND_RAMP.length - 1)) / (n - 1))];
      placements.push({
        beatIndex: beat,
        element: {
          id: `el_s${sid}_${node.id}`,
          type: "rect",
          x: Math.round(x),
          y: Math.round(bandY),
          width: Math.round(bandW),
          height: bandH,
          fill: color,
          strokeWidth: 5,
          delay: 0,
          revealStep: step,
        },
      });
      if (node.caption) {
        placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_c`, wrapCaption(node.caption), cx, bandY + bandH + 46, 27, step, 0.12) });
      }
      if (node.value) {
        const capLines = node.caption ? wrapCaption(node.caption).split("\n").length : 0;
        placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_v`, node.value, cx, bandY + bandH + 46 + capLines * 44, 31, step, 0.18) });
      }
      const placed: Placed = { node: { ...node, beat }, cx, cy: bandY + bandH / 2, size: bandH, r: bandH / 2, step, captionH: 96 };
      placedById.set(node.id, placed);
      lastPlaced = placed;
    });
    if (lastPlaced) {
      const lp = lastPlaced as Placed;
      const y = bandY + bandH + 132;
      placements.push({
        beatIndex: lp.node.beat,
        element: lineElement(`el_s${sid}_z${zi}_dir`, { x: X_MIN + 6, y }, { x: X_MAX - 6, y }, "arrow", lp.step, 0.3, 6),
      });
    }
  };

  // Points along a horizontal line: icon above, marker on the line, caption (and
  // value) below — oldest → newest, step N of M, eras.
  const composeTimeline = (zi: number, band: Band, nodes: GraphNode[]) => {
    const n = nodes.length;
    const lineY = band.top + band.height * 0.56;
    const xs = spread(n, X_MIN + 90, X_MAX - 90);
    const tIcon = clampInt(band.height * 0.34, 84, 122);
    const first = nodes[0];
    placements.push({
      beatIndex: clampBeat(first.beat),
      element: lineElement(`el_s${sid}_z${zi}_tl`, { x: X_MIN + 10, y: lineY }, { x: X_MAX - 10, y: lineY }, "line", 0, 0, 5),
    });
    nodes.forEach((node, i) => {
      const beat = clampBeat(node.beat);
      const step = stepForNode(node, beat);
      const myFill = fillIdx++;
      const cx = xs[i];
      const iconCy = lineY - 34 - tIcon / 2;
      if (node.concept) {
        placements.push({ beatIndex: beat, element: iconElement(`el_s${sid}_${node.id}`, node, cx, iconCy, tIcon, false, step, myFill) });
      }
      placements.push({
        beatIndex: beat,
        element: {
          id: `el_s${sid}_${node.id}_m`,
          type: "node",
          x: Math.round(cx - 13),
          y: Math.round(lineY - 13),
          width: 26,
          height: 26,
          fill: PALETTE[myFill % PALETTE.length],
          delay: 0.1,
          revealStep: step,
        },
      });
      if (node.caption) {
        placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_c`, wrapCaption(node.caption), cx, lineY + 52, 25, step, 0.14) });
      }
      if (node.value) {
        const capLines = node.caption ? wrapCaption(node.caption).split("\n").length : 0;
        placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_v`, node.value, cx, lineY + 52 + capLines * 28 + 12, 37, step, 0.2) });
      }
      placedById.set(node.id, { node: { ...node, beat }, cx, cy: iconCy, size: tIcon, r: tIcon / 2, step, captionH: 0 });
    });
  };

  // One hero object with leader-line text labels around it (product callouts,
  // labelled parts of a single thing). Node 0 = the hero; the rest are labels.
  const composeAnnotate = (zi: number, band: Band, nodes: GraphNode[]) => {
    const hero = nodes[0];
    const heroSize = clampInt(Math.min(band.height * 0.66, 360), 190, 360);
    const heroBeat = clampBeat(hero.beat);
    const heroStep = stepForNode(hero, heroBeat);
    const myFill = fillIdx++;
    placements.push({ beatIndex: heroBeat, element: iconElement(`el_s${sid}_${hero.id}`, hero, CENTER_X, band.cy, heroSize, true, heroStep, myFill) });
    const heroCapH = hero.caption ? 44 + wrapCaption(hero.caption).split("\n").length * 32 : 0;
    placedById.set(hero.id, { node: { ...hero, beat: heroBeat }, cx: CENTER_X, cy: band.cy, size: heroSize, r: heroSize / 2, step: heroStep, captionH: heroCapH });

    const labels = nodes.slice(1);
    const rightCount = Math.ceil(labels.length / 2);
    const leftCount = labels.length - rightCount;
    const yFor = (count: number) => spread(count, band.cy - band.height * 0.3, band.cy + band.height * 0.3);
    const rightYs = yFor(rightCount);
    const leftYs = yFor(leftCount);
    let ri = 0;
    let li = 0;
    labels.forEach((node) => {
      const beat = clampBeat(node.beat);
      const step = stepForNode(node, beat);
      const right = ri < rightCount && (li >= leftCount || (ri <= li));
      const y = right ? rightYs[ri++] : leftYs[li++];
      const dir = right ? 1 : -1;
      const text = wrapCaption(node.caption ?? node.id);
      const textW = captionTextWidth(text, 26);
      const labelX = CENTER_X + dir * (heroSize / 2 + 168 + textW / 2);
      placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}`, text, labelX, y, 26, step, 0.12) });
      const lineStart: Pt = { x: labelX - dir * (textW / 2 + 14), y: y - 8 };
      const lineEnd: Pt = { x: CENTER_X + dir * (heroSize / 2 + 14), y: y - 8 + (band.cy - y) * 0.22 };
      placements.push({ beatIndex: beat, element: lineElement(`el_s${sid}_${node.id}_l`, lineStart, lineEnd, "line", step, 0.18, 3.5) });
      placedById.set(node.id, { node: { ...node, beat }, cx: labelX, cy: y, size: 40, r: 20, step, captionH: 0 });
    });
  };

  // Composition pie: slice sizes from node values ("35%"), labels on leader lines
  // around the rim. Falls back to equal slices when values are missing.
  const composePie = (zi: number, band: Band, nodes: GraphNode[]) => {
    const r = clampInt(Math.min(band.height / 2 - 26, 215), 120, 215);
    const cx = CENTER_X;
    const cy = band.cy;
    const parsed = nodes.map((n) => {
      const v = Number.parseFloat((n.value ?? "").replace(/[^0-9.]/g, ""));
      return Number.isFinite(v) && v > 0 ? v : 0;
    });
    const total = parsed.reduce((s, v) => s + v, 0);
    const shares = total > 0 ? parsed.map((v) => (v > 0 ? v : total / Math.max(1, parsed.filter(Boolean).length) / 4)) : nodes.map(() => 1);
    const shareTotal = shares.reduce((s, v) => s + v, 0);
    let angle = 0;
    nodes.forEach((node, i) => {
      const beat = clampBeat(node.beat);
      const step = stepForNode(node, beat);
      const myFill = fillIdx++;
      const sweep = (shares[i] / shareTotal) * 360;
      const a1 = angle;
      const a2 = angle + sweep;
      angle = a2;
      placements.push({
        beatIndex: beat,
        element: {
          id: `el_s${sid}_${node.id}`,
          type: "pieSlice",
          x: Math.round(cx - r),
          y: Math.round(cy - r),
          width: r * 2,
          height: r * 2,
          a1: Math.round(a1 * 10) / 10,
          a2: Math.round(a2 * 10) / 10,
          fill: PALETTE[myFill % PALETTE.length],
          delay: 0,
          revealStep: step,
        },
      });
      const mid = ((a1 + a2) / 2 - 90) * (Math.PI / 180);
      const ux = Math.cos(mid);
      const uy = Math.sin(mid);
      const labelText = node.value && node.caption ? `${wrapCaption(node.caption)}\n${node.value}` : wrapCaption(node.caption ?? node.value ?? "");
      const labelDist = r + 86;
      placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_c`, labelText, cx + ux * labelDist, cy + uy * labelDist, 25, step, 0.16) });
      placements.push({
        beatIndex: beat,
        element: lineElement(`el_s${sid}_${node.id}_l`, { x: cx + ux * (r + 6), y: cy + uy * (r + 6) }, { x: cx + ux * (r + 44), y: cy + uy * (r + 44) }, "line", step, 0.2, 3.5),
      });
      placedById.set(node.id, { node: { ...node, beat }, cx: cx + ux * r * 0.6, cy: cy + uy * r * 0.6, size: r * 0.5, r: r * 0.25, step, captionH: 0 });
    });
  };

  scene.zones.forEach((zone, zi) => {
    const band = bands[zi];
    const nodes = zone.nodes.map((id) => nodeById.get(id)).filter((n): n is GraphNode => Boolean(n));
    if (!nodes.length) return;

    // Special content zones compose all their own elements.
    if (zone.arrange === "bands") return composeBands(zi, band, nodes);
    if (zone.arrange === "timeline") return composeTimeline(zi, band, nodes);
    if (zone.arrange === "annotate" && nodes.length >= 2) return composeAnnotate(zi, band, nodes);
    if (zone.arrange === "pie" && nodes.length >= 2) return composePie(zi, band, nodes);

    // Compact list rows use their own smaller icon size; everything else shares
    // the scene-wide size.
    const isList = zone.arrange === "list" || zone.arrange === "checklist";
    const listRows = nodes.length >= 6 ? Math.ceil(nodes.length / 2) : nodes.length;
    const zoneIconSize = isList ? clampInt(Math.round(band.height / listRows) - 22, 56, 112) : sceneSize;
    const pts = arrangeNodes(zone, nodes, band, zoneIconSize);

    nodes.forEach((node, i) => {
      const pt = pts[i] ?? { x: CENTER_X, y: band.cy };
      const beat = clampBeat(node.beat);
      const step = stepForNode(node, beat);
      const myFill = fillIdx++;
      // A lone hub node sharing the scene with other zones takes a SIDE caption:
      // a below-caption would eat its (short) band and shrink the icon.
      const captionSide = node.caption
        ? sideCaptionSide(zone, node, i, nodes.length) ??
          (scene.zones.length > 1 && nodes.length === 1 && node.kind === "icon" ? "right" : null)
        : null;

      if (zone.arrange === "branch" && i === 1) {
        // Decision node -> diamond with caption inside.
        const hw = 104;
        const hh = 80;
        const r = Math.max(hw, hh);
        placedById.set(node.id, { node: { ...node, beat }, cx: pt.x, cy: pt.y, size: r * 2, r, step, captionH: 0 });
        for (const line of diamondElements(`el_s${sid}_${node.id}`, pt.x, pt.y, hw, hh, step)) {
          placements.push({ beatIndex: beat, element: line });
        }
        if (node.caption) {
          placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_c`, node.caption, pt.x, pt.y + 7, node.caption.length > 8 ? 19 : 22, step, 0.12) });
        }
        return;
      }

      // Hero (oversized) icons only in a hero zone or a lone-node scene — never in
      // a multi-node flow/row, where a giant icon crowds and overlaps the arrows.
      // In a multi-zone scene the bump is modest: the hero must fit its band.
      const allowHero = zone.arrange === "hero" || nodes.length === 1;
      const heroBump = scene.zones.length === 1 ? 1.3 : 1.08;
      let size = allowHero && node.role === "hero" ? Math.round(zoneIconSize * heroBump) : zoneIconSize;
      // Cap by the horizontal spacing of line-type zones so icons + their gap (room
      // for an arrow) always fit without touching.
      const lineZone = zone.arrange === "row" || zone.arrange === "flow" || zone.arrange === "loopback" || zone.arrange === "ladder";
      if (lineZone && nodes.length > 1) {
        const spacing = (X_MAX - X_MIN) / (nodes.length - 1);
        size = Math.min(size, Math.max(84, spacing - 56));
      }
      // Band heights are allocated from real zone needs (zoneRequiredPx), so this
      // is only a degenerate-case guard, not a sizing mechanism.
      size = Math.min(size, Math.round(band.height + 8));
      const r = size / 2;
      // Vertical space a caption (and value) occupy BELOW the node, so connectors
      // can be routed clear of it. Captions may wrap to 2 lines, so reserve enough.
      const capLines = node.caption ? wrapCaption(node.caption).split("\n").length : 1;
      const valueH = node.kind === "icon" && node.value ? 68 : 0;
      // A count grid spreads beyond the nominal icon radius — its caption (and any
      // connector keep-out) starts below the grid footprint, not the icon box.
      const gridExtra = (node.count ?? 1) > 1 ? Math.round(size * 0.3) : 0;
      const captionH =
        node.kind === "value" ? 124 : node.kind === "note" ? 0 : (!captionSide && node.caption ? 44 + capLines * 32 : 0) + valueH + gridExtra;
      placedById.set(node.id, { node: { ...node, beat }, cx: pt.x, cy: pt.y, size, r, step, captionH });

      if (node.kind === "value") {
        // Icon (consistent scene size) on top, the big number, then the caption.
        // The number is the STAR (Lamina-scale headline figure).
        const vIcon = Math.round(size * 0.82);
        if (node.concept) {
          placements.push({ beatIndex: beat, element: iconElement(`el_s${sid}_${node.id}_i`, node, pt.x, pt.y - vIcon * 0.55, vIcon, false, step, myFill) });
        }
        if (node.value) {
          placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_v`, node.value, pt.x, pt.y + vIcon * 0.44, 58, step, 0.1) });
        }
        if (node.caption) {
          placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_c`, node.caption, pt.x, pt.y + vIcon * 0.44 + 58, 27, step, 0.16) });
        }
        return;
      }

      if (node.kind === "note") {
        // Notes are often equations ("3,000 / 10,000 = 30%") — draw them at
        // headline weight like the reference explainers, not caption size.
        placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}`, node.caption ?? "", pt.x, pt.y, 36, step) });
        return;
      }

      // icon node. A checklist row defaults to a literal check icon (no concept)
      // or a green check badge over its own icon (concept given).
      const effNode: GraphNode =
        zone.arrange === "checklist"
          ? { ...node, concept: node.concept ?? "check", badge: node.badge ?? (node.concept ? "check" : undefined) }
          : node;
      if ((node.count ?? 1) > 1) {
        for (const el of gridIconElements(`el_s${sid}_${node.id}`, effNode, pt.x, pt.y, size * 1.6, step, myFill)) {
          placements.push({ beatIndex: beat, element: el });
        }
        // Grid cells carry no label — draw the caption below the grid footprint
        // (it was silently dropped before).
        if (!captionSide && node.caption) {
          placements.push({
            beatIndex: beat,
            element: textElement(`el_s${sid}_${node.id}_c`, wrapCaption(node.caption), pt.x, pt.y + size * 0.8 + 40, 26, step, 0.16),
          });
        }
      } else {
        placements.push({ beatIndex: beat, element: iconElement(`el_s${sid}_${node.id}`, effNode, pt.x, pt.y, size, !captionSide, step, myFill) });
      }
      if (captionSide && node.caption) {
        for (const el of sideCaptionElement(`el_s${sid}_${node.id}_c`, node.caption, pt, size, captionSide, step, node.kind === "icon" ? node.value : undefined)) {
          placements.push({ beatIndex: beat, element: el });
        }
      }
      // A big number attached to an icon node ("LIMIT" + "$10,000") — drawn as a
      // bold value line under the caption. Side-caption rows carry the value as a
      // caption line instead (above), so only below-caption nodes emit it here.
      if (node.kind === "icon" && node.value && !captionSide) {
        const vy = pt.y + size / 2 + 14 + (node.caption ? capLines * 30 + 56 : 50);
        placements.push({ beatIndex: beat, element: textElement(`el_s${sid}_${node.id}_v`, node.value, pt.x, vy, 44, step, 0.22) });
      }
    });

    // Auto-connectors implied by the arrangement.
    const placedNodes = nodes.map((n) => placedById.get(n.id)).filter((p): p is Placed => Boolean(p));
    const active = patternActive(zone);
    if ((zone.arrange === "flow" || zone.arrange === "ladder") && placedNodes.length >= 2) {
      for (let i = 1; i < placedNodes.length; i += 1) {
        addAutoConnector(`el_s${sid}_z${zi}_a${i}`, placedNodes[i - 1], placedNodes[i], "arrow", undefined);
      }
    } else if (zone.arrange === "radial" && active) {
      const hub = placedNodes[0];
      for (let i = 1; i < placedNodes.length; i += 1) {
        addAutoConnector(`el_s${sid}_z${zi}_s${i}`, hub, placedNodes[i], "line", undefined);
      }
    } else if (zone.arrange === "branch" && active) {
      const [action, decision, ...outcomes] = placedNodes;
      addAutoConnector(`el_s${sid}_z${zi}_ad`, action, decision, "arrow", undefined);
      outcomes.forEach((o, i) => addAutoConnector(`el_s${sid}_z${zi}_o${i}`, decision, o, "arrow", o.node.caption && i < 2 ? (i === 0 ? "YES" : "NO") : undefined));
    } else if (zone.arrange === "comparison" && active) {
      // Centre divider line (no arrows) — spans the CONTENT's vertical extent, so
      // it never dangles into empty board below a short comparison, and appears
      // with the FIRST of its nodes (not at scene start, before any content).
      const top = Math.min(...placedNodes.map((p) => p.cy - p.size / 2)) - 22;
      const bottom = Math.max(...placedNodes.map((p) => p.cy + p.size / 2 + p.captionH)) + 6;
      const first = placedNodes.reduce((a, b) =>
        b.node.beat < a.node.beat || (b.node.beat === a.node.beat && b.step < a.step) ? b : a,
      );
      placements.push({
        beatIndex: first.node.beat,
        element: lineElement(`el_s${sid}_z${zi}_div`, { x: CENTER_X, y: Math.max(band.top, top) }, { x: CENTER_X, y: Math.min(band.top + band.height, bottom) }, "line", first.step, 0.05),
      });
    } else if (zone.arrange === "cards" && placedNodes.length) {
      // A rounded card border around each node — sized from the ACTUAL content
      // so nothing pokes over the border: value nodes stack their icon higher
      // than plain icon nodes, and a big value line ("2-5 DAYS") can be wider
      // than both the icon and the caption.
      for (const p of placedNodes) {
        const isValue = p.node.kind === "value";
        const vIcon = Math.round(p.size * 0.82);
        const capW = captionTextWidth(wrapCaption(p.node.caption ?? ""), isValue ? 27 : 25);
        const valueFs = isValue ? 58 : 44;
        const valueW = p.node.value ? p.node.value.length * valueFs * 0.62 + 20 : 0;
        // Vertical extent of what's actually drawn inside (see the value-node and
        // icon-node emitters above), plus breathing room.
        const top = isValue ? p.cy - vIcon * 0.55 - vIcon / 2 - 24 : p.cy - p.size / 2 - 26;
        const bottom = isValue
          ? p.cy + vIcon * 0.44 + (p.node.caption ? 58 + 40 : 30)
          : p.cy + p.size / 2 + p.captionH + 26;
        const cardW = Math.max(p.size + 64, capW + 40, valueW + 40);
        placements.push({
          beatIndex: p.node.beat,
          element: {
            id: `el_s${sid}_z${zi}_card_${p.node.id}`,
            type: "rect",
            x: Math.round(p.cx - cardW / 2),
            y: Math.round(top),
            width: Math.round(cardW),
            height: Math.round(bottom - top),
            strokeWidth: 4.6,
            delay: 0,
            revealStep: p.step,
          },
        });
      }
    } else if (zone.arrange === "fanout" && active) {
      const src = placedNodes[0];
      for (let i = 1; i < placedNodes.length; i += 1) {
        addAutoConnector(`el_s${sid}_z${zi}_f${i}`, src, placedNodes[i], "arrow", undefined);
      }
    } else if (zone.arrange === "convergence" && active) {
      const target = placedNodes[placedNodes.length - 1];
      for (let i = 0; i < placedNodes.length - 1; i += 1) {
        addAutoConnector(`el_s${sid}_z${zi}_c${i}`, placedNodes[i], target, "arrow", undefined);
      }
    } else if (zone.arrange === "loopback" && placedNodes.length >= 2) {
      for (let i = 1; i < placedNodes.length; i += 1) {
        addAutoConnector(`el_s${sid}_z${zi}_a${i}`, placedNodes[i - 1], placedNodes[i], "arrow", undefined);
      }
      const last = placedNodes[placedNodes.length - 1];
      const first = placedNodes[0];
      addAutoLoop(`el_s${sid}_z${zi}_loop`, last, first, "REPEAT");
    } else if (zone.arrange === "cycle" && active) {
      // Arrows flow around the ring: each node -> the next, closing the loop.
      for (let i = 0; i < placedNodes.length; i += 1) {
        const a = placedNodes[i];
        const b = placedNodes[(i + 1) % placedNodes.length];
        addAutoConnector(`el_s${sid}_z${zi}_cy${i}`, a, b, "arrow", undefined);
      }
    }
  });

  // Explicit edges (hub links, cross-zone, loops, branches the director declared).
  // A `loopback` zone already draws its own loop arc, so drop redundant explicit
  // loop edges — that double-label collision is what garbled the loop caption.
  const hasLoopbackZone = scene.zones.some((z) => z.arrange === "loopback");
  const hasComparisonZone = scene.zones.some((z) => z.arrange === "comparison");
  scene.edges.forEach((edge, ei) => {
    if (edge.kind === "loop" && hasLoopbackZone) return;
    const from = placedById.get(edge.from);
    const to = placedById.get(edge.to);
    if (!from || !to) return;
    // In a comparison scene, an arrow crossing the centre divider (one node on
    // each side) reads as a mistake and collides with the divider — drop it.
    if (hasComparisonZone && Math.sign(from.cx - CENTER_X) !== Math.sign(to.cx - CENTER_X)) return;
    const explicitKind = edge.kind === "line" || edge.kind === "loop" ? edge.kind : "arrow";
    if (autoConnectorKeys.has(connectorKey(from, to, explicitKind))) return;
    const idBase = `el_s${sid}_e${ei}`;
    if (edge.kind === "loop") {
      placements.push(...loopConnect(idBase, from, to, edge.label));
    } else {
      placements.push(...connect(idBase, from, to, edge.kind, edge.label));
    }
  });

  // Final safety net: nudge any overlapping TEXT apart so captions and connector
  // labels can never stack into an unreadable blob (the renderer's collision
  // repair only moves icons, not text).
  deoverlapText(placements);

  // Group elements by beat.
  const elementsByBeat: VisualElement[][] = scene.beats.map(() => []);
  for (const p of placements) {
    const bucket = elementsByBeat[clampBeat(p.beatIndex)] ?? elementsByBeat[0];
    bucket.push(p.element);
  }

  const repIcon = scene.nodes.find((n) => n.concept)?.concept ?? "generic";
  const beats: Beat[] = scene.beats.map((beat, beatIndex) => ({
    id: scriptBeatId(sceneIndex, beatIndex),
    narration: beat.narration,
    revealCues: beat.cues,
    visual: {
      type: "asset",
      assetKey: repIcon,
      label: sceneTitle.toUpperCase().slice(0, 32),
      shape: "square",
      position: "center",
      fill: "#a7c7ff",
    },
    elements: elementsByBeat[beatIndex],
  }));

  return {
    id: `scene_${sid}`,
    title: sceneTitle.toUpperCase().slice(0, 48),
    composition: "flow",
    beats,
  };
}

export function composeSceneGraphPlan(plan: SceneGraphPlan): Storyboard {
  return validateStoryboard({
    title: plan.title.slice(0, 64),
    durationSeconds: plan.durationSeconds,
    scenes: plan.scenes.map((scene, index) => composeGraphScene(scene, index)),
  });
}

// ---------------------------------------------------------------------------
// Sanitiser — coerce arbitrary director JSON into a valid SceneGraphPlan.
// ---------------------------------------------------------------------------

const ARRANGES: ZoneArrange[] = [
  "row", "flow", "column", "stack", "grid", "radial", "branch", "ladder", "hero",
  "comparison", "fanout", "convergence", "loopback", "cycle",
  "list", "checklist", "cards", "bands", "timeline", "annotate", "pie",
];

const BADGES = new Set(["check", "x", "star", "no", "strike"]);

function str(v: unknown, max: number): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : undefined;
}

function cleanSceneTitle(value: unknown): string | undefined {
  const title = str(value, 40);
  if (!title) return undefined;
  const cleaned = title
    .replace(/^(?:(?:scene|step)\s+)?\d{1,2}\s*(?:[.)]|[-:])\s*/i, "")
    .trim();
  return cleaned || title;
}

function cleanId(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.replace(/[^a-zA-Z0-9_-]/g, "") : "";
  return s ? s.slice(0, 24) : undefined;
}

function cleanConcept(v: unknown): string | undefined {
  const raw = typeof v === "string" ? v.replace(/[^a-zA-Z0-9_-]/g, "").replace(/^[^a-zA-Z]+/, "") : "";
  return raw.length >= 2 ? raw.slice(0, 64) : undefined;
}

function sanitizeNode(raw: any): GraphNode | null {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanId(raw.id);
  if (!id) return null;
  const kind = raw.kind === "value" || raw.kind === "note" ? raw.kind : "icon";
  const node: GraphNode = {
    id,
    kind,
    role: raw.role === "hero" ? "hero" : "normal",
    beat: clampInt(Number(raw.beat) || 0, 0, 7),
  };
  if (typeof raw.cue === "number" && Number.isFinite(raw.cue)) node.cue = clampInt(raw.cue, 0, 8);
  const concept = cleanConcept(raw.concept);
  if (concept) node.concept = concept;
  const imagery = str(raw.imagery, 40);
  if (imagery) node.imagery = imagery;
  const caption = str(raw.caption, 28);
  if (caption) node.caption = caption;
  const value = str(raw.value, 24);
  if (value) node.value = value;
  if (typeof raw.count === "number" && Number.isFinite(raw.count)) node.count = clampInt(raw.count, 1, 9);
  if (raw.side === "left" || raw.side === "right") node.side = raw.side;
  if (typeof raw.badge === "string" && BADGES.has(raw.badge)) node.badge = raw.badge as GraphNode["badge"];
  // A note needs a caption (it is text-only); an icon needs a concept.
  if (kind === "note" && !node.caption) return null;
  if (kind === "icon" && !node.concept && !node.caption) return null;
  return node;
}

function sanitizeZone(raw: any, validIds: Set<string>): GraphZone | null {
  if (!raw || typeof raw !== "object") return null;
  const arrange: ZoneArrange = ARRANGES.includes(raw.arrange) ? raw.arrange : "row";
  const ids = Array.isArray(raw.nodes)
    ? raw.nodes.map(cleanId).filter((id: string | undefined): id is string => Boolean(id) && validIds.has(id!)).slice(0, 8)
    : [];
  if (!ids.length) return null;
  return { arrange, nodes: ids };
}

function sanitizeEdge(raw: any, validIds: Set<string>): GraphEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const from = cleanId(raw.from);
  const to = cleanId(raw.to);
  if (!from || !to || from === to || !validIds.has(from) || !validIds.has(to)) return null;
  const kind = raw.kind === "line" || raw.kind === "loop" ? raw.kind : "arrow";
  const edge: GraphEdge = { from, to, kind };
  const label = str(raw.label, 16);
  if (label) edge.label = label;
  return edge;
}

export function sanitizeGraphScene(raw: any): GraphScene | null {
  if (!raw || typeof raw !== "object") return null;
  const title = cleanSceneTitle(raw.title);
  if (!title) return null;

  const beats = Array.isArray(raw.beats)
    ? raw.beats
        .map((b: any) => {
          const narration = str(b?.narration ?? b, 240);
          if (!narration) return null;
          const lower = narration.toLowerCase();
          const cues = Array.isArray(b?.cues)
            ? [...new Set<string>(
                b.cues
                  .map((cue: unknown) => str(cue, 80))
                  .filter((cue: string | undefined): cue is string => Boolean(cue))
                  .filter((cue: string) => lower.includes(cue.toLowerCase())),
              )].slice(0, 9)
            : undefined;
          return { narration, cues: cues?.length ? cues : undefined };
        })
        .filter((beat: GraphScene["beats"][number] | null): beat is GraphScene["beats"][number] => beat !== null)
        .slice(0, 8)
    : [];
  if (beats.length < 1) return null;

  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map(sanitizeNode).filter((n: GraphNode | null): n is GraphNode => n !== null)
    : [];
  // De-duplicate node ids and clamp beats into range.
  const seen = new Set<string>();
  const uniqueNodes: GraphNode[] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    uniqueNodes.push({ ...n, beat: clampInt(n.beat, 0, beats.length - 1) });
  }
  if (uniqueNodes.length < 1) return null;
  const trimmedNodes = uniqueNodes.slice(0, 12);
  const trimmedIds = new Set(trimmedNodes.map((n) => n.id));

  let zones: GraphZone[] = Array.isArray(raw.zones)
    ? raw.zones.map((z: any) => sanitizeZone(z, trimmedIds)).filter((z: GraphZone | null): z is GraphZone => z !== null).slice(0, 3)
    : [];
  // A node can be positioned only once. Preserve its first declared zone when
  // model output repeats it, otherwise composition emits duplicate element ids.
  const assigned = new Set<string>();
  zones = zones
    .map((zone) => ({
      ...zone,
      nodes: zone.nodes.filter((id) => {
        if (assigned.has(id)) return false;
        assigned.add(id);
        return true;
      }),
    }))
    .filter((zone) => zone.nodes.length > 0);
  // Any node not referenced by a zone goes into a trailing fallback row so it is
  // never dropped silently.
  const referenced = new Set(zones.flatMap((z: GraphZone) => z.nodes));
  const orphans = trimmedNodes.filter((n) => !referenced.has(n.id)).map((n) => n.id);
  if (!zones.length && orphans.length) {
    zones = [{ arrange: orphans.length > 4 ? "grid" : "row", nodes: orphans.slice(0, 8) }];
  } else if (orphans.length) {
    zones.push({ arrange: orphans.length > 4 ? "grid" : "row", nodes: orphans.slice(0, 8) });
  }
  if (!zones.length) return null;

  const edges = Array.isArray(raw.edges)
    ? raw.edges.map((e: any) => sanitizeEdge(e, trimmedIds)).filter((e: GraphEdge | null): e is GraphEdge => e !== null).slice(0, 4)
    : [];

  harvestNarrationNumbers(beats, trimmedNodes, zones);

  return { title, beats, nodes: trimmedNodes, zones, edges: edges.length ? edges : [] };
}

// ---------------------------------------------------------------------------
// Number harvesting — "numbers are stars", enforced by construction
// ---------------------------------------------------------------------------

// Salient number phrases worth drawing as a big on-screen value, most specific
// first: currency, percentages, ranges, multipliers, figures with a unit, then
// large plain/scale numbers. Bare small integers ("step 2", "one tap") are NOT
// worth a headline value, so they never match.
const NUMBER_PATTERNS: RegExp[] = [
  /[$€£₹]\s?\d[\d,.]*\s?(?:k|m|bn?|million|billion|trillion)?\b/i, // $10,000 / $1.5m
  /\b\d[\d,.]*\s?(?:%|percent)/i, // 35% / 35 percent
  /\b\d[\d,]*\s?(?:-|–|—|to)\s?\d[\d,]*\b/, // 300-850 / 580 to 669
  /\b\d+(?:\.\d+)?x\b/i, // 10x
  /\b\d[\d,.]*\s?(?:years?|days?|months?|weeks?|hours?|minutes?|seconds?|points?|coins?|steps?|times)\b/i,
  /\b\d[\d,.]*\s?(?:k|m|bn?|million|billion|trillion)\b/i, // 21 million
  /\b\d{1,3}(?:,\d{3})+\b|\b\d{3,}\b/, // 21,000,000 / 2280
];

/** Extract the most salient drawable figure from a narration line, if any. */
export function harvestValue(narration: string): string | undefined {
  for (const pattern of NUMBER_PATTERNS) {
    const match = narration.match(pattern);
    if (!match) continue;
    let v = match[0].trim().toUpperCase();
    v = v.replace(/\s?(?:TO|–|—)\s?/g, "-").replace(/\s+/g, " ");
    v = v.replace(/\bPERCENT\b/, "%").replace(/(\d)\s%/, "$1%");
    v = v.replace(/\bMILLION\b/, "M").replace(/\bBILLION\b/, "B").replace(/\bTRILLION\b/, "T");
    v = v.replace(/\bMINUTES?\b/, "MIN").replace(/\bSECONDS?\b/, "SEC").replace(/\bHOURS?\b/, "HRS");
    v = v.replace(/(\d) (M|B|T|K)\b/, "$1$2");
    return v.slice(0, 24);
  }
  return undefined;
}

// If a beat's narration carries a concrete figure but the designer left every
// node of that beat without a value, harvest the figure onto the beat's first
// icon node so it is drawn as a big on-screen number. Pie-zone nodes are
// excluded (their values drive slice sizes, not headlines).
function harvestNarrationNumbers(
  beats: { narration: string }[],
  nodes: GraphNode[],
  zones: GraphZone[],
): void {
  const pieNodeIds = new Set(zones.filter((z) => z.arrange === "pie").flatMap((z) => z.nodes));
  const existingValues = new Set(nodes.map((n) => n.value).filter(Boolean));
  beats.forEach((b, i) => {
    const beatNodes = nodes.filter((n) => n.beat === i && !pieNodeIds.has(n.id));
    if (!beatNodes.length || beatNodes.some((n) => n.value)) return;
    const target = beatNodes.find((n) => n.kind === "icon") ?? beatNodes.find((n) => n.kind === "value");
    if (!target) return;
    const value = harvestValue(b.narration);
    if (!value || existingValues.has(value)) return;
    target.value = value;
    existingValues.add(value);
  });
}

/** Coerce arbitrary director JSON into a valid SceneGraphPlan, or null if unusable. */
export function sanitizeSceneGraphPlan(raw: unknown): SceneGraphPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;
  const title = str(r.title, 64) ?? "Explainer";
  const durationSeconds = clampInt(Number(r.durationSeconds) || 130, 40, 210);
  const scenes = Array.isArray(r.scenes)
    ? r.scenes.map(sanitizeGraphScene).filter((s: GraphScene | null): s is GraphScene => s !== null)
    : [];
  if (scenes.length < 3) return null;
  return { title, durationSeconds, scenes: scenes.slice(0, 10) };
}
