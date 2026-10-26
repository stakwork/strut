/**
 * Step version pinning (src/step-ref.ts): `type: clip/shout@v1` runs THAT
 * version while every bare `clip/shout` follows the active pointer; the run
 * records the pinned version on `step.start.stepVersion`, and everything
 * keyed on a step type sees the bare type. A pinned version's relative
 * imports resolve as the active version's do, on every store.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createStrut } from "./createStrut.js";
import { defineStep, type RunEvent } from "./core.js";
import { baseType, formatStepRef, parseStepRef } from "./step-ref.js";
import { createRegistry, resolveStep, withStepVersions } from "./steps/registry.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager, validateStepName, type WorkspaceStore } from "./workspace.js";
import { validateWorkflowYaml } from "./validate.js";
import { flowClosure } from "./closure.js";
import { projectionsSettled } from "./graph/projector.js";
import { seedStrutDomain } from "./graph/schema-seed.js";
import { testBackends } from "./graph/test-util.js";
import { GraphWorkspaceStore } from "./graph/workspace-store.js";

const SHOUT = (suffix: string) => `import { z, defineStep } from "strut";
export default defineStep({ type: "clip/shout", input: z.object({ text: z.string() }), output: z.string(), async run(cfg) { return cfg.text.toUpperCase() + ${JSON.stringify(suffix)}; } });`;

describe("parseStepRef", () => {
  it("splits one trailing @label off a type; a bare type has no version", () => {
    assert.deepEqual(parseStepRef("clip/shout@v1"), { type: "clip/shout", version: "v1" });
    assert.deepEqual(parseStepRef("clip/shout"), { type: "clip/shout" });
    assert.deepEqual(parseStepRef("http"), { type: "http" });
    assert.equal(baseType("clip/shout@v12"), "clip/shout");
    assert.equal(formatStepRef({ type: "a/b", version: "v2" }), "a/b@v2");
    assert.equal(formatStepRef({ type: "a/b" }), "a/b");
    // Not a pin: a slash after the @ (a path, not a label), a bare "@".
    assert.deepEqual(parseStepRef("a@b/c"), { type: "a@b/c" });
    assert.deepEqual(parseStepRef("a@"), { type: "a@" });
  });

  it("a step NAME may not contain @ — it is the pin separator", () => {
    assert.throws(() => validateStepName("clip/shout@v1"), /reserved for version pins/);
    assert.doesNotThrow(() => validateStepName("clip/shout"));
  });
});

describe("resolveStep", () => {
  const echo = defineStep({ type: "echo", input: z.object({ v: z.string() }), output: z.string(), async run(c) { return c.v; } });

  it("a bare type is the registry entry; unknown → null", async () => {
    const registry = await createRegistry([echo]);
    assert.equal((await resolveStep(registry, "echo"))?.def, echo);
    assert.equal(await resolveStep(registry, "nope"), null);
  });

  it("a pin on a registry with no versions throws — never a silent fallback to active", async () => {
    const registry = await createRegistry([echo]);
    await assert.rejects(resolveStep(registry, "echo@v1"), /has no step versions/);
  });

  it("a pin loads through the loader once per registry, caches the def by ref (hidden from Object.keys), and refuses core/lib types", async () => {
    const dir = join(tmpdir(), `strut-pin-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const ws = new WorkspaceManager(dir);
    const v1 = await ws.publishStep("clip/shout", SHOUT("!"));
    let loads = 0;
    const registry = withStepVersions(await createRegistry([echo]), { echo: "custom", http: "core" }, async (name, version) => {
      loads++;
      return ws.materializeStepVersion(name, version);
    });
    const a = await resolveStep(registry, `clip/shout@${v1.version}`);
    const b = await resolveStep(registry, `clip/shout@${v1.version}`);
    assert.equal(loads, 1);
    assert.equal(a!.def, b!.def);
    assert.equal(a!.version, v1.version);
    assert.equal(a!.hash, (await ws.getActiveStepHashes())["clip/shout"]);
    assert.equal(registry[`clip/shout@${v1.version}`], a!.def, "sync lookups see a resolved pin");
    assert.ok(!Object.keys(registry).includes(`clip/shout@${v1.version}`), "…but listings never do");
    await assert.rejects(resolveStep(registry, "http@v1"), /is a core step/);
    await assert.rejects(resolveStep(registry, "clip/shout@v99"), /not found/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("a pinned step in a workflow", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-pin-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs the pinned version while a bare reference follows the active pointer, and records both honestly", async () => {
    const ws = new WorkspaceManager(tempDir);
    const v1 = await ws.publishStep("clip/shout", SHOUT("!"));
    const v2 = await ws.publishStep("clip/shout", SHOUT("?"));
    assert.deepEqual([v1.version, v2.version], ["v1", "v2"]);
    const activeHash = (await ws.getActiveStepHashes())["clip/shout"]!;
    const pinnedHash = (await ws.materializeStepVersion("clip/shout", "v1")).hash;
    assert.notEqual(activeHash, pinnedHash);

    await ws.publishWorkflow("both", "v1", {
      steps: [
        { id: "old", type: "clip/shout@v1", config: { text: "{{ input.text }}" } },
        { id: "now", type: "clip/shout", config: { text: "{{ input.text }}" }, depends: [] },
      ],
    });
    const store = new MemoryRunStore();
    const strut = await createStrut({ workspace: ws, store, serveUi: false, enableChat: false, stt: false });
    const res = await strut.run("both", { text: "hi" });
    assert.equal(res.status, "success");
    assert.deepEqual(res.output, "HI?", "the run's output is the last step's — the ACTIVE version");
    const events = await store.getRunEvents("both", res.runId);
    const start = (path: string) => events.find((e) => e.type === "step.start" && e.path === path)!;
    const end = (path: string) => events.find((e) => e.type === "step.end" && e.path === path)!;
    assert.equal(end("both/old").output, "HI!", "the pinned step ran v1");
    assert.equal(end("both/now").output, "HI?", "the bare step ran v2");
    assert.deepEqual(start("both/old").stepVersion, { version: "v1", hash: pinnedHash });
    assert.equal(start("both/now").stepVersion, undefined);
    assert.equal(start("both/old").stepType, "clip/shout", "events carry the bare type");
    assert.deepEqual(events.find((e) => e.type === "run.start")!.stepHashes, { "clip/shout": activeHash }, "run.start still records what was ACTIVE");

    // Rolling the step back does not touch the pinned step's behaviour, and
    // the bare one follows.
    await ws.setActiveStepVersion("clip/shout", "v1");
    await strut.rebuildRegistry();
    assert.equal((await strut.run("both", { text: "yo" })).output, "YO!");
  });

  it("a pin that does not exist fails the step before it starts; the run errors, nothing substitutes", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishStep("clip/shout", SHOUT("!"));
    await ws.publishWorkflow("bad", "v1", { steps: [{ id: "s", type: "clip/shout@v9", config: { text: "x" } }] });
    const store = new MemoryRunStore();
    const strut = await createStrut({ workspace: ws, store, serveUi: false, enableChat: false, stt: false });
    const res = await strut.run("bad", {});
    assert.equal(res.status, "error");
    assert.match(res.error!.message, /Version "v9" of step "clip\/shout" not found/);
    const events = await store.getRunEvents("bad", res.runId);
    assert.ok(!events.some((e: RunEvent) => e.type === "step.start"), "no step.start for a step that cannot load");
  });

  it("the HTTP doors: /schema and /source resolve a pinned reference; /steps/:type/run keeps under the bare type", async () => {
    const ws = new WorkspaceManager(tempDir);
    await ws.publishStep("clip/shout", SHOUT("!"));
    await ws.publishStep("clip/shout", `import { z, defineStep } from "strut";
export default defineStep({ type: "clip/shout", input: z.object({ text: z.string(), loud: z.boolean().default(true) }), output: z.string(), async run(cfg) { return cfg.text; } });`);
    const store = new MemoryRunStore();
    const strut = await createStrut({ workspace: ws, store, serveUi: false, enableChat: false, stt: false });
    const json = async (path: string, init?: RequestInit) => (await strut.app.request(path, init)).json() as Promise<any>;
    const enc = encodeURIComponent("clip/shout@v1");
    assert.deepEqual(((await json(`/steps/${enc}/schema`)).fields as Array<{ name: string }>).map((f) => f.name), ["text"], "v1's schema, not the active v2's");
    assert.deepEqual(((await json(`/steps/clip/shout/schema`)).fields as Array<{ name: string }>).map((f) => f.name), ["text", "loud"]);
    assert.ok(((await json(`/steps/${enc}/source`)).source as string).includes('"!"'));
    assert.equal((await strut.app.request(`/steps/${encodeURIComponent("clip/shout@v7")}/schema`)).status, 404);

    const run = await json(`/steps/${enc}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { text: "a" }, keep: true }),
    });
    assert.deepEqual([run.output, run.kept], ["A!", "step:clip/shout"]);
  });

  it("validate + closure see the bare type", async () => {
    const registry = await createRegistry([
      defineStep({ type: "echo", input: z.object({ v: z.string() }), output: z.string(), async run(c) { return c.v; } }),
    ]);
    const ok = validateWorkflowYaml(`name: w\nsteps:\n  - id: a\n    type: echo@v3\n    config: { v: hi }\n`, { registry });
    assert.deepEqual(ok.errors, []);
    const bad = validateWorkflowYaml(`name: w\nsteps:\n  - id: a\n    type: nope@v3\n`, { registry });
    assert.match(bad.errors[0]!.message, /Unknown step type "nope"/);
    const closure = await flowClosure({ steps: [{ id: "a", type: "echo@v3", config: {} }] });
    assert.deepEqual([...closure.types], ["echo"]);
  });
});

// A step that imports a helper by the `_`-file convention: a pinned version
// imports what the active one does (src/workspace.ts `materializePinnedStep`),
// and a helper republished while strut runs reaches both at the next registry
// build (src/strut-resolve-hook.ts).
const STORES: Array<{
  name: string;
  skip: string | false;
  /** Per suite: a fresh empty store over a case's dir, and the teardowns. */
  open(): Promise<{ make(dir: string): Promise<WorkspaceStore>; settle(): Promise<void>; close(): Promise<void> }>;
}> = [
  {
    name: "a file workspace",
    skip: false,
    open: async () => ({ make: async (dir) => new WorkspaceManager(dir), settle: async () => {}, close: async () => {} }),
  },
  ...testBackends().map((tb) => ({
    name: `a graph workspace on ${tb.name}`,
    skip: tb.skip,
    async open() {
      const backend = await tb.open();
      return {
        async make(dir: string) {
          await tb.wipe(backend);
          await seedStrutDomain(backend);
          return new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps", "_graph"), appsDir: join(dir, "apps") });
        },
        // Every run is projected into the graph after it ends, detached.
        settle: () => projectionsSettled(backend),
        close: () => tb.close(backend),
      };
    },
  })),
];

const HELPED = (label: string) => `import { z, defineStep } from "strut";
import { g } from "./_h.js";
import { t } from "../_top.js";
export default defineStep({ type: "a/b/s", input: z.object({}), output: z.string(), async run() { return ${JSON.stringify(label)} + ":" + g + ":" + t; } });`;

for (const s of STORES) {
  describe(`a step that imports a helper, on ${s.name}`, { skip: s.skip }, () => {
    let harness: Awaited<ReturnType<(typeof s)["open"]>>;
    let dir: string;
    let ws: WorkspaceStore;
    before(async () => {
      harness = await s.open();
    });
    after(() => harness?.close());
    beforeEach(async () => {
      dir = join(tmpdir(), `strut-pin-${randomUUID()}`);
      await mkdir(dir, { recursive: true });
      ws = await harness.make(dir);
    });
    afterEach(async () => {
      await harness.settle();
      await rm(dir, { recursive: true, force: true });
    });
    const boot = (store: MemoryRunStore) =>
      createStrut({
        workspace: ws,
        store,
        dataDir: dir,
        serveUi: false,
        enableChat: false,
        stt: false,
        scheduler: false,
        claims: false,
        job: false,
        orchestrator: false,
        builder: false,
        concepts: false,
        views: false,
        systemWorkflows: false,
        browserWorkflows: false,
        privacyWorkflows: false,
      });

    it("loads beside the active steps: the pinned code over the helpers' ACTIVE versions, as the active step sees them", async () => {
      await ws.publishStep("a/_top", `export const t = 7;`);
      await ws.publishStep("a/b/_h", `export const g = 1;`);
      const v1 = await ws.publishStep("a/b/s", HELPED("one"));
      await ws.publishStep("a/b/s", HELPED("two"));
      await ws.publishStep("a/b/_h", `export const g = 2;`);
      await ws.publishWorkflow("w", "v1", {
        steps: [
          { id: "old", type: `a/b/s@${v1.version}`, config: {} },
          { id: "now", type: "a/b/s", config: {}, depends: [] },
        ],
      });
      const store = new MemoryRunStore();
      const strut = await boot(store);
      const res = await strut.run("w", {});
      assert.equal(res.status, "success", res.error?.message);
      const events = await store.getRunEvents("w", res.runId);
      const end = (path: string) => events.find((e) => e.type === "step.end" && e.path === path)!;
      assert.equal(end("w/old").output, "one:2:7", "v1's own code, and the helper the active step imports");
      assert.equal(end("w/now").output, "two:2:7");
      assert.deepEqual(events.find((e) => e.type === "step.start" && e.path === "w/old")!.stepVersion, {
        version: v1.version,
        hash: (await ws.materializeStepVersion("a/b/s", v1.version)).hash,
      });
      assert.deepEqual(Object.keys(strut.getRegistry()).filter((k) => k.startsWith("a/")), ["a/b/s"], "the pinned file is never discovered as a step");
      await strut.close();
    });

    it("a republished helper, or a helper it imports, reaches the active step and the pinned version at the next rebuild", async () => {
      await ws.publishStep("a/_top", `export const t = 7;`);
      await ws.publishStep("a/b/_h", `export const g = 1;`);
      const v1 = await ws.publishStep("a/b/s", HELPED("one"));
      await ws.publishStep("a/b/s", HELPED("two"));
      await ws.publishWorkflow("w", "v1", {
        steps: [
          { id: "old", type: `a/b/s@${v1.version}`, config: {} },
          { id: "now", type: "a/b/s", config: {}, depends: [] },
        ],
      });
      const store = new MemoryRunStore();
      const strut = await boot(store);
      const outputs = async () => {
        const res = await strut.run("w", {});
        assert.equal(res.status, "success", res.error?.message);
        const events = await store.getRunEvents("w", res.runId);
        return ["w/old", "w/now"].map((path) => events.find((e) => e.type === "step.end" && e.path === path)!.output);
      };
      assert.deepEqual(await outputs(), ["one:1:7", "two:1:7"]);

      await ws.publishStep("a/b/_h", `export const g = 2;`);
      await strut.rebuildRegistry();
      assert.deepEqual(await outputs(), ["one:2:7", "two:2:7"]);

      // The steps and `_h` unchanged; the helper `_h` imports republished.
      await ws.publishStep("a/b/_d", `export const d = 3;`);
      await ws.publishStep("a/b/_h", `export { d as g } from "./_d.js";`);
      await strut.rebuildRegistry();
      assert.deepEqual(await outputs(), ["one:3:7", "two:3:7"]);
      await ws.publishStep("a/b/_d", `export const d = 4;`);
      await strut.rebuildRegistry();
      assert.deepEqual(await outputs(), ["one:4:7", "two:4:7"]);

      await ws.setActiveStepVersion("a/b/_h", "v1");
      await strut.rebuildRegistry();
      assert.deepEqual(await outputs(), ["one:1:7", "two:1:7"], "a rollback reaches them too");
      await strut.close();
    });

    it("a label reused after a delete runs its own code, never the deleted version's", async () => {
      await ws.publishStep("a/_top", `export const t = 7;`);
      await ws.publishStep("a/b/_h", `export const g = 1;`);
      await ws.publishStep("a/b/s", HELPED("old"));
      await ws.publishWorkflow("w", "v1", { steps: [{ id: "x", type: "a/b/s@v1", config: {} }] });
      const strut = await boot(new MemoryRunStore());
      assert.equal((await strut.run("w", {})).output, "old:1:7");
      await ws.deleteStep("a/b/s");
      assert.equal((await ws.publishStep("a/b/s", HELPED("new"))).version, "v1", "labels start over");
      await strut.rebuildRegistry();
      assert.equal((await strut.run("w", {})).output, "new:1:7");
      await strut.close();
    });
  });
}
