"use client";

import { FormEvent, KeyboardEvent } from "react";
import { ArrowUp, Grid3x3, Loader2, Ratio } from "lucide-react";

import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";

export function Composer({
  prompt,
  onPromptChange,
  gridBackground,
  onToggleGrid,
  onSubmit,
  disabled,
  submitting,
  placeholder = "Ask Chalk to explain anything…",
}: {
  prompt: string;
  onPromptChange: (v: string) => void;
  gridBackground: boolean;
  onToggleGrid: () => void;
  onSubmit: () => void;
  disabled: boolean;
  submitting: boolean;
  placeholder?: string;
}) {
  const canSend = prompt.trim().length >= 8 && !disabled;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (canSend) onSubmit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-3xl border border-border bg-card p-2.5 shadow-lg shadow-black/[0.03]"
    >
      <Textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
        className="px-3 pt-2 text-[15px]"
      />
      <div className="mt-1 flex items-center gap-2 px-1">
        <Pill active={gridBackground} onClick={onToggleGrid} icon={<Grid3x3 className="size-3.5" />}>
          Graph paper
        </Pill>
        <div className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">
          <Ratio className="size-3.5" /> 16:9
        </div>
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Generate video"
          className={cn(
            "ml-auto flex size-9 items-center justify-center rounded-full transition-colors",
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-secondary text-muted-foreground",
          )}
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
    </form>
  );
}

function Pill({
  children,
  icon,
  active,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
