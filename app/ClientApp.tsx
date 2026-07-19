"use client";

import { useMemo, useState } from "react";
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { SquareDashedMousePointer } from "lucide-react";
import { Toaster, toast } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/whiteboard/sidebar";
import { ChatView } from "@/components/whiteboard/chat-view";
import { GalleryView } from "@/components/whiteboard/gallery-view";
import { BrandMark } from "@/components/whiteboard/brand-mark";
import {
  type VideoJob,
  createVideoJobRef,
  getVideoJobRef,
  retryVideoJobRef,
  listVideoJobsRef,
} from "@/app/whiteboard-types";

function SetupView() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
        <BrandMark size={56} />
        <div className="flex items-center gap-2 text-lg font-semibold">
          <SquareDashedMousePointer className="size-5" /> Connect your backend
        </div>
        <p className="text-sm text-muted-foreground">
          Set <code className="rounded bg-secondary px-1 py-0.5">NEXT_PUBLIC_CONVEX_URL</code> in your
          environment, then start the Convex dev server and the render worker.
        </p>
        <pre className="w-full rounded-lg bg-secondary p-3 text-left text-xs text-secondary-foreground">{`npm run convex:dev
npm run worker
npm run dev`}</pre>
      </div>
    </div>
  );
}

function ConfiguredApp({ generationEnabled }: { generationEnabled: boolean }) {
  const [view, setView] = useState<"chat" | "gallery">("chat");
  const [jobId, setJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [gridBackground, setGridBackground] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const createVideoJob = useMutation(createVideoJobRef);
  const retryVideoJob = useMutation(retryVideoJobRef);
  const job = useQuery(getVideoJobRef, jobId ? { jobId } : "skip") as VideoJob | null | undefined;
  const jobs = useQuery(listVideoJobsRef, {}) as VideoJob[] | undefined;

  const jobLoading = jobId !== null && job === undefined;

  function onNewChat() {
    setView("chat");
    setJobId(null);
    setPrompt("");
  }

  function onSelectChat(id: string) {
    setView("chat");
    setJobId(id);
  }

  // Showcase mode (NEXT_PUBLIC_DEMO=off): block any generation attempt, tell the
  // visitor why, and send them to the gallery of already-rendered videos.
  function blockedByDemo(): boolean {
    if (generationEnabled) return false;
    toast("Video generation is disabled for now", {
      description: "Check the already-generated videos in the gallery.",
      duration: 6000,
    });
    setView("gallery");
    return true;
  }

  async function onSubmit() {
    const source = prompt.trim();
    if (source.length < 8 || submitting) return;
    if (blockedByDemo()) return;
    setSubmitting(true);
    try {
      const id = (await createVideoJob({ prompt: source, gridBackground })) as string;
      setJobId(id);
      setView("chat");
      setPrompt("");
    } finally {
      setSubmitting(false);
    }
  }

  // Resume: re-run the SAME job (reuses saved checkpoints on the worker side).
  async function onResume() {
    if (!job || busy) return;
    if (blockedByDemo()) return;
    setBusy(true);
    try {
      await retryVideoJob({ jobId: job._id });
    } finally {
      setBusy(false);
    }
  }

  // Regenerate: a brand-new job from the same prompt — a fresh AI pass.
  async function onRegenerate() {
    const source = (job?.prompt ?? prompt).trim();
    if (source.length < 8 || busy) return;
    if (blockedByDemo()) return;
    setBusy(true);
    try {
      const id = (await createVideoJob({ prompt: source, gridBackground })) as string;
      setJobId(id);
      setView("chat");
    } finally {
      setBusy(false);
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <Sidebar
          jobs={jobs}
          activeJobId={jobId}
          view={view}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onNewChat={onNewChat}
          onSelectChat={onSelectChat}
          onOpenGallery={() => setView("gallery")}
          userLabel="You"
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {view === "gallery" ? (
            <GalleryView jobs={jobs} onOpen={onSelectChat} />
          ) : (
            <ChatView
              job={jobId ? job : null}
              jobLoading={jobLoading}
              prompt={prompt}
              onPromptChange={setPrompt}
              gridBackground={gridBackground}
              onToggleGrid={() => setGridBackground((g) => !g)}
              onSubmit={onSubmit}
              onResume={onResume}
              onRegenerate={onRegenerate}
              busy={busy || submitting}
              submitting={submitting}
            />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

export default function ClientApp({
  convexUrl,
  generationEnabled = true,
}: {
  convexUrl: string;
  generationEnabled?: boolean;
}) {
  const convex = useMemo(() => (convexUrl ? new ConvexReactClient(convexUrl) : null), [convexUrl]);

  return (
    <>
      <Toaster
        position="top-center"
        toastOptions={{
          classNames: {
            toast: "!rounded-xl !border !border-border !bg-card !text-foreground !shadow-lg",
            description: "!text-muted-foreground",
          },
        }}
      />
      {!convex ? (
        <SetupView />
      ) : (
        <ConvexProvider client={convex}>
          <ConfiguredApp generationEnabled={generationEnabled} />
        </ConvexProvider>
      )}
    </>
  );
}
