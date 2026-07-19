import { test } from "node:test";
import assert from "node:assert/strict";
import { findLibraryIcon } from "./iconLibrary";
import { resolveSceneIcons } from "./iconResolver";
import { setRerank } from "./iconRerankCache";
import { resolveOpenMojiAssetInfo } from "./openMojiAssets";
import { normalizeQuery } from "./openMojiEmbeddings";
import type { VisualElement } from "./storyboard";

test("exact library lookup does not treat broad synonyms as identity", () => {
  assert.equal(findLibraryIcon("waterDrop", "WATER"), null);
  assert.equal(findLibraryIcon("anchor", "WATER")?.id, "anchor");
});

test("resolver rejects weak semantic proxies so missing icons can be generated", () => {
  const prism = resolveOpenMojiAssetInfo("prism", "glass prism");
  assert.ok(prism === null || prism.iconRef === "iclib:prism");

  const water = resolveOpenMojiAssetInfo("waterDrop", "WATER");
  assert.equal(water?.iconRef, "openmoji:1F4A7");
});

test("renderer honors an immutable resolved asset binding", () => {
  const element: VisualElement = {
    id: "el_bound",
    type: "asset",
    assetKey: "waterDrop",
    label: "WATER",
    x: 0,
    y: 0,
    resolvedAsset: {
      provider: "icon-library",
      iconRef: "iclib:magnifier-inspect",
      svgPath: "assets/generated/icon-library/svg/magnifier-inspect.svg",
      label: "Bound test icon",
    },
  };

  assert.equal(resolveSceneIcons([element]).get(element.id)?.iconRef, "iclib:magnifier-inspect");
});

// The context-aware rerank decision must win over raw embedding/keyword matching.
test("resolver prefers a context-aware rerank choice", () => {
  const key = "polysemyTestConcept";
  const hint = "river bank water nature";
  const qk = normalizeQuery(key, hint);
  setRerank(qk, {
    iconRef: "openmoji:1F3DE",
    svgPath: "assets/vendor/openmoji/color/1F3DE.svg",
    label: "national park",
    source: "local-openmoji",
  });
  const res = resolveOpenMojiAssetInfo(key, hint, undefined, true);
  assert.ok(res, "resolver should return a result");
  assert.equal(res?.iconRef, "openmoji:1F3DE", "should use the reranked icon");
  assert.equal(res?.provider, "local-openmoji");
});

test("rerank choice is skipped when that icon is already used in the scene (dedup)", () => {
  const key = "polysemyTestConcept2";
  const hint = "computer mouse pointer";
  const qk = normalizeQuery(key, hint);
  setRerank(qk, {
    iconRef: "iclib:some-mouse",
    svgPath: "assets/generated/icon-library/svg/some-mouse.svg",
    label: "computer mouse",
    source: "icon-library",
  });
  // Excluding that exact ref forces a fall-through (not the rerank pick).
  const res = resolveOpenMojiAssetInfo(key, hint, new Set(["iclib:some-mouse"]), true);
  assert.ok(!res || res.iconRef !== "iclib:some-mouse", "should not reuse an excluded icon");
});
