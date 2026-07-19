import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setVideoProviderBias } from "../shared/iconResolver";
import { compileVideo } from "../shared/layout";
import { validateStoryboard, type Storyboard } from "../shared/storyboard";
import { estimateTimepoints, expandBeatTimepoints, scaleTimepoints, type Timepoint } from "../shared/ssml";
import type { ResolvedTimeline } from "../shared/timeline";
import { storyboardToVideoPlan, type VideoPlan } from "../shared/videoPlan";
import { draftScript, designStoryboardFromScript, type Outline } from "./agents";
import { probeDurationSeconds } from "./ffmpeg";
import { loadNarrationCheckpoint, synthesizeScriptNarration, type ScriptAudioResult } from "./google";
import type { OrchestrationStage } from "./orchestrator/types";
import { resolveScenesInParallel } from "./orchestrator/resolveScenes";
import { prepareStoryboardAssets, type AssetResolutionRecord } from "./assetResolver";
import { warmIconEmbeddings } from "./iconWarm";
import { rerankIcons } from "./iconRerank";
import { renderVideo, type RenderProgress } from "./render";

export type PipelineProgress =
  | { stage: Extract<OrchestrationStage, "directing" | "generating_assets" | "assembling">; progress: number; message: string; sceneId?: string }
  | { stage: "rendering_final"; phase: RenderProgress["stage"]; progress: number; message: string }
  | { stage: "completed"; progress: number; message: string };

export type PipelineResult = {
  outputPath: string;
  storyboard: Storyboard;
  videoPlan: VideoPlan;
  timeline: ResolvedTimeline;
  artifactPaths: {
    plan: string;
    assetResolution: string;
    resolvedScenes: string;
    timeline: string;
    layoutDiagnostics: string;
    designReport: string;
    qualityReport: string;
    contactSheet: string;
  };
  plannerSource: "agents";
  audioSource: "google-tts";
  durationSeconds: number;
  assetResolution: AssetResolutionRecord[];
};

// Combine the early (pre-design) narration with the designed storyboard into
// the per-reveal timepoints compileVideo expects. If the voice reported real
// beat marks AND the designed storyboard still matches the script structurally
// (same scenes/beats — designers keep narration verbatim, but a scene can in
// principle be dropped by sanitization), expand them to sub-beat reveals.
// Otherwise fall back to the word-weighted estimate scaled to the real audio
// length — the exact behaviour the serial pipeline had.
function resolveNarrationTiming(
  script: Outline,
  storyboard: Storyboard,
  audio: ScriptAudioResult,
): { audioPath: string; timepoints: Timepoint[]; durationSeconds: number; source: "google-tts" } {
  const structureMatches =
    storyboard.scenes.length === script.scenes.length &&
    storyboard.scenes.every((scene, i) => scene.beats.length === script.scenes[i].beats.length);

  const estimate = estimateTimepoints(storyboard);
  const timepoints =
    audio.beatTimepoints.length > 0 && structureMatches
      ? expandBeatTimepoints(storyboard, audio.beatTimepoints, audio.durationSeconds)
      : scaleTimepoints(estimate.timepoints, estimate.durationSeconds, audio.durationSeconds);

  return {
    audioPath: audio.audioPath,
    timepoints,
    durationSeconds: audio.durationSeconds,
    source: audio.source,
  };
}

// Checkpoint reuse (Resume): a failed job's outputDir may already hold a valid
// storyboard.json (written right after design) and narration.wav. Reusing them
// skips scripting, scene design and TTS entirely — a render-stage failure
// resumes in seconds instead of re-billing every model call.
async function loadCheckpointStoryboard(outputDir: string): Promise<Storyboard | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(outputDir, "storyboard.json"), "utf8"));
    return validateStoryboard(raw);
  } catch {
    return null; // missing or unusable -> full fresh run
  }
}

// The script equivalent of a designed storyboard — narration is stored verbatim
// on the beats, so a resumed job can re-synthesize audio (or match timings)
// without re-calling the script agents.
function scriptFromStoryboard(storyboard: Storyboard): Outline {
  return {
    title: storyboard.title,
    durationSeconds: storyboard.durationSeconds,
    scenes: storyboard.scenes.map((scene) => ({
      title: scene.title,
      intent: "",
      beats: scene.beats.map((beat) => ({
        narration: beat.narration,
        cues: beat.revealCues ?? [],
      })),
    })),
  };
}

async function reuseOrSynthesizeNarration(script: Outline, outputDir: string): Promise<ScriptAudioResult> {
  // Reuse the composed narration.wav + its exact per-beat timing sidecar; only
  // synthesize fresh when the checkpoint is missing or unusable.
  const checkpoint = await loadNarrationCheckpoint(outputDir);
  if (checkpoint) return checkpoint;
  return synthesizeScriptNarration(script, outputDir);
}

async function writeJsonArtifact(outputDir: string, filename: string, data: unknown): Promise<string> {
  const artifactPath = path.join(outputDir, filename);
  await writeFile(artifactPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return artifactPath;
}

export async function runVideoPipeline(input: {
  prompt: string;
  outputDir: string;
  background?: "plain" | "grid";
  // Reuse this job's saved storyboard/narration checkpoints when present
  // (set for Resume retries; Regenerate starts a new job with a fresh dir).
  resume?: boolean;
  onProgress?: (progress: PipelineProgress) => void | Promise<void>;
  // Live HLS: called once per encoded MPEG-TS segment (in order), then on
  // completion. When omitted (render:local, tests) no segments are encoded.
  onSegment?: (segmentPath: string, index: number, durationSeconds: number) => void | Promise<void>;
  onSegmentsComplete?: () => void | Promise<void>;
}): Promise<PipelineResult> {
  await mkdir(input.outputDir, { recursive: true });

  let script: Outline;
  let storyboard: Storyboard;
  let plannerSource: "agents" = "agents";
  let visualBrief: unknown = null;
  let repairedSceneIds: string[] = [];

  const checkpoint = input.resume ? await loadCheckpointStoryboard(input.outputDir) : null;
  let scriptAudio: ScriptAudioResult;
  if (checkpoint) {
    await input.onProgress?.({
      stage: "directing",
      progress: 0.1,
      message: "Resuming from the saved plan",
    });
    storyboard = checkpoint;
    script = scriptFromStoryboard(checkpoint);
    scriptAudio = await reuseOrSynthesizeNarration(script, input.outputDir);
  } else {
    await input.onProgress?.({
      stage: "directing",
      progress: 0.08,
      message: "Writing the script",
    });
    // Stage 1: the script. After this the narration is FINAL (designers keep
    // beats verbatim), so TTS runs in PARALLEL with scene design below.
    script = await draftScript(input.prompt);

    await input.onProgress?.({
      stage: "directing",
      progress: 0.14,
      message: "Designing scenes + narrating (in parallel)",
    });
    const [designed, audio] = await Promise.all([
      designStoryboardFromScript(script),
      synthesizeScriptNarration(script, input.outputDir),
    ]);
    storyboard = designed.storyboard;
    plannerSource = designed.source;
    visualBrief = designed.visualBrief;
    repairedSceneIds = designed.repairedSceneIds;
    scriptAudio = audio;
  }
  const videoPlan = storyboardToVideoPlan(storyboard);
  const planPath = await writeJsonArtifact(input.outputDir, "plan.json", videoPlan);
  const designReportPath = await writeJsonArtifact(input.outputDir, "design-report.json", {
    version: 1,
    resumedFromCheckpoint: Boolean(checkpoint),
    visualBrief,
    repairedSceneIds,
  });
  // Persist the raw storyboard so an interrupted run can be re-rendered offline
  // (scripts/resume-render.ts) without re-calling the director.
  await writeJsonArtifact(input.outputDir, "storyboard.json", storyboard);

  await input.onProgress?.({
    stage: "generating_assets",
    progress: 0.15,
    message: "Matching icons by meaning (embeddings)",
  });
  await warmIconEmbeddings(storyboard);

  await input.onProgress?.({
    stage: "generating_assets",
    progress: 0.17,
    message: "Choosing icons in context (rerank)",
  });
  await rerankIcons(storyboard);

  await input.onProgress?.({
    stage: "generating_assets",
    progress: 0.18,
    message: "Resolving library and OpenMoji icons",
  });
  const preparedAssets = await prepareStoryboardAssets(storyboard);
  storyboard = preparedAssets.storyboard;
  const assetResolution = preparedAssets.records;
  // Upgrade the resume checkpoint with exact asset bindings. Future renders of
  // this job now use the same SVGs even if caches or provider bias change.
  await writeJsonArtifact(input.outputDir, "storyboard.json", storyboard);
  const assetResolutionPath = await writeJsonArtifact(input.outputDir, "asset-resolution.json", assetResolution);

  // One visual dialect per VIDEO: bias render-time icon resolution toward the
  // majority provider so near-tie picks don't flip style between scenes. The
  // house library wins ties — it is the preferred style.
  const providerCounts = { "local-openmoji": 0, "icon-library": 0 };
  for (const record of assetResolution) {
    if (record.provider === "local-openmoji" || record.provider === "icon-library") {
      providerCounts[record.provider] += 1;
    }
  }
  setVideoProviderBias(
    providerCounts["local-openmoji"] > 0 || providerCounts["icon-library"] > 0
      ? {
          provider: providerCounts["icon-library"] >= providerCounts["local-openmoji"] ? "icon-library" : "local-openmoji",
          bonus: 0.06,
        }
      : null,
  );

  const audio = resolveNarrationTiming(script, storyboard, scriptAudio);

  await input.onProgress?.({
    stage: "generating_assets",
    progress: 0.3,
    message: "Resolving scene work items",
  });
  const compiled = compileVideo(
    storyboard,
    audio.timepoints,
    audio.durationSeconds,
    {
      width: Number(process.env.VIDEO_WIDTH ?? 1920),
      height: Number(process.env.VIDEO_HEIGHT ?? 1080),
      fps: Number(process.env.VIDEO_FPS ?? 12),
      background: input.background ?? "plain",
    },
  );
  const resolvedScenes = await resolveScenesInParallel({
    videoPlan,
    compiled,
    async onProgress(progress) {
      await input.onProgress?.({
        stage: "generating_assets",
        progress: 0.32 + ((progress.sceneIndex + (progress.status === "completed" ? 1 : 0.25)) / progress.totalScenes) * 0.28,
        message: progress.message,
        sceneId: progress.sceneId,
      });
    },
  });

  await input.onProgress?.({
    stage: "assembling",
    progress: 0.64,
    message: "Assembling validated timeline artifacts",
  });
  const resolvedScenesPath = await writeJsonArtifact(input.outputDir, "resolved-scenes.json", resolvedScenes.scenes);
  const timelinePath = await writeJsonArtifact(input.outputDir, "timeline.json", compiled.timeline);
  const layoutDiagnosticsPath = await writeJsonArtifact(
    input.outputDir,
    "layout-diagnostics.json",
    compiled.layoutDiagnostics,
  );
  const qualityReportPath = await writeJsonArtifact(input.outputDir, "quality-report.json", {
    version: 1,
    assets: {
      total: assetResolution.length,
      bound: assetResolution.filter((record) => record.provider !== "unresolved").length,
      unresolved: assetResolution.filter((record) => record.provider === "unresolved").map((record) => ({
        assetKey: record.assetKey,
        label: record.label,
        sceneId: record.sceneId,
        reason: record.reason,
      })),
      providers: {
        iconLibrary: assetResolution.filter((record) => record.provider === "icon-library").length,
        openMoji: assetResolution.filter((record) => record.provider === "local-openmoji").length,
      },
    },
    layout: {
      errors: compiled.layoutDiagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      warnings: compiled.layoutDiagnostics.filter((diagnostic) => diagnostic.severity === "warning"),
      affectedScenes: [...new Set(compiled.layoutDiagnostics.map((diagnostic) => diagnostic.sceneId))],
    },
    visualQa: {
      enabled: (process.env.SCENE_VISUAL_QA ?? "on").trim().toLowerCase() !== "off",
      repairedSceneIds,
    },
  });

  const outputPath = await renderVideo(
    compiled,
    audio.audioPath,
    input.outputDir,
    async (progress) => {
      await input.onProgress?.({
        stage: "rendering_final",
        phase: progress.stage,
        progress: progress.progress,
        message: progress.message,
      });
    },
    input.onSegment ? { onSegment: input.onSegment, onComplete: input.onSegmentsComplete } : undefined,
  );
  const outputDurationSeconds = await probeDurationSeconds(outputPath);

  await input.onProgress?.({
    stage: "completed",
    progress: 1,
    message: "Video completed",
  });

  return {
    outputPath: path.resolve(outputPath),
    storyboard,
    videoPlan,
    timeline: compiled.timeline,
    artifactPaths: {
      plan: path.resolve(planPath),
      assetResolution: path.resolve(assetResolutionPath),
      resolvedScenes: path.resolve(resolvedScenesPath),
      timeline: path.resolve(timelinePath),
      layoutDiagnostics: path.resolve(layoutDiagnosticsPath),
      designReport: path.resolve(designReportPath),
      qualityReport: path.resolve(qualityReportPath),
      contactSheet: path.resolve(path.join(input.outputDir, "contact-sheet.jpg")),
    },
    plannerSource,
    audioSource: audio.source,
    durationSeconds: outputDurationSeconds,
    assetResolution,
  };
}
