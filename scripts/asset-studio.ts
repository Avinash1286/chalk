/**
 * Asset Studio — an interactive tool to query the icon library EXACTLY the way
 * the render pipeline does, see every candidate it considers, and curate the
 * library (delete bad icons, pin good ones).
 *
 *   npx tsx scripts/asset-studio.ts      (then open http://localhost:4321)
 *
 * It reuses the real resolution path: a query is live-embedded (Vertex) and the
 * top matches are written into the SAME on-disk caches the pipeline reads, then
 * `resolveOpenMojiAssetInfo` is called to get the exact winner. Curation writes
 * to the SAME stores the pipeline honours:
 *   - Delete/deny  -> QA denylist  (shared/iconQaDenylist.ts, sticky "manual")
 *   - Pin          -> rerank cache (shared/iconRerankCache.ts, top resolver tier)
 * so any change you make here takes effect on the next generation (restart the
 * worker so it reloads the caches).
 */
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AssetKey } from "../shared/assetCatalog";
import { embedTexts, embeddingsAvailable } from "../worker/embeddings";
import {
  cachedMatches,
  embeddingIndexAvailable,
  matchVector,
  normalizeQuery,
  reloadOpenMojiIndex,
  saveQueryCache,
  setQueryMatches,
} from "../shared/openMojiEmbeddings";
import {
  cachedLibraryMatches,
  libraryIndexAvailable,
  matchLibraryVector,
  reloadLibraryIndex,
  saveLibraryCache,
  setLibraryMatches,
} from "../shared/iconLibraryEmbeddings";
import { iconLibraryEntries, iconLibraryEntryById, reloadIconLibrary, removeLibraryEntry } from "../shared/iconLibrary";
import { resolveOpenMojiAssetInfo, isIconRefDenied } from "../shared/openMojiAssets";
import { allReranks, cachedRerank, removeRerank, saveRerank, setRerank } from "../shared/iconRerankCache";
import { cachedChoice, saveChoices, setChoice } from "../shared/iconChoice";
import { allQaRecords, clearQaRecord, qaRecord, saveQaDenylist, setQaRecord } from "../shared/iconQaDenylist";
import { writeLibraryIndex } from "../shared/iconLibraryEmbeddings";
import { resolveIconifyIcon } from "../worker/iconify";
import { ensureLibraryIcon } from "../worker/iconLibraryGen";
import { EMBED_DIM } from "../worker/embeddings";
import { imageGenAvailable } from "../worker/imageGen";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const PORT = Number(process.env.STUDIO_PORT ?? 4321);

// ---- minimal .env.local loader (no fontconfig re-exec; we serve raw SVG) ----
function parseEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash !== -1) value = value.slice(0, hash).trim();
    if (!key || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
parseEnvFile(path.join(root, ".env.local"));
parseEnvFile(path.join(root, ".env"));

// ---- index metadata (counts + ref->svgPath reverse lookup + browse) ----
type OmMeta = { entries: { hexcode: string; label: string; svgPath: string }[] };
type OmSearch = { entries: { hexcode: string; label: string; concepts?: string[]; group?: string; subgroup?: string; colorSvgPath: string }[] };
type OmCurated = { entries: { hexcode: string }[] };

type OmBrowse = { hexcode: string; label: string; concepts: string[]; group: string; subgroup: string; svgPath: string };
type LibBrowse = { id: string; label: string; svgPath: string };

function tryMeta<T>(rel: string): T | null {
  const p = path.join(root, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

let omMeta: OmMeta | null;
let omByHex: Map<string, { hexcode: string; label: string; svgPath: string }>;
let omItems: OmBrowse[] = [];
let libItems: LibBrowse[] = [];
let curatedHex = new Set<string>(); // OpenMoji hexcodes backing curated keys — never purge.

function reloadData(): void {
  omMeta = tryMeta<OmMeta>("assets/vendor/openmoji/embeddings-meta.json");
  omByHex = new Map((omMeta?.entries ?? []).map((e) => [e.hexcode, e]));
  const omSearch = tryMeta<OmSearch>("assets/vendor/openmoji/search-index.json");
  omItems = (omSearch?.entries ?? []).map((e) => ({
    hexcode: e.hexcode,
    label: e.label,
    concepts: e.concepts ?? [],
    group: e.group || "other",
    subgroup: e.subgroup || "other",
    svgPath: e.colorSvgPath,
  }));
  reloadIconLibrary();
  libItems = iconLibraryEntries().map((e) => ({ id: e.id, label: e.label, svgPath: e.svgPath }));
  const omCur = tryMeta<OmCurated>("assets/vendor/openmoji/manifest.json");
  curatedHex = new Set((omCur?.entries ?? []).map((e) => e.hexcode));
}
reloadData();

// The batch generator appends to the library from a SEPARATE process while the
// studio runs — re-read the manifest on demand so counts and the browse grid
// are always live (cheap: one JSON file read).
function refreshLibrary(): void {
  reloadIconLibrary();
  libItems = iconLibraryEntries().map((e) => ({ id: e.id, label: e.label, svgPath: e.svgPath }));
}

function svgPathForRef(ref: string): string | null {
  if (ref.startsWith("openmoji:")) {
    const hex = ref.slice("openmoji:".length);
    return omByHex.get(hex)?.svgPath ?? `assets/vendor/openmoji/color/svg/${hex}.svg`;
  }
  if (ref.startsWith("iclib:")) {
    return iconLibraryEntryById(ref.slice("iclib:".length))?.svgPath ?? null;
  }
  if (ref.startsWith("iconify:")) {
    const [, prefix, name] = ref.split(":");
    if (!prefix || !name) return null;
    const safe = `${prefix}_${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `assets/generated/iconify/${safe}.svg`;
  }
  return null;
}

function qaOf(ref: string) {
  const r = qaRecord(ref);
  if (!r) return null;
  return {
    darkFrac: r.darkFrac,
    fillFrac: r.fillFrac,
    solidFrac: r.solidFrac ?? null,
    denied: r.denied,
    source: r.source ?? "qa",
    reason: r.reason ?? null,
  };
}

type Cand = {
  iconRef: string;
  label: string;
  score: number;
  svgPath: string | null;
  provider: "local-openmoji" | "icon-library";
  denied: boolean;
  qa: ReturnType<typeof qaOf>;
};

// ---- the core: resolve a query the way the pipeline does ----
async function resolveQuery(concept: string, imagery: string, preferImagery: boolean) {
  const label = imagery.trim() || undefined;
  const queryKey = normalizeQuery(concept, label);

  // Live-embed and populate the SAME caches the resolver reads, then persist so
  // repeat queries (and the pipeline) reuse them. Degrade to keyword if no creds.
  let mode: "embedding" | "keyword" = "keyword";
  if (embeddingsAvailable() && (embeddingIndexAvailable() || libraryIndexAvailable())) {
    try {
      const [vec] = await embedTexts([queryKey], "RETRIEVAL_QUERY");
      if (vec) {
        if (embeddingIndexAvailable()) {
          setQueryMatches(queryKey, matchVector(vec, 10));
          saveQueryCache();
        }
        if (libraryIndexAvailable()) {
          setLibraryMatches(queryKey, matchLibraryVector(vec, 10));
          saveLibraryCache();
        }
        mode = "embedding";
      }
    } catch (err) {
      console.warn(`embed failed, keyword mode: ${String(err)}`);
    }
  }

  const omCands: Cand[] = (cachedMatches(queryKey) ?? []).map((m) => {
    const iconRef = `openmoji:${m.hexcode}`;
    return {
      iconRef,
      label: m.label,
      score: m.score,
      svgPath: m.svgPath ?? svgPathForRef(iconRef),
      provider: "local-openmoji",
      denied: isIconRefDenied(iconRef),
      qa: qaOf(iconRef),
    };
  });
  const libCands: Cand[] = (cachedLibraryMatches(queryKey) ?? []).map((m) => {
    const iconRef = `iclib:${m.id}`;
    return {
      iconRef,
      label: m.label,
      score: m.score,
      svgPath: m.svgPath ?? svgPathForRef(iconRef),
      provider: "icon-library",
      denied: isIconRefDenied(iconRef),
      qa: qaOf(iconRef),
    };
  });

  const pin = cachedRerank(queryKey);
  const choice = cachedChoice(queryKey);

  // The exact winner the pipeline would render.
  const winner = resolveOpenMojiAssetInfo(concept as AssetKey, label, undefined, preferImagery && Boolean(label));

  // Infer which resolution tier produced the winner.
  let tier = "none";
  let tierScore: number | null = null;
  if (winner) {
    if (winner.id.startsWith("curated.")) tier = "curated";
    else if (winner.id.startsWith("rerank.")) tier = "pinned";
    else if (winner.id.startsWith("iclib.") && winner.strategy === "curated") tier = "library-direct";
    else if (choice && winner.iconRef === choice.iconRef) tier = "iconify";
    else {
      const m = [...omCands, ...libCands].find((c) => c.iconRef === winner.iconRef);
      if (m) {
        tierScore = m.score;
        tier = m.score >= 0.66 ? "embedding-confident" : m.score >= 0.46 ? "embedding-weak" : "embedding-lastresort";
      } else {
        tier = winner.strategy === "curated" ? "curated" : "keyword";
      }
    }
  }

  return {
    queryKey,
    mode,
    preferImagery: preferImagery && Boolean(label),
    winner: winner
      ? {
          iconRef: winner.iconRef,
          label: winner.label ?? null,
          provider: winner.provider,
          strategy: winner.strategy,
          svgPath: winner.svgPath,
          tier,
          tierScore,
          qa: qaOf(winner.iconRef),
          denied: isIconRefDenied(winner.iconRef),
        }
      : null,
    pin: pin
      ? { iconRef: pin.iconRef, label: pin.label, svgPath: pin.svgPath, provider: pin.source }
      : null,
    iconify: choice ? { iconRef: choice.iconRef, label: choice.label, svgPath: choice.svgPath } : null,
    openmoji: omCands,
    library: libCands,
  };
}

function stats() {
  refreshLibrary();
  return {
    openmoji: omMeta?.entries.length ?? null,
    library: libItems.length,
    denied: Object.values(allQaRecords()).filter((r) => r.denied).length,
    pinned: Object.keys(allReranks()).length,
    embeddings: embeddingsAvailable(),
    indexes: { openmoji: embeddingIndexAvailable(), library: libraryIndexAvailable() },
  };
}

function denylist() {
  return Object.entries(allQaRecords())
    .filter(([, r]) => r.denied)
    .map(([iconRef, r]) => ({
      iconRef,
      svgPath: svgPathForRef(iconRef),
      source: r.source ?? "qa",
      reason: r.reason ?? null,
      darkFrac: r.darkFrac,
      fillFrac: r.fillFrac,
      solidFrac: r.solidFrac ?? null,
    }));
}

function pins() {
  return Object.entries(allReranks()).map(([queryKey, c]) => ({
    queryKey,
    iconRef: c.iconRef,
    label: c.label,
    svgPath: c.svgPath,
    provider: c.source,
  }));
}

// ---- mutations ----
function deny(iconRef: string, reason: string): void {
  // Sticky manual deny: solidFrac present so the QA pass never re-measures it.
  setQaRecord(iconRef, { darkFrac: 1, fillFrac: 1, solidFrac: 1, denied: true, source: "manual", reason: reason || "manually removed" });
  saveQaDenylist();
}
function allow(iconRef: string, reason: string): void {
  setQaRecord(iconRef, { darkFrac: 0, fillFrac: 0, solidFrac: 0, denied: false, source: "manual", reason: reason || "manually approved" });
  saveQaDenylist();
}
function reset(iconRef: string): void {
  clearQaRecord(iconRef);
  saveQaDenylist();
}
function pin(concept: string, imagery: string, iconRef: string, svgPath: string, label: string, provider: string): void {
  const queryKey = normalizeQuery(concept, imagery.trim() || undefined);
  const source = provider === "icon-library" ? "icon-library" : "local-openmoji";
  setRerank(queryKey, { iconRef, svgPath, label, source });
  saveRerank();
  // An iconify pin must also live in the choice cache (resolver reads it there for
  // the iconify tier); rerank covers it too, but keep both consistent.
  if (iconRef.startsWith("iconify:")) {
    setChoice(queryKey, { iconRef, svgPath, label });
    saveChoices();
  }
}
function unpin(queryKey: string): void {
  removeRerank(queryKey);
  saveRerank();
}

// ---- browse (grouped library view) ----
type GroupSummary = { key: string; count: number; denied: number; subgroups: { key: string; count: number; denied: number }[] };

function browseGroups(provider: string): GroupSummary[] {
  if (provider === "openmoji") {
    const byGroup = new Map<string, Map<string, { count: number; denied: number }>>();
    for (const it of omItems) {
      let subs = byGroup.get(it.group);
      if (!subs) byGroup.set(it.group, (subs = new Map()));
      let s = subs.get(it.subgroup);
      if (!s) subs.set(it.subgroup, (s = { count: 0, denied: 0 }));
      s.count += 1;
      if (isIconRefDenied(`openmoji:${it.hexcode}`)) s.denied += 1;
    }
    return [...byGroup.entries()]
      .map(([key, subs]) => {
        const subgroups = [...subs.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => b.count - a.count);
        return { key, count: subgroups.reduce((s, x) => s + x.count, 0), denied: subgroups.reduce((s, x) => s + x.denied, 0), subgroups };
      })
      .sort((a, b) => b.count - a.count);
  }
  const denied = libItems.filter((it) => isIconRefDenied(`iclib:${it.id}`)).length;
  return [{ key: "icon-library", count: libItems.length, denied, subgroups: [] }];
}

function browseItems(provider: string, group: string, subgroup: string, offset: number, limit: number) {
  let all: { iconRef: string; label: string; subgroup: string; svgPath: string; denied: boolean }[];
  if (provider === "openmoji") {
    all = omItems
      .filter((it) => it.group === group && (!subgroup || it.subgroup === subgroup))
      .map((it) => ({ iconRef: `openmoji:${it.hexcode}`, label: it.label, subgroup: it.subgroup, svgPath: it.svgPath, denied: isIconRefDenied(`openmoji:${it.hexcode}`) }));
  } else {
    all = libItems.map((it) => ({ iconRef: `iclib:${it.id}`, label: it.label, subgroup: "", svgPath: it.svgPath, denied: isIconRefDenied(`iclib:${it.id}`) }));
  }
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

function refsForGroup(provider: string, group: string, subgroup: string): string[] {
  if (provider === "openmoji") {
    return omItems.filter((it) => it.group === group && (!subgroup || it.subgroup === subgroup)).map((it) => `openmoji:${it.hexcode}`);
  }
  return libItems.map((it) => `iclib:${it.id}`);
}

// ---- bulk remove / restore / reset (denylist) ----
function applyDenyAction(action: "deny" | "allow" | "reset", refs: string[]): number {
  for (const ref of refs) {
    if (action === "deny") setQaRecord(ref, { darkFrac: 1, fillFrac: 1, solidFrac: 1, denied: true, source: "manual", reason: "removed in studio" });
    else if (action === "allow") setQaRecord(ref, { darkFrac: 0, fillFrac: 0, solidFrac: 0, denied: false, source: "manual", reason: "approved in studio" });
    else clearQaRecord(ref);
  }
  saveQaDenylist();
  return refs.length;
}

// ---- hard purge (physically remove from the embedding index) ----
// Rebuilds embeddings.bin + embeddings-meta.json (+ search-index / manifest) with
// the entries removed, keeping the bin's vector order aligned to meta. Backs up
// every file it touches first, and refuses to purge curated OpenMoji keys.
let purgeBackupDir = "";

function rebuildOpenMojiFiles(removeIds: Set<string>): number {
  const dir = path.join(root, "assets", "vendor", "openmoji");
  const metaP = path.join(dir, "embeddings-meta.json");
  const binP = path.join(dir, "embeddings.bin");
  if (!existsSync(metaP) || !existsSync(binP)) return 0;
  mkdirSync(purgeBackupDir, { recursive: true });
  copyFileSync(metaP, path.join(purgeBackupDir, "openmoji-embeddings-meta.json"));
  copyFileSync(binP, path.join(purgeBackupDir, "openmoji-embeddings.bin"));

  const meta = JSON.parse(readFileSync(metaP, "utf8")) as { dim: number; entries: any[] };
  const dim = meta.dim;
  const buf = readFileSync(binP);
  const old = new Float32Array(buf.buffer, buf.byteOffset, meta.entries.length * dim);
  const keptEntries: any[] = [];
  const keptVecs: Float32Array[] = [];
  let removed = 0;
  meta.entries.forEach((e, i) => {
    if (removeIds.has(e.hexcode)) {
      removed += 1;
    } else {
      keptEntries.push(e);
      keptVecs.push(old.subarray(i * dim, (i + 1) * dim));
    }
  });
  const next = new Float32Array(keptEntries.length * dim);
  let o = 0;
  for (const v of keptVecs) {
    next.set(v, o);
    o += dim;
  }
  // Atomic: write temp then rename, bin + meta together.
  writeFileSync(`${binP}.tmp`, Buffer.from(next.buffer, next.byteOffset, next.byteLength));
  meta.entries = keptEntries;
  writeFileSync(`${metaP}.tmp`, JSON.stringify(meta));
  renameSync(`${binP}.tmp`, binP);
  renameSync(`${metaP}.tmp`, metaP);

  const siP = path.join(dir, "search-index.json");
  if (existsSync(siP)) {
    copyFileSync(siP, path.join(purgeBackupDir, "openmoji-search-index.json"));
    const si = JSON.parse(readFileSync(siP, "utf8")) as { entries: any[] };
    si.entries = si.entries.filter((e) => !removeIds.has(e.hexcode));
    writeFileSync(siP, JSON.stringify(si));
  }
  return removed;
}

function purge(refs: string[]): { purged: number; skipped: { iconRef: string; reason: string }[]; backup: string } {
  purgeBackupDir = path.join(root, "assets", "generated", "index-backups", String(Date.now()));
  const skipped: { iconRef: string; reason: string }[] = [];
  const omHex = new Set<string>();
  const libIds = new Set<string>();
  for (const r of refs) {
    if (r.startsWith("openmoji:")) {
      const hex = r.slice("openmoji:".length);
      if (curatedHex.has(hex)) skipped.push({ iconRef: r, reason: "backs a curated asset key (protected)" });
      else omHex.add(hex);
    } else if (r.startsWith("iclib:")) {
      libIds.add(r.slice("iclib:".length));
    } else {
      skipped.push({ iconRef: r, reason: "not a purgeable provider" });
    }
  }
  let purged = 0;
  if (omHex.size) purged += rebuildOpenMojiFiles(omHex);
  // Library icons: drop the manifest entry (the SVG/PNG files stay on disk for
  // reference; regenerate the embedding index via generate-icon-library --index-only).
  for (const id of libIds) {
    if (removeLibraryEntry(id)) purged += 1;
  }
  // Belt-and-suspenders: also denylist purged refs so any lingering reference is blocked.
  const purgedRefs = refs.filter((r) => !skipped.some((s) => s.iconRef === r));
  for (const r of purgedRefs) setQaRecord(r, { darkFrac: 1, fillFrac: 1, solidFrac: 1, denied: true, source: "manual", reason: "purged from index" });
  saveQaDenylist();
  // Reflect on disk changes: reset embedding caches + reload studio's copies.
  reloadOpenMojiIndex();
  reloadLibraryIndex();
  reloadData();
  return { purged, skipped, backup: path.relative(root, purgeBackupDir) };
}

// ---- replace OpenMoji icons with freshly generated house icons ----
type ReplaceResult = { iconRef: string; ok: boolean; newId?: string; newSvgPath?: string; reason?: string };

/**
 * For each OpenMoji ref: draw a house-style icon for its label (one attempt,
 * QA-gated), and on success DENY the OpenMoji original (sticky manual verdict,
 * provenance in the reason) so the resolver always prefers the replacement. Failures
 * leave the OpenMoji icon untouched. Sequential — the image quota is tight.
 */
async function replaceIcons(refs: string[]): Promise<ReplaceResult[]> {
  const results: ReplaceResult[] = [];
  for (const iconRef of refs) {
    if (!iconRef.startsWith("openmoji:")) {
      results.push({ iconRef, ok: false, reason: "only OpenMoji icons can be replaced" });
      continue;
    }
    const item = omItems.find((it) => `openmoji:${it.hexcode}` === iconRef);
    if (!item) {
      results.push({ iconRef, ok: false, reason: "not found in the OpenMoji search index" });
      continue;
    }
    const taxonomy = new Set([item.group.toLowerCase(), item.subgroup.toLowerCase()]);
    const synonyms = item.concepts.filter((c) => c && !taxonomy.has(c.toLowerCase()) && c.toLowerCase() !== item.label.toLowerCase());
    const generated = await ensureLibraryIcon({
      concept: item.label,
      label: item.label,
      synonyms,
      log: (message) => console.log(`replace ${iconRef}: ${message}`),
    });
    if (!generated.ok) {
      results.push({ iconRef, ok: false, reason: generated.reason });
      continue;
    }
    setQaRecord(iconRef, {
      darkFrac: 1,
      fillFrac: 1,
      solidFrac: 1,
      denied: true,
      source: "manual",
      reason: `replaced by iclib:${generated.entry.id}`,
    });
    results.push({ iconRef, ok: true, newId: generated.entry.id, newSvgPath: generated.entry.svgPath });
  }
  saveQaDenylist();
  reloadData();
  return results;
}

async function reindexLibrary(): Promise<{ ok: boolean; total?: number; reason?: string }> {
  reloadIconLibrary();
  const entries = iconLibraryEntries();
  if (!entries.length) return { ok: false, reason: "library is empty" };
  if (!embeddingsAvailable()) return { ok: false, reason: "embeddings unavailable (no Google credentials)" };
  const docs = entries.map((entry) => [entry.label, entry.concept, ...entry.synonyms].filter(Boolean).join(". "));
  const vectors = await embedTexts(docs, "RETRIEVAL_DOCUMENT");
  writeLibraryIndex(
    EMBED_DIM,
    entries.map((entry) => ({ id: entry.id, label: entry.label, svgPath: entry.svgPath })),
    vectors,
  );
  reloadLibraryIndex();
  reloadData();
  return { ok: true, total: entries.length };
}

// ---- http ----
function send(res: import("node:http").ServerResponse, code: number, body: unknown, type = "application/json"): void {
  const payload = type === "application/json" ? JSON.stringify(body) : (body as string | Buffer);
  res.writeHead(code, { "Content-Type": type });
  res.end(payload);
}

function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const HTML = readFileSync(path.join(__dirname, "asset-studio.html"), "utf8");

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === "/" || p === "/index.html") return send(res, 200, HTML, "text/html; charset=utf-8");
    if (p === "/api/stats") return send(res, 200, stats());

    if (p === "/api/resolve") {
      const concept = (url.searchParams.get("concept") ?? "").trim();
      const imagery = (url.searchParams.get("imagery") ?? "").trim();
      const preferImagery = url.searchParams.get("preferImagery") === "1";
      if (!concept) return send(res, 400, { error: "concept is required" });
      return send(res, 200, await resolveQuery(concept, imagery, preferImagery));
    }

    if (p === "/api/iconify") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return send(res, 400, { error: "q is required" });
      const choice = await resolveIconifyIcon(q);
      return send(res, 200, { choice });
    }

    if (p === "/api/denylist") return send(res, 200, { items: denylist() });
    if (p === "/api/pins") return send(res, 200, { items: pins() });

    if (p === "/api/browse") {
      const provider = url.searchParams.get("provider") === "library" ? "library" : "openmoji";
      if (provider === "library") refreshLibrary();
      return send(res, 200, { provider, groups: browseGroups(provider) });
    }
    if (p === "/api/browse/items") {
      const provider = url.searchParams.get("provider") === "library" ? "library" : "openmoji";
      if (provider === "library") refreshLibrary();
      const group = url.searchParams.get("group") ?? "";
      const subgroup = url.searchParams.get("subgroup") ?? "";
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      return send(res, 200, browseItems(provider, group, subgroup, offset, limit));
    }

    if (p === "/api/icon") {
      const rel = url.searchParams.get("path") ?? "";
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root) || !abs.endsWith(".svg") || !existsSync(abs)) {
        return send(res, 404, "not found", "text/plain");
      }
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
      return res.end(readFileSync(abs));
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (p === "/api/deny") {
        if (!body.iconRef) return send(res, 400, { error: "iconRef required" });
        deny(body.iconRef, body.reason ?? "");
        return send(res, 200, { ok: true });
      }
      if (p === "/api/allow") {
        if (!body.iconRef) return send(res, 400, { error: "iconRef required" });
        allow(body.iconRef, body.reason ?? "");
        return send(res, 200, { ok: true });
      }
      if (p === "/api/reset") {
        if (!body.iconRef) return send(res, 400, { error: "iconRef required" });
        reset(body.iconRef);
        return send(res, 200, { ok: true });
      }
      if (p === "/api/pin") {
        if (!body.concept || !body.iconRef || !body.svgPath) return send(res, 400, { error: "concept, iconRef, svgPath required" });
        pin(body.concept, body.imagery ?? "", body.iconRef, body.svgPath, body.label ?? body.iconRef, body.provider ?? "local-openmoji");
        return send(res, 200, { ok: true });
      }
      if (p === "/api/unpin") {
        if (!body.queryKey) return send(res, 400, { error: "queryKey required" });
        unpin(body.queryKey);
        return send(res, 200, { ok: true });
      }
      if (p === "/api/replace") {
        const refs: string[] = Array.isArray(body.iconRefs) ? body.iconRefs : [];
        if (!refs.length) return send(res, 400, { error: "iconRefs required" });
        if (refs.length > 10) return send(res, 400, { error: "max 10 refs per request — send chunks" });
        if (!imageGenAvailable()) return send(res, 400, { error: "image generation unavailable (no Google credentials)" });
        return send(res, 200, { results: await replaceIcons(refs) });
      }
      if (p === "/api/library/reindex") {
        return send(res, 200, await reindexLibrary());
      }
      if (p === "/api/bulk") {
        const refs: string[] = Array.isArray(body.iconRefs) ? body.iconRefs : [];
        if (!refs.length) return send(res, 400, { error: "iconRefs required" });
        if (body.action === "purge") return send(res, 200, purge(refs));
        if (["deny", "allow", "reset"].includes(body.action)) return send(res, 200, { ok: true, count: applyDenyAction(body.action, refs) });
        return send(res, 400, { error: "bad action" });
      }
      if (p === "/api/group") {
        const provider = body.provider === "library" ? "library" : "openmoji";
        const refs = refsForGroup(provider, body.group ?? "", body.subgroup ?? "");
        if (!refs.length) return send(res, 400, { error: "empty group" });
        if (body.action === "purge") return send(res, 200, purge(refs));
        if (["deny", "allow", "reset"].includes(body.action)) return send(res, 200, { ok: true, count: applyDenyAction(body.action, refs) });
        return send(res, 400, { error: "bad action" });
      }
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String(err) });
  }
});

server.listen(PORT, () => {
  const s = stats();
  console.log(`\n  Asset Studio  →  http://localhost:${PORT}\n`);
  console.log(`  Library: ${s.library}   OpenMoji: ${s.openmoji ?? "?"}   denied: ${s.denied}   pinned: ${s.pinned}`);
  console.log(`  Mode: ${s.embeddings ? "embedding (live Vertex)" : "keyword only (no Google creds)"}\n`);
});
