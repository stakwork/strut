import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Automation } from "../automations.js";
import type { WorkspaceStore } from "../workspace.js";
import { contentHash } from "../version.js";

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
