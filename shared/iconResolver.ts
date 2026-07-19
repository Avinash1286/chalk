import type { VisualElement } from "./storyboard";
import { resolveOpenMojiAssetInfo, type OpenMojiAssetResolution, type ProviderBias } from "./openMojiAssets";

/**
 * Resolves every icon in a scene ONCE, with per-scene de-duplication so two
 * different concepts never render the same glyph, and per-scene PROVIDER
 * COHESION so one scene doesn't mix visual dialects (emoji-flat vs sketchy)
 * when a near-tie could keep it consistent. Memoized by element content (not
 * scene id) so it is safe across jobs that reuse scene ids, and cheap to call
 * every frame.
 */

const cache = new Map<string, Map<string, OpenMojiAssetResolution | null>>();

// Small additive cosine bonus toward the scene's majority provider — enough to
// flip a near-tie, never a clear winner.
const COHESION_BONUS = 0.06;

// VIDEO-level provider bias: scene cohesion alone still lets scene A resolve
// all-library and scene B all-OpenMoji, so the video flips visual dialects
// between scenes. The pipeline counts providers across the whole storyboard
// after asset resolution and sets the majority here; near-tie picks then fall
// in line video-wide. Renderers that never set it (unit tests, local scripts)
// keep the old behaviour.
let videoBias: ProviderBias | null = null;

export function setVideoProviderBias(bias: ProviderBias | null): void {
  videoBias = bias;
}

function hintOf(el: VisualElement): string | undefined {
  return el.searchHint ?? el.label ?? el.text;
}

function signature(elements: VisualElement[]): string {
  return elements
    .map((el) => `${el.id}:${el.assetKey ?? ""}:${hintOf(el) ?? ""}:${el.resolvedAsset?.iconRef ?? ""}`)
    .join("|");
}

function resolvePass(elements: VisualElement[], bias?: ProviderBias): Map<string, OpenMojiAssetResolution | null> {
  const map = new Map<string, OpenMojiAssetResolution | null>();
  const used = new Set<string>();
  // Cache by assetKey + search hint so the SAME concept (e.g. every cell of a
  // quantity grid) reuses one glyph, while DIFFERENT concepts still de-duplicate
  // against each other (the `used` set forces a distinct icon per concept).
  const byKey = new Map<string, OpenMojiAssetResolution | null>();
  for (const el of elements) {
    if (el.type !== "asset" && el.type !== "logo") continue;
    if (el.resolvedAsset) {
      const resolved: OpenMojiAssetResolution = {
        provider: el.resolvedAsset.provider,
        id: `bound.${el.resolvedAsset.iconRef}`,
        iconRef: el.resolvedAsset.iconRef,
        svgPath: el.resolvedAsset.svgPath,
        label: el.resolvedAsset.label ?? hintOf(el) ?? el.assetKey ?? "icon",
        strategy: "curated",
      };
      map.set(el.id, resolved);
      used.add(resolved.iconRef);
      continue;
    }
    const key = el.assetKey ?? "generic";
    const hint = hintOf(el);
    const cacheKey = `${key}::${hint ?? ""}`;
    if (byKey.has(cacheKey)) {
      map.set(el.id, byKey.get(cacheKey) ?? null);
      continue;
    }
    // An explicit imagery hint (searchHint) should override an overloaded curated
    // assetKey; a caption/text hint should not.
    const preferImagery = Boolean(el.searchHint);
    const resolved = resolveOpenMojiAssetInfo(key, hint, used, preferImagery, bias);
    if (resolved) used.add(resolved.iconRef);
    byKey.set(cacheKey, resolved);
    map.set(el.id, resolved);
  }
  return map;
}

export function resolveSceneIcons(elements: VisualElement[]): Map<string, OpenMojiAssetResolution | null> {
  const sig = `${videoBias ? `${videoBias.provider}~` : ""}${signature(elements)}`;
  const cached = cache.get(sig);
  if (cached) return cached;

  // Pass 1: resolution with the video-wide bias (if the pipeline set one). If
  // the scene still mixes providers, re-resolve the whole scene with a small
  // bonus toward the scene's majority provider so near-tie minority picks fall
  // in line (clear semantic winners still win).
  let map = resolvePass(elements, videoBias ?? undefined);
  const counts = { "local-openmoji": 0, "icon-library": 0 };
  for (const r of map.values()) {
    if (r) counts[r.provider] += 1;
  }
  if (counts["local-openmoji"] > 0 && counts["icon-library"] > 0) {
    const majority = counts["icon-library"] >= counts["local-openmoji"] ? "icon-library" : "local-openmoji";
    map = resolvePass(elements, { provider: majority, bonus: COHESION_BONUS });
  }

  cache.set(sig, map);
  return map;
}
