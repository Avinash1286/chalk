import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId, userForToken } from "./auth";

const statusValidator = v.union(
  v.literal("queued"),
  v.literal("planning"),
  v.literal("generating_audio"),
  v.literal("laying_out"),
  v.literal("rendering"),
  v.literal("completed"),
  v.literal("failed"),
);

export const createVideoJob = mutation({
  args: { prompt: v.string(), gridBackground: v.optional(v.boolean()), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx, args.token);
    const now = Date.now();
    const jobId = await ctx.db.insert("videoJobs", {
      prompt: args.prompt,
      userId,
      gridBackground: args.gridBackground ?? false,
      status: "queued",
      progress: 0,
      message: "Queued",
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.pipeline.kickoffWorker, { jobId });
    return jobId;
  },
});

// A live HLS stream is exposed once enough runway is buffered that playback
// won't immediately stall (or the stream is finished — then it's a normal VOD).
function hlsUrlFor(job: Doc<"videoJobs">): string | null {
  const siteUrl = process.env.CONVEX_SITE_URL;
  const segments = job.hlsSegments ?? [];
  const readySec = segments.reduce((sum, seg) => sum + seg.duration, 0);
  const minStart = Number(process.env.HLS_MIN_START_SECONDS) || 12;
  const ready = segments.length > 0 && (readySec >= minStart || job.hlsComplete === true);
  return siteUrl && ready ? `${siteUrl}/hls/${job._id}.m3u8` : null;
}

export const getVideoJob = query({
  args: { jobId: v.id("videoJobs"), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    const viewer = await userForToken(ctx, args.token);
    const storageUrl = job.videoFileId ? await ctx.storage.getUrl(job.videoFileId) : null;
    const owner = job.userId ? await ctx.db.get(job.userId) : null;
    return {
      ...job,
      videoUrl: storageUrl ?? job.videoUrl ?? null,
      hlsUrl: hlsUrlFor(job),
      ownerName: owner?.displayName ?? null,
      // Owner-only actions (Resume / Regenerate) are gated on this in the UI and
      // re-checked server-side in retryVideoJob.
      mine: Boolean(viewer && job.userId && job.userId === viewer._id),
    };
  },
});

// The signed-in user's own chats — powers the sidebar history (all statuses).
export const listMyVideoJobs = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await userForToken(ctx, args.token);
    if (!viewer) return [];
    const jobs = await ctx.db
      .query("videoJobs")
      .withIndex("by_user", (q) => q.eq("userId", viewer._id))
      .order("desc")
      .take(40);
    return Promise.all(
      jobs.map(async (job) => ({
        ...job,
        videoUrl: job.videoFileId ? await ctx.storage.getUrl(job.videoFileId) : job.videoUrl ?? null,
        hlsUrl: hlsUrlFor(job),
        ownerName: viewer.displayName,
        mine: true,
      })),
    );
  },
});

// Everyone's finished videos — the public gallery. `mine` flags the viewer's own.
export const listGalleryJobs = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const viewer = await userForToken(ctx, args.token);
    const jobs = await ctx.db
      .query("videoJobs")
      .withIndex("by_status", (q) => q.eq("status", "completed"))
      .order("desc")
      .take(60);
    const nameCache = new Map<string, string | null>();
    const ownerName = async (userId: Id<"users"> | undefined): Promise<string | null> => {
      if (!userId) return null;
      if (!nameCache.has(userId)) nameCache.set(userId, (await ctx.db.get(userId))?.displayName ?? null);
      return nameCache.get(userId) ?? null;
    };
    return Promise.all(
      jobs.map(async (job) => ({
        ...job,
        videoUrl: job.videoFileId ? await ctx.storage.getUrl(job.videoFileId) : job.videoUrl ?? null,
        hlsUrl: hlsUrlFor(job),
        ownerName: await ownerName(job.userId),
        mine: Boolean(viewer && job.userId && job.userId === viewer._id),
      })),
    );
  },
});

export const claimQueuedJob = mutation({
  args: { workerId: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("videoJobs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .order("asc")
      .first();
    if (!job) return null;
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "planning",
      progress: 0.05,
      message: "Worker claimed job",
      workerId: args.workerId,
      updatedAt: now,
    });
    return {
      jobId: job._id,
      prompt: job.prompt,
      gridBackground: job.gridBackground ?? false,
      resume: job.resume ?? false,
    };
  },
});

// Resume: re-queue an existing job (typically a failed one) with the same
// prompt. Clears the stale error and any previous video so the job presents
// cleanly. Marks the job resumable: the worker reuses the job's saved
// checkpoints (storyboard.json, narration.mp3) when they exist, so a job that
// failed during rendering skips scripting/design/TTS entirely on retry.
async function deleteHlsFiles(ctx: MutationCtx, job: Doc<"videoJobs"> | null): Promise<void> {
  for (const seg of job?.hlsSegments ?? []) {
    try {
      await ctx.storage.delete(seg.fileId);
    } catch {
      // already gone
    }
  }
}

export const retryVideoJob = mutation({
  args: { jobId: v.id("videoJobs"), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx, args.token);
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");
    if (job.userId !== userId) throw new Error("You can only resume your own videos.");
    // The retried render streams fresh segments — release the old ones.
    await deleteHlsFiles(ctx, job);
    const now = Date.now();
    await ctx.db.patch(args.jobId, {
      status: "queued",
      progress: 0,
      message: "Re-queued",
      error: undefined,
      videoFileId: undefined,
      videoUrl: undefined,
      hlsSegments: undefined,
      hlsComplete: undefined,
      workerId: undefined,
      resume: true,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.pipeline.kickoffWorker, { jobId: args.jobId });
    return args.jobId;
  },
});

// ── Live HLS ──────────────────────────────────────────────────────────────────
// The worker uploads each ~6s MPEG-TS segment ONCE (immutable) and appends it
// here; the /hls HTTP action rebuilds the playlist from this list per poll —
// a textbook EVENT-type HLS stream over immutable storage.

export const appendHlsSegment = mutation({
  args: {
    jobId: v.id("videoJobs"),
    index: v.number(),
    fileId: v.id("_storage"),
    duration: v.number(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");
    const segments = job.hlsSegments ?? [];
    // Idempotency: a retried upload of an already-appended segment is dropped
    // (and its duplicate file released). Out-of-order appends can't happen —
    // the worker encodes and uploads segments strictly sequentially.
    if (args.index < segments.length) {
      try {
        await ctx.storage.delete(args.fileId);
      } catch {
        /* ignore */
      }
      return;
    }
    if (args.index !== segments.length) {
      throw new Error(`Segment out of order: got ${args.index}, expected ${segments.length}`);
    }
    await ctx.db.patch(args.jobId, {
      hlsSegments: [...segments, { fileId: args.fileId, duration: args.duration }],
      updatedAt: Date.now(),
    });
  },
});

export const setHlsComplete = mutation({
  args: { jobId: v.id("videoJobs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, { hlsComplete: true, updatedAt: Date.now() });
  },
});

// Read model for the /hls HTTP action (playlist + segment lookup).
export const getHls = internalQuery({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("videoJobs", args.jobId);
    if (!id) return null;
    const job = await ctx.db.get(id);
    if (!job) return null;
    return { segments: job.hlsSegments ?? [], complete: job.hlsComplete === true };
  },
});

export const updateVideoJob = mutation({
  args: {
    jobId: v.id("videoJobs"),
    status: v.optional(statusValidator),
    progress: v.optional(v.number()),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
    scenePlan: v.optional(v.any()),
    plannerSource: v.optional(v.string()),
    audioSource: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    videoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { jobId, ...patch } = args;
    await ctx.db.patch(jobId, {
      ...patch,
      updatedAt: Date.now(),
    });
  },
});

export const generateUploadUrl = mutation({
  args: { jobId: v.id("videoJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) throw new Error("Job not found");
    return await ctx.storage.generateUploadUrl();
  },
});

export const completeVideoJob = mutation({
  args: {
    jobId: v.id("videoJobs"),
    videoFileId: v.optional(v.id("_storage")),
    videoUrl: v.optional(v.string()),
    scenePlan: v.any(),
    plannerSource: v.string(),
    audioSource: v.string(),
    durationSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      status: "completed",
      progress: 1,
      message: "Video ready",
      videoFileId: args.videoFileId,
      videoUrl: args.videoUrl,
      scenePlan: args.scenePlan,
      plannerSource: args.plannerSource,
      audioSource: args.audioSource,
      durationSeconds: args.durationSeconds,
      updatedAt: Date.now(),
    });
  },
});

export const failVideoJob = mutation({
  args: { jobId: v.id("videoJobs"), error: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      status: "failed",
      progress: 1,
      message: "Failed",
      error: args.error,
      updatedAt: Date.now(),
    });
  },
});

// Watchdog: fail any job that's been in a processing state without a progress
// update for too long. `updatedAt` is bumped on every onProgress tick, so a job
// stuck here means the worker hung on an API/render call OR died mid-job. Either
// way the user gets a clear failure (+ Resume/Regenerate) instead of a silent
// stall. Runs from a 1-minute cron (see convex/crons.ts).
const STALE_MS = Number(process.env.JOB_STALE_MS ?? 300000); // 5 minutes
const PROCESSING_STATUSES = ["planning", "generating_audio", "laying_out", "rendering"] as const;

export const failStaleJobs = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_MS;
    let failed = 0;
    for (const status of PROCESSING_STATUSES) {
      const jobs = await ctx.db
        .query("videoJobs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect();
      for (const job of jobs) {
        if (job.updatedAt >= cutoff) continue;
        await ctx.db.patch(job._id, {
          status: "failed",
          progress: 1,
          message: "Failed (timed out)",
          error:
            "Generation timed out — the worker stopped reporting progress (a model/render call hung or the worker stopped). Use Resume or Regenerate.",
          updatedAt: Date.now(),
        });
        failed += 1;
      }
    }
    return { failed };
  },
});

export const internalPatchJob = internalMutation({
  args: {
    jobId: v.id("videoJobs"),
    status: v.optional(statusValidator),
    progress: v.optional(v.number()),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { jobId, ...patch } = args;
    await ctx.db.patch(jobId, { ...patch, updatedAt: Date.now() });
  },
});
