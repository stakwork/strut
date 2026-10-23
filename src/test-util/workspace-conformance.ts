import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Automation } from "../automations.js";
import type { WorkspaceStore } from "../workspace.js";
import { contentHash } from "../version.js";
import { manifestSchema } from "../apps/manifest.js";

/**
 * The `WorkspaceStore` contract as tests — one behavioral suite every
 * backend (file, path-less wrapper, graph) must pass. A backend that needs
 * a different assertion here is a backend that changed the contract.
 */

const STEP_SRC = (type: string, desc: string) => `import { z } from "zod";
import { defineStep } from "strut";
export default defineStep({
  type: ${JSON.stringify(type)},
  description: ${JSON.stringify(desc)},
  input: z.object({}),
  output: z.any(),
  async run() { return ${JSON.stringify(desc)}; },
});
`;

// ── Workspace store ────────────────────────────────────────────────────────

/** An app manifest with the defaults filled (what a build hands the store). */
const APP = (title: string, workflows: string[] = []) => manifestSchema.parse({ title, grants: { workflows } });

export interface WorkspaceImpl {
  name: string;
  /** Build a fresh, empty store. `dir` is a fresh temp dir the case owns. */
  make: (dir: string) => Promise<WorkspaceStore> | WorkspaceStore;
  /** Reset backend state between cases (graph wipe, …). */
  reset?: () => Promise<void>;
  /** `describe` skip reason (e.g. no live database configured). */
  skip?: string | false;
}

export function workspaceConformance(impl: WorkspaceImpl): void {
  describe(`WorkspaceStore conformance: ${impl.name}`, { skip: impl.skip ?? false }, () => {
    let dir: string;
    let ws: WorkspaceStore;
    beforeEach(async () => {
      dir = join(tmpdir(), `strut-conf-ws-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      await impl.reset?.();
      ws = await impl.make(dir);
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    const steps = [{ id: "a", type: "log", config: { message: "hi" } }];

    it("workflow publish → list → metadata → source → hash round-trip", async () => {
      await ws.publishWorkflow("wf", "v1", { steps }, "first", "exp", "me");
      const list = await ws.listWorkflows();
      assert.deepEqual(
        list.map((w) => [w.name, w.activeVersion, w.versions, w.description, w.category, w.publisher]),
        [["wf", "v1", ["v1"], "first", "exp", "me"]],
      );
      assert.equal("lastRunAt" in list[0]!, false, "runs are the run store's — never listed here");
      const meta = await ws.getWorkflowMetadata("wf");
      assert.equal(meta?.active, "v1");
      assert.equal(meta?.publisher, "me");
      assert.equal(await ws.getWorkflowMetadata("nope"), null);
      const src = await ws.getWorkflowSource("wf", "v1");
      assert.ok(src.includes("type: log"));
      assert.equal(typeof (await ws.getWorkflowHash("wf")), "string");
      assert.equal(await ws.getWorkflowHash("nope"), null);
      assert.equal((await ws.getWorkflow("wf")).steps.length, 1);
      assert.equal((await ws.getWorkflowVersion("wf", "v1")).steps.length, 1);
      await assert.rejects(() => ws.getWorkflow("nope"), /not found/);
    });

    it("a declared input block round-trips through a steps-form publish and builds the flow's schema", async () => {
      const input = { url: { type: "string" as const }, limit: { type: "number" as const, default: 10 } };
      await ws.publishWorkflow("wf", "v1", { steps, input });
      const flow = await ws.getWorkflow("wf");
      assert.deepEqual(flow.inputBlock, input);
      assert.equal(flow.input.safeParse({}).success, false);
      assert.deepEqual(flow.input.parse({ url: "x" }), { url: "x", limit: 10 });
      await assert.rejects(
        () => ws.publishWorkflow("wf", "v2", { steps, input: { n: { type: "number" as const, default: "x" } } }),
        /is not a number/,
      );
    });

    it("versions, active switching, content dedup, category, params", async () => {
      await ws.publishWorkflow("wf", "v1", { steps, params: { greeting: "old" } });
      const first = await ws.publishWorkflowByContent("wf", await ws.getWorkflowSource("wf", "v1"));
      assert.equal(first.changed, false, "same content → no new version");
      assert.equal(first.version, "v1");
      const second = await ws.publishWorkflowByContent(
        "wf",
        (await ws.getWorkflowSource("wf", "v1")).replace("old", "new"),
      );
      assert.equal(second.changed, true);
      assert.notEqual(second.version, "v1");
      assert.equal((await ws.getWorkflowMetadata("wf"))?.active, second.version);
      await ws.setActiveVersion("wf", "v1");
      assert.equal((await ws.getWorkflowMetadata("wf"))?.active, "v1");
      await assert.rejects(() => ws.setActiveVersion("wf", "v99"));
      await ws.setWorkflowCategory("wf", "cat");
      assert.equal((await ws.getWorkflowMetadata("wf"))?.category, "cat");
      const p = await ws.setParam("wf", "greeting", "newer");
      assert.deepEqual([p.before, p.after], ["old", "newer"]);
      assert.equal((await ws.getWorkflow("wf")).params?.["greeting"], "newer");
    });

    it("automations are workflow-level metadata: they round-trip and survive every other write", async () => {
      const automations: Automation[] = [
        { id: "a-1", name: "Morning", enabled: true, trigger: { type: "schedule", every: "day", at: ["09:00"], tz: "UTC" }, input: { since: "{{ last.output.id }}" } },
        { id: "a-2", name: "Paused", enabled: false, trigger: { type: "schedule", every: "week", on: ["mon"], at: ["08:00"], tz: "America/New_York" }, input: {} },
      ];
      const stored = async () => (await ws.getWorkflowMetadata("wf"))?.automations;
      await ws.publishWorkflow("wf", "v1", { steps, params: { greeting: "old" } });
      assert.equal(await stored(), undefined, "absent until set");
      await assert.rejects(() => ws.setWorkflowAutomations("nope", automations));

      await ws.setWorkflowAutomations("wf", automations);
      assert.deepEqual(await stored(), automations);
      assert.deepEqual((await ws.listWorkflows()).find((w) => w.name === "wf")?.automations, automations, "the list entry carries them");
      assert.equal((await ws.getWorkflowMetadata("wf"))?.active, "v1", "no version is published");

      const source = await ws.getWorkflowSource("wf", "v1");
      await ws.publishWorkflowByContent("wf", source); // no-op publish
      const next = await ws.publishWorkflowByContent("wf", source.replace("old", "new"));
      await ws.setWorkflowCategory("wf", "cat");
      await ws.setActiveVersion("wf", "v1");
      await ws.setParam("wf", "greeting", "newer");
      assert.equal(next.changed, true);
      assert.deepEqual(await stored(), automations, "survives publish, category, active switch, setParam");
      assert.equal((await ws.getWorkflowMetadata("wf"))?.category, "cat");

      await ws.setWorkflowAutomations("wf", []);
      assert.equal(await stored(), undefined, "an empty list clears the field");
      assert.equal((await ws.listWorkflows()).find((w) => w.name === "wf")?.automations, undefined);
    });

    it("deleteWorkflow removes every version and all metadata; the name starts over", async () => {
      const automations: Automation[] = [
        { id: "a-1", name: "Morning", enabled: true, trigger: { type: "schedule", every: "day", at: ["09:00"], tz: "UTC" }, input: {} },
      ];
      await ws.publishWorkflow("wf", "v1", { steps, params: { greeting: "old" } }, "first", "exp");
      await ws.publishWorkflowByContent("wf", (await ws.getWorkflowSource("wf", "v1")).replace("old", "new"));
      await ws.setWorkflowAutomations("wf", automations);
      await ws.setWorkflowOwner("wf", "alice-1");
      await ws.setWorkflowRunCap("wf", 2.5);
      await ws.publishWorkflow("other", "v1", { steps });

      assert.equal(await ws.deleteWorkflow("wf"), true);
      assert.equal(await ws.deleteWorkflow("wf"), false, "already gone");
      assert.equal(await ws.deleteWorkflow("never"), false);
      assert.deepEqual((await ws.listWorkflows()).map((w) => w.name), ["other"]);
      assert.equal(await ws.getWorkflowMetadata("wf"), null);
      assert.equal(await ws.getWorkflowHash("wf"), null);
      await assert.rejects(() => ws.getWorkflow("wf"), /not found/);

      // The name is free, and nothing of the old one rides along.
      assert.equal((await ws.createWorkflow("wf", { steps })).name, "wf");
      const meta = await ws.getWorkflowMetadata("wf");
      assert.deepEqual(Object.keys(meta!.versions), ["v1"]);
      assert.equal(meta!.active, "v1");
      assert.equal(meta!.category, undefined);
      assert.equal(meta!.owner, undefined);
      assert.equal(meta!.maxRunCostUsd, undefined);
      assert.equal(meta!.automations, undefined);
    });

    it("owner and run cap are workflow-level metadata: set, survive a publish, clear", async () => {
      const meta = () => ws.getWorkflowMetadata("wf");
      await ws.publishWorkflow("wf", "v1", { steps });
      await ws.setWorkflowOwner("wf", "alice-1");
      await ws.setWorkflowRunCap("wf", 2.5);
      assert.equal((await meta())?.owner, "alice-1");
      assert.equal((await meta())?.maxRunCostUsd, 2.5);

      await ws.publishWorkflow("wf", "v2", { steps, params: { greeting: "other" } });
      assert.equal((await meta())?.owner, "alice-1", "survives a publish");
      assert.equal((await meta())?.maxRunCostUsd, 2.5);

      await ws.setWorkflowOwner("wf", null);
      await ws.setWorkflowRunCap("wf", null);
      assert.equal((await meta())?.owner, undefined);
      assert.equal((await meta())?.maxRunCostUsd, undefined);
    });

    it("reactivateKnown: false keeps a workspace edit active across a reseed", async () => {
      await ws.publishWorkflow("wf", "v1", { steps, params: { greeting: "old" } });
      const seed = await ws.getWorkflowSource("wf", "v1");
      const edit = await ws.publishWorkflowByContent("wf", seed.replace("old", "new")); // UI edit → v2
      // Reseeding the UNCHANGED template must not demote the edit …
      const reseed = await ws.publishWorkflowByContent("wf", seed, undefined, "cat", "seed", {
        reactivateKnown: false,
      });
      assert.equal(reseed.changed, false);
      assert.equal(reseed.version, "v1");
      const meta = await ws.getWorkflowMetadata("wf");
      assert.equal(meta?.active, edit.version);
      assert.equal(meta?.category, "cat", "category is still reconciled on the no-op path");
      // … but a CHANGED template (never-seen hash) still publishes + activates.
      const updated = await ws.publishWorkflowByContent(
        "wf",
        seed.replace("old", "newer"),
        undefined,
        undefined,
        undefined,
        { reactivateKnown: false },
      );
      assert.equal(updated.changed, true);
      assert.equal((await ws.getWorkflowMetadata("wf"))?.active, updated.version);
      // Default (author) behavior is unchanged: known content re-activates.
      const back = await ws.publishWorkflowByContent("wf", seed);
      assert.equal(back.changed, true);
      assert.equal((await ws.getWorkflowMetadata("wf"))?.active, "v1");
    });

    it("records which door wrote each version, and who", async () => {
      await ws.createWorkflow("wf", { steps, params: { greeting: "old" } }, undefined, undefined, undefined, { source: "seed" });
      const seed = await ws.getWorkflowSource("wf", "v1");
      const edit = seed.replace("old", "new");
      await ws.publishWorkflowByContent("wf", edit, undefined, undefined, undefined, { source: "ui", actor: "alice" });
      await ws.setParam("wf", "greeting", "promoted", "bob");
      await ws.publishWorkflow("wf", "v4", { steps, params: { greeting: "plain" } });
      const v = (await ws.getWorkflowMetadata("wf"))!.versions;
      assert.equal(v["v1"]?.source, "seed");
      assert.equal(v["v1"]?.actor, undefined);
      assert.equal(v["v2"]?.source, "ui");
      assert.equal(v["v2"]?.actor, "alice");
      assert.equal(v["v3"]?.source, "promote");
      assert.equal(v["v3"]?.actor, "bob");
      assert.equal(v["v4"]?.source, undefined, "a publish that names no door records none");
    });

    it("createWorkflow allocates a fresh name/version and returns it", async () => {
      const a = await ws.createWorkflow("made", { steps });
      const b = await ws.createWorkflow("made", { steps });
      assert.equal(a.name, "made");
      assert.notEqual(b.name, a.name, "a second create under the same name is renamed, not clobbered");
    });

    it("publishStep reactivateKnown: false keeps a workspace edit active across a reseed", async () => {
      const v1 = await ws.publishStep("kept", STEP_SRC("kept", "one"), "one", "seed");
      const edit = await ws.publishStep("kept", STEP_SRC("kept", "two"), "two"); // UI edit → v2
      const reseed = await ws.publishStep("kept", STEP_SRC("kept", "one"), "one", "seed", {
        reactivateKnown: false,
      });
      assert.equal(reseed.changed, false);
      assert.equal(reseed.version, v1.version);
      assert.equal((await ws.listStepVersions("kept")).active, edit.version);
      assert.ok(
        (await ws.getStepSource("kept"))?.code.includes("two"),
        "the materialized (loadable) source is still the edit",
      );
      const updated = await ws.publishStep("kept", STEP_SRC("kept", "three"), "three", "seed", {
        reactivateKnown: false,
      });
      assert.equal(updated.changed, true);
      assert.equal((await ws.listStepVersions("kept")).active, updated.version);
      const back = await ws.publishStep("kept", STEP_SRC("kept", "one"));
      assert.equal(back.changed, true);
      assert.equal((await ws.listStepVersions("kept")).active, v1.version);
    });

    it("step publish → list → versions → source → active switching → delete", async () => {
      const v1 = await ws.publishStep("my-step", STEP_SRC("my-step", "one"), "one", "svc");
      const again = await ws.publishStep("my-step", STEP_SRC("my-step", "one"), "one", "svc");
      assert.equal(again.changed, false, "same source → no new version");
      const v2 = await ws.publishStep("my-step", STEP_SRC("my-step", "two"), "two", "svc");
      assert.equal(v2.changed, true);
      assert.deepEqual(
        (await ws.listSteps()).map((s) => [s.type, s.description, s.publisher]),
        [["my-step", "two", "svc"]],
      );
      assert.deepEqual(await ws.listSteps({ publisher: "other" }), []);
      const versions = await ws.listStepVersions("my-step");
      assert.equal(versions.active, v2.version);
      assert.deepEqual(new Set(versions.versions), new Set([v1.version, v2.version]));
      assert.ok((await ws.getStepVersionSource("my-step", v1.version)).includes('"one"'));
      // A pin (`my-step@v1`) loads the archived version as a file + its hash.
      const pinned = await ws.materializeStepVersion("my-step", v1.version);
      assert.equal(pinned.hash, contentHash(STEP_SRC("my-step", "one")));
      assert.ok((await readFile(pinned.path, "utf-8")).includes('"one"'));
      await assert.rejects(ws.materializeStepVersion("my-step", "v99"), /not found/);
      // Active step hashes follow the active pointer (run.start.stepHashes).
      const h2 = (await ws.getActiveStepHashes())["my-step"];
      assert.equal(h2, contentHash(STEP_SRC("my-step", "two")));
      await ws.setActiveStepVersion("my-step", v1.version);
      assert.equal((await ws.listStepVersions("my-step")).active, v1.version);
      assert.deepEqual(await ws.getActiveStepHashes(), { "my-step": contentHash(STEP_SRC("my-step", "one")) });
      assert.equal((await ws.getStepSource("my-step"))?.code.includes('"one"'), true);
      assert.equal(await ws.deleteStep("my-step"), true);
      assert.equal(await ws.deleteStep("my-step"), false);
      assert.deepEqual(await ws.listSteps(), []);
      assert.deepEqual(await ws.getActiveStepHashes(), {});
    });


    // ── Apps (plans/apps.md §1.3): the pointers ──

    it("app publish → list → get → versions → active switching → delete; the files are the caller's", async () => {
      await ws.publishWorkflow("wf", "v1", { steps });
      const one = APP("One", ["wf"]);
      const two = APP("Two");
      const v1 = await ws.publishApp("hvac", "h1", one, { publisher: "ai", actor: "alice" });
      assert.deepEqual(v1, { version: "v1", changed: true });
      assert.deepEqual(await ws.publishApp("hvac", "h1", one), { version: "v1", changed: false }, "same tree → no new version");
      const v2 = await ws.publishApp("hvac", "h2", two);
      assert.deepEqual(v2, { version: "v2", changed: true });

      const list = await ws.listApps();
      assert.deepEqual(
        list.map((a) => [a.name, a.activeVersion, a.versions, a.title, a.grants.workflows, a.publisher, a.owner]),
        [["hvac", "v2", ["v1", "v2"], "Two", [], "ai", "alice"]],
      );
      const got = (await ws.getApp("hvac"))!;
      assert.equal(got.version, "v2");
      assert.equal(got.hash, "h2");
      assert.deepEqual(got.manifest, two);
      assert.equal(got.active, "v2");
      assert.deepEqual(Object.keys(got.versions), ["v1", "v2"]);
      assert.equal(got.versions["v1"]?.hash, "h1");
      assert.equal("manifest" in got.versions["v1"]!, false, "the version list carries no manifests");
      assert.equal(got.owner, "alice");
      assert.equal(got.publisher, "ai");
      const old = (await ws.getApp("hvac", "v1"))!;
      assert.equal(old.hash, "h1");
      assert.deepEqual(old.manifest, one);
      assert.equal(await ws.getApp("nope"), null);
      assert.equal(await ws.getApp("hvac", "v9"), null);

      // The version's directory: a path, named consistently, never a copy.
      const dir1 = await ws.materializeAppVersion("hvac", "v1");
      assert.equal(dir1.hash, "h1");
      assert.equal(typeof dir1.path, "string");
      assert.deepEqual(await ws.materializeAppVersion("hvac", "v1"), dir1, "stable");
      assert.notEqual((await ws.materializeAppVersion("hvac", "v2")).path, dir1.path);
      assert.ok(dir1.path.endsWith(join("hvac", "v1")), dir1.path);
      await assert.rejects(ws.materializeAppVersion("hvac", "v9"), /not found/);
      await assert.rejects(ws.materializeAppVersion("nope", "v1"), /not found/);

      await ws.setActiveAppVersion("hvac", "v1");
      assert.equal((await ws.getApp("hvac"))?.version, "v1");
      assert.equal((await ws.listApps())[0]?.title, "One", "the listing follows the active version's manifest");
      await assert.rejects(ws.setActiveAppVersion("hvac", "v99"), /not found/);
      await assert.rejects(ws.setActiveAppVersion("nope", "v1"), /not found/);

      assert.equal(await ws.deleteApp("hvac"), true);
      assert.equal(await ws.deleteApp("hvac"), false);
      assert.deepEqual(await ws.listApps(), []);
      assert.equal(await ws.getApp("hvac"), null);
      // The name starts over, with nothing of the old one riding along.
      assert.deepEqual(await ws.publishApp("hvac", "h3", two), { version: "v1", changed: true });
      const fresh = (await ws.getApp("hvac"))!;
      assert.deepEqual(Object.keys(fresh.versions), ["v1"]);
      assert.equal(fresh.owner, undefined);
      assert.equal(fresh.publisher, undefined);
    });

    it("setAppPinned: the record's flag — listed and read back, kept by a publish and a rollback, cleared by unpin and by a delete", async () => {
      await ws.publishApp("tabbed", "p1", APP("One"));
      await ws.publishApp("plain", "q1", APP("Plain"));
      assert.equal((await ws.listApps()).some((a) => "pinned" in a), false, "absent until pinned");
      await ws.setAppPinned("tabbed", true);
      await ws.setAppPinned("tabbed", true);
      const listed = await ws.listApps();
      assert.deepEqual(listed.map((a) => [a.name, a.pinned]), [["plain", undefined], ["tabbed", true]]);
      assert.equal((await ws.getApp("tabbed"))?.pinned, true);
      await ws.publishApp("tabbed", "p2", APP("Two"));
      await ws.publishApp("tabbed", "p1", APP("One"));
      await ws.setActiveAppVersion("tabbed", "v2");
      assert.equal((await ws.getApp("tabbed"))?.pinned, true, "a publish, a re-activation and a rollback keep it");
      assert.equal((await ws.getApp("tabbed", "v1"))?.pinned, true, "the record's, whichever version is read");
      await ws.setAppPinned("tabbed", false);
      await ws.setAppPinned("tabbed", false);
      assert.equal((await ws.getApp("tabbed"))?.pinned, undefined);
      await ws.setAppPinned("tabbed", true);
      assert.equal(await ws.deleteApp("tabbed"), true);
      await ws.publishApp("tabbed", "p3", APP("Three"));
      assert.equal((await ws.getApp("tabbed"))?.pinned, undefined, "the name starts over unpinned");
      await assert.rejects(ws.setAppPinned("nope", true), /not found/);
    });

    it("releases (plans/app-releases.md §1): a release holds the app, a publish is then a draft, setAppLive rolls back or follows latest", async () => {
      await ws.publishApp("held", "rh1", APP("One"));
      await ws.publishApp("held", "rh2", APP("Two"));
      const lock = { workflows: { wf: { version: "v1", hash: "x" } }, steps: { "s/t": { version: "v2", hash: "y" } }, floating: ["a"] };
      const r1 = await ws.addAppRelease("held", { version: "v1", lock, by: "alice" });
      assert.deepEqual([r1.id, r1.version, r1.by, typeof r1.createdAt], ["r1", "v1", "alice", "string"]);
      let rec = (await ws.getApp("held"))!;
      assert.deepEqual([rec.version, rec.active, rec.live], ["v1", "v1", "r1"]);
      assert.deepEqual(rec.releases?.[0]?.lock, lock, "the lock read back as written");
      assert.equal((await ws.listApps()).find((a) => a.name === "held")?.live, "r1");

      // Held: a new tree is a draft, a known one re-activates nothing.
      assert.deepEqual(await ws.publishApp("held", "rh3", APP("Three")), { version: "v3", changed: true });
      assert.deepEqual(await ws.publishApp("held", "rh2", APP("Two")), { version: "v2", changed: false });
      rec = (await ws.getApp("held"))!;
      assert.deepEqual([rec.active, rec.live, Object.keys(rec.versions)], ["v1", "r1", ["v1", "v2", "v3"]]);
      assert.equal((await ws.listApps()).find((a) => a.name === "held")?.title, "One", "the listing follows the live page");

      // Promote the draft, roll back to r1 (adding nothing), follow latest.
      assert.equal((await ws.addAppRelease("held", { version: "v3", lock: { workflows: {}, steps: {} } })).id, "r2");
      assert.equal((await ws.getApp("held"))?.active, "v3");
      await ws.setAppLive("held", "r1");
      rec = (await ws.getApp("held"))!;
      assert.deepEqual([rec.active, rec.live, rec.releases?.map((r) => r.id)], ["v1", "r1", ["r1", "r2"]]);
      await ws.setAppLive("held", null);
      rec = (await ws.getApp("held"))!;
      assert.deepEqual([rec.active, rec.live, rec.releases?.length], ["v3", undefined, 2], "the newest version, the releases kept");
      await ws.publishApp("held", "rh4", APP("Four"));
      assert.equal((await ws.getApp("held"))?.active, "v4", "following again, a publish is live");

      // Moving the pointer by hand lets go of the release.
      await ws.addAppRelease("held", { version: "v2", lock });
      await ws.setActiveAppVersion("held", "v4");
      rec = (await ws.getApp("held"))!;
      assert.deepEqual([rec.active, rec.live, rec.releases?.length], ["v4", undefined, 3]);

      await assert.rejects(ws.addAppRelease("held", { version: "v9", lock }), /not found/);
      await assert.rejects(ws.addAppRelease("nope", { version: "v1", lock }), /not found/);
      await assert.rejects(ws.setAppLive("held", "r9"), /not found/);
      await assert.rejects(ws.setAppLive("nope", null), /not found/);

      await ws.setAppLive("held", "r3");
      assert.equal(await ws.deleteApp("held"), true);
      await ws.publishApp("held", "rh5", APP("Five"));
      rec = (await ws.getApp("held"))!;
      assert.deepEqual([rec.live, rec.releases], [undefined, undefined], "the name starts over with no releases");
    });

    it("publishApp: reactivateKnown, the publisher and owner stamps, and upstream carried forward", async () => {
      const seed = APP("Seed");
      const edit = APP("Edit");
      const first = await ws.publishApp("kept", "s1", seed, { publisher: "seed" });
      const edited = await ws.publishApp("kept", "e1", edit, { actor: "bob" });
      // Reseeding the unchanged template leaves the edit active …
      assert.deepEqual(await ws.publishApp("kept", "s1", seed, { publisher: "seed", reactivateKnown: false }), { version: first.version, changed: false });
      assert.equal((await ws.getApp("kept"))?.version, edited.version);
      // … a known tree re-activates by default …
      assert.deepEqual(await ws.publishApp("kept", "s1", seed), { version: first.version, changed: true });
      assert.equal((await ws.getApp("kept"))?.version, first.version);
      // … and the stamps: the publisher follows the publish, the owner is the first actor seen.
      const rec = (await ws.getApp("kept"))!;
      assert.equal(rec.publisher, "seed");
      assert.equal(rec.owner, "bob");
      await ws.publishApp("kept", "s1", seed, { actor: "carol" });
      assert.equal((await ws.getApp("kept"))?.owner, "bob", "the owner is not re-stamped");

      // Upstream (marketplace.md §3) rides on a version and is carried forward over the name.
      const upstream = { package: "acme/hvac", version: "1.2.0", digest: "abc" };
      const installed = await ws.publishApp("kept", "u1", APP("Installed"), { upstream, source: "seed" });
      assert.deepEqual((await ws.getApp("kept"))?.upstream, upstream);
      assert.equal((await ws.getApp("kept"))?.versions[installed.version]?.source, "seed");
      await ws.publishApp("kept", "u2", APP("Forked"), { actor: "bob", source: "ui" });
      const fork = (await ws.getApp("kept"))!;
      assert.deepEqual(fork.upstream, upstream, "a publish over the name carries the active version's upstream forward");
      assert.equal(fork.versions[fork.version]?.actor, "bob");
      assert.equal(fork.versions[fork.version]?.source, "ui");
      await ws.publishApp("kept", "u3", APP("Cut loose"), { upstream: null });
      assert.equal((await ws.getApp("kept"))?.upstream, undefined, "null clears it");
      assert.equal((await ws.getApp("kept", first.version))?.upstream, undefined, "an older version keeps its own (none)");
    });

    it("app names carry a package prefix: slashes are segments, and names that differ in punctuation are different apps", async () => {
      await ws.publishApp("acme/ui", "a1", APP("Kit"));
      await ws.publishApp("acme_ui", "b1", APP("Other"));
      await ws.publishApp("acme/ui/charts", "c1", APP("Nested under a name"));
      assert.deepEqual((await ws.listApps()).map((a) => [a.name, a.title]), [["acme/ui", "Kit"], ["acme/ui/charts", "Nested under a name"], ["acme_ui", "Other"]]);
      assert.ok((await ws.materializeAppVersion("acme/ui", "v1")).path.endsWith(join("acme", "ui", "v1")));
      assert.equal(await ws.deleteApp("acme_ui"), true);
      assert.deepEqual((await ws.listApps()).map((a) => a.name), ["acme/ui", "acme/ui/charts"]);
      await assert.rejects(ws.publishApp("bad@v1", "x", APP("x")), /reserved/);
      await assert.rejects(ws.publishApp("acme/v2", "x", APP("x")), /version label/);
      await assert.rejects(ws.publishApp("../x", "x", APP("x")), /Invalid app name/);
    });

    it("names that differ only in punctuation are different steps and workflows: published, read, versioned and deleted apart", async () => {
      // `pod/test` once landed on `pod_test`'s graph node (its key stripped
      // every non-alphanumeric); every backend must keep such pairs apart.
      await ws.publishStep("a/b", STEP_SRC("a/b", "slash"), "slash");
      await ws.publishStep("a_b", STEP_SRC("a_b", "underscore"), "underscore");
      await ws.publishWorkflow("a-b", "v1", { steps }, "dash");
      await ws.publishWorkflow("a_b", "v1", { steps, params: { x: 1 } }, "underscore");
      assert.deepEqual(
        (await ws.listSteps()).map((s) => [s.type, s.description]).sort(),
        [["a/b", "slash"], ["a_b", "underscore"]],
      );
      assert.ok((await ws.getStepSource("a/b"))?.code.includes('"slash"'));
      assert.ok((await ws.getStepSource("a_b"))?.code.includes('"underscore"'));
      assert.deepEqual((await ws.listWorkflows()).map((w) => [w.name, w.description]).sort(), [["a-b", "dash"], ["a_b", "underscore"]]);
      assert.ok((await ws.getWorkflowSource("a_b", "v1")).includes("x: 1"));
      assert.notEqual(await ws.getWorkflowHash("a-b"), await ws.getWorkflowHash("a_b"));
      // Versions stay apart: a second version of one is not a version of the other.
      await ws.publishStep("a_b", STEP_SRC("a_b", "underscore two"), "two");
      await ws.publishWorkflow("a_b", "v2", { steps, params: { x: 2 } });
      assert.deepEqual(await ws.listStepVersions("a/b"), { active: "v1", versions: ["v1"] });
      assert.deepEqual(await ws.listStepVersions("a_b"), { active: "v2", versions: ["v1", "v2"] });
      assert.deepEqual(Object.keys((await ws.getWorkflowMetadata("a-b"))!.versions), ["v1"]);
      assert.deepEqual(Object.keys((await ws.getWorkflowMetadata("a_b"))!.versions), ["v1", "v2"]);
      // Deleting one of a pair leaves the other whole …
      assert.equal(await ws.deleteStep("a_b"), true);
      assert.deepEqual((await ws.listSteps()).map((s) => s.type), ["a/b"]);
      assert.ok((await ws.getStepSource("a/b"))?.code.includes('"slash"'));
      assert.equal(await ws.deleteWorkflow("a-b"), true);
      assert.deepEqual((await ws.listWorkflows()).map((w) => w.name), ["a_b"]);
      assert.deepEqual(Object.keys((await ws.getWorkflowMetadata("a_b"))!.versions), ["v1", "v2"]);
      // … and the deleted name comes back as itself, not as its twin.
      await ws.publishStep("a_b", STEP_SRC("a_b", "underscore"), "underscore");
      assert.deepEqual((await ws.listSteps()).map((s) => [s.type, s.description]).sort(), [["a/b", "slash"], ["a_b", "underscore"]]);
    });

    it("deleteStepsByPublisher removes exactly that publisher's steps", async () => {
      await ws.publishStep("a", STEP_SRC("a", "a"), "a", "svc-1");
      await ws.publishStep("ns/b", STEP_SRC("ns/b", "b"), "b", "svc-1");
      await ws.publishStep("c", STEP_SRC("c", "c"), "c", "svc-2");
      assert.deepEqual((await ws.deleteStepsByPublisher("svc-1")).sort(), ["a", "ns/b"]);
      assert.deepEqual((await ws.listSteps()).map((s) => s.type), ["c"]);
    });

    it("getStepSource spans tiers: custom from the store, lib + core from the engine, null otherwise", async () => {
      await ws.publishStep("ns/custom", STEP_SRC("ns/custom", "x"));
      assert.equal((await ws.getStepSource("ns/custom"))?.origin, "custom");
      assert.equal((await ws.getStepSource("log"))?.origin, "core");
      assert.equal((await ws.getStepSource("github/fetch-pr"))?.origin, "lib");
      assert.equal(await ws.getStepSource("no/such/step"), null);
    });

    it("materializeCustomSteps returns a directory holding every active custom step as a file", async () => {
      await ws.publishStep("flat", STEP_SRC("flat", "f"));
      await ws.publishStep("ns/nested", STEP_SRC("ns/nested", "n"));
      const root = await ws.materializeCustomSteps();
      assert.ok((await stat(join(root, "flat.ts"))).isFile());
      assert.ok((await stat(join(root, "ns", "nested.ts"))).isFile());
      assert.equal(await ws.materializeCustomSteps(), root, "idempotent");
    });
  });
}
