import assert from "node:assert/strict";
import { test } from "node:test";
import { expandBeatTimepoints, scriptToSsml } from "./ssml";
import { validateStoryboard } from "./storyboard";

test("script SSML uses a short inter-beat pause", () => {
  const ssml = scriptToSsml([{ beats: ["First sentence.", "Second sentence."] }]);

  assert.equal((ssml.match(/<break time="100ms"\/>/g) ?? []).length, 2);
  assert.ok(!ssml.includes("250ms"));
});

test("script SSML places stable marks before exact spoken cues", () => {
  const ssml = scriptToSsml([
    {
      beats: [
        {
          narration: "Blue light collides with gas and scatters everywhere.",
          cues: ["Blue light", "gas", "scatters"],
        },
      ],
    },
  ]);

  assert.match(ssml, /beat_1__r0.*Blue light/);
  assert.match(ssml, /beat_1__r1.*gas/);
  assert.match(ssml, /beat_1__r2.*scatters/);
});

test("cue expansion preserves exact TTS cue marks", () => {
  const storyboard = validateStoryboard({
    title: "Cues",
    durationSeconds: 20,
    scenes: [
      {
        id: "scene_1",
        title: "CUES",
        composition: "flow",
        beats: [
          {
            id: "beat_1",
            narration: "Blue light collides with gas.",
            revealCues: ["Blue light", "gas"],
            visual: { type: "asset", assetKey: "light", label: "LIGHT", shape: "square", position: "center" },
            elements: [
              { id: "el_light", type: "asset", assetKey: "light", x: 0, y: 0, revealStep: 0 },
              { id: "el_gas", type: "asset", assetKey: "gas", x: 200, y: 0, revealStep: 1 },
            ],
          },
        ],
      },
    ],
  });
  const points = expandBeatTimepoints(
    storyboard,
    [
      { markName: "beat_1", timeSeconds: 1 },
      { markName: "beat_1__r0", timeSeconds: 1.2 },
      { markName: "beat_1__r1", timeSeconds: 2.8 },
    ],
    4,
  );

  assert.equal(points.find((point) => point.markName === "beat_1__r0")?.timeSeconds, 1.2);
  assert.equal(points.find((point) => point.markName === "beat_1__r1")?.timeSeconds, 2.8);
});