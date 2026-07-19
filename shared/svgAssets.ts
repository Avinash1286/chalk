import type { AssetKey } from "./assetCatalog";
import { renderOpenMojiAsset } from "./openMojiAssets";

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function renderSvgAsset(input: {
  key: AssetKey;
  label?: string;
  box: Box;
  color: string;
  progress: number;
  opacity: number;
  seed: number;
  clipId: string;
}): string {
  // House library first, OpenMoji fallback (resolved inside). When neither
  // matches, draw nothing — an honest gap beats a generic placeholder blob.
  return (
    renderOpenMojiAsset({
      key: input.key,
      label: input.label,
      box: input.box,
      progress: input.progress,
      opacity: input.opacity,
      seed: input.seed,
      clipId: input.clipId,
    }) ?? ""
  );
}
