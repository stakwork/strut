import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { kitForTests } from "../test-util/app-kit.js";
import { treeHash } from "../version.js";
import type { KitLocation } from "./kit.js";
import { DREAM_APP, DREAM_DIR } from "./dream-seed.js";
import { VIEWS_APP } from "./views-seed.js";
import { costText, sectionsOf } from "./dream/src/lib/report.js";

/**
 * `strut/dream` (plans/dream.md): what the dream did, as a first-party app
 * strut ships — how its page reads a run's report, and its seed beside
 * strut/views.
 */

describe("strut/dream: the report", () => {
  it("splits the report into its sections, an item a line; `none` and blank lines are no item", () => {
    const text = "LESSONS: Keep summaries to three lines — session c-1 turn 1, new\n- No greeting in emails to Sam — turn 4\nFACTS: none\nPAGES:\n- Writing: added \"three lines\"\n\n**LEFT ALONE:** (none)";
    assert.deepEqual(sectionsOf(text), [
      { title: "Lessons", lines: ["Keep summaries to three lines — session c-1 turn 1, new", "No greeting in emails to Sam — turn 4"] },
      { title: "Facts changed", lines: [] },
      { title: "Pages changed", lines: ['Writing: added "three lines"'] },
      { title: "Left alone", lines: [] },
    ]);
  });

  it("a report not shaped that way is not split: the page draws it as written", () => {
    assert.equal(sectionsOf("No new turns since the last dream."), null);
    assert.equal(sectionsOf(""), null);
  });

  it("says what a run cost, and when it cost nothing", () => {
    assert.deepEqual([costText(0), costText(undefined), costText(0.004), costText(1.239)], ["no model cost", "no model cost", "under $0.01", "$1.24"]);
  });
});

describe("strut/dream — seeded at boot beside strut/views", () => {
  let kit: KitLocation;
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const quiet = { serveUi: false, enableChat: false, scheduler: false } as const;
  before(async () => {
    kit = await kitForTests();
  });
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("publishes strut/dream with strut/views compiled in, granted the dream workflow's runs and no step; `dream: false` seeds none", async () => {
    const first = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-dream-seed-")), store: new MemoryRunStore(), kit });
    const app = await first.apps.get(DREAM_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale], ["v1", "strut", "seed", false]);
    assert.equal(app.hash, await treeHash(DREAM_DIR));
    assert.equal(app.manifest.title, "Dream");
    assert.deepEqual(app.manifest.grants.workflows, ["dream"]);
    assert.deepEqual(app.manifest.grants.steps, []);
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    const views = (await first.apps.get(VIEWS_APP))!;
    assert.deepEqual(info.imports, [{ name: VIEWS_APP, version: views.version, hash: views.hash }], "strut/views compiled in");
    assert.deepEqual(info.warnings, []);
    const html = await readFile(join(app.dir, "dist", "index.html"), "utf8");
    assert.match(html, /Run now/);
    assert.match(html, /Every step it took/);
    assert.ok(info.bytes < 2_000_000, `${info.bytes} bytes`);

    const off = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-dream-off-")), store: new MemoryRunStore(), kit, dream: false });
    assert.equal(await off.apps.get(DREAM_APP), null);
    assert.ok(await off.apps.get(VIEWS_APP), "the others still seeded");
  });
});
