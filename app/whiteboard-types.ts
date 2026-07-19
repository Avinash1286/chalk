export type JobStatus =
  | "queued"
  | "planning"
  | "generating_audio"
  | "laying_out"
  | "rendering"
  | "completed"
  | "failed";

export type VideoJob = {
  _id: string;
  prompt: string;
  status: JobStatus;
  progress: number;
  message?: string;
  error?: string;
  videoUrl?: string | null;
  // Live HLS stream: set while the render is streaming (and after, until the
  // page reloads with a completed MP4 available).
  hlsUrl?: string | null;
  durationSeconds?: number;
  plannerSource?: string;
  audioSource?: string;
  createdAt?: number;
  // Owner display name (gallery) and whether the viewer owns this job.
  ownerName?: string | null;
  mine?: boolean;
};

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
};

// Convex function references. Typed as `any` so the frontend doesn't depend on
// the generated Convex API surface at build time (it resolves at runtime).
export const createVideoJobRef = "jobs:createVideoJob" as any;
export const getVideoJobRef = "jobs:getVideoJob" as any;
export const retryVideoJobRef = "jobs:retryVideoJob" as any;
export const listMyVideoJobsRef = "jobs:listMyVideoJobs" as any;
export const listGalleryJobsRef = "jobs:listGalleryJobs" as any;

export const signUpRef = "auth:signUp" as any;
export const signInRef = "auth:signIn" as any;
export const signOutRef = "auth:signOut" as any;
export const meRef = "auth:me" as any;

export const AUTH_TOKEN_KEY = "chalk-auth-token";

export const statusLabels: Record<JobStatus, string> = {
  queued: "Queued",
  planning: "Planning the script",
  generating_audio: "Designing scenes + narration",
  laying_out: "Laying out the timeline",
  rendering: "Rendering the video",
  completed: "Completed",
  failed: "Failed",
};

export const ACTIVE_STATUSES: JobStatus[] = [
  "queued",
  "planning",
  "generating_audio",
  "laying_out",
  "rendering",
];

export function isActive(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export const EXAMPLE_PROMPTS = [
  "Explain how credit scores work",
  "How does the water cycle work?",
  "Why is the sky blue?",
  "How do stablecoin cross-border payments work?",
];
