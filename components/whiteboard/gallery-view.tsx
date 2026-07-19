"use client";

import { useRef } from "react";
import { Film, Play, Images } from "lucide-react";

import { cn } from "@/lib/utils";
import { type VideoJob } from "@/app/whiteboard-types";

function GalleryCard({ job, onOpen }: { job: VideoJob; onOpen: (id: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <button
      type="button"
      onClick={() => onOpen(job._id)}
      title={job.prompt}
      onMouseEnter={() => {
        const v = videoRef.current;
        if (v) {
          v.currentTime = 0;
          void v.play().catch(() => {});
        }
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = 0;
        }
      }}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md",
      )}
    >
      <div className="relative aspect-video overflow-hidden bg-black">
        {/* #t=0.6 makes the browser paint a real frame as the poster. */}
        <video
          ref={videoRef}
          src={job.videoUrl ? `${job.videoUrl}#t=0.6` : undefined}
          muted
          playsInline
          preload="metadata"
          className="size-full object-cover"
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/20 group-hover:opacity-100">
          <span className="flex size-11 items-center justify-center rounded-full bg-white/90 text-primary">
            <Play className="size-5" />
          </span>
        </span>
        {job.durationSeconds ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
            {Math.round(job.durationSeconds)}s
          </span>
        ) : null}
      </div>
      <div className="p-3">
        <p className="line-clamp-2 text-sm font-medium text-foreground">{job.prompt}</p>
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">by {job.mine ? "you" : job.ownerName ?? "someone"}</span>
          {job.mine && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-medium text-primary">You</span>
          )}
        </div>
      </div>
    </button>
  );
}

export function GalleryView({
  jobs,
  onOpen,
}: {
  jobs: VideoJob[] | undefined;
  onOpen: (id: string) => void;
}) {
  const done = (jobs ?? []).filter((j) => j.status === "completed" && j.videoUrl);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
            <Images className="size-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Gallery</h1>
            <p className="text-sm text-muted-foreground">
              {done.length} finished video{done.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>

        {done.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
            <Film className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Your finished videos will collect here. Start a chat to make your first one.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {done.map((job) => (
              <GalleryCard key={job._id} job={job} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
