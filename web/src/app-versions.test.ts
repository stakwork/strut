import { test } from "node:test";
import assert from "node:assert/strict";
import { appVersionRows, draftCount, followNote, holdNote, isSeeded, liveRelease, makeLiveNote, when, type AppVersionsData, panelChip, panelKey } from "./app-versions";

const at = (day: number) => `2026-11-0${day}T12:00:00.000Z`;

/** The screenshot's app: held at v8 (r9), drafts v9–v11, v2 made live twice. */
const held: AppVersionsData = {
  active: "v8",
  live: "r9",
  versions: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`v${i + 1}`, { createdAt: at(1) }])),
  releases: [
    { id: "r1", version: "v1", createdAt: at(1) },
    { id: "r2", version: "v2", createdAt: at(1) },
    { id: "r3", version: "v2", createdAt: at(2), by: "evan-x1" },
    ...[3, 4, 5, 6, 7, 8].map((n, i) => ({ id: `r${i + 4}`, version: `v${n}`, createdAt: at(3) })),
  ],
};

test("appVersionRows: one row per version, newest first, each in its state", () => {
  const rows = appVersionRows(held);
  assert.deepEqual(rows.map((r) => r.version), ["v11", "v10", "v9", "v8", "v7", "v6", "v5", "v4", "v3", "v2", "v1"]);
  assert.deepEqual(rows.map((r) => r.state), ["draft", "draft", "draft", "live", "was-live", "was-live", "was-live", "was-live", "was-live", "was-live", "was-live"]);
  // A version made live twice restores through its newest release.
  assert.equal(rows.find((r) => r.version === "v2")?.release, "r3");
  assert.equal(rows.find((r) => r.version === "v11")?.release, undefined);
});

test("appVersionRows: a version rolled back from was live, never a draft", () => {
  // v6 made live (r10), then v4 restored (r6): v6 is newer than live but was seen.
  const rolledBack: AppVersionsData = { ...held, active: "v4", live: "r6", releases: [...held.releases, { id: "r10", version: "v6", createdAt: at(4) }] };
  const rows = appVersionRows(rolledBack);
  const state = (v: string) => rows.find((r) => r.version === v)?.state;
  assert.equal(state("v6"), "was-live");
  assert.equal(rows.find((r) => r.version === "v6")?.release, "r10");
  assert.equal(state("v5"), "was-live");
  assert.equal(state("v4"), "live");
  assert.equal(state("v11"), "draft");
});

test("appVersionRows: following latest, nothing is a draft", () => {
  const following: AppVersionsData = { ...held, active: "v11", live: "latest" };
  const rows = appVersionRows(following);
  assert.equal(rows[0]?.state, "live");
  assert.ok(!rows.some((r) => r.state === "draft"));
  // v8 was live once (r9), the rest never were but those with releases.
  assert.equal(rows.find((r) => r.version === "v8")?.state, "was-live");
  assert.equal(rows.find((r) => r.version === "v9")?.state, "");
});

test("appVersionRows: versions sort by number, not as text", () => {
  const rows = appVersionRows({ active: "v2", live: "latest", releases: [], versions: { v2: { createdAt: at(1) }, v10: { createdAt: at(2) }, v9: { createdAt: at(1) } } });
  assert.deepEqual(rows.map((r) => r.version), ["v10", "v9", "v2"]);
});

test("draftCount: only while held, only after the live version", () => {
  const versions = Object.keys(held.versions);
  assert.equal(draftCount(versions, "v8", "r9"), 3);
  assert.equal(draftCount(versions, "v8", "latest"), 0);
  assert.equal(draftCount(versions, "v8", undefined), 0);
  assert.equal(draftCount(versions, "v11", "r12"), 0);
});

test("liveRelease: the held release, none while following", () => {
  assert.equal(liveRelease(held)?.version, "v8");
  assert.equal(liveRelease({ ...held, live: "latest" }), undefined);
});

test("isSeeded: the live version's source", () => {
  assert.equal(isSeeded(held), false);
  assert.equal(isSeeded({ ...held, versions: { ...held.versions, v8: { createdAt: at(1), source: "seed" } } }), true);
});

test("the confirm notes say what everyone gets", () => {
  assert.equal(makeLiveNote("v11", "r9"), "Everyone who opens the app gets v11 now.");
  assert.match(makeLiveNote("v7", "latest"), /stays there: later publishes wait as drafts/);
  assert.match(followNote(held), /^Everyone gets v11, the newest publish, now/);
  assert.equal(followNote({ ...held, active: "v11" }), "Every later publish goes live as soon as it is published.");
  assert.equal(holdNote("v8"), "The app stays at v8. Later publishes wait as drafts until you make one live.");
});

test("when: relative within a day, then the date", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  assert.equal(when("2026-11-04T11:59:40.000Z", now), "just now");
  assert.equal(when("2026-11-04T11:15:00.000Z", now), "45m ago");
  assert.equal(when("2026-11-04T07:00:00.000Z", now), "5h ago");
  assert.match(when("2026-11-01T12:00:00.000Z", now), /Nov/);
  assert.equal(when("not a date", now), "");
});

test("the side panel's chip: the version shown and its state, drafts on the live one; none for a lone version following latest", () => {
  const held = { activeVersion: "v3", versions: ["v1", "v2", "v3", "v4", "v5"], live: "r2" };
  assert.deepEqual(panelChip("v3", held), { label: "v3 · live", drafts: 2 });
  assert.deepEqual(panelChip("v5", held), { label: "v5 · draft", drafts: 0 });
  assert.deepEqual(panelChip("v1", held), { label: "v1", drafts: 0 }, "an older one: the rows say if it was live");
  assert.deepEqual(panelChip("v2", { activeVersion: "v2", versions: ["v1", "v2"] }), { label: "v2 · live", drafts: 0 }, "following latest, two versions");
  assert.equal(panelChip("v1", { activeVersion: "v1", versions: ["v1"] }), null);
  assert.deepEqual(panelChip("v1", { activeVersion: "v1", versions: ["v1"], live: "r1" }), { label: "v1 · live", drafts: 0 }, "held, even alone");
  assert.equal(panelKey("acme/crm", "v3", "v3"), "acme/crm", "the live one follows what is live");
  assert.equal(panelKey("acme/crm", "v5", "v3"), "acme/crm@v5");
});
