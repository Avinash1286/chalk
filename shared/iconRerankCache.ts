import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Disk-backed cache of the context-aware rerank decisions (worker/iconRerank.ts):
 * for a given concept query, which concrete icon the LLM chose AFTER seeing the
 * scene context + candidate options. Read synchronously by the render-time resolver.
 */

export type RerankChoice = {
  iconRef: string; // "openmoji:1F436" | "iclib:<id>"
  svgPath: string;
  label: string;
  source: "local-openmoji" | "icon-library";
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cachePath = path.join(root, "assets", "generated", "icon-rerank-cache.json");

let cache: Record<string, RerankChoice> | undefined;

function load(): Record<string, RerankChoice> {
  if (cache) return cache;
  cache = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, RerankChoice>) : {};
  return cache;
}

export function cachedRerank(queryKey: string): RerankChoice | null {
  return load()[queryKey] ?? null;
}

export function setRerank(queryKey: string, choice: RerankChoice): void {
  load()[queryKey] = choice;
}

/** Remove a pinned concept→icon choice (asset studio "unpin"). */
export function removeRerank(queryKey: string): void {
  delete load()[queryKey];
}

/** All pinned choices, for the asset studio. */
export function allReranks(): Record<string, RerankChoice> {
  return { ...load() };
}

export function saveRerank(): void {
  if (!cache) return;
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 0));
}
