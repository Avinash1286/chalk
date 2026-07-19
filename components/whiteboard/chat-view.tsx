"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BrandMark } from "./brand-mark";
import { Composer } from "./composer";
import { VideoPlayer } from "./video-player";
import {
  type VideoJob,
  type JobStatus,
  statusLabels,
  isActive,
  EXAMPLE_PROMPTS,
} from "@/app/whiteboard-types";

function StatusPill({ status }: { status: JobStatus }) {
  const done = status === "completed";
  const failed = status === "failed";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        done
          ? "bg-emerald-500/12 text-emerald-600"
          : failed
            ? "bg-destructive/12 text-destructive"
            : "bg-amber-500/12 text-amber-600",
      )}
    >
      {done ? (
        <CheckCircle2 className="size-3.5" />
      ) : failed ? (
        <AlertTriangle className="size-3.5" />
      ) : (
        <Loader2 className="size-3.5 animate-spin" />
      )}
      {statusLabels[status]}
    </span>
  );
}

function JobResponse({
  job,
  onResume,
  onRegenerate,
  busy,
}: {
  job: VideoJob;
  onResume: () => void;
  onRegenerate: () => void;
  busy: boolean;
}) {
  const complete = job.status === "completed";
  const failed = job.status === "failed";
  const working = isActive(job.status);

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0">
        <BrandMark size={30} />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <StatusPill status={job.status} />

        {(complete && job.videoUrl) || job.hlsUrl ? (
          <div className="overflow-hidden rounded-2xl border border-border bg-black shadow-sm">
            <VideoPlayer hlsUrl={job.hlsUrl ?? null} videoUrl={complete ? (job.videoUrl ?? null) : null} />
          </div>
        ) : null}
        {complete || (job.hlsUrl && !failed) ? null : failed ? (
          <div className="flex flex-col items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="size-4" /> Generation failed
            </div>
            <p className="text-sm text-muted-foreground">
              {job.error?.split("\n")[0] ?? "Something went wrong while building this video."}
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <Loader2 className="size-4 animate-spin text-amber-600" />
              {job.message ?? statusLabels[job.status]}
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${Math.max(4, Math.round(job.progress * 100))}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {complete && job.durationSeconds ? <span>{job.durationSeconds.toFixed(1)}s video</span> : null}
          {job.plannerSource ? <span>planner · {job.plannerSource}</span> : null}
          {job.audioSource ? <span>audio · {job.audioSource}</span> : null}
        </div>

        {(failed || complete) && (
          <div className="flex gap-2">
            {failed && (
              <Button variant="secondary" size="sm" onClick={onResume} disabled={busy}>
                <RotateCcw className="size-4" /> Resume
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onRegenerate} disabled={busy}>
              <RefreshCw className="size-4" /> Regenerate
            </Button>
          </div>
        )}
        {working && (
          <p className="text-xs text-muted-foreground">
            This runs the full AI pipeline — usually a couple of minutes. You can start another chat
            meanwhile.
          </p>
        )}
      </div>
    </div>
  );
}

export function ChatView({
  job,
  jobLoading,
  prompt,
  onPromptChange,
  gridBackground,
  onToggleGrid,
  onSubmit,
  onResume,
  onRegenerate,
  busy,
  submitting,
}: {
  job: VideoJob | null | undefined;
  jobLoading: boolean;
  prompt: string;
  onPromptChange: (v: string) => void;
  gridBackground: boolean;
  onToggleGrid: () => void;
  onSubmit: () => void;
  onResume: () => void;
  onRegenerate: () => void;
  busy: boolean;
  submitting: boolean;
}) {
  const showThread = Boolean(job) || jobLoading;

  // Empty state: centered hero + composer, mirroring the reference product.
  if (!showThread) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4">
        <div className="w-full max-w-2xl">
          <div className="mb-8 flex flex-col items-center text-center">
            <BrandMark size={92} className="mb-6" />
            <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
              What should <span className="text-primary">Chalk</span> make clear?
            </h1>
            <p className="mt-3 max-w-md text-muted-foreground">
              Start with a concept or a question that needs a visual explanation. Chalk writes a
              script, designs each scene, narrates it, and renders a hand-drawn video.
            </p>
          </div>

          <Composer
            prompt={prompt}
            onPromptChange={onPromptChange}
            gridBackground={gridBackground}
            onToggleGrid={onToggleGrid}
            onSubmit={onSubmit}
            disabled={submitting}
            submitting={submitting}
          />

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {EXAMPLE_PROMPTS.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => onPromptChange(ex)}
                className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
              >
                <Sparkles className="size-3" /> {ex}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Thread: the prompt as a user message, then the render as the response.
  return (
    <div className="flex h-full flex-col">
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-8">
          {job && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-primary px-4 py-2.5 text-primary-foreground">
                {job.prompt}
              </div>
            </div>
          )}
          {jobLoading && !job ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading chat…
            </div>
          ) : job ? (
            <JobResponse job={job} onResume={onResume} onRegenerate={onRegenerate} busy={busy} />
          ) : null}
        </div>
      </div>

      <div className="border-t border-border bg-background/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl">
          <Composer
            prompt={prompt}
            onPromptChange={onPromptChange}
            gridBackground={gridBackground}
            onToggleGrid={onToggleGrid}
            onSubmit={onSubmit}
            disabled={submitting}
            submitting={submitting}
            placeholder="Start a new explanation…"
          />
        </div>
      </div>
    </div>
  );
}
