import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeOutline } from "../worker/agents";

test("outline sanitizer keeps only exact cues in spoken order", () => {
  const outline = sanitizeOutline({
    title: "Light",
    durationSeconds: 90,
    scenes: [
      {
        title: "Scattering",
        intent: "show the flow",
        beats: [
          {
            narration: "Blue light collides with gas and scatters everywhere.",
            cues: ["Blue light", "scatters", "not spoken", "gas"],
          },
        ],
      },
      { title: "Legacy", intent: "old checkpoint", beats: ["Legacy string beat."] },
      { title: "Recap", intent: "checklist", beats: [{ narration: "Remember blue light.", cues: ["blue light"] }] },
    ],
  });

  assert.ok(outline);
  assert.deepEqual(outline!.scenes[0].beats[0].cues, ["Blue light", "scatters"]);
  assert.deepEqual(outline!.scenes[1].beats[0], { narration: "Legacy string beat.", cues: [] });
  assert.deepEqual(outline!.scenes[2].beats[0].cues, ["blue light"]);
});