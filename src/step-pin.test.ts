/**
 * Step version pinning (src/step-ref.ts): `type: clip/shout@v1` runs THAT
 * version while every bare `clip/shout` follows the active pointer; the run
 * records the pinned version on `step.start.stepVersion`, and everything
 * keyed on a step type sees the bare type.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
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
import { WorkspaceManager, validateStepName } from "./workspace.js";
import { validateWorkflowYaml } from "./validate.js";
import { flowClosure } from "./closure.js";

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
