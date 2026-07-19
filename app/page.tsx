import type { Metadata } from "next";
import Link from "next/link";
import { Patrick_Hand } from "next/font/google";

import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/whiteboard/brand-mark";

// The same hand-drawn face the videos use — the landing page IS the product's
// visual language: warm paper, marker headings, the house icon library.
const marker = Patrick_Hand({ weight: "400", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Chalk — AI whiteboard explainer videos",
  description:
    "Most AI video is built for cinematic clips. Chalk is built for useful videos that teach and explain.",
};

// Icons drawn by Chalk's own image-model icon library (assets/generated/icon-library).
const STRIP_ICONS = [
  "rocket", "brain", "chart", "globe", "lock", "server", "shield", "clock",
  "wallet", "network", "coin", "document", "learning", "warning", "database", "timeline",
];

function Doodle({ name, size = 44, className }: { name: string; size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/icons/${name}.svg`}
      alt=""
      width={size}
      height={size}
      className={cn("select-none", className)}
      aria-hidden
    />
  );
}

function SketchCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-2xl border-2 border-foreground/85 bg-card p-6 shadow-[5px_5px_0_0_theme(colors.foreground/12%)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

const STEPS = [
  {
    icon: "document",
    title: "Type one line",
    body: "“Explain how credit scores work.” That’s the whole brief — no timeline, no editor, no assets to hunt down.",
  },
  {
    icon: "brain",
    title: "Agents write & design",
    body: "A scriptwriter drafts a real narrative, an editor makes every sentence drawable, and a designer lays out each scene as a clean diagram.",
  },
  {
    icon: "clock",
    title: "Watch it stream in",
    body: "Playback starts seconds into rendering — the board draws itself in sync with the narration while the rest of the video is still being made.",
  },
];

const FEATURES = [
  {
    icon: "learning",
    title: "Scripts that teach",
    body: "A hook, a guiding analogy, real numbers put on screen — not a bullet list read aloud.",
  },
  {
    icon: "rocket",
    title: "A hand-drawn icon library of its own",
    body: "Every icon is drawn by Chalk’s image model in one locked style — and the library grows with every video generated.",
  },
  {
    icon: "network",
    title: "Deterministic layout engine",
    body: "Flows, comparisons, cycles, timelines — solved by geometry, not vibes. No overlaps, ever.",
  },
  {
    icon: "chart",
    title: "Word-synced draw-on",
    body: "Icons wipe in outline-then-fill exactly as they’re spoken. The narration is the storyboard.",
  },
  {
    icon: "clock",
    title: "Live playback",
    body: "An HLS stream starts while the render is still running — no waiting for the full video.",
  },
  {
    icon: "shield",
    title: "Reliable by construction",
    body: "Checkpointed jobs, resumable renders, and a watchdog that fails loudly instead of hanging.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      {/* subtle whiteboard grid */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(to right, oklch(0.92 0.004 265 / 40%) 1px, transparent 1px), linear-gradient(to bottom, oklch(0.92 0.004 265 / 40%) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
        aria-hidden
      />

      <div className="relative mx-auto max-w-6xl px-5">
        {/* Nav */}
        <header className="flex items-center justify-between py-6">
          <div className="flex items-center gap-2.5">
            <BrandMark size={30} />
            <span className={cn(marker.className, "text-2xl")}>Chalk</span>
          </div>
          <nav className="flex items-center gap-3">
            <a href="#how" className="hidden text-sm text-muted-foreground hover:text-foreground sm:block">
              How it works
            </a>
            <a href="#demo" className="hidden text-sm text-muted-foreground hover:text-foreground sm:block">
              Demo
            </a>
            <Link
              href="/chalk"
              className="rounded-full border-2 border-foreground/85 bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-[3px_3px_0_0_theme(colors.foreground/15%)] transition-transform hover:-translate-y-0.5"
            >
              Open the studio
            </Link>
          </nav>
        </header>

        {/* Hero */}
        <section className="grid items-center gap-10 py-14 lg:grid-cols-[1.05fr_1fr] lg:py-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
              <Doodle name="rocket" size={16} /> AI whiteboard explainer videos
            </p>
            <h1 className={cn(marker.className, "text-5xl leading-[1.05] sm:text-6xl lg:text-7xl")}>
              Type a prompt.
              <br />
              Watch it{" "}
              <span className="relative inline-block">
                explain itself.
                <svg
                  className="absolute -bottom-2 left-0 w-full"
                  viewBox="0 0 220 12"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M3 8 C 60 2, 150 12, 217 5"
                    stroke="#ffd43b"
                    strokeWidth="7"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
              Most AI video is built for cinematic clips. <span className="font-semibold text-foreground">Chalk</span> is
              built for useful videos that teach and explain.
            </p>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
              One line in — a narrated, hand-drawn whiteboard video out: a real script, clean scene diagrams, and every
              icon drawn as it’s spoken.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/chalk"
                className="rounded-xl border-2 border-foreground/85 bg-primary px-6 py-3 font-medium text-primary-foreground shadow-[4px_4px_0_0_theme(colors.foreground/15%)] transition-transform hover:-translate-y-0.5"
              >
                Make a video
              </Link>
              <a
                href="#demo"
                className="rounded-xl border-2 border-foreground/85 bg-card px-6 py-3 font-medium shadow-[4px_4px_0_0_theme(colors.foreground/10%)] transition-transform hover:-translate-y-0.5"
              >
                Watch the demo
              </a>
            </div>
          </div>

          <div className="relative">
            <Doodle name="brain" size={54} className="absolute -left-6 -top-8 -rotate-6" />
            <Doodle name="chart" size={48} className="absolute -right-4 -top-10 rotate-6" />
            <Doodle name="globe" size={50} className="absolute -bottom-8 -left-8 rotate-3" />
            <div className="rotate-1 overflow-hidden rounded-2xl border-2 border-foreground/85 bg-card shadow-[8px_8px_0_0_theme(colors.foreground/12%)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/landing/ss.png" alt="The Chalk studio generating a whiteboard explainer" className="w-full" />
            </div>
          </div>
        </section>

        {/* Icon strip */}
        <section className="py-8">
          <SketchCard className="flex flex-col items-center gap-4 py-5">
            <div className="flex flex-wrap items-center justify-center gap-4">
              {STRIP_ICONS.map((name) => (
                <Doodle key={name} name={name} size={40} className="transition-transform hover:-translate-y-1" />
              ))}
            </div>
            <p className="text-center text-sm text-muted-foreground">
              Every icon above was drawn by Chalk’s own image-model icon library — one style, hundreds of concepts,
              growing with every video.
            </p>
          </SketchCard>
        </section>

        {/* How it works */}
        <section id="how" className="py-16">
          <h2 className={cn(marker.className, "text-center text-4xl sm:text-5xl")}>How it works</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <SketchCard key={step.title} className={i === 1 ? "md:-rotate-1" : "md:rotate-1"}>
                <div className="flex items-center gap-3">
                  <Doodle name={step.icon} size={42} />
                  <span className={cn(marker.className, "text-sm text-muted-foreground")}>Step {i + 1}</span>
                </div>
                <h3 className={cn(marker.className, "mt-3 text-2xl")}>{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              </SketchCard>
            ))}
          </div>
        </section>

        {/* Demo */}
        <section id="demo" className="py-16">
          <h2 className={cn(marker.className, "text-center text-4xl sm:text-5xl")}>Watch one draw itself</h2>
          <p className="mx-auto mt-3 max-w-lg text-center text-muted-foreground">
            A full explainer generated by Chalk from a single prompt — script, scenes, narration, and icons included.
          </p>
          <div className="mx-auto mt-8 max-w-3xl overflow-hidden rounded-2xl border-2 border-foreground/85 bg-black shadow-[8px_8px_0_0_theme(colors.foreground/12%)]">
            <video className="aspect-video w-full" src="/landing/demo.mp4" poster="/landing/poster.png" controls playsInline />
          </div>
        </section>

        {/* Features */}
        <section className="py-16">
          <h2 className={cn(marker.className, "text-center text-4xl sm:text-5xl")}>Built to explain</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <SketchCard key={feature.title}>
                <Doodle name={feature.icon} size={44} />
                <h3 className={cn(marker.className, "mt-3 text-2xl")}>{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
              </SketchCard>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-16">
          <SketchCard className="flex flex-col items-center gap-5 bg-primary py-12 text-primary-foreground">
            <h2 className={cn(marker.className, "max-w-2xl text-center text-4xl leading-tight sm:text-5xl")}>
              The next thing you have to explain — let Chalk draw it.
            </h2>
            <Link
              href="/chalk"
              className="rounded-xl border-2 border-primary-foreground/90 bg-background px-7 py-3 font-medium text-foreground shadow-[4px_4px_0_0_rgb(255_255_255/20%)] transition-transform hover:-translate-y-0.5"
            >
              Open the studio
            </Link>
          </SketchCard>
        </section>

        {/* Footer */}
        <footer className="flex flex-col items-center justify-between gap-3 border-t border-border py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <BrandMark size={22} />
            <span className={cn(marker.className, "text-lg text-foreground")}>Chalk</span>
          </div>
          <p>Useful videos that teach and explain.</p>
        </footer>
      </div>
    </main>
  );
}
