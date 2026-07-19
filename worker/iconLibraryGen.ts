import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import ImageTracer from "imagetracerjs";
import {
  ICON_OUTLINE,
  ICON_PALETTE,
  conceptSlug,
  findLibraryIcon,
  iconLibraryPngDir,
  iconLibraryRoot,
  iconLibrarySvgDir,
  normalizeConcept,
  writeLibraryEntry,
  type IconLibraryEntry,
} from "../shared/iconLibrary";
import { ICON_IMAGE_MODEL, callGeminiVisionJson, generateImage, imageGenAvailable } from "./imageGen";

/**
 * Icon-library generation: one style-locked doodle icon per concept.
 *
 *   Gemini image model  →  background removal  →  vectorize (imagetracer)
 *   →  palette snap + outline/color split  →  programmatic QA  →  vision QA
 *   →  assets/generated/icon-library/{svg,png}/<slug>.*  + manifest entry
 *
 * The emitted SVG mimics OpenMoji's structure (color paths first, then a
 * <g id="line"> outline group) so the renderer's outline-then-fill reveal
 * works unchanged.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const anchorsDir = path.join(iconLibraryRoot, "anchors");

const TRACE_SIZE = 512;
// Background sentinel — never occurs in generated icons, so its traced paths
// can be dropped unambiguously after vectorization.
const SENTINEL = { r: 255, g: 0, b: 255 };

// ---------------------------------------------------------------------------
// Style contract
// ---------------------------------------------------------------------------

export function styleContractPrompt(concept: string, label?: string): string {
  const subject = label && normalizeConcept(label) !== normalizeConcept(concept) ? `${concept} (${label})` : concept;
  return `You are the staff illustrator for a hand-drawn whiteboard explainer video. Draw ONE icon, in exactly the same visual style as the reference icons provided.

SUBJECT: ${subject}

Choose the single most ICONIC, instantly recognizable depiction — the simple, front-facing object a person would doodle on a whiteboard to mean "${subject}". If the subject is abstract, depict its most universal concrete symbol instead of anything literal-but-obscure.

STYLE — must match the references exactly:
- One thick, uniform, dark-charcoal (#1a1a1a) outline around every shape, with a slight hand-drawn wobble and rounded line ends. The outline is BOLD — it must stay visible when the icon is shrunk to 100 pixels.
- FLAT saturated fills only, from this exact palette: ${ICON_PALETTE.join(", ")}. Use 1–3 of these colors, picking the most natural color for the subject (not everything blue).
- At most ONE lighter or darker flat accent region as shading. No gradients, no drop shadows, no texture, no 3D, no glossy highlights.
- At most TWO small interior detail shapes. Minimal and playful — clarity beats detail.
- Do NOT put a face, eyes, or a smile on the object.

CANVAS:
- Plain PURE WHITE background — nothing else in the frame: no border, no frame, no ground line, no shadow under the object, no sparkles, no decorative dots, no background shapes.
- The object is centered and fills 70–80% of the square canvas — draw it BIG.

ABSOLUTELY FORBIDDEN — the icon is automatically rejected if it contains:
- ANY text, letters, numbers, or typographic symbols anywhere in the image
- more than one object, a scene, or a collage of items
- a dark or colored background
- watermarks or signatures

Output: the single icon image only.`;
}

// ---------------------------------------------------------------------------
// Raster processing: background removal (flood fill from the borders)
// ---------------------------------------------------------------------------

function isBackgroundPixel(data: Buffer, idx: number): boolean {
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  // Near-white and low-saturation: the plain background the contract demands.
  return r >= 218 && g >= 218 && b >= 218 && Math.max(r, g, b) - Math.min(r, g, b) <= 18;
}

/**
 * Replace the border-connected near-white background with the magenta sentinel,
 * then dilate one step into the anti-aliased halo so quantization can't leave a
 * pale fringe around the icon. Interior whites (eyes, highlights) survive.
 */
function paintBackgroundSentinel(data: Buffer, width: number, height: number): void {
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * width + x;
    if (visited[p]) return;
    if (!isBackgroundPixel(data, p * 4)) return;
    visited[p] = 1;
    queue.push(p);
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (queue.length) {
    const p = queue.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  // Dilate one step: light pixels adjacent to background join it (halo cleanup).
  const halo: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (visited[p]) continue;
      const idx = p * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (lum < 180) continue;
      const nearBg =
        (x > 0 && visited[p - 1]) ||
        (x < width - 1 && visited[p + 1]) ||
        (y > 0 && visited[p - width]) ||
        (y < height - 1 && visited[p + width]);
      if (nearBg) halo.push(p);
    }
  }
  for (const p of halo) visited[p] = 1;
  for (let p = 0; p < width * height; p += 1) {
    if (!visited[p]) continue;
    const idx = p * 4;
    data[idx] = SENTINEL.r;
    data[idx + 1] = SENTINEL.g;
    data[idx + 2] = SENTINEL.b;
    data[idx + 3] = 255;
  }
}

// ---------------------------------------------------------------------------
// Vectorization + normalization
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

const PALETTE_RGB = ICON_PALETTE.map((hex) => ({ hex, ...hexToRgb(hex) }));

function isSentinelColor(r: number, g: number, b: number): boolean {
  return r > 200 && b > 200 && g < 100;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

const PALETTE_HSL = PALETTE_RGB.map((c) => ({ hex: c.hex, ...rgbToHsl(c.r, c.g, c.b) }));

/**
 * Snap a color to the house style: dark ink → outline, unsaturated/very light →
 * white, everything else → the palette color with the nearest HUE. Hue (not RGB
 * distance) keeps a pale blue snapping to BLUE instead of drifting to cyan —
 * this is what makes every icon share the exact same saturated fills.
 */
function snapColor(r: number, g: number, b: number): string {
  if (Math.max(r, g, b) < 96) return ICON_OUTLINE;
  const { h, s, l } = rgbToHsl(r, g, b);
  if (l < 0.2) return ICON_OUTLINE;
  if (s < 0.16 || l > 0.96) return "#ffffff";
  let best = PALETTE_HSL[0];
  let bestDist = Infinity;
  for (const target of PALETTE_HSL) {
    const dh = Math.min(Math.abs(h - target.h), 360 - Math.abs(h - target.h)) / 180;
    const dist = dh * dh + 0.15 * (s - target.s) ** 2 + 0.3 * (l - target.l) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = target;
    }
  }
  return best.hex;
}

/**
 * Pre-quantize every non-sentinel pixel to the house colors BEFORE tracing.
 * Doing it in pixel space (and handing the tracer a FIXED palette) keeps the
 * huge sentinel/background mass from distorting the tracer's color sampling.
 */
function quantizeToHousePalette(data: Buffer, width: number, height: number): void {
  const cache = new Map<number, { r: number; g: number; b: number }>();
  for (let p = 0; p < width * height; p += 1) {
    const idx = p * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    if (isSentinelColor(r, g, b)) continue;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let snapped = cache.get(key);
    if (!snapped) {
      snapped = hexToRgb(snapColor(r, g, b));
      cache.set(key, snapped);
    }
    data[idx] = snapped.r;
    data[idx + 1] = snapped.g;
    data[idx + 2] = snapped.b;
  }
}

type TracedPath = { fill: string; d: string; opacity: number };

function parseTracedPaths(svg: string): TracedPath[] {
  const out: TracedPath[] = [];
  const pathRe = /<path([^>]*)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(svg))) {
    const attrs = match[1];
    const fill = attrs.match(/fill="rgb\((\d+),(\d+),(\d+)\)"/);
    const d = attrs.match(/\sd="([^"]+)"/)?.[1];
    const opacity = Number(attrs.match(/opacity="([\d.]+)"/)?.[1] ?? 1);
    if (!fill || !d) continue;
    const r = Number(fill[1]);
    const g = Number(fill[2]);
    const b = Number(fill[3]);
    if (isSentinelColor(r, g, b)) continue; // background
    if (opacity < 0.2) continue;
    out.push({ fill: snapColor(r, g, b), d, opacity: 1 });
  }
  return out;
}

/**
 * Vectorize a processed raster into the library SVG: flat color paths first,
 * then the dark outline paths inside <g id="line"> (the renderer wipes the line
 * group in ahead of the color flood, exactly like OpenMoji icons).
 */
export function vectorizeIcon(raw: Buffer, width: number, height: number): { svg: string; pathCount: number } {
  const imgd = { width, height, data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, width * height * 4) };
  // Fixed palette (pixels are already snapped to it) — colorsampling off and a
  // single quant cycle so the tracer can't invent averaged in-between colors.
  const pal = [
    { ...SENTINEL, a: 255 },
    { ...hexToRgb(ICON_OUTLINE), a: 255 },
    { r: 255, g: 255, b: 255, a: 255 },
    ...PALETTE_RGB.map((c) => ({ r: c.r, g: c.g, b: c.b, a: 255 })),
  ];
  const traced: string = ImageTracer.imagedataToSVG(imgd, {
    pal,
    colorsampling: 0,
    numberofcolors: pal.length,
    colorquantcycles: 1,
    ltres: 1,
    qtres: 1,
    pathomit: 12,
    strokewidth: 0,
    roundcoords: 1,
    viewbox: true,
    desc: false,
    linefilter: true,
  });
  const paths = parseTracedPaths(traced);
  const colorPaths = paths.filter((p) => p.fill !== ICON_OUTLINE);
  const linePaths = paths.filter((p) => p.fill === ICON_OUTLINE);
  const toMarkup = (list: TracedPath[]) => list.map((p) => `    <path fill="${p.fill}" d="${p.d}"/>`).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g id="color">
${toMarkup(colorPaths)}
  </g>
  <g id="line">
${toMarkup(linePaths)}
  </g>
</svg>`;
  return { svg, pathCount: paths.length };
}

// ---------------------------------------------------------------------------
// QA
// ---------------------------------------------------------------------------

type IconStats = { inkFrac: number; coverage: number; colorFrac: number };

/** Rasterize the final SVG and measure ink/coverage/colorfulness. */
async function measureIcon(svg: string): Promise<IconStats | null> {
  const size = 96;
  try {
    const buf = await sharp(Buffer.from(svg))
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer();
    let opaque = 0;
    let dark = 0;
    let colored = 0;
    let minX = size;
    let minY = size;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = (y * size + x) * 4;
        if (buf[idx + 3] < 48) continue;
        opaque += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        const r = buf[idx];
        const g = buf[idx + 1];
        const b = buf[idx + 2];
        if (Math.max(r, g, b) < 90) dark += 1;
        else if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored += 1;
      }
    }
    if (!opaque || maxX < 0) return null;
    const bboxArea = (maxX - minX + 1) * (maxY - minY + 1);
    return {
      inkFrac: dark / opaque,
      coverage: bboxArea / (size * size),
      colorFrac: colored / opaque,
    };
  } catch {
    return null;
  }
}

function statsPass(stats: IconStats | null, pathCount: number): { ok: boolean; reason?: string } {
  if (!stats) return { ok: false, reason: "raster measurement failed" };
  if (pathCount < 2) return { ok: false, reason: "too few vector paths (blank trace)" };
  if (pathCount > 400) return { ok: false, reason: `too many vector paths (${pathCount}) — noisy trace` };
  if (stats.coverage < 0.3) return { ok: false, reason: `icon too small on canvas (coverage ${stats.coverage.toFixed(2)})` };
  if (stats.coverage > 0.97) return { ok: false, reason: "icon bleeds to the canvas edge" };
  if (stats.inkFrac < 0.04) return { ok: false, reason: "no visible outline ink" };
  if (stats.inkFrac > 0.75) return { ok: false, reason: "near-silhouette (too much black)" };
  return { ok: true };
}

type VisionVerdict = { depicts: boolean; singleObject: boolean; styleOk: boolean; critique?: string };

async function visionQa(png: Buffer, concept: string, anchors: Buffer[]): Promise<VisionVerdict> {
  const anchorNote = anchors.length
    ? `The FIRST image is the candidate icon. The ${anchors.length} image(s) after it are approved style references from the same library.`
    : `The image is the candidate icon.`;
  const raw = (await callGeminiVisionJson(
    "IconLibraryQA",
    `${anchorNote}
Judge the candidate icon for a hand-drawn whiteboard explainer library.
Return ONLY JSON: {
  "depicts": boolean,      // would a viewer recognize it as "${concept}" WITHOUT a label?
  "singleObject": boolean, // one clean object, not a scene/collage; no text or letters
  "styleOk": boolean,      // flat doodle with thick dark outline${anchors.length ? ", consistent with the reference style" : ""}
  "critique": string       // <= 20 words: what to fix if any check failed
}`,
    [png, ...anchors],
  )) as Record<string, unknown>;
  return {
    depicts: Boolean(raw?.depicts),
    singleObject: Boolean(raw?.singleObject),
    styleOk: Boolean(raw?.styleOk),
    critique: typeof raw?.critique === "string" ? raw.critique : undefined,
  };
}

// ---------------------------------------------------------------------------
// Golden anchors (style references passed with every generation)
// ---------------------------------------------------------------------------

let anchorCache: Buffer[] | undefined;

export function loadStyleAnchors(limit = 4): Buffer[] {
  if (anchorCache) return anchorCache.slice(0, limit);
  anchorCache = [];
  if (existsSync(anchorsDir)) {
    for (const file of readdirSync(anchorsDir).sort()) {
      if (!/\.(png|jpg|jpeg)$/i.test(file)) continue;
      try {
        anchorCache.push(readFileSync(path.join(anchorsDir, file)));
      } catch {
        // unreadable anchor — skip
      }
    }
  }
  return anchorCache.slice(0, limit);
}

export function reloadStyleAnchors(): void {
  anchorCache = undefined;
}

// ---------------------------------------------------------------------------
// Full per-concept pipeline
// ---------------------------------------------------------------------------

export type GenerateIconResult =
  | { ok: true; entry: IconLibraryEntry }
  | { ok: false; reason: string };

/** Bounding box of non-background content, or null when the canvas is blank. */
function contentBBox(data: Buffer, width: number, height: number): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isBackgroundPixel(data, (y * width + x) * 4)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Process one generated raster into the final SVG + preview PNG. */
export async function processIconRaster(
  png: Buffer,
): Promise<{ svg: string; pathCount: number; stats: IconStats | null; preview: Buffer; sourceCoverage: number }> {
  const first = await sharp(png)
    .flatten({ background: "#ffffff" })
    .resize(TRACE_SIZE, TRACE_SIZE, { fit: "contain", background: "#ffffff" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Normalize scale: crop to the drawn content (+8% margin) and re-fit, so every
  // library icon fills its viewBox the same amount — icons render at a uniform
  // visual size regardless of how large the model happened to draw them.
  const bbox = contentBBox(first.data, first.info.width, first.info.height);
  const sourceCoverage = bbox ? (bbox.w * bbox.h) / (first.info.width * first.info.height) : 0;
  let data = first.data;
  let info = first.info;
  if (bbox && sourceCoverage > 0.02 && sourceCoverage < 0.8) {
    const margin = Math.round(Math.max(bbox.w, bbox.h) * 0.08);
    const left = Math.max(0, bbox.x - margin);
    const top = Math.max(0, bbox.y - margin);
    const cropW = Math.min(first.info.width - left, bbox.w + margin * 2);
    const cropH = Math.min(first.info.height - top, bbox.h + margin * 2);
    const refit = await sharp(first.data, { raw: { width: first.info.width, height: first.info.height, channels: 4 } })
      .extract({ left, top, width: cropW, height: cropH })
      .resize(TRACE_SIZE, TRACE_SIZE, { fit: "contain", background: "#ffffff" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = refit.data;
    info = refit.info;
  }

  paintBackgroundSentinel(data, info.width, info.height);
  quantizeToHousePalette(data, info.width, info.height);
  const { svg, pathCount } = vectorizeIcon(data, info.width, info.height);
  const stats = await measureIcon(svg);
  const preview = await sharp(Buffer.from(svg)).resize(256, 256, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer();
  return { svg, pathCount, stats, preview, sourceCoverage };
}

/**
 * Generate (or return the existing) library icon for a concept. ONE generation
 * attempt by default: a QA rejection fails the concept immediately (no
 * regenerate loop — the prompt is engineered for first-try success, and API /
 * transport errors already retry with backoff inside generateImage). A failed
 * concept is reported, not written — the resolver falls back, and any later
 * batch rerun tries it again since it never entered the manifest.
 */
export async function ensureLibraryIcon(input: {
  concept: string;
  label?: string;
  synonyms?: string[];
  attempts?: number;
  skipVisionQa?: boolean;
  log?: (message: string) => void;
}): Promise<GenerateIconResult> {
  const log = input.log ?? (() => {});
  const existing = findLibraryIcon(input.concept, input.label);
  if (existing) return { ok: true, entry: existing };
  if (!imageGenAvailable()) {
    return { ok: false, reason: "Google credentials unavailable for image generation." };
  }

  // Unique id: the concept key, plus the label when it adds information — two
  // different concepts can share a display label, and ids must never collide.
  const slug = conceptSlug(
    [
      input.concept,
      input.label && normalizeConcept(input.label) !== normalizeConcept(input.concept) ? input.label : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  const anchors = loadStyleAnchors();
  const attempts = Math.max(1, input.attempts ?? 1);
  let critique = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const prompt = critique
        ? `${styleContractPrompt(input.concept, input.label)}\n\nThe previous attempt failed QA: ${critique}. Fix that.`
        : styleContractPrompt(input.concept, input.label);
      log(`icon "${slug}": generating (attempt ${attempt}/${attempts})`);
      const png = await generateImage({ prompt, referenceImages: anchors });
      const { svg, pathCount, stats, preview, sourceCoverage } = await processIconRaster(png);

      if (sourceCoverage < 0.06) {
        critique = "the drawn object is tiny or the canvas is blank — draw ONE object filling ~70% of the frame";
        log(`icon "${slug}": ${critique}`);
        continue;
      }
      const programmatic = statsPass(stats, pathCount);
      if (!programmatic.ok) {
        critique = programmatic.reason ?? "failed programmatic checks";
        log(`icon "${slug}": ${critique}`);
        continue;
      }

      let vision: VisionVerdict = { depicts: true, singleObject: true, styleOk: true };
      if (!input.skipVisionQa) {
        vision = await visionQa(preview, input.label || input.concept, anchors);
        if (!vision.depicts || !vision.singleObject || !vision.styleOk) {
          critique = vision.critique || "vision QA rejected the icon";
          log(`icon "${slug}": vision QA failed — ${critique}`);
          continue;
        }
      }

      mkdirSync(iconLibrarySvgDir, { recursive: true });
      mkdirSync(iconLibraryPngDir, { recursive: true });
      const svgRel = `assets/generated/icon-library/svg/${slug}.svg`;
      const pngRel = `assets/generated/icon-library/png/${slug}.png`;
      writeFileSync(path.join(root, svgRel), `${svg}\n`, "utf8");
      writeFileSync(path.join(root, pngRel), png);

      const entry = writeLibraryEntry({
        id: slug,
        concept: normalizeConcept(input.concept),
        label: input.label ?? input.concept,
        synonyms: [...new Set((input.synonyms ?? []).map(normalizeConcept).filter(Boolean))],
        svgPath: svgRel,
        pngPath: pngRel,
        model: ICON_IMAGE_MODEL(),
        createdAt: new Date().toISOString(),
        qa: {
          depicts: vision.depicts,
          styleOk: vision.styleOk,
          inkFrac: Math.round((stats?.inkFrac ?? 0) * 1000) / 1000,
          coverage: Math.round((stats?.coverage ?? 0) * 1000) / 1000,
        },
      });
      log(`icon "${slug}": accepted (${pathCount} paths, coverage ${(stats?.coverage ?? 0).toFixed(2)})`);
      return { ok: true, entry };
    } catch (error) {
      critique = String(error).slice(0, 200);
      log(`icon "${slug}": attempt ${attempt} errored — ${critique}`);
    }
  }
  return { ok: false, reason: `all ${attempts} attempts failed QA (${critique})` };
}
