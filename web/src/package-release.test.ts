import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_NAME, PACKAGE_SEGMENT, comesAlong, isInstalledName, nextVersion, packageLabel, packageOf, pickerGroups, picksFromRelease } from "./package-release";

test("packageOf reads the package off a name with a prefix", () => {
  assert.equal(packageOf("stakwork/tools/summarize"), "stakwork/tools");
  assert.equal(packageOf("acme/demo/x/deep"), "acme/demo");
  assert.equal(packageOf("acme/x"), null);
  assert.equal(packageOf("summarize"), null);
});

test("PACKAGE_NAME takes two lowercase segments, PACKAGE_SEGMENT the one a person types", () => {
  assert.ok(PACKAGE_NAME.test("stakwork/tools"));
  assert.ok(!PACKAGE_NAME.test("Stakwork/tools"));
  assert.ok(!PACKAGE_NAME.test("stakwork/tools_x"));
  assert.ok(PACKAGE_SEGMENT.test("tools"));
  assert.ok(!PACKAGE_SEGMENT.test("acme/tools"));
  assert.ok(!PACKAGE_SEGMENT.test("Tools"));
});

test("nextVersion raises the last number", () => {
  assert.equal(nextVersion(undefined), "1.0.0");
  assert.equal(nextVersion("1.4.0"), "1.4.1");
  assert.equal(nextVersion("1.0.9"), "1.0.10");
  assert.equal(nextVersion("v3"), "v4");
  assert.equal(nextVersion("2.0.0-rc"), "2.0.1-rc");
  assert.equal(nextVersion("beta"), "beta");
});

test("pickerGroups groups the workflows here by category, an installed package's and the host's left out", () => {
  const workflows = [
    { name: "summarize", category: "media" },
    { name: "clip", category: "media" },
    { name: "transcribe", category: "calls" },
    { name: "scratch" },
    { name: "bob/util/fmt", category: "media" },
    { name: "lab-seeded", publisher: "lab" },
    { name: "job", category: "job", activeSource: "seed" },
    { name: "ai-made", publisher: "ai", category: "calls" },
  ];
  assert.deepEqual(pickerGroups(workflows, { installed: ["bob/util"] }), [
    { category: "calls", names: ["ai-made", "transcribe"] },
    { category: "media", names: ["clip", "summarize"] },
    { category: null, names: ["scratch"] },
  ]);
  assert.deepEqual(pickerGroups(workflows, { q: "CLI" }), [{ category: "media", names: ["clip"] }]);
  assert.deepEqual(pickerGroups(workflows, { q: "calls" }), [{ category: "calls", names: ["ai-made", "transcribe"] }]);
  assert.ok(isInstalledName("bob/util/fmt", ["bob/util"]));
  assert.ok(!isInstalledName("summarize", ["bob/util"]));
});

test("comesAlong reads what a dry build adds to the picks, and the picks it does not carry", () => {
  const files = ["strut.yaml", "workflows/summarize.yaml", "workflows/tidy.yaml", "steps/clip/shout.ts", "steps/clip/_shared.ts", "steps/clip/shout.claims.yaml", "apps/board/app.yaml", "apps/board/src/App.tsx"];
  assert.deepEqual(comesAlong("acme/tools", files, { workflows: ["summarize", "job"], apps: [] }), {
    workflows: ["tidy"],
    steps: ["clip/shout"],
    apps: ["board"],
    leftOut: ["job"],
  });
  assert.deepEqual(comesAlong("acme/tools", files, { workflows: ["acme/tools/summarize", "tidy"], apps: ["board"] }).workflows, [], "a name under the prefix is its path");
});

test("picksFromRelease maps what a release held back to the names here", () => {
  const items = [
    { kind: "workflow", name: "summarize" },
    { kind: "workflow", name: "tidy" },
    { kind: "workflow", name: "gone" },
    { kind: "step", name: "clip/shout" },
    { kind: "app", name: "board" },
    { kind: "concept", name: "Clips" },
  ];
  assert.deepEqual(picksFromRelease("acme/tools", items, { workflows: new Set(["summarize", "acme/tools/tidy"]), apps: new Set(["board"]) }), {
    workflows: ["acme/tools/tidy", "summarize"],
    apps: ["board"],
    concepts: ["Clips"],
  });
});

test("packageLabel shows the package segment alone under this strut's publisher", () => {
  assert.equal(packageLabel("stakwork/tools", "stakwork"), "tools");
  assert.equal(packageLabel("acme/demo", "stakwork"), "acme/demo");
  assert.equal(packageLabel("stakwork/tools", undefined), "stakwork/tools");
});
