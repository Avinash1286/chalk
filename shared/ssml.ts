import type { Storyboard, VisualElement } from "./storyboard";
import { flattenBeats, scriptBeatId } from "./storyboard";

const INTER_BEAT_BREAK_MS = 100;

export type Timepoint = {
  markName: string;
  timeSeconds: number;
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// How many narration-synced reveal groups a beat has, from its elements' revealStep.
function beatSteps(beat: { elements?: VisualElement[] }): number {
  let max = 0;
  for (const el of beat.elements ?? []) {
    if (typeof el.revealStep === "number") max = Math.max(max, el.revealStep);
  }
  return max + 1;
}

// Split a sentence into `groups` contiguous word chunks so each reveal mark lands
// at roughly the moment its part of the sentence is spoken.
function splitWords(text: string, groups: number): string[] {
  const trimmed = text.trim();
  if (groups <= 1) return [trimmed];
  const words = trimmed.split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let idx = 0;
  for (let g = 0; g < groups; g += 1) {
    const end = g === groups - 1 ? words.length : Math.max(idx, Math.round(((g + 1) / groups) * words.length));
    result.push(words.slice(idx, end).join(" "));
    idx = end;
  }
  return result;
}

export type ScriptNarrationBeat = string | { narration: string; cues?: string[] };

function cueFraction(narration: string, cue: string | undefined, fallback: number): number {
  if (!cue) return fallback;
  const index = narration.toLowerCase().indexOf(cue.toLowerCase());
  return index < 0 ? fallback : index / Math.max(1, narration.length);
}

function cueMarkedNarration(beatId: string, narration: string, cues: string[]): string {
  const lower = narration.toLowerCase();
  let cursor = 0;
  let result = `<mark name="${escapeXml(beatId)}"/> `;
  cues.forEach((cue, cueIndex) => {
    const index = lower.indexOf(cue.toLowerCase(), cursor);
    if (index < cursor) return;
    result += `${escapeXml(narration.slice(cursor, index))}<mark name="${escapeXml(`${beatId}__r${cueIndex}`)}"/> `;
    cursor = index;
  });
  return `${result}${escapeXml(narration.slice(cursor))}`;
}

export function storyboardToSsml(storyboard: Storyboard): string {
  const lines = flattenBeats(storyboard).map((beat) => {
    if (beat.revealCues?.length) {
      return `${cueMarkedNarration(beat.id, beat.narration, beat.revealCues)} <break time="${INTER_BEAT_BREAK_MS}ms"/>`;
    }
    const steps = beatSteps(beat);
    if (steps <= 1) {
      return `<mark name="${escapeXml(beat.id)}"/> ${escapeXml(beat.narration)} <break time="${INTER_BEAT_BREAK_MS}ms"/>`;
    }
    const parts = splitWords(beat.narration, steps)
      .map((group, k) => {
        const mark = k === 0 ? beat.id : `${beat.id}__r${k}`;
        return `<mark name="${escapeXml(mark)}"/> ${escapeXml(group)}`;
      })
      .join(" ");
    return `${parts} <break time="${INTER_BEAT_BREAK_MS}ms"/>`;
  });
  return `<speak>${lines.join("\n")}</speak>`;
}

// SSML for a bare SCRIPT (before scene design exists). The narration is fixed
// once the script is polished, so this lets TTS run in parallel with the scene
// designers. One mark per beat, using the same deterministic ids the composer
// assigns later (scriptBeatId) — marks are zero-width, so the audio is
// byte-identical to what the post-design SSML would produce.
export function scriptToSsml(scenes: { beats: ScriptNarrationBeat[] }[]): string {
  const lines: string[] = [];
  scenes.forEach((scene, sceneIndex) => {
    scene.beats.forEach((beat, beatIndex) => {
      const narration = typeof beat === "string" ? beat : beat.narration;
      const cues = typeof beat === "string" ? [] : beat.cues ?? [];
      const beatId = scriptBeatId(sceneIndex, beatIndex);
      lines.push(
        `${cues.length ? cueMarkedNarration(beatId, narration, cues) : `<mark name="${escapeXml(beatId)}"/> ${escapeXml(narration)}`} <break time="${INTER_BEAT_BREAK_MS}ms"/>`,
      );
    });
  });
  return `<speak>${lines.join("\n")}</speak>`;
}

export function scaleTimepoints(timepoints: Timepoint[], from: number, to: number): Timepoint[] {
  if (from <= 0 || to <= 0) return timepoints;
  const factor = to / from;
  return timepoints.map((point) => ({ ...point, timeSeconds: point.timeSeconds * factor }));
}

// Expand per-BEAT timepoints (from early, pre-design TTS) into the per-REVEAL
// timepoints compileVideo expects: sub-beat __rK marks are interpolated inside
// the beat's real spoken span (start of this beat -> start of the next), which
// closely matches what in-SSML word-group marks would report, because
// splitWords slices the sentence into equal word shares anyway.
export function expandBeatTimepoints(
  storyboard: Storyboard,
  beatPoints: Timepoint[],
  durationSeconds: number,
): Timepoint[] {
  const flat = flattenBeats(storyboard);
  const byId = new Map(beatPoints.map((point) => [point.markName, point.timeSeconds]));
  const out: Timepoint[] = [];
  flat.forEach((beat, index) => {
    const start = byId.get(beat.id);
    if (start === undefined) return; // compileVideo degrades gracefully
    out.push({ markName: beat.id, timeSeconds: start });
    const steps = beatSteps(beat);
    let end = durationSeconds;
    for (let j = index + 1; j < flat.length; j += 1) {
      const next = byId.get(flat[j].id);
      if (next !== undefined) {
        end = next;
        break;
      }
    }
    const span = Math.max(0.6, end - start - 0.25); // exclude the beat break
    for (let k = 0; k < steps; k += 1) {
      const markName = `${beat.id}__r${k}`;
      const exact = byId.get(markName);
      const fallback = cueFraction(beat.narration, beat.revealCues?.[k], k / Math.max(1, steps));
      out.push({ markName, timeSeconds: exact ?? start + fallback * span });
    }
  });
  return out;
}

export function narrationText(storyboard: Storyboard): string {
  return flattenBeats(storyboard)
    .map((beat) => beat.narration)
    .join(" ");
}

export function estimateTimepoints(storyboard: Storyboard): {
  timepoints: Timepoint[];
  durationSeconds: number;
} {
  const beats = flattenBeats(storyboard);
  const targetDuration = Math.max(storyboard.durationSeconds, beats.length * 3);
  const totalChars = beats.reduce((sum, beat) => sum + beat.narration.length, 0);
  let cursor = 0;
  const timepoints: Timepoint[] = [];
  for (const beat of beats) {
    const weight = beat.narration.length / Math.max(1, totalChars);
    const beatDuration = Math.max(2.4, targetDuration * weight);
    const steps = beatSteps(beat);
    timepoints.push({ markName: beat.id, timeSeconds: cursor });
    for (let k = 0; k < steps; k += 1) {
      const fallback = steps > 1 ? k / steps : 0;
      const frac = cueFraction(beat.narration, beat.revealCues?.[k], fallback);
      timepoints.push({ markName: `${beat.id}__r${k}`, timeSeconds: cursor + frac * beatDuration * 0.9 });
    }
    cursor += beatDuration;
  }
  return {
    timepoints,
    durationSeconds: Math.max(cursor + 1.2, targetDuration),
  };
}
