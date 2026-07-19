import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { CompiledVideo } from "../shared/layout";
import { renderFrameSvg } from "../shared/svgFrame";
import { assertMediaDurationsAligned, probeMediaDurations, runCommand } from "./ffmpeg";

const NARRATION_FILTER = "loudnorm=I=-20:TP=-3:LRA=5";
// PNG concat packets use a 25fps time base and round declared timestamps to
// 40ms. Keep the sentinel farther inside the audio endpoint than that rounding
// quantum so -shortest cannot discard it and erase the final held-frame run.
const CONCAT_SENTINEL_MARGIN_SECONDS = 0.06;

function concatRunDuration(frameCount: number, fps: number, finalRun: boolean): number {
  const duration = frameCount / fps;
  return finalRun ? Math.max(0.001, duration - CONCAT_SENTINEL_MARGIN_SECONDS) : duration;
}

export type RenderProgress = {
  stage: "frames" | "encoding";
  progress: number;
  message: string;
};

export type HlsOptions = {
  /** Target segment length in seconds (HLS sweet spot is 2–6s). */
  segmentSeconds?: number;
  /** Called once per encoded MPEG-TS segment, strictly in order (0, 1, 2, …). */
  onSegment: (segmentPath: string, index: number, durationSeconds: number) => void | Promise<void>;
  /** Called after the LAST segment's onSegment resolves (playlist can end). */
  onComplete?: () => void | Promise<void>;
};

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Run async jobs over items with bounded concurrency (frame rasterisation is
// CPU-bound in sharp/libvips; a small pool saturates the cores without
// thrashing them).
async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker()));
}

// ffconcat entries want POSIX-style separators and quoted paths.
function concatPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function writeContactSheet(
  compiled: CompiledVideo,
  frameFileAt: (frame: number) => string,
  outputDir: string,
  frameCount: number,
): Promise<string> {
  const intervalSeconds = 4;
  const samples: { frame: number; time: number }[] = [];
  for (let time = 0; time < compiled.duration; time += intervalSeconds) {
    samples.push({
      frame: Math.min(frameCount - 1, Math.round(time * compiled.fps)),
      time,
    });
  }
  if (!samples.length) {
    samples.push({ frame: 0, time: 0 });
  }

  const thumbWidth = 320;
  const thumbHeight = 180;
  const labelHeight = 28;
  const cols = 4;
  const rows = Math.ceil(samples.length / cols);
  const width = cols * thumbWidth;
  const height = rows * (thumbHeight + labelHeight);
  const composites: sharp.OverlayOptions[] = [];

  for (const [index, sample] of samples.entries()) {
    const left = (index % cols) * thumbWidth;
    const top = Math.floor(index / cols) * (thumbHeight + labelHeight);
    const filePath = frameFileAt(sample.frame);
    const frame = await sharp(filePath).resize(thumbWidth, thumbHeight, { fit: "cover" }).png().toBuffer();
    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${thumbWidth}" height="${labelHeight}">
        <rect width="100%" height="100%" fill="#fbfbfa"/>
        <text x="10" y="20" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#333">${esc(sample.time.toFixed(1))}s</text>
      </svg>`,
    );
    composites.push({ input: frame, left, top });
    composites.push({ input: label, left, top: top + thumbHeight });
  }

  const outputPath = path.join(outputDir, "contact-sheet.jpg");
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#fbfbfa",
    },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toFile(outputPath);

  return outputPath;
}

// Write an ffconcat covering frames [startFrame, endFrame) — the same
// run-collapsing dedup trick the final encode uses, scoped to one segment.
function segmentConcatLines(
  frameHashes: string[],
  fileForHash: (hash: string) => string,
  startFrame: number,
  endFrame: number,
  fps: number,
): string {
  const lines = ["ffconcat version 1.0"];
  let runStart = startFrame;
  for (let frame = startFrame + 1; frame <= endFrame; frame += 1) {
    if (frame === endFrame || frameHashes[frame] !== frameHashes[runStart]) {
      const duration = concatRunDuration(frame - runStart, fps, frame === endFrame);
      lines.push(
        `file '${concatPath(fileForHash(frameHashes[runStart]))}'`,
        `duration ${duration.toFixed(6)}`,
      );
      runStart = frame;
    }
  }
  // Concat-demuxer quirk: the final entry's duration is only honoured when the
  // file is listed once more after it.
  lines.push(`file '${concatPath(fileForHash(frameHashes[endFrame - 1]))}'`);
  return `${lines.join("\n")}\n`;
}

// One independent MPEG-TS segment: the segment's frames plus the matching audio
// slice. Every segment starts with its own IDR frame (each encode is fresh) and
// carries a PTS offset to its absolute position, so segments concatenate into
// one continuous stream — a textbook live-HLS EVENT feed.
function encodeSegmentArgs(
  concatFile: string,
  audioPath: string,
  output: string,
  fps: number,
  startSec: number,
  durSec: number,
): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatFile,
    "-ss", startSec.toFixed(3), "-t", durSec.toFixed(3), "-i", audioPath,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-r", String(fps), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-af", NARRATION_FILTER,
    "-muxdelay", "0", "-output_ts_offset", startSec.toFixed(3),
    "-f", "mpegts", output,
  ];
}

export async function renderVideo(
  compiled: CompiledVideo,
  audioPath: string,
  outputDir: string,
  onProgress?: (progress: RenderProgress) => void | Promise<void>,
  hls?: HlsOptions,
): Promise<string> {
  const framesDir = path.join(outputDir, "frames");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  // Keep the concat sentinel inside the narration timeline. With ceil(), the
  // repeated final packet can land just after the audio endpoint; -shortest then
  // drops it and ffmpeg loses the entire duration of the last held frame.
  const frameCount = Math.max(1, Math.floor(compiled.duration * compiled.fps));

  // 1) Generate every frame's SVG and DEDUPLICATE by content hash.
  // renderFrameSvg is a pure function of time, and a whiteboard video holds
  // still between reveals — so long runs of frames are byte-identical and only
  // the unique ones need rasterising (typically 25-50% of the total).
  const frameHashes: string[] = new Array(frameCount);
  const uniqueByHash = new Map<string, { file: string; svg: string; hash: string }>();
  for (let frame = 0; frame < frameCount; frame += 1) {
    const svg = renderFrameSvg(compiled, frame / compiled.fps);
    const hash = createHash("sha1").update(svg).digest("hex");
    frameHashes[frame] = hash;
    if (!uniqueByHash.has(hash)) {
      uniqueByHash.set(hash, {
        file: path.join(framesDir, `u_${String(uniqueByHash.size).padStart(5, "0")}.png`),
        svg,
        hash,
      });
    }
  }
  const uniqueFrames = [...uniqueByHash.values()];

  // ── Live HLS segment encoder ────────────────────────────────────────────────
  // Runs BESIDE the frame pool, never blocking it: as the CONTIGUOUS rendered
  // frontier (frames 0..k all rasterised — dedup counts: a frame is ready when
  // its canonical unique file exists) crosses each ~6s boundary, that segment is
  // encoded ONCE as MPEG-TS and onSegment fires. Segments encode strictly in
  // order, one at a time. A segment failure kills the STREAM only — the final
  // MP4 (the job's source of truth) still completes.
  const segSeconds = Math.max(2, Number(hls?.segmentSeconds ?? process.env.HLS_SEGMENT_SECONDS ?? 6));
  const segFrames = Math.max(1, Math.round(segSeconds * compiled.fps));
  const segCount = hls ? Math.ceil(frameCount / segFrames) : 0;
  const hlsDir = path.join(outputDir, "hls");
  if (hls) {
    await rm(hlsDir, { recursive: true, force: true });
    await mkdir(hlsDir, { recursive: true });
  }
  const doneByHash = new Set<string>();
  const fileForHash = (hash: string) => uniqueByHash.get(hash)!.file;
  let contiguous = 0; // frames 0..contiguous-1 all have their unique file on disk
  let nextSegment = 0;
  let segmentBusy = false;
  let streamDead = false;
  let segmentChain: Promise<void> = Promise.resolve();

  const maybeEncodeSegments = (): void => {
    if (!hls || segmentBusy || streamDead || nextSegment >= segCount) return;
    const startFrame = nextSegment * segFrames;
    const endFrame = Math.min(frameCount, startFrame + segFrames);
    if (contiguous < endFrame) return; // this segment's frames aren't all here yet
    segmentBusy = true;
    const index = nextSegment;
    const startSec = startFrame / compiled.fps;
    const durSec = (endFrame - startFrame) / compiled.fps;
    segmentChain = segmentChain.then(async () => {
      try {
        const segConcat = path.join(hlsDir, `seg_${String(index).padStart(5, "0")}.ffconcat`);
        const segPath = path.join(hlsDir, `seg_${String(index).padStart(5, "0")}.ts`);
        await writeFile(segConcat, segmentConcatLines(frameHashes, fileForHash, startFrame, endFrame, compiled.fps), "utf8");
        await runCommand("ffmpeg", encodeSegmentArgs(segConcat, audioPath, segPath, compiled.fps, startSec, durSec));
        await hls.onSegment(segPath, index, durSec);
        nextSegment = index + 1;
        if (nextSegment === segCount) await hls.onComplete?.();
      } catch (error) {
        streamDead = true; // stop streaming; the final MP4 still completes
        console.warn(`HLS segment ${index} failed (stream stops growing, render continues): ${String(error)}`);
      } finally {
        segmentBusy = false;
        maybeEncodeSegments(); // the frontier may already cover further segments
      }
    });
  };

  const markFrameDone = (hash: string): void => {
    doneByHash.add(hash);
    while (contiguous < frameCount && doneByHash.has(frameHashes[contiguous])) contiguous += 1;
    maybeEncodeSegments();
  };

  // 2) Rasterise unique frames in PARALLEL across the CPU. uniqueFrames is in
  // first-appearance order, so the contiguous frontier advances steadily and
  // early segments stream while later frames are still rendering.
  const concurrency = Math.max(2, Math.min(availableParallelism() - 1, 8));
  let rendered = 0;
  await mapPool(uniqueFrames, concurrency, async (frame) => {
    await sharp(Buffer.from(frame.svg)).png().toFile(frame.file);
    rendered += 1;
    markFrameDone(frame.hash);
    if (rendered % 25 === 0 || rendered === uniqueFrames.length) {
      await onProgress?.({
        stage: "frames",
        progress: rendered / uniqueFrames.length,
        message: `Rendered ${rendered} of ${uniqueFrames.length} unique frames (${frameCount} total)`,
      });
    }
  });

  // 3) Concat script: consecutive identical frames collapse into one entry
  // with a longer duration, so ffmpeg never decodes the same PNG twice.
  const lines = ["ffconcat version 1.0"];
  let runStart = 0;
  for (let frame = 1; frame <= frameCount; frame += 1) {
    if (frame === frameCount || frameHashes[frame] !== frameHashes[runStart]) {
      const file = uniqueByHash.get(frameHashes[runStart])!.file;
      const duration = concatRunDuration(frame - runStart, compiled.fps, frame === frameCount);
      lines.push(`file '${concatPath(file)}'`, `duration ${duration.toFixed(6)}`);
      runStart = frame;
    }
  }
  // Concat-demuxer quirk: the final entry's duration is only honoured when the
  // file is listed once more after it.
  lines.push(`file '${concatPath(uniqueByHash.get(frameHashes[frameCount - 1])!.file)}'`);
  const concatFile = path.join(outputDir, "frames.ffconcat");
  await writeFile(concatFile, `${lines.join("\n")}\n`, "utf8");

  const frameFileAt = (frame: number) => uniqueByHash.get(frameHashes[Math.max(0, Math.min(frameCount - 1, frame))])!.file;
  await writeContactSheet(compiled, frameFileAt, outputDir, frameCount);

  await onProgress?.({
    stage: "encoding",
    progress: 0.92,
    message: "Encoding MP4",
  });

  const outputPath = path.join(outputDir, "final.mp4");
  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-i",
    audioPath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-r",
    String(compiled.fps),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-af",
    NARRATION_FILTER,
    "-t",
    compiled.duration.toFixed(3),
    "-shortest",
    outputPath,
  ]);
  assertMediaDurationsAligned(await probeMediaDurations(outputPath), compiled.fps, compiled.duration);

  // Let the live stream finish: each awaited link re-arms the next segment
  // synchronously in its finally, so re-reading segmentChain walks the whole
  // chain; stop when it stops growing (all segments done, or the stream died).
  if (hls) {
    for (;;) {
      const tail = segmentChain;
      await tail;
      if (segmentChain === tail) break;
    }
  }

  await onProgress?.({
    stage: "encoding",
    progress: 1,
    message: "MP4 ready",
  });

  return outputPath;
}
