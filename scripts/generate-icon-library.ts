import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../shared/loadDotenv";
import { assetCatalog, assetKeys, type KnownAssetKey } from "../shared/assetCatalog";
import {
  findLibraryIcon,
  iconLibraryEntries,
  iconLibraryRoot,
  normalizeConcept,
  reloadIconLibrary,
} from "../shared/iconLibrary";
import { writeLibraryIndex } from "../shared/iconLibraryEmbeddings";
import { embeddingsAvailable, embedTexts, EMBED_DIM } from "../worker/embeddings";
import { ensureLibraryIcon, loadStyleAnchors, styleContractPrompt } from "../worker/iconLibraryGen";
import { generateImage, imageGenAvailable } from "../worker/imageGen";

/**
 * Build the house icon library (Lamina-style doodle icons).
 *
 *   npx tsx scripts/generate-icon-library.ts --anchors
 *       Generate 3 candidates for each archetype concept into
 *       assets/generated/icon-library/anchor-candidates/. Hand-pick the best,
 *       copy them into assets/generated/icon-library/anchors/ — they become the
 *       style references locked into every later generation.
 *
 *   npx tsx scripts/generate-icon-library.ts
 *       Generate an icon for every curated asset-catalog concept (skips ones
 *       already in the manifest), then rebuild the embedding index.
 *
 *   npx tsx scripts/generate-icon-library.ts --concepts "rocket,piggy bank"
 *   npx tsx scripts/generate-icon-library.ts --file concepts.txt
 *   npx tsx scripts/generate-icon-library.ts --index-only
 *
 *   npx tsx scripts/generate-icon-library.ts --openmoji
 *       Generate a house-style icon for EVERY meaningful OpenMoji concept
 *       (~2,200 after dropping flags, skin-tone variants and duplicates), so the
 *       library can fully replace OpenMoji. Resumable: already-covered concepts
 *       are skipped, so rerun the same command after any interruption.
 *
 * Flags: --limit N   --concurrency N (default 2)   --skip-vision-qa
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

type Args = {
  anchors: boolean;
  indexOnly: boolean;
  openmoji: boolean;
  skipVisionQa: boolean;
  limit: number;
  concurrency: number;
  concurrencyExplicit?: boolean;
  concepts: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = { anchors: false, indexOnly: false, openmoji: false, skipVisionQa: false, limit: Infinity, concurrency: 2, concepts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--anchors") args.anchors = true;
    else if (arg === "--openmoji") args.openmoji = true;
    else if (arg === "--index-only") args.indexOnly = true;
    else if (arg === "--skip-vision-qa") args.skipVisionQa = true;
    else if (arg === "--limit") args.limit = Number(argv[++i] ?? Infinity) || Infinity;
    else if (arg === "--concurrency") {
      args.concurrency = Math.max(1, Number(argv[++i] ?? 2) || 2);
      args.concurrencyExplicit = true;
    }
    else if (arg === "--concepts") {
      args.concepts.push(...String(argv[++i] ?? "").split(",").map((c) => c.trim()).filter(Boolean));
    } else if (arg === "--file") {
      const file = String(argv[++i] ?? "");
      args.concepts.push(
        ...readFileSync(path.resolve(root, file), "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#")),
      );
    }
  }
  return args;
}

type Concept = { concept: string; label: string; synonyms: string[] };

function catalogConcepts(): Concept[] {
  return assetKeys.map((key: KnownAssetKey) => ({
    concept: key,
    label: assetCatalog[key].label,
    synonyms: assetCatalog[key].tags,
  }));
}

type OpenMojiSearchIndex = {
  entries: { hexcode: string; label: string; concepts: string[]; group: string; subgroup: string }[];
};

// Concepts that can NEVER pass the icon QA (or make no sense as doodles), so
// generating them only burns money: anything flag-like (state/regional flags
// hide outside the unicode flags group), text-bearing symbols (blood-type and
// UI buttons, keycaps, ordinal medals), and the 24 "N o'clock" clock faces.
const DOOMED_LABEL = /\bflags?\b|\bbutton\b|\bkeycap\b|o.clock\b|(1st|2nd|3rd) place|\bsymbol for\b/i;

/**
 * Every meaningful OpenMoji concept: drop flags, skin-tone components and
 * text-doomed symbols (no value in a whiteboard explainer), dedupe by
 * normalized label, keep the OpenMoji concept keywords as synonyms so search
 * coverage carries over.
 */
function openMojiConcepts(): Concept[] {
  const indexPath = path.join(root, "assets", "vendor", "openmoji", "search-index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as OpenMojiSearchIndex;
  const out: Concept[] = [];
  const seen = new Set<string>();
  for (const entry of index.entries) {
    if (entry.group === "flags" || entry.group === "component") continue;
    if (/skin tone/i.test(entry.label)) continue;
    if (DOOMED_LABEL.test(entry.label)) continue;
    const key = normalizeConcept(entry.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const taxonomy = new Set([normalizeConcept(entry.group), normalizeConcept(entry.subgroup)]);
    const synonyms = entry.concepts
      .map(normalizeConcept)
      .filter((c) => c && c !== key && !taxonomy.has(c))
      .slice(0, 8);
    out.push({ concept: entry.label, label: entry.label, synonyms });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

// Archetype concepts for the golden anchor set — a spread of shapes (object,
// creature, building, device, symbol) so the style locks across categories.
const ANCHOR_CONCEPTS = [
  "light bulb",
  "rocket",
  "bank building",
  "padlock",
  "brain",
  "robot",
  "magnifying glass",
  "piggy bank",
  "gear",
  "trophy",
  "hourglass",
  "shield",
];

async function generateAnchorCandidates(): Promise<void> {
  if (!imageGenAvailable()) {
    throw new Error("Google credentials are required (GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS).");
  }
  const outDir = path.join(iconLibraryRoot, "anchor-candidates");
  mkdirSync(outDir, { recursive: true });
  for (const concept of ANCHOR_CONCEPTS) {
    for (let variant = 1; variant <= 3; variant += 1) {
      const file = path.join(outDir, `${normalizeConcept(concept).replace(/\s+/g, "-")}_${variant}.png`);
      if (existsSync(file)) {
        console.log(`anchor ${path.basename(file)}: exists, skipping`);
        continue;
      }
      try {
        const png = await generateImage({ prompt: styleContractPrompt(concept) });
        writeFileSync(file, png);
        console.log(`anchor ${path.basename(file)}: written`);
      } catch (error) {
        console.warn(`anchor ${path.basename(file)}: failed — ${String(error)}`);
      }
    }
  }
  console.log(`\nAnchor candidates in ${outDir}`);
  console.log(`Pick the best (aim for 10-15 across different concepts) and COPY them into:`);
  console.log(`  ${path.join(iconLibraryRoot, "anchors")}`);
  console.log(`Those become the style references for every subsequent generation.`);
}

async function rebuildIndex(): Promise<void> {
  reloadIconLibrary();
  const entries = iconLibraryEntries();
  if (!entries.length) {
    console.log("Index: library is empty — nothing to index.");
    return;
  }
  if (!embeddingsAvailable()) {
    console.warn("Index: embeddings unavailable (no Google credentials) — direct concept matching still works.");
    return;
  }
  const docs = entries.map((entry) => [entry.label, entry.concept, ...entry.synonyms].filter(Boolean).join(". "));
  console.log(`Index: embedding ${docs.length} library entries...`);
  const vectors = await embedTexts(docs, "RETRIEVAL_DOCUMENT", (done, total) => {
    console.log(`Index: ${done}/${total}`);
  });
  writeLibraryIndex(
    EMBED_DIM,
    entries.map((entry) => ({ id: entry.id, label: entry.label, svgPath: entry.svgPath })),
    vectors,
  );
  console.log(`Index: wrote ${entries.length} vectors.`);
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.anchors) {
    await generateAnchorCandidates();
    return;
  }
  if (args.indexOnly) {
    await rebuildIndex();
    return;
  }

  if (!imageGenAvailable()) {
    throw new Error("Google credentials are required (GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS).");
  }
  if (!loadStyleAnchors().length) {
    console.warn(
      "WARNING: no style anchors found in assets/generated/icon-library/anchors/ — style will drift between icons.\n" +
        "Run with --anchors first, hand-pick the golden set, then re-run this batch.",
    );
  }

  const wanted: Concept[] = args.concepts.length
    ? args.concepts.map((concept) => ({ concept, label: concept, synonyms: [] }))
    : args.openmoji
      ? openMojiConcepts()
      : catalogConcepts();

  // The parallel-5 default for the big OpenMoji replacement run (an explicit
  // --concurrency always wins).
  const concurrency = args.openmoji && !args.concurrencyExplicit ? 5 : args.concurrency;

  // findLibraryIcon also matches labels/synonyms, so concepts already covered
  // by an earlier run (or an equivalent icon) are skipped, making reruns cheap.
  const todo = wanted
    .filter((c) => !findLibraryIcon(c.concept, c.label))
    .slice(0, Number.isFinite(args.limit) ? args.limit : undefined);

  console.log(
    `Library: ${iconLibraryEntries().length} existing icons; generating ${todo.length} of ${wanted.length} concepts (concurrency ${concurrency}).`,
  );
  let ok = 0;
  let failed = 0;
  const started = Date.now();
  await mapWithConcurrency(todo, concurrency, async (concept) => {
    const result = await ensureLibraryIcon({
      concept: concept.concept,
      label: concept.label,
      synonyms: concept.synonyms,
      skipVisionQa: args.skipVisionQa,
      log: (message) => console.log(message),
    });
    if (result.ok) ok += 1;
    else {
      failed += 1;
      console.warn(`FAILED "${concept.concept}": ${result.reason}`);
    }
    const done = ok + failed;
    if (done % 25 === 0 || done === todo.length) {
      const perMin = done / Math.max(1, (Date.now() - started) / 60000);
      const etaMin = Math.round((todo.length - done) / Math.max(0.1, perMin));
      console.log(`--- progress: ${done}/${todo.length} (${ok} ok, ${failed} failed) · ${perMin.toFixed(1)}/min · ~${etaMin} min left ---`);
    }
  });
  console.log(`\nDone: ${ok} accepted, ${failed} failed.`);

  await rebuildIndex();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
