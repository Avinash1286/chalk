import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nearest-neighbour lookup over the generated icon-library index (built by
 * scripts/generate-icon-library.ts), mirroring the OpenMoji index so cosine
 * scores are directly comparable. The pipeline embeds each concept query once
 * (worker/iconWarm.ts) and caches the top matches to disk, so the render-time
 * resolver stays synchronous.
 */

export type LibraryMatch = { id: string; label: string; svgPath: string; score: number };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const binPath = path.join(root, "assets", "generated", "icon-library", "embeddings.bin");
const metaPath = path.join(root, "assets", "generated", "icon-library", "embeddings-meta.json");
const queryCachePath = path.join(root, "assets", "generated", "icon-library-query-cache.json");

type Meta = { dim: number; entries: { id: string; label: string; svgPath: string }[] };
type Index = { dim: number; entries: Meta["entries"]; vectors: Float32Array };

let indexCache: Index | null | undefined;

export function libraryIndexAvailable(): boolean {
  return existsSync(binPath) && existsSync(metaPath);
}

/** Drop the in-memory index so the next lookup re-reads it (after a rebuild). */
export function reloadLibraryIndex(): void {
  indexCache = undefined;
}

function loadIndex(): Index | null {
  if (indexCache !== undefined) return indexCache;
  if (!libraryIndexAvailable()) {
    indexCache = null;
    return null;
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
  const buf = readFileSync(binPath);
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, meta.entries.length * meta.dim);
  indexCache = { dim: meta.dim, entries: meta.entries, vectors };
  return indexCache;
}

/** Top-k icon-library matches for a (already L2-normalised) query vector. */
export function matchLibraryVector(queryVec: number[], topK = 8): LibraryMatch[] {
  const index = loadIndex();
  if (!index) return [];
  const { dim, entries, vectors } = index;
  const scored: LibraryMatch[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d += 1) dot += queryVec[d] * vectors[base + d];
    scored.push({ id: entries[i].id, label: entries[i].label, svgPath: entries[i].svgPath, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Write the embedding index (batch script). Vectors must be L2-normalised. */
export function writeLibraryIndex(dim: number, entries: Meta["entries"], vectors: number[][]): void {
  mkdirSync(path.dirname(binPath), { recursive: true });
  const flat = new Float32Array(entries.length * dim);
  vectors.forEach((vec, i) => flat.set(vec, i * dim));
  writeFileSync(binPath, Buffer.from(flat.buffer));
  writeFileSync(metaPath, JSON.stringify({ dim, entries }, null, 0));
  indexCache = undefined;
}

// ---- disk-backed query → matches cache (so render-time stays sync) ----
let queryCache: Record<string, LibraryMatch[]> | undefined;

function loadQueryCache(): Record<string, LibraryMatch[]> {
  if (queryCache) return queryCache;
  queryCache = existsSync(queryCachePath)
    ? (JSON.parse(readFileSync(queryCachePath, "utf8")) as Record<string, LibraryMatch[]>)
    : {};
  return queryCache;
}

export function cachedLibraryMatches(queryKey: string): LibraryMatch[] | null {
  return loadQueryCache()[queryKey] ?? null;
}

export function setLibraryMatches(queryKey: string, matches: LibraryMatch[]): void {
  loadQueryCache()[queryKey] = matches;
}

export function saveLibraryCache(): void {
  if (!queryCache) return;
  mkdirSync(path.dirname(queryCachePath), { recursive: true });
  writeFileSync(queryCachePath, JSON.stringify(queryCache, null, 0));
}
