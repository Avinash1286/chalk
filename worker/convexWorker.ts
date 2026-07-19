import "./env";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { runVideoPipeline } from "./pipeline";

const claimQueuedJob = makeFunctionReference<
  "mutation",
  { workerId: string },
  null | { jobId: string; prompt: string; gridBackground?: boolean; resume?: boolean }
>("jobs:claimQueuedJob");
const updateVideoJob = makeFunctionReference<"mutation", any, null>("jobs:updateVideoJob");
const completeVideoJob = makeFunctionReference<"mutation", any, null>("jobs:completeVideoJob");
const failVideoJob = makeFunctionReference<"mutation", { jobId: string; error: string }, null>(
  "jobs:failVideoJob",
);
const generateUploadUrl = makeFunctionReference<"mutation", { jobId: string }, string>(
  "jobs:generateUploadUrl",
);
const appendHlsSegment = makeFunctionReference<
  "mutation",
  { jobId: string; index: number; fileId: string; duration: number },
  null
>("jobs:appendHlsSegment");
const setHlsComplete = makeFunctionReference<"mutation", { jobId: string }, null>(
  "jobs:setHlsComplete",
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const convexUrl = process.env.CONVEX_URL || process.env.VITE_CONVEX_URL;

if (!convexUrl) {
  throw new Error("CONVEX_URL is required to run the worker");
}

const workerId = `worker-${process.pid}`;
const client = new ConvexHttpClient(convexUrl);
if (process.env.CONVEX_AUTH_TOKEN) {
  client.setAuth(process.env.CONVEX_AUTH_TOKEN);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientConvexError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("try again later") ||
    message.includes("internalservererror") ||
    message.includes("failed to fetch") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("service unavailable")
  );
}

async function uploadFile(jobId: string, filePath: string, contentType: string): Promise<string> {
  // No silent fallback to a local file:// path — a browser can't play that, so a
  // "completed" job with a local path is really a broken video. Throw so the job
  // is marked failed and the user can Resume/Regenerate.
  const uploadUrl = await client.mutation(generateUploadUrl, { jobId });
  const data = await readFile(filePath);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: data,
  });
  if (!response.ok) {
    throw new Error(`Convex storage upload failed with ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error("Convex storage upload did not return a storageId");
  }
  return payload.storageId;
}

const uploadVideo = (jobId: string, filePath: string) => uploadFile(jobId, filePath, "video/mp4");

// Upload one live-HLS segment and append it to the job's playlist. One retry on
// a transient failure; a hard failure propagates so the renderer marks the
// stream dead (the final MP4 is unaffected).
async function uploadHlsSegment(jobId: string, segmentPath: string, index: number, duration: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const fileId = await uploadFile(jobId, segmentPath, "video/mp2t");
      await client.mutation(appendHlsSegment, { jobId, index, fileId, duration });
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      await sleep(1500);
    }
  }
}

async function processOneJob(): Promise<boolean> {
  const job = await client.mutation(claimQueuedJob, { workerId });
  if (!job) return false;

  const outputDir = path.join(root, "outputs", String(job.jobId));
  try {
    const result = await runVideoPipeline({
      prompt: job.prompt,
      outputDir,
      background: job.gridBackground ? "grid" : "plain",
      resume: Boolean(job.resume),
      async onProgress(progress) {
        const status =
          progress.stage === "directing"
            ? "planning"
            : progress.stage === "generating_assets"
              ? "generating_audio"
              : progress.stage === "assembling"
                ? "laying_out"
                : progress.stage === "completed"
                  ? "completed"
                  : "rendering";
        await client.mutation(updateVideoJob, {
          jobId: job.jobId,
          status,
          progress: Math.min(0.98, progress.progress),
          message: progress.message,
        });
      },
      // Live HLS: stream each encoded segment up as the render progresses, so
      // the frontend can start playback within seconds of rendering starting.
      async onSegment(segmentPath, index, durationSeconds) {
        await uploadHlsSegment(job.jobId, segmentPath, index, durationSeconds);
      },
      async onSegmentsComplete() {
        await client.mutation(setHlsComplete, { jobId: job.jobId });
      },
    });

    const storageId = await uploadVideo(job.jobId, result.outputPath);
    await client.mutation(completeVideoJob, {
      jobId: job.jobId,
      videoFileId: storageId,
      scenePlan: result.storyboard,
      plannerSource: result.plannerSource,
      audioSource: result.audioSource,
      durationSeconds: result.durationSeconds,
    });
    console.log(`Completed ${job.jobId}: ${result.outputPath}`);
    // Hosted workers have small ephemeral disks and a job leaves 100MB+ of
    // frames behind — everything the app needs is in Convex now, so clean up.
    // KEEP_OUTPUTS=1 preserves everything for local debugging.
    if (process.env.KEEP_OUTPUTS !== "1") {
      await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    await client.mutation(failVideoJob, { jobId: job.jobId, error: message });
    console.error(`Failed ${job.jobId}`, error);
    // Failed jobs KEEP their checkpoints (storyboard.json / narration.mp3 power
    // the Resume button) but drop the bulky frame/segment dirs.
    if (process.env.KEEP_OUTPUTS !== "1") {
      await rm(path.join(outputDir, "frames"), { recursive: true, force: true }).catch(() => {});
      await rm(path.join(outputDir, "hls"), { recursive: true, force: true }).catch(() => {});
    }
  }
  return true;
}

console.log(`Render worker ${workerId} connected to ${convexUrl}`);
let backoffMs = 2000;
for (;;) {
  try {
    const worked = await processOneJob();
    backoffMs = worked ? 1000 : 2500;
    if (!worked) {
      await sleep(backoffMs);
    }
  } catch (error) {
    if (!isTransientConvexError(error)) {
      console.error("Worker polling failed", error);
    } else {
      console.warn(`Convex is not ready yet; retrying in ${Math.round(backoffMs / 1000)}s.`);
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 1.6, 15000);
  }
}
