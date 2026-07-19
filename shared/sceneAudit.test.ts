import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSceneAudit } from "./sceneAudit";

test("scene audit sanitizer aligns rows and defaults missing scenes to pass", () => {
  const audit = sanitizeSceneAudit(
    {
      scenes: [
        { sceneId: "scene_2", pass: false, score: 42, issues: ["Disconnected symbols"] },
        { sceneId: "unknown", score: 95 },
      ],
    },
    ["scene_1", "scene_2", "scene_3"],
  );

  assert.deepEqual(audit[0], { sceneId: "scene_1", pass: true, score: 100, issues: [] });
  assert.deepEqual(audit[1], { sceneId: "scene_2", pass: false, score: 42, issues: ["Disconnected symbols"] });
  assert.deepEqual(audit[2], { sceneId: "scene_3", pass: true, score: 100, issues: [] });
});

test("scene audit sanitizer derives conservative pass state", () => {
  const [result] = sanitizeSceneAudit(
    { scenes: [{ sceneId: "scene_1", score: 65, issues: ["Labels are too small"] }] },
    ["scene_1"],
  );
  assert.equal(result.pass, false);
  assert.equal(result.score, 65);
});