import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetKeys, type AssetKey } from "./assetCatalog";
import { cachedMatches, normalizeQuery } from "./openMojiEmbeddings";
import { cachedLibraryMatches } from "./iconLibraryEmbeddings";
import { findLibraryIcon } from "./iconLibrary";
import { cachedChoice } from "./iconChoice";
import { cachedRerank } from "./iconRerankCache";
import { isQaDenied } from "./iconQaDenylist";

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OpenMojiManifestEntry = {
  assetKey: AssetKey;
  iconRef: string;
  svgPath: string;
  colorSvgPath?: string;
  label?: string;
  openMojiLabel?: string;
  concepts?: string[];
};

type OpenMojiManifest = {
  provider?: string;
  style?: string;
  registryTotal?: number;
  entries: OpenMojiManifestEntry[];
};

type ParsedSvg = {
  viewBox: string;
  body: string;
};

type OpenMojiSearchIndexEntry = {
  id: string;
  hexcode: string;
  label: string;
  concepts: string[];
  group: string;
  subgroup: string;
  colorSvgPath: string;
};

type OpenMojiSearchIndex = {
  entries: OpenMojiSearchIndexEntry[];
};

type ResolvedOpenMojiAsset = {
  id: string;
  iconRef: string;
  svgPath: string;
  label?: string;
  concepts?: string[];
  strategy: "curated" | "semantic";
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "assets", "vendor", "openmoji", "manifest.json");
const searchIndexPath = path.join(root, "assets", "vendor", "openmoji", "search-index.json");

let manifestCache: Map<AssetKey, OpenMojiManifestEntry> | null | undefined;
let searchIndexCache: OpenMojiSearchIndexEntry[] | undefined;
const svgCache = new Map<string, ParsedSvg>();

function missingLibraryMessage(): string {
  return `OpenMoji asset manifest is missing at ${manifestPath}. Run npm run assets:openmoji first.`;
}

function manifestEntryPath(entry: OpenMojiManifestEntry): string {
  return entry.colorSvgPath ?? entry.svgPath;
}

function validateManifest(manifest: OpenMojiManifest): Map<AssetKey, OpenMojiManifestEntry> {
  if (manifest.provider !== "local-openmoji") {
    throw new Error(`OpenMoji manifest must be generated from the local repo. Run npm run assets:openmoji.`);
  }
  if (manifest.style !== "color") {
    throw new Error(`OpenMoji manifest must be color-only. Run npm run assets:openmoji.`);
  }

  const byKey = new Map(manifest.entries.map((entry) => [entry.assetKey, entry]));
  const missing = assetKeys.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    throw new Error(`OpenMoji manifest is missing asset keys: ${missing.join(", ")}`);
  }

  const missingFiles = assetKeys.filter((key) => {
    const entry = byKey.get(key);
    return !entry || !existsSync(path.join(root, manifestEntryPath(entry)));
  });
  if (missingFiles.length > 0) {
    throw new Error(`OpenMoji SVG files are missing for asset keys: ${missingFiles.join(", ")}`);
  }

  return byKey;
}

function loadManifest(): Map<AssetKey, OpenMojiManifestEntry> | null {
  if (manifestCache !== undefined) return manifestCache;
  if (!existsSync(manifestPath)) {
    throw new Error(missingLibraryMessage());
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OpenMojiManifest;
  manifestCache = validateManifest(manifest);
  return manifestCache;
}

function loadSearchIndex(): OpenMojiSearchIndexEntry[] {
  if (searchIndexCache !== undefined) return searchIndexCache;
  if (!existsSync(searchIndexPath)) {
    throw new Error(`OpenMoji search index is missing at ${searchIndexPath}. Run npm run assets:openmoji first.`);
  }

  const index = JSON.parse(readFileSync(searchIndexPath, "utf8")) as OpenMojiSearchIndex;
  searchIndexCache = index.entries;
  return searchIndexCache;
}

function parseSvg(svg: string): ParsedSvg | null {
  const viewBox = svg.match(/\sviewBox="([^"]+)"/)?.[1] ?? "0 0 72 72";
  const body = svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<svg\b[^>]*>/i, "")
    .replace(/<\/svg>\s*$/i, "")
    .trim();

  if (!body) return null;
  return { viewBox, body };
}

function loadSvg(entry: ResolvedOpenMojiAsset): ParsedSvg | null {
  if (svgCache.has(entry.id)) {
    return svgCache.get(entry.id) ?? null;
  }

  const filePath = path.join(root, entry.svgPath);
  if (!existsSync(filePath)) {
    throw new Error(`OpenMoji SVG file is missing for "${entry.iconRef}": ${filePath}`);
  }

  const parsed = parseSvg(readFileSync(filePath, "utf8"));
  if (!parsed) {
    throw new Error(`OpenMoji SVG file is empty or invalid for "${entry.iconRef}": ${filePath}`);
  }
  svgCache.set(entry.id, parsed);
  return parsed;
}

function normalize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function conceptTokens(key: string, label?: string): string[] {
  return [...new Set([key, label ?? ""].flatMap((value) => normalize(value).split(/\s+/)).filter((token) => token.length > 2))];
}

// Map abstract explainer concepts onto concrete OpenMoji label keywords so that
// words no emoji is literally named after ("subconscious", "dopamine", "growth")
// still resolve to a sensible, distinct icon instead of a generic placeholder.
// Targets are verified substrings of real OpenMoji labels.
const CONCEPT_SYNONYMS: Record<string, string[]> = {
  idea: ["light bulb"], insight: ["light bulb"], concept: ["light bulb"], innovation: ["light bulb"], inspiration: ["light bulb"],
  mind: ["brain"], cognitive: ["brain"], mental: ["brain"], subconscious: ["brain"], conscious: ["brain"], psychology: ["brain"], think: ["brain"], thought: ["brain"], intelligence: ["brain"], cognition: ["brain"],
  process: ["gear"], engine: ["gear"], mechanism: ["gear"], automation: ["gear"], operation: ["gear"], machinery: ["gear"], settings: ["gear"],
  growth: ["chart increasing", "seedling"], increase: ["chart increasing"], rise: ["chart increasing"], improve: ["chart increasing"], scaling: ["chart increasing"], progress: ["chart increasing"], gain: ["chart increasing"],
  decline: ["chart decreasing"], decrease: ["chart decreasing"], loss: ["chart decreasing"], drop: ["chart decreasing"], downturn: ["chart decreasing"],
  reward: ["trophy", "sparkles"], win: ["trophy"], success: ["trophy"], achievement: ["trophy"], prize: ["trophy"], dopamine: ["sparkles"], motivation: ["trophy"], reinforcement: ["trophy"],
  loop: ["counterclockwise arrows"], cycle: ["counterclockwise arrows"], repeat: ["counterclockwise arrows"], habit: ["counterclockwise arrows"], routine: ["counterclockwise arrows"], iteration: ["counterclockwise arrows"], recurring: ["counterclockwise arrows"], feedback: ["counterclockwise arrows"],
  decision: ["balance scale"], decide: ["balance scale"], choice: ["balance scale"], judgment: ["balance scale"], tradeoff: ["balance scale"], balance: ["balance scale"], fairness: ["balance scale"], weigh: ["balance scale"],
  goal: ["bullseye"], target: ["bullseye"], objective: ["bullseye"], aim: ["bullseye"], focus: ["bullseye"], precision: ["bullseye"],
  danger: ["warning"], threat: ["warning"], problem: ["warning"], alert: ["warning"], caution: ["warning"], hazard: ["warning"], risk: ["warning"],
  time: ["hourglass", "alarm clock"], delay: ["hourglass"], deadline: ["alarm clock"], duration: ["hourglass"], aging: ["hourglass"], wait: ["hourglass"], urgency: ["alarm clock"],
  money: ["money bag"], cash: ["money bag"], funding: ["money bag"], capital: ["money bag"], cost: ["money bag"], revenue: ["money bag"], finance: ["money bag"], budget: ["money bag"], investment: ["money bag"], profit: ["money bag"],
  agreement: ["handshake"], partnership: ["handshake"], deal: ["handshake"], collaboration: ["handshake"], trust: ["handshake"], alliance: ["handshake"], cooperation: ["handshake"],
  search: ["magnifying glass"], analysis: ["magnifying glass"], inspect: ["magnifying glass"], research: ["magnifying glass"], discover: ["magnifying glass"], explore: ["magnifying glass"], investigate: ["magnifying glass"],
  protect: ["shield"], security: ["shield"], defense: ["shield"], safety: ["shield"], guard: ["shield"], secure: ["shield"],
  launch: ["rocket"], startup: ["rocket"], ship: ["rocket"], accelerate: ["rocket"], boost: ["rocket"],
  energy: ["high voltage"], power: ["high voltage"], signal: ["high voltage"], stimulus: ["high voltage"], trigger: ["high voltage"], electric: ["high voltage"], spark: ["high voltage"], impulse: ["high voltage"],
  communication: ["speech balloon"], message: ["speech balloon"], conversation: ["speech balloon"], discuss: ["speech balloon"], dialogue: ["speech balloon"], voice: ["speech balloon"],
  announce: ["megaphone"], broadcast: ["megaphone"], marketing: ["megaphone"], promote: ["megaphone"], advertise: ["megaphone"],
  people: ["busts in silhouette"], team: ["busts in silhouette"], group: ["busts in silhouette"], community: ["busts in silhouette"], social: ["busts in silhouette"], crowd: ["busts in silhouette"], audience: ["busts in silhouette"], collective: ["busts in silhouette"],
  person: ["bust in silhouette"], user: ["bust in silhouette"], individual: ["bust in silhouette"], identity: ["bust in silhouette"], customer: ["bust in silhouette"],
  plan: ["clipboard"], strategy: ["compass"], roadmap: ["compass"], direction: ["compass"], navigation: ["compass"], guide: ["compass"],
  solution: ["key"], access: ["key"], unlock: ["key"],
  schedule: ["calendar"], timeline: ["calendar"], date: ["calendar"], event: ["calendar"],
  knowledge: ["books"], learning: ["books"], education: ["books"], study: ["books"], reference: ["books"],
  value: ["gem stone"], quality: ["gem stone"], premium: ["gem stone"], worth: ["gem stone"],
  prediction: ["crystal ball"], forecast: ["crystal ball"], future: ["crystal ball"], uncertainty: ["crystal ball"], vision: ["crystal ball"],
  complexity: ["puzzle piece"], integration: ["puzzle piece"], piece: ["puzzle piece"], component: ["puzzle piece"],
  sustainability: ["recycling symbol"], reuse: ["recycling symbol"], recycle: ["recycling symbol"], renewable: ["recycling symbol"],
  logic: ["brain"], reason: ["brain"], reasoning: ["brain"], rational: ["brain"], deduction: ["brain"],
  instinct: ["fire"], drive: ["fire"], passion: ["fire"], urge: ["fire"], desire: ["fire"],
  emotion: ["red heart"], emotional: ["red heart"], feeling: ["red heart"], love: ["red heart"], care: ["red heart"], empathy: ["red heart"], desire_emotion: ["red heart"],
  memory: ["floppy disk"], remember: ["floppy disk"], storage: ["file cabinet"], record: ["card index"], archive: ["file cabinet"],
  attention: ["bullseye"], concentrate: ["bullseye"],
  thinking: ["thinking face"], consider: ["thinking face"], ponder: ["thinking face"], curiosity: ["thinking face"], doubt: ["thinking face"],
  science: ["atom symbol"], physics: ["atom symbol"], molecule: ["atom symbol"], chemistry: ["atom symbol"], atom: ["atom symbol"],
  quantum: ["atom symbol"], qubit: ["atom symbol"], subatomic: ["atom symbol"], particle: ["atom symbol"], superposition: ["atom symbol"],
  gene: ["dna"], genetic: ["dna"], biology: ["dna"], genome: ["dna"],
  calculation: ["abacus"], math: ["abacus"], compute: ["abacus"], arithmetic: ["abacus"], equation: ["abacus"],
  parameter: ["control knobs"], parameters: ["control knobs"], setting: ["control knobs"], tuning: ["control knobs"], weights: ["control knobs"], hyperparameter: ["control knobs"], knob: ["control knobs"],
  data: ["bar chart"], dataset: ["bar chart"], statistics: ["bar chart"], metrics: ["bar chart"], benchmark: ["bar chart"], tokens: ["bar chart"],
  bit: ["level slider"], binary: ["level slider"], toggle: ["level slider"], switch: ["level slider"],
  note: ["spiral notepad"], notes: ["spiral notepad"], writing: ["memo"], write: ["memo"],
  robot: ["robot"], ai: ["robot"], bot: ["robot"], machine: ["robot"],
  tag: ["label"], category: ["label"],
};

function matchesLabelWord(entryLabel: string, target: string): boolean {
  // Multi-word targets are specific enough for substring; single words use a
  // word boundary so "brain" does not match "musicbrainz".
  return target.includes(" ") ? entryLabel.includes(target) : entryLabel.split(/\s+/).includes(target);
}

function scoreSearchEntry(entry: OpenMojiSearchIndexEntry, key: string, label?: string): number {
  const query = normalize([key, label].filter(Boolean).join(" "));
  const tokens = conceptTokens(key, label);
  const entryLabel = normalize(entry.label);
  const group = normalize(entry.group);
  const subgroup = normalize(entry.subgroup);
  // Drop group/subgroup names that OpenMoji appends to every concept list; they
  // are taxonomy noise, not meaning ("objects", "animals-nature", ...).
  const concepts = entry.concepts
    .map(normalize)
    .filter((concept) => concept !== group && concept !== subgroup);
  let score = 0;

  if (entryLabel === query) score += 130;
  if (concepts.includes(query)) score += 100;

  for (const token of tokens) {
    if (entryLabel === token) score += 52;
    else if (entryLabel.split(/\s+/).includes(token)) score += 30;
    if (concepts.includes(token)) score += 38;
  }

  for (const token of tokens) {
    for (const target of CONCEPT_SYNONYMS[token] ?? []) {
      const t = normalize(target);
      if (entryLabel === t) score += 100;
      else if (matchesLabelWord(entryLabel, t)) score += 74;
      if (concepts.includes(t)) score += 50;
    }
  }

  return score;
}

export type OpenMojiAssetResolution = ResolvedOpenMojiAsset & {
  provider: "local-openmoji" | "icon-library";
};

// Drab / low-information / dated glyphs that the semantic matcher kept selecting
// as a catch-all for abstract concepts (bit, qubit, digital, math…). The grey
// "desktop computer" reads as a no-signal screen. These are never auto-selected
// as a SEMANTIC proxy (a curated mapping, if any, still wins). Keep this list
// tight — it only blocks bad proxies, not legitimate concrete icons.
const ICON_DENYLIST = new Set<string>([
  "openmoji:1F5A5", // desktop computer (grey "no-signal" monitor)
  "openmoji:1F4BD", // computer disk
  "openmoji:1F4BF", // optical disk
  "openmoji:1F4FA", // television
]);

function isDenied(iconRef: string, exclude?: Set<string>): boolean {
  return ICON_DENYLIST.has(iconRef) || isQaDenied(iconRef) || (exclude?.has(iconRef) ?? false);
}

/** True if this icon ref is on the global drab/ambiguous denylist. */
export function isIconRefDenied(iconRef: string): boolean {
  return ICON_DENYLIST.has(iconRef) || isQaDenied(iconRef);
}

/** Nudge toward one provider so a scene's icons share a visual dialect. */
export type ProviderBias = { provider: "local-openmoji" | "icon-library"; bonus: number };

// The generated house library is the PREFERRED source: its icons always get a
// small innate bonus in the unified embedding competition, so an equally-good
// library icon beats the OpenMoji one.
const LIBRARY_BONUS = 0.05;
const SEMANTIC_CONFIDENCE_FLOOR = 0.66;

// Semantic resolution tiers (all precomputed in the warm pass). The embedding
// pool is UNIFIED: icon-library + OpenMoji candidates compete on the same cosine
// scale and the best score wins (library gets LIBRARY_BONUS). Order: rerank ->
// confident embedding (>= SEMANTIC_CONFIDENCE_FLOOR) -> Iconify long-tail ->
// keyword ONLY when no embeddings exist (offline). Anything weaker returns null
// so the pipeline generates the requested icon instead of accepting a bad proxy.
function resolveSemantic(
  key: AssetKey,
  label: string | undefined,
  exclude: Set<string> | undefined,
  bias?: ProviderBias,
): OpenMojiAssetResolution | null {
  const queryKey = normalizeQuery(key, label);
  const embMatches = cachedMatches(queryKey);
  const libMatches = cachedLibraryMatches(queryKey);

  // Context-aware rerank wins: an LLM already chose this icon AFTER seeing the
  // scene context + the candidate options, so it beats a raw cosine match. A
  // cached choice still needs a plausible retrieval score: if every offered
  // candidate was weak, the correct outcome is to generate the missing icon.
  const reranked = cachedRerank(queryKey);
  if (reranked && !isDenied(reranked.iconRef, exclude)) {
    const rawScore =
      reranked.source === "icon-library"
        ? libMatches?.find((match) => `iclib:${match.id}` === reranked.iconRef)?.score
        : embMatches?.find((match) => `openmoji:${match.hexcode}` === reranked.iconRef)?.score;
    const score = rawScore === undefined ? undefined : rawScore + (reranked.source === "icon-library" ? LIBRARY_BONUS : 0);
    if (score === undefined || score >= SEMANTIC_CONFIDENCE_FLOOR) {
      return {
        provider: reranked.source,
        id: `rerank.${reranked.iconRef}`,
        iconRef: reranked.iconRef,
        svgPath: reranked.svgPath,
        label: reranked.label,
        strategy: "semantic",
      };
    }
  }

  const embResolution = (m: { hexcode: string; svgPath: string; label: string }): OpenMojiAssetResolution => ({
    provider: "local-openmoji",
    id: `embed.${m.hexcode}`,
    iconRef: `openmoji:${m.hexcode}`,
    svgPath: m.svgPath,
    label: m.label,
    strategy: "semantic",
  });
  const libResolution = (m: { id: string; svgPath: string; label: string }): OpenMojiAssetResolution => ({
    provider: "icon-library",
    id: `iclib.${m.id}`,
    iconRef: `iclib:${m.id}`,
    svgPath: m.svgPath,
    label: m.label,
    strategy: "semantic",
  });

  // Best non-excluded embedding candidate across BOTH sources at a score floor.
  // A scene-cohesion bias adds a small bonus to the preferred provider so near-
  // ties resolve toward one visual dialect (it never overrides a clear winner).
  const bestEmbedding = (floor: number): { score: number; make: () => OpenMojiAssetResolution } | null => {
    const cands: { score: number; make: () => OpenMojiAssetResolution }[] = [];
    const om = embMatches?.find((m) => m.score >= floor && !isDenied(`openmoji:${m.hexcode}`, exclude));
    if (om) cands.push({ score: om.score + (bias?.provider === "local-openmoji" ? bias.bonus : 0), make: () => embResolution(om) });
    const lib = libMatches?.find((m) => m.score >= floor && !isDenied(`iclib:${m.id}`, exclude));
    if (lib)
      cands.push({
        score: lib.score + LIBRARY_BONUS + (bias?.provider === "icon-library" ? bias.bonus : 0),
        make: () => libResolution(lib),
      });
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    return cands[0];
  };

  const confident = bestEmbedding(SEMANTIC_CONFIDENCE_FLOOR);
  if (confident) return confident.make();

  // Iconify long-tail icon (flat-doodle normalised), chosen when both were weak.
  const choice = cachedChoice(queryKey);
  if (choice && !isDenied(choice.iconRef, exclude)) {
    return {
      provider: "local-openmoji",
      id: choice.iconRef,
      iconRef: choice.iconRef,
      svgPath: choice.svgPath,
      label: choice.label,
      strategy: "semantic",
    };
  }

  // Keyword matching is an offline fallback only. When embedding candidates
  // exist but all score poorly, accepting another proxy prevents the pipeline's
  // missing-icon generator from ever running.
  const match =
    !embMatches?.length && !libMatches?.length
      ? loadSearchIndex()
          .filter((entry) => !isDenied(`openmoji:${entry.hexcode}`, exclude))
          .map((entry) => ({ entry, score: scoreSearchEntry(entry, key, label) }))
          .filter(({ score }) => score >= 56)
          .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))[0]?.entry
      : undefined;

  if (match) {
    return {
      provider: "local-openmoji",
      id: match.id,
      iconRef: `openmoji:${match.hexcode}`,
      svgPath: match.colorSvgPath,
      label: match.label,
      concepts: match.concepts,
      strategy: "semantic",
    };
  }

  return null;
}

export function resolveOpenMojiAssetInfo(
  key: AssetKey,
  label?: string,
  exclude?: Set<string>,
  // When the label is an explicit imagery metaphor (not just the caption), trust
  // it OVER the curated assetKey mapping — so an overloaded key like "chip" or
  // "network" can't force every concept onto the same glyph.
  preferImagery = false,
  bias?: ProviderBias,
): OpenMojiAssetResolution | null {
  // The generated house library wins outright on an exact concept/synonym match —
  // it is the style-locked primary icon source; everything else is fallback.
  const libraryEntry = findLibraryIcon(key, label);
  if (libraryEntry && !isDenied(`iclib:${libraryEntry.id}`, exclude)) {
    return {
      provider: "icon-library",
      id: `iclib.${libraryEntry.id}`,
      iconRef: `iclib:${libraryEntry.id}`,
      svgPath: libraryEntry.svgPath,
      label: libraryEntry.label,
      concepts: libraryEntry.synonyms,
      strategy: "curated",
    };
  }

  const manifest = loadManifest();
  const curatedEntry = manifest?.get(key);
  // Curated mapping is honoured unless this icon is already used in the scene
  // (de-dup) OR it's a denylisted drab glyph (e.g. "chip" -> grey monitor): then
  // we fall through to a distinct, better semantic match.
  const curated: OpenMojiAssetResolution | null =
    curatedEntry && !isDenied(curatedEntry.iconRef, exclude)
      ? {
          provider: "local-openmoji",
          id: `curated.${key}`,
          iconRef: curatedEntry.iconRef,
          svgPath: manifestEntryPath(curatedEntry),
          label: curatedEntry.openMojiLabel ?? curatedEntry.label,
          concepts: curatedEntry.concepts,
          strategy: "curated",
        }
      : null;

  if (preferImagery && label) {
    return resolveSemantic(key, label, exclude, bias) ?? curated;
  }
  return curated ?? resolveSemantic(key, label, exclude, bias);
}

function rough(seed: number, amount = 1.2): number {
  return Math.sin(seed * 9.713 + 3.1) * amount;
}

// Render an OpenMoji icon with a draw-then-fill animation: the black outline
// (<g id="line">) wipes in first as if drawn, then the colour (<g id="color">)
// floods in just behind it — matching the Lamina "being drawn" reveal.
function renderIconSvg(
  svg: ParsedSvg,
  x: number,
  y: number,
  scale: number,
  input: { progress: number; opacity: number; clipId: string },
  iconRef: string,
): string {
  const p = Math.max(0, Math.min(1, input.progress));
  const id = `${input.clipId}_om`;
  const open = `<g transform="translate(${x} ${y}) scale(${scale})" opacity="${input.opacity}" filter="url(#softShadow)" data-icon="${iconRef}">`;
  const innerOpen = `<svg x="0" y="0" width="100" height="100" viewBox="${svg.viewBox}">`;

  // Split the body at the line-group boundary (colour precedes line in OpenMoji),
  // robust to nested groups inside either part.
  const lineIdx = svg.body.search(/<g[^>]*id=["']line["']/);
  if (lineIdx > 0) {
    const colorPart = svg.body.slice(0, lineIdx);
    const linePart = svg.body.slice(lineIdx);
    const outline = Math.min(1, p / 0.55);
    const fill = Math.max(0, (p - 0.42) / 0.58);
    const lineW = (3 + 100 * outline).toFixed(1);
    const fillW = (3 + 100 * fill).toFixed(1);
    return `
    <defs>
      <clipPath id="${id}_l"><rect x="-3" y="-3" width="${lineW}" height="106"/></clipPath>
      <clipPath id="${id}_c"><rect x="-3" y="-3" width="${fillW}" height="106"/></clipPath>
    </defs>
    ${open}
      <g clip-path="url(#${id}_c)">${innerOpen}${colorPart}</svg></g>
      <g clip-path="url(#${id}_l)">${innerOpen}${linePart}</svg></g>
    </g>`;
  }

  // Fallback (monochrome icons / no line group): a single wipe of the whole icon.
  const w = (3 + 100 * p).toFixed(1);
  return `
    <defs><clipPath id="${id}"><rect x="-3" y="-3" width="${w}" height="106"/></clipPath></defs>
    ${open}
      <g clip-path="url(#${id})">${innerOpen}${svg.body}</svg></g>
    </g>`;
}

function iconGeometry(box: Box, seed: number): { x: number; y: number; scale: number } {
  const scale = Math.min(box.width, box.height) / 100;
  const size = 100 * scale;
  return {
    x: box.x + (box.width - size) / 2 + rough(seed),
    y: box.y + (box.height - size) / 2 + rough(seed + 11),
    scale,
  };
}

export function renderOpenMojiEntry(
  entry: ResolvedOpenMojiAsset,
  input: { box: Box; progress: number; opacity: number; seed: number; clipId: string },
): string {
  const svg = loadSvg(entry);
  if (!svg) {
    throw new Error(`OpenMoji SVG could not be loaded for "${entry.iconRef}".`);
  }
  const { x, y, scale } = iconGeometry(input.box, input.seed);
  return renderIconSvg(svg, x, y, scale, input, entry.iconRef);
}

export function renderOpenMojiAsset(input: {
  key: AssetKey;
  label?: string;
  box: Box;
  progress: number;
  opacity: number;
  seed: number;
  clipId: string;
}): string | null {
  const entry = resolveOpenMojiAssetInfo(input.key, input.label);
  if (!entry) return null;
  return renderOpenMojiEntry(entry, input);
}

export function assertOpenMojiAssetLibrary(): void {
  loadManifest();
}
