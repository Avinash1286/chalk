"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { Loader2, SquareDashedMousePointer } from "lucide-react";
import { Toaster, toast } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/whiteboard/sidebar";
import { ChatView } from "@/components/whiteboard/chat-view";
import { GalleryView } from "@/components/whiteboard/gallery-view";
import { AuthView } from "@/components/whiteboard/auth-view";
import { BrandMark } from "@/components/whiteboard/brand-mark";
import {
  type AuthUser,
  type VideoJob,
  AUTH_TOKEN_KEY,
  createVideoJobRef,
  getVideoJobRef,
  retryVideoJobRef,
  listMyVideoJobsRef,
  listGalleryJobsRef,
  meRef,
  signOutRef,
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

function ConfiguredApp({
  generationEnabled,
  token,
  user,
  onSignOut,
}: {
  generationEnabled: boolean;
  token: string;
  user: AuthUser;
  onSignOut: () => void;
}) {
  const [view, setView] = useState<"chat" | "gallery">("chat");
  const [jobId, setJobId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [gridBackground, setGridBackground] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const createVideoJob = useMutation(createVideoJobRef);
  const retryVideoJob = useMutation(retryVideoJobRef);
  const job = useQuery(getVideoJobRef, jobId ? { jobId, token } : "skip") as VideoJob | null | undefined;
  // Sidebar = only my chats; gallery = everyone's finished videos.
  const myJobs = useQuery(listMyVideoJobsRef, { token }) as VideoJob[] | undefined;
  const galleryJobs = useQuery(listGalleryJobsRef, { token }) as VideoJob[] | undefined;

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
      const id = (await createVideoJob({ prompt: source, gridBackground, token })) as string;
      setJobId(id);
      setView("chat");
      setPrompt("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message.replace(/^\[.*?\]\s*/, "") : "Could not start the video.");
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
      await retryVideoJob({ jobId: job._id, token });
    } catch (err) {
      toast.error(err instanceof Error ? err.message.replace(/^\[.*?\]\s*/, "") : "Could not resume.");
    } finally {
      setBusy(false);
    }
  }

  // Regenerate: a brand-new job from the same prompt — a fresh AI pass. Becomes
  // the current user's own video even when regenerating from someone else's.
  async function onRegenerate() {
    const source = (job?.prompt ?? prompt).trim();
    if (source.length < 8 || busy) return;
    if (blockedByDemo()) return;
    setBusy(true);
    try {
      const id = (await createVideoJob({ prompt: source, gridBackground, token })) as string;
      setJobId(id);
      setView("chat");
    } catch (err) {
      toast.error(err instanceof Error ? err.message.replace(/^\[.*?\]\s*/, "") : "Could not regenerate.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <Sidebar
          jobs={myJobs}
          activeJobId={jobId}
          view={view}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onNewChat={onNewChat}
          onSelectChat={onSelectChat}
          onOpenGallery={() => setView("gallery")}
          galleryCount={(galleryJobs ?? []).length}
          userLabel={user.displayName}
          onSignOut={onSignOut}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {view === "gallery" ? (
            <GalleryView jobs={galleryJobs} onOpen={onSelectChat} />
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

// Auth gate: reads the persisted token, validates it against the backend, and
// shows the sign-in screen until there's a real session.
function AuthGate({ generationEnabled }: { generationEnabled: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setToken(localStorage.getItem(AUTH_TOKEN_KEY));
    } catch {
      // localStorage unavailable — user just signs in fresh
    }
    setReady(true);
  }, []);

  const me = useQuery(meRef, token ? { token } : "skip") as AuthUser | null | undefined;
  const signOut = useMutation(signOutRef);

  const onAuthed = useCallback((newToken: string, _user: AuthUser) => {
    try {
      localStorage.setItem(AUTH_TOKEN_KEY, newToken);
    } catch {
      // ignore — session lives in memory for this tab
    }
    setToken(newToken);
  }, []);

  const onSignOut = useCallback(async () => {
    const current = token;
    setToken(null);
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {
      // ignore
    }
    if (current) await signOut({ token: current }).catch(() => {});
  }, [token, signOut]);

  // A stored token that the backend rejects (expired/cleared) — drop it.
  useEffect(() => {
    if (token && me === null) {
      setToken(null);
      try {
        localStorage.removeItem(AUTH_TOKEN_KEY);
      } catch {
        // ignore
      }
    }
  }, [token, me]);

  if (!ready || (token && me === undefined)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!token || !me) {
    return <AuthView onAuthed={onAuthed} />;
  }

  return (
    <ConfiguredApp generationEnabled={generationEnabled} token={token} user={me} onSignOut={onSignOut} />
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
          <AuthGate generationEnabled={generationEnabled} />
        </ConvexProvider>
      )}
    </>
  );
}
