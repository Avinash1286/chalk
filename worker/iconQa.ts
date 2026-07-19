import sharp from "sharp";
import { qaRecord, saveQaDenylist, setQaRecord } from "../shared/iconQaDenylist";

/**
 * Visual QA gate for candidate icons: rasterize the SVG small and measure how
 * much of it is solid near-black. Mostly-black silhouette glyphs (e.g. "busts
 * in silhouette", filled logo marks) read as broken blobs in the flat-doodle
 * style, so they are denied before the resolver can pick them.
 */

const RASTER = 48;
// An icon is a blob when a large share of the canvas is opaque AND most of that
// ink is near-black. Outlined doodles have high dark share but LOW fill share;
// colorful icons have high fill but low dark share — both pass. Pure silhouettes
// (nearly ALL ink black) are blobs even at moderate fill — but only when the
// dark mass is SOLID (interior-heavy). Thin-stroke outline sketches are also
// ~100% dark ink, yet edge-heavy, and must pass.
const DARK_FRAC = Number(process.env.ICON_QA_DARK_FRAC ?? 0.55);
const FILL_FRAC = Number(process.env.ICON_QA_FILL_FRAC ?? 0.42);
const SILHOUETTE_DARK = Number(process.env.ICON_QA_SILHOUETTE_DARK ?? 0.85);
const SILHOUETTE_FILL = Number(process.env.ICON_QA_SILHOUETTE_FILL ?? 0.28);
const SOLID_DARK = Number(process.env.ICON_QA_SOLID_DARK ?? 0.85);
const SOLID_FILL = Number(process.env.ICON_QA_SOLID_FILL ?? 0.14);
const SOLID_INTERIOR = Number(process.env.ICON_QA_SOLID_INTERIOR ?? 0.55);
// Ghosts: almost NO dark linework on the canvas (light-grey outline rects,
// washed-out glyphs) — invisible at icon scale on a near-white board.
const GHOST_MIN_INK = Number(process.env.ICON_QA_GHOST_MIN_INK ?? 0.015);

async function measure(svgPath: string): Promise<{ darkFrac: number; fillFrac: number; solidFrac: number } | null> {
  try {
    const buf = await sharp(svgPath, { density: 72 })
      .resize(RASTER, RASTER, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const isDark = (px: number): boolean => {
      const i = px * 4;
      return buf[i + 3] >= 48 && buf[i] < 84 && buf[i + 1] < 84 && buf[i + 2] < 84;
    };
    let opaque = 0;
    let dark = 0;
    let interior = 0;
    for (let y = 0; y < RASTER; y += 1) {
      for (let x = 0; x < RASTER; x += 1) {
        const px = y * RASTER + x;
        if (buf[px * 4 + 3] < 48) continue;
        opaque += 1;
        if (!isDark(px)) continue;
        dark += 1;
        // Interior dark pixel: all 4 neighbours are dark too (solid mass, not a
        // thin stroke edge).
        if (
          x > 0 && x < RASTER - 1 && y > 0 && y < RASTER - 1 &&
          isDark(px - 1) && isDark(px + 1) && isDark(px - RASTER) && isDark(px + RASTER)
        ) {
          interior += 1;
        }
      }
    }
    if (!opaque) return null;
    return {
      darkFrac: dark / opaque,
      fillFrac: opaque / (RASTER * RASTER),
      solidFrac: dark > 0 ? interior / dark : 0,
    };
  } catch {
    return null;
  }
}

/**
 * QA-check a batch of candidate icons (iconRef -> svgPath). Already-checked
 * refs are skipped; new verdicts are persisted for the sync resolver.
 */
export async function qaCheckIcons(candidates: Map<string, string>): Promise<void> {
  let changed = false;
  for (const [iconRef, svgPath] of candidates) {
    const existing = qaRecord(iconRef);
    // A manual verdict (set in the asset studio) is sticky — never overwrite it.
    if (existing?.source === "manual") continue;
    // Re-measure records from before the solidity metric existed.
    if (existing?.solidFrac !== undefined) continue;
    const stats = await measure(svgPath);
    if (!stats) continue;
    const inkCanvasFrac = stats.darkFrac * stats.fillFrac;
    const denied =
      (stats.darkFrac >= DARK_FRAC && stats.fillFrac >= FILL_FRAC) ||
      (stats.darkFrac >= SILHOUETTE_DARK && stats.fillFrac >= SILHOUETTE_FILL) ||
      (stats.darkFrac >= SOLID_DARK && stats.fillFrac >= SOLID_FILL && stats.solidFrac >= SOLID_INTERIOR) ||
      inkCanvasFrac < GHOST_MIN_INK;
    setQaRecord(iconRef, {
      darkFrac: Math.round(stats.darkFrac * 1000) / 1000,
      fillFrac: Math.round(stats.fillFrac * 1000) / 1000,
      solidFrac: Math.round(stats.solidFrac * 1000) / 1000,
      denied,
    });
    changed = true;
    if (denied) {
      console.warn(
        `Icon QA denied ${iconRef} (dark ${stats.darkFrac.toFixed(2)}, fill ${stats.fillFrac.toFixed(2)}, solid ${stats.solidFrac.toFixed(2)})`,
      );
    }
  }
  if (changed) saveQaDenylist();
}
