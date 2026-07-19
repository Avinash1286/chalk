import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenMojiAssetInfo } from "../shared/openMojiAssets";
import { iconLibraryEntryById } from "../shared/iconLibrary";
import { validateStoryboard, type ResolvedAsset, type Storyboard } from "../shared/storyboard";
import { ensureLibraryIcon } from "./iconLibraryGen";

const HOUSE_STYLE_BIAS = { provider: "icon-library" as const, bonus: 0.06 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// The persisted binding is self-describing: viewBox read once from the SVG at
// bind time, qaScore from generation-time QA (library icons: bbox coverage).
const viewBoxCache = new Map<string, string | undefined>();

function viewBoxOf(svgPath: string): string | undefined {
  if (viewBoxCache.has(svgPath)) return viewBoxCache.get(svgPath);
  let viewBox: string | undefined;
  try {
    viewBox = readFileSync(path.join(root, svgPath), "utf8").match(/\sviewBox="([^"]+)"/)?.[1];
  } catch {
    viewBox = undefined;
  }
  viewBoxCache.set(svgPath, viewBox);
  return viewBox;
}

function qaScoreOf(iconRef: string): number | undefined {
  if (!iconRef.startsWith("iclib:")) return undefined;
  const qa = iconLibraryEntryById(iconRef.slice("iclib:".length))?.qa;
  if (!qa) return undefined;
  if (!qa.depicts || !qa.styleOk) return 0;
  return Math.max(0, Math.min(1, qa.coverage));
}

function makeBinding(input: {
  provider: ResolvedAsset["provider"];
  iconRef: string;
  svgPath: string;
  label?: string;
}): ResolvedAsset {
  return {
    provider: input.provider,
    iconRef: input.iconRef,
    svgPath: input.svgPath,
    label: input.label,
    viewBox: viewBoxOf(input.svgPath),
    qaScore: qaScoreOf(input.iconRef),
  };
}

export type AssetResolutionRecord = {
  assetKey: string;
  label?: string;
  sceneId: string;
  beatId: string;
  provider: "icon-library" | "local-openmoji" | "unresolved";
  strategy:
    | "library-curated"
    | "library-semantic"
    | "library-generated"
    | "openmoji-curated"
    | "openmoji-semantic"
    | "unresolved";
  iconRef?: string;
  svgPath?: string;
  model?: string;
  reason?: string;
};

type AssetRequest = {
  assetKey: string;
  label?: string;
  preferImagery: boolean;
  sceneId: string;
  sceneTitle: string;
  beatId: string;
  narration: string;
};

export type PreparedStoryboardAssets = {
  storyboard: Storyboard;
  records: AssetResolutionRecord[];
};

function requestId(assetKey: string, label?: string): string {
  return `${assetKey}::${label ?? ""}`;
}

function collectAssetRequests(storyboard: Storyboard): AssetRequest[] {
  const requests = new Map<string, AssetRequest>();

  for (const scene of storyboard.scenes) {
    for (const beat of scene.beats) {
      const add = (assetKey: string | undefined, label?: string, preferImagery = false, bound?: ResolvedAsset) => {
        if (!assetKey || bound) return;
        const id = requestId(assetKey, label);
        if (requests.has(id)) return;
        requests.set(id, {
          assetKey,
          label,
          preferImagery,
          sceneId: scene.id,
          sceneTitle: scene.title,
          beatId: beat.id,
          narration: beat.narration,
        });
      };

      add(beat.visual.assetKey, beat.visual.label, false, beat.visual.resolvedAsset);
      for (const element of beat.elements ?? []) {
        if (element.type === "asset" || element.type === "logo") {
          // Resolve by the same hint + priority the renderer uses, so the
          // generation decision matches what actually gets drawn.
          add(
            element.assetKey,
            element.searchHint ?? element.label ?? element.text,
            Boolean(element.searchHint),
            element.resolvedAsset,
          );
        }
      }
    }
  }

  return [...requests.values()];
}

export async function prepareStoryboardAssets(storyboard: Storyboard): Promise<PreparedStoryboardAssets> {
  const records: AssetResolutionRecord[] = [];
  const bindings = new Map<string, ResolvedAsset>();

  for (const request of collectAssetRequests(storyboard)) {
    const resolved = resolveOpenMojiAssetInfo(
      request.assetKey,
      request.label,
      undefined,
      request.preferImagery,
      HOUSE_STYLE_BIAS,
    );
    if (resolved) {
      const isLibrary = resolved.provider === "icon-library";
      bindings.set(
        requestId(request.assetKey, request.label),
        makeBinding({
          provider: resolved.provider,
          iconRef: resolved.iconRef,
          svgPath: resolved.svgPath,
          label: resolved.label,
        }),
      );
      records.push({
        assetKey: request.assetKey,
        label: request.label,
        sceneId: request.sceneId,
        beatId: request.beatId,
        provider: resolved.provider,
        strategy: isLibrary
          ? resolved.strategy === "curated"
            ? "library-curated"
            : "library-semantic"
          : resolved.strategy === "curated"
            ? "openmoji-curated"
            : "openmoji-semantic",
        iconRef: resolved.iconRef,
        svgPath: resolved.svgPath,
        reason: isLibrary
          ? resolved.strategy === "curated"
            ? "Exact concept match in the house icon library."
            : "Matched the house icon library (embedding)."
          : resolved.strategy === "curated"
            ? "Matched curated OpenMoji manifest."
            : "Matched OpenMoji (embedding/keyword).",
      });
      continue;
    }

    // Long tail: draw a NEW house-style icon with the image model, QA it, and
    // add it to the library permanently (the library compounds video by video).
    const generated = await ensureLibraryIcon({
      concept: request.assetKey,
      label: request.label,
      log: (message) => console.log(`Icon library: ${message}`),
    });

    if (generated.ok) {
      bindings.set(
        requestId(request.assetKey, request.label),
        makeBinding({
          provider: "icon-library",
          iconRef: `iclib:${generated.entry.id}`,
          svgPath: generated.entry.svgPath,
          label: generated.entry.label,
        }),
      );
      records.push({
        assetKey: request.assetKey,
        label: request.label,
        sceneId: request.sceneId,
        beatId: request.beatId,
        provider: "icon-library",
        strategy: "library-generated",
        iconRef: `iclib:${generated.entry.id}`,
        svgPath: generated.entry.svgPath,
        model: generated.entry.model,
        reason: "Generated a new house-style icon (image model + QA).",
      });
    } else {
      records.push({
        assetKey: request.assetKey,
        label: request.label,
        sceneId: request.sceneId,
        beatId: request.beatId,
        provider: "unresolved",
        strategy: "unresolved",
        reason: generated.reason,
      });
      console.warn(`Icon library: no icon for "${request.assetKey}" — ${generated.reason}`);
    }
  }

  const prepared = validateStoryboard({
    ...storyboard,
    scenes: storyboard.scenes.map((scene) => ({
      ...scene,
      beats: scene.beats.map((beat) => ({
        ...beat,
        visual: {
          ...beat.visual,
          resolvedAsset:
            beat.visual.resolvedAsset ?? bindings.get(requestId(beat.visual.assetKey, beat.visual.label)),
        },
        elements: beat.elements?.map((element) => {
          if (element.type !== "asset" && element.type !== "logo") return element;
          const label = element.searchHint ?? element.label ?? element.text;
          return {
            ...element,
            resolvedAsset:
              element.resolvedAsset ?? bindings.get(requestId(element.assetKey ?? "generic", label)),
          };
        }),
      })),
    })),
  });

  return { storyboard: prepared, records };
}
