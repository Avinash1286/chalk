import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Lightweight accounts. Passwords are PBKDF2-hashed (see convex/auth.ts); the
  // plaintext is never stored. `username` is the lookup key; `displayName` is
  // what other users see on shared gallery videos.
  users: defineTable({
    username: v.string(), // lowercased, unique
    displayName: v.string(),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    createdAt: v.number(),
  }).index("by_username", ["username"]),

  // Opaque bearer tokens minted at sign-in and validated server-side on every
  // authenticated call. Stored in the browser's localStorage.
  sessions: defineTable({
    token: v.string(),
    userId: v.id("users"),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  videoJobs: defineTable({
    prompt: v.string(),
    // Owner. Optional so pre-auth rows and worker flows stay valid; set on
    // creation for every job made through the signed-in UI.
    userId: v.optional(v.id("users")),
    gridBackground: v.optional(v.boolean()),
    status: v.union(
      v.literal("queued"),
      v.literal("planning"),
      v.literal("generating_audio"),
      v.literal("laying_out"),
      v.literal("rendering"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    progress: v.number(),
    message: v.optional(v.string()),
    error: v.optional(v.string()),
    scenePlan: v.optional(v.any()),
    plannerSource: v.optional(v.string()),
    audioSource: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    videoFileId: v.optional(v.id("_storage")),
    videoUrl: v.optional(v.string()),
    // Live HLS: immutable MPEG-TS segments appended during the render (bounded:
    // ~35 for a 210s video at 6s/segment). The playlist is generated on the fly
    // by the /hls HTTP action from this list.
    hlsSegments: v.optional(v.array(v.object({ fileId: v.id("_storage"), duration: v.number() }))),
    hlsComplete: v.optional(v.boolean()),
    workerId: v.optional(v.string()),
    // Set by retryVideoJob: the worker may reuse this job's saved artifacts
    // (storyboard.json, narration.mp3) instead of re-running the full pipeline.
    resume: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"])
    .index("by_user", ["userId"]),
});
