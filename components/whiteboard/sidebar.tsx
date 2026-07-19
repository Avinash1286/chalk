"use client";

import { useMemo, useState } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Images,
  MessageSquare,
  Loader2,
  User,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandMark } from "./brand-mark";
import { type VideoJob, isActive } from "@/app/whiteboard-types";

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function StatusDot({ job }: { job: VideoJob }) {
  if (isActive(job.status)) {
    return <span className="size-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />;
  }
  if (job.status === "failed") {
    return <span className="size-1.5 shrink-0 rounded-full bg-destructive" />;
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/70" />;
}

function ChatRow({
  job,
  active,
  onSelect,
}: {
  job: VideoJob;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(job._id)}
      title={job.prompt}
      className={cn(
        "group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
      )}
    >
      <span className="truncate">{job.prompt}</span>
      <span className="ml-auto flex items-center">
        <StatusDot job={job} />
      </span>
    </button>
  );
}

export function Sidebar({
  jobs,
  activeJobId,
  view,
  collapsed,
  onToggleCollapse,
  onNewChat,
  onSelectChat,
  onOpenGallery,
  userLabel,
}: {
  jobs: VideoJob[] | undefined;
  activeJobId: string | null;
  view: "chat" | "gallery";
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onOpenGallery: () => void;
  userLabel: string;
}) {
  const [query, setQuery] = useState("");

  const galleryCount = (jobs ?? []).filter((j) => j.status === "completed" && j.videoUrl).length;

  const { today, earlier } = useMemo(() => {
    const list = (jobs ?? []).filter((j) =>
      query.trim() ? j.prompt.toLowerCase().includes(query.trim().toLowerCase()) : true,
    );
    const cutoff = startOfToday();
    return {
      today: list.filter((j) => (j.createdAt ?? 0) >= cutoff),
      earlier: list.filter((j) => (j.createdAt ?? 0) < cutoff),
    };
  }, [jobs, query]);

  if (collapsed) {
    return (
      <aside className="flex h-full w-[60px] flex-col items-center gap-2 border-r border-sidebar-border bg-sidebar py-3">
        <button onClick={onToggleCollapse} className="mb-1" aria-label="Expand sidebar">
          <BrandMark size={30} />
        </button>
        <RailButton label="New chat" onClick={onNewChat}>
          <Plus className="size-5" />
        </RailButton>
        <RailButton label="Gallery" onClick={onOpenGallery} active={view === "gallery"}>
          <Images className="size-5" />
        </RailButton>
        <RailButton label="Expand" onClick={onToggleCollapse}>
          <PanelLeftOpen className="size-5" />
        </RailButton>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[272px] flex-col border-r border-sidebar-border bg-sidebar">
      {/* Brand + collapse */}
      <div className="flex items-center gap-2 px-4 pb-1 pt-4">
        <BrandMark size={30} />
        <span className="text-lg font-semibold tracking-tight text-sidebar-foreground">Chalk</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleCollapse}
          className="ml-auto size-8 text-muted-foreground"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>

      {/* Primary actions */}
      <div className="flex flex-col gap-2 px-3 pt-3">
        <Button
          variant="outline"
          onClick={onNewChat}
          className="h-10 justify-start gap-2 rounded-xl bg-card font-medium shadow-sm"
        >
          <Plus className="size-4" /> New chat
        </Button>
        <button
          type="button"
          onClick={onOpenGallery}
          className={cn(
            "flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent",
            view === "gallery" && "ring-2 ring-ring",
          )}
        >
          <Images className="size-4" /> Gallery
          {galleryCount > 0 && (
            <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
              {galleryCount}
            </span>
          )}
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-3">
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-2.5">
          <Search className="size-4 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* History */}
      <div className="scrollbar-thin mt-2 flex-1 overflow-y-auto px-3 pb-2">
        {jobs === undefined ? (
          <div className="flex items-center gap-2 px-2.5 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : today.length === 0 && earlier.length === 0 ? (
          <EmptyHistory hasQuery={Boolean(query.trim())} />
        ) : (
          <>
            <ChatGroup label="Today" jobs={today} activeJobId={activeJobId} view={view} onSelect={onSelectChat} />
            <ChatGroup label="Earlier" jobs={earlier} activeJobId={activeJobId} view={view} onSelect={onSelectChat} />
          </>
        )}
      </div>

      {/* User footer */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
            <User className="size-4" />
          </span>
          <span className="truncate text-sm font-medium text-sidebar-foreground">{userLabel}</span>
        </div>
      </div>
    </aside>
  );
}

function ChatGroup({
  label,
  jobs,
  activeJobId,
  view,
  onSelect,
}: {
  label: string;
  jobs: VideoJob[];
  activeJobId: string | null;
  view: "chat" | "gallery";
  onSelect: (id: string) => void;
}) {
  if (jobs.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">
        {jobs.map((job) => (
          <ChatRow
            key={job._id}
            job={job}
            active={view === "chat" && job._id === activeJobId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyHistory({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
      {hasQuery ? (
        <>
          <Search className="size-5" />
          <span>No chats match your search.</span>
        </>
      ) : (
        <>
          <MessageSquare className="size-5" />
          <span>No chats yet. Start one above.</span>
        </>
      )}
    </div>
  );
}

function RailButton({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "flex size-10 items-center justify-center rounded-xl text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent",
            active && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
