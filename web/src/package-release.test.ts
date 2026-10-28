import { test } from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_NAME, PACKAGE_SEGMENT, comesAlong, installedTitle, isInstalledName, nameInGroup, nextVersion, packageLabel, packageOf, pickerGroups, picksFromRelease, sidebarGroups } from "./package-release";

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

test("sidebarGroups puts an installed package's workflows in its own group, whatever their category", () => {
  const workflows = [
    { name: "acme/tools/summarize", category: "media" },
    { name: "acme/tools/tidy" },
    { name: "clip", category: "media" },
    { name: "scratch" },
    { name: "mine/local/x", category: "work" },
  ];
  const installed = [{ package: "acme/tools", version: "1.0.0", source: { ref: "subscription:acme" } }];
  const groups = sidebarGroups(workflows, installed);
  const by = (key: string) => groups.find((g) => g.key === key)!;
  assert.deepEqual(by("pkg:acme/tools").wfs.map((w) => w.name), ["acme/tools/summarize", "acme/tools/tidy"]);
  assert.equal(by("pkg:acme/tools").label, "tools");
  assert.equal(by("pkg:acme/tools").installed?.version, "1.0.0");
  assert.deepEqual(by("media").wfs.map((w) => w.name), ["clip"], "a local workflow never joins the package's group");
  assert.deepEqual(by("work").wfs.map((w) => w.name), ["mine/local/x"], "a prefixed name that is not installed stays in its category");
  assert.deepEqual(by("").wfs.map((w) => w.name), ["scratch"]);
  assert.equal(nameInGroup("acme/tools/summarize", by("pkg:acme/tools")), "summarize");
  assert.equal(nameInGroup("clip", by("media")), "clip");
  assert.equal(installedTitle(installed[0]!), "acme/tools · 1.0.0 · installed from subscription:acme");
});

test("sidebarGroups names an installed package in full when another group reads the same", () => {
  const workflows = [{ name: "acme/tools/a" }, { name: "bob/tools/b" }, { name: "acme/media/c" }, { name: "local", category: "media" }];
  const groups = sidebarGroups(workflows, [{ package: "acme/tools" }, { package: "bob/tools" }, { package: "acme/media" }]);
  assert.deepEqual(groups.filter((g) => g.installed).map((g) => g.label).sort(), ["acme/media", "acme/tools", "bob/tools"]);
});
