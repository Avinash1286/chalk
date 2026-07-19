import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMediaDurationsAligned } from "../worker/ffmpeg";

test("media duration gate accepts sub-frame mux drift", () => {
  assert.doesNotThrow(() =>
    assertMediaDurationsAligned(
      { format: 46.167, video: 46.167, audio: 46.145 },
      12,
      46.2,
    ),
  );
});

test("media duration gate rejects a silent video tail", () => {
  assert.throws(
    () =>
      assertMediaDurationsAligned(
        { format: 130.083, video: 130.083, audio: 112.848 },
        12,
        112.848,
      ),
    /audio\/video drift/,
  );
});

test("media duration gate rejects equally truncated streams", () => {
  assert.throws(
    () =>
      assertMediaDurationsAligned(
        { format: 41.083, video: 41.083, audio: 41.077 },
        12,
        46.2,
      ),
    /expected 46\.200s/,
  );
});