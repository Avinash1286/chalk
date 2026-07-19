import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Persistent QA denylist for icons that fail visual quality gates (currently:
 * mostly-black "silhouette blob" glyphs that read as broken in the flat-doodle
 * style). Written by the worker's async QA pass, read synchronously by the
 * render-time resolver. Entries record the measured stats so a re-run can skip
 * already-checked icons (denied or not).
 */

export type IconQaRecord = {
  // Fraction of opaque pixels that are near-black.
  darkFrac: number;
  // Fraction of the raster covered by opaque pixels.
  fillFrac: number;
  // Fraction of dark pixels that are interior (all 4 neighbours dark) — solid
  // mass vs thin strokes. Absent on records from before this metric existed.
  solidFrac?: number;
  denied: boolean;
  // Who set this verdict: the automated QA pass, or a manual call in the asset
  // studio. Manual records are STICKY — the QA pass skips icons that already
  // have a record, so a human deny/allow is never overridden by re-measurement.
  source?: "qa" | "manual";
  // Optional human note (why an icon was denied/allowed).
  reason?: string;
};

const QA_PATH = path.join(process.cwd(), "assets", "generated", "icon-qa.json");

let cache: Record<string, IconQaRecord> | null = null;
let dirty = false;

function load(): Record<string, IconQaRecord> {
  if (cache) return cache;
  try {
    cache = existsSync(QA_PATH) ? (JSON.parse(readFileSync(QA_PATH, "utf8")) as Record<string, IconQaRecord>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

export function qaRecord(iconRef: string): IconQaRecord | undefined {
  return load()[iconRef];
}

/** True when the QA pass has marked this icon as visually unusable. */
export function isQaDenied(iconRef: string): boolean {
  return load()[iconRef]?.denied === true;
}

export function setQaRecord(iconRef: string, record: IconQaRecord): void {
  load()[iconRef] = record;
  dirty = true;
}

/** Remove a verdict entirely, so the QA pass re-measures the icon next run. */
export function clearQaRecord(iconRef: string): void {
  const c = load();
  if (iconRef in c) {
    delete c[iconRef];
    dirty = true;
  }
}

/** All current QA verdicts (denied and allowed), for the asset studio. */
export function allQaRecords(): Record<string, IconQaRecord> {
  return { ...load() };
}

export function saveQaDenylist(): void {
  if (!dirty || !cache) return;
  mkdirSync(path.dirname(QA_PATH), { recursive: true });
  writeFileSync(QA_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  dirty = false;
}
