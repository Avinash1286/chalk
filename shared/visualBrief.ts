export const visualBriefPatterns = [
  "flow",
  "comparison",
  "list",
  "checklist",
  "cards",
  "bands",
  "timeline",
  "pie",
  "annotate",
  "fanout",
  "convergence",
  "loopback",
  "cycle",
  "branch",
  "radial",
  "ladder",
  "grid",
  "hero",
] as const;

export type VisualBriefPattern = (typeof visualBriefPatterns)[number];
export type VisualDensity = "focused" | "balanced" | "dense";

export type SceneVisualBrief = {
  sceneIndex: number;
  pattern: VisualBriefPattern;
  density: VisualDensity;
  emphasis: string;
  continuity: string;
  avoid: string[];
};

export type VideoVisualBrief = {
  style: "flat-doodle";
  scenes: SceneVisualBrief[];
};

export type VisualBriefSceneInput = {
  title: string;
  intent: string;
  beats: string[];
};

function inferredPattern(scene: VisualBriefSceneInput, index: number, total: number): VisualBriefPattern {
  const text = `${scene.title} ${scene.intent}`.toLowerCase();
  if (index === total - 1 || /recap|summary|checklist/.test(text)) return "checklist";
  if (/compare|contrast|versus|vs\b|before.*after/.test(text)) return "comparison";
  if (/percent|share|parts? of|composition/.test(text)) return "pie";
  if (/range|spectrum|bands?|tiers?|levels?/.test(text)) return "bands";
  if (/history|timeline|over time|years?/.test(text)) return "timeline";
  if (/cycle|loop|repeat/.test(text)) return "cycle";
  if (/one.to.many|fan.?out|produces many/.test(text)) return "fanout";
  if (/many.to.one|converge|combine|aggregate/.test(text)) return "convergence";
  if (/decision|yes\/no|branch/.test(text)) return "branch";
  if (/parts?|anatomy|inside|annotat/.test(text)) return "annotate";
  if (/factors?|features?|ingredients?|benefits?/.test(text)) return "list";
  if (/steps?|pipeline|process|flows?|becomes?|turns into/.test(text)) return "flow";
  return scene.beats.length <= 2 ? "hero" : "grid";
}

export function defaultVisualBrief(scenes: VisualBriefSceneInput[]): VideoVisualBrief {
  return {
    style: "flat-doodle",
    scenes: scenes.map((scene, sceneIndex) => ({
      sceneIndex,
      pattern: inferredPattern(scene, sceneIndex, scenes.length),
      density: scene.beats.length >= 5 ? "dense" : scene.beats.length <= 2 ? "focused" : "balanced",
      emphasis: scene.intent || scene.title,
      continuity: sceneIndex === 0 ? "Establish the visual vocabulary." : "Build on the previous scene without repeating it.",
      avoid: ["disconnected symbols", "duplicate icons", "decorative objects"],
    })),
  };
}

export function sanitizeVisualBrief(raw: unknown, scenes: VisualBriefSceneInput[]): VideoVisualBrief {
  const fallback = defaultVisualBrief(scenes);
  const rows = raw && typeof raw === "object" && Array.isArray((raw as { scenes?: unknown }).scenes)
    ? (raw as { scenes: unknown[] }).scenes
    : [];
  const allowedPatterns = new Set<string>(visualBriefPatterns);
  const allowedDensities = new Set<VisualDensity>(["focused", "balanced", "dense"]);

  return {
    style: "flat-doodle",
    scenes: fallback.scenes.map((base, sceneIndex) => {
      const row = rows[sceneIndex];
      if (!row || typeof row !== "object") return base;
      const value = row as Record<string, unknown>;
      const text = (input: unknown, max: number, defaultValue: string): string => {
        const normalized = typeof input === "string" ? input.trim() : "";
        return (normalized || defaultValue).slice(0, max);
      };
      const avoid = Array.isArray(value.avoid)
        ? value.avoid
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .map((item) => item.trim().slice(0, 60))
            .slice(0, 4)
        : base.avoid;
      return {
        sceneIndex,
        pattern: allowedPatterns.has(String(value.pattern))
          ? (value.pattern as VisualBriefPattern)
          : base.pattern,
        density: allowedDensities.has(value.density as VisualDensity)
          ? (value.density as VisualDensity)
          : base.density,
        emphasis: text(value.emphasis, 120, base.emphasis),
        continuity: text(value.continuity, 120, base.continuity),
        avoid,
      };
    }),
  };
}