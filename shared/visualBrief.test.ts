import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultVisualBrief, sanitizeVisualBrief } from "./visualBrief";

const scenes = [
  { title: "THE INPUTS", intent: "three ingredients", beats: ["One.", "Two.", "Three."] },
  { title: "THE PROCESS", intent: "step-by-step pipeline", beats: ["First.", "Then."] },
  { title: "RECAP", intent: "checklist summary", beats: ["One.", "Two.", "Three."] },
];

test("default visual brief assigns scene-specific patterns", () => {
  assert.deepEqual(defaultVisualBrief(scenes).scenes.map((scene) => scene.pattern), ["list", "flow", "checklist"]);
});

test("visual brief sanitizer repairs malformed and missing rows", () => {
  const brief = sanitizeVisualBrief(
    { scenes: [{ pattern: "pie", density: "dense", emphasis: "Percentages" }, { pattern: "invalid" }] },
    scenes,
  );
  assert.equal(brief.scenes.length, scenes.length);
  assert.equal(brief.scenes[0].pattern, "pie");
  assert.equal(brief.scenes[0].density, "dense");
  assert.equal(brief.scenes[1].pattern, "flow");
  assert.equal(brief.scenes[2].pattern, "checklist");
});