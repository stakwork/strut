import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { defineStep } from "./core.js";
import { createRegistry } from "./steps/registry.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore, FileRunStore } from "./store.js";
import { MemorySecretStore } from "./secret-store.js";
import { lsSteps, searchSteps } from "./ai/stepHelpers.js";
import { buildSystem } from "./ai/prompts.js";
import { buildTools } from "./ai/tools.js";
import { stepSchemas, zodToFields } from "./ai/schemaHelpers.js";

/** Every yield of a generator tool (run_workflow); its result is the last. */
async function yields(it: AsyncIterable<any>): Promise<any[]> {
  const out = [];
  for await (const y of it) out.push(y);
  return out;
}
const lastYield = async (it: AsyncIterable<any>) => (await yields(it)).at(-1);

/**
 * End-to-end verification that the AI workflow-builder tools can see
 * steps that were registered in code via `createRegistry([...])`.
 * Without this wiring, in-code consumers' steps would be invisible to
 * the chat agent even though execution worked fine.
 */

describe("AI tools see in-code registered steps", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-ai-integration-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function setup() {
    const myThing = defineStep({
      type: "do-thing",
      description: "Does a custom thing in-memory",
      input: z.object({ x: z.number() }),
      output: z.string(),
      async run(cfg) {
        return `did ${cfg.x}`;
      },
    });

    const gitreeSave = defineStep({
      type: "gitree/store-feature",
      description: "Stores a feature description in gitree",
      input: z.object({ feature: z.string() }),
      output: z.any(),
      async run(cfg) {
        return { saved: cfg.feature };
      },
    });

    const registry = await createRegistry([myThing, gitreeSave]);

    return {
      myThing,
      gitreeSave,
      deps: {
        workspace: new WorkspaceManager(tempDir),
        registry,
        store: new MemoryRunStore(),
        getRegistry: async () => registry,
      },
    };
  }

  it("list_steps('steps/custom') includes in-code registry entries", async () => {
    const { deps } = await setup();
    const result = await lsSteps("steps/custom", deps);
    const entries = (result as { entries?: string[] }).entries ?? [];

    // Should include both the flat and the namespaced step.
    const matchThing = entries.find((e) => e.startsWith("do-thing"));
    const matchGitree = entries.find((e) =>
      e.startsWith("gitree/store-feature"),
    );

    assert.ok(matchThing, `expected "do-thing" in custom listing, got: ${JSON.stringify(entries)}`);
    assert.ok(matchGitree, `expected "gitree/store-feature" in custom listing, got: ${JSON.stringify(entries)}`);
    // Descriptions are included.
    assert.ok(matchThing.includes("Does a custom thing"));
    assert.ok(matchGitree.includes("Stores a feature"));
  });

  it("search_steps finds in-code steps by name and description", async () => {
    const { deps } = await setup();

    const byName = await searchSteps("thing", deps);
    const names = byName.matches.map((m) => m.type);
    assert.ok(names.includes("do-thing"), `expected do-thing in matches: ${JSON.stringify(names)}`);

    const byDesc = await searchSteps("gitree feature", deps);
    const names2 = byDesc.matches.map((m) => m.type);
    assert.ok(
      names2.includes("gitree/store-feature"),
      `expected gitree/store-feature in matches: ${JSON.stringify(names2)}`,
    );
  });

  it("get_step returns JSON Schema (input + output) for in-code steps, no source by default", async () => {
    const { deps } = await setup();
    const tools = buildTools(deps) as any;

    const res = await tools.get_step.execute({ type: "do-thing" });
    assert.equal(res.type, "do-thing");
    assert.equal(res.description, "Does a custom thing in-memory");
    assert.deepEqual(res.input, {
      type: "object",
      properties: { x: { type: "number" } },
      required: ["x"],
    });
    assert.deepEqual(res.output, { type: "string" });
    assert.equal("source" in res, false);

    // source: true on an in-code step (no file on disk) → null, not an error;
    // the model still has the schema and description.
    const withSource = await tools.get_step.execute({ type: "do-thing", source: true });
    assert.equal(withSource.source, null);
  });

  it("run_step returns the output once — not again on step.end / run.end", async () => {
    const { deps } = await setup();
    const tools = buildTools(deps) as any;
    const res = await tools.run_step.execute({ type: "do-thing", config: { x: 7 } });
    assert.equal(res.output, "did 7");
    assert.deepEqual(res.events.map((e: any) => e.type), ["run.start", "step.start", "step.end", "run.end"]);
    for (const e of res.events) assert.equal("output" in e, false, e.type);
  });

  it("get_step omits `output` for an untyped (z.any()) step and resolves namespaced types", async () => {
    const { deps } = await setup();
    const tools = buildTools(deps) as any;
    const res = await tools.get_step.execute({ type: "gitree/store-feature" });
    assert.deepEqual(res.input.properties, { feature: { type: "string" } });
    assert.equal("output" in res, false);
  });

  it("stepSchemas keeps .describe() text and makes defaulted fields optional; zodToFields carries description", () => {
    const def = defineStep({
      type: "t",
      input: z.object({
        cmd: z.string().describe("program to run"),
        args: z.array(z.string()).default([]).describe("verbatim"),
        mode: z.enum(["a", "b"]).optional().describe("which"),
        n: z.number(),
      }),
      output: z.any(),
      async run() {
        return null;
      },
    });

    const { input, output } = stepSchemas(def);
    const props = input.properties as Record<string, any>;
    assert.equal(props.cmd.description, "program to run");
    assert.equal(props.args.description, "verbatim");
    assert.deepEqual(props.args.default, []);
    assert.deepEqual(input.required, ["cmd", "n"]);
    assert.equal(output, undefined);

    const fields = zodToFields(def.input);
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    assert.equal(by.cmd.description, "program to run");
    assert.equal(by.mode.description, "which"); // .describe() on the outer optional wrapper
    assert.equal(by.mode.kind, "enum");
    assert.deepEqual(by.n, { name: "n", kind: "number", required: true, default: undefined }); // no description key when unset
  });

  it("the system prompt's 'Available steps' tree lists in-code steps under custom/", async () => {
    const { deps } = await setup();
    const system = await buildSystem(deps);
    const tree = system.slice(system.indexOf("Available steps:"));

    // Tree groups: steps/ → core/ + lib/ + custom/. Our two should appear
    // under custom/.
    assert.ok(tree.includes("custom/"), "tree should have a custom/ section");
    assert.ok(
      tree.includes("do-thing"),
      `expected 'do-thing' in the seeded tree:\n${tree}`,
    );
    assert.ok(
      tree.includes("gitree/store-feature"),
      `expected 'gitree/store-feature' in the seeded tree:\n${tree}`,
    );
  });

  it("does NOT duplicate steps that are both on disk AND in the registry", async () => {
    // If someone publishes a step to the workspace AND has the same
    // name in their in-code registry (unusual but possible), it should
    // appear once.
    const ws = new WorkspaceManager(tempDir);
    await ws.publishStep(
      "shared",
      `import { z } from "zod";
       import { defineStep } from "strut";
       export default defineStep({
         type: "shared",
         input: z.object({}),
         output: z.any(),
         async run() { return null; },
       });`,
      "on-disk version",
    );

    const inCode = defineStep({
      type: "shared",
      description: "in-code version",
      input: z.object({}),
      output: z.any(),
      async run() {
        return null;
      },
    });

    const registry = await createRegistry([inCode]);
    const deps = {
      workspace: ws,
      registry,
      store: new MemoryRunStore(),
      getRegistry: async () => registry,
    };

    const result = await lsSteps("steps/custom", deps);
    const entries = (result as { entries?: string[] }).entries ?? [];
    const matches = entries.filter((e) => e.startsWith("shared"));
    assert.equal(
      matches.length,
      1,
      `expected exactly one 'shared' entry, got: ${JSON.stringify(matches)}`,
    );
  });
});

describe("AI create_step / edit_step tools", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-ai-steps-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeDeps(opts: { publishingEnabled?: boolean } = {}) {
    const ws = new WorkspaceManager(tempDir);
    return {
      workspace: ws,
      registry: {} as any,
      store: new MemoryRunStore(),
      // Static getRegistry — the temp workspace lives outside the project tree
      // so a published .ts can't resolve `strut` to actually load. These tests
      // verify publish/version semantics, not registry loading.
      getRegistry: async () => ({} as any),
      ...opts,
    };
  }

  const code = (n: number) =>
    `import { z, defineStep } from "strut";\nexport default defineStep({ type: "my/step", input: z.object({}), output: z.any(), async run(){ return ${n}; } });\n`;

  it("create_step publishes a new step at v1; edit_step bumps to v2", async () => {
    const deps = makeDeps();
    const tools = buildTools(deps) as any;

    const created = await tools.create_step.execute({ name: "my/step", code: code(1) });
    assert.equal(created.ok, true);
    assert.equal(created.version, "v1");

    const edited = await tools.edit_step.execute({ type: "my/step", code: code(2) });
    assert.equal(edited.ok, true);
    assert.equal(edited.version, "v2");
    assert.equal(edited.changed, true);

    const { active, versions } = await deps.workspace.listStepVersions("my/step");
    assert.equal(active, "v2");
    assert.deepEqual(versions, ["v1", "v2"]);
  });

  it("edit_step takes `edits` over the active source; a missing or repeated match publishes nothing", async () => {
    const deps = makeDeps();
    const tools = buildTools(deps) as any;
    await tools.create_step.execute({ name: "my/step", code: code(1) });

    // Neither / both → refused before anything is read.
    assert.match((await tools.edit_step.execute({ type: "my/step" })).error, /Pass the full step source or `edits`/);
    assert.match(
      (await tools.edit_step.execute({ type: "my/step", code: code(2), edits: [{ old: "1", new: "2" }] })).error,
      /not both/,
    );
    // No match: nothing published, the message says to copy verbatim.
    const miss = await tools.edit_step.execute({ type: "my/step", edits: [{ old: "return 9;", new: "return 2;" }] });
    assert.match(miss.error, /^Edit 1: no match .*Nothing was published/);
    // Repeated match: every line named.
    const dup = await tools.edit_step.execute({ type: "my/step", edits: [{ old: "z", new: "zz" }] });
    assert.match(dup.error, /^Edit 1: the text to replace matches 3 times \(lines 1, 2\)/);
    assert.equal((await deps.workspace.listStepVersions("my/step")).active, "v1");

    // One exact match → v2 with the edit applied; edits apply in order.
    const edited = await tools.edit_step.execute({
      type: "my/step",
      edits: [
        { old: "return 1;", new: "return 2;" },
        { old: "return 2;", new: "return 3;" },
      ],
    });
    assert.equal(edited.ok, true);
    assert.equal(edited.version, "v2");
    assert.match((await deps.workspace.getStepSource("my/step"))!.code, /return 3;/);
    assert.match(
      (await tools.edit_step.execute({ type: "nope/step", edits: [{ old: "a", new: "b" }] })).error,
      /Step "nope\/step" not found/,
    );
  });

  it("set_active_version rolls a custom step back and refreshes the registry", async () => {
    const deps = makeDeps();
    let refreshed = 0;
    deps.getRegistry = async () => { refreshed++; return {} as any; };
    const tools = buildTools(deps) as any;
    await tools.create_step.execute({ name: "my/step", code: code(1) });
    await tools.edit_step.execute({ type: "my/step", code: code(2) });
    const before = refreshed;

    const res = await tools.set_active_version.execute({ kind: "step", name: "my/step", version: "v1" });
    assert.deepEqual(res, { ok: true, kind: "step", name: "my/step", active: "v1" });
    assert.equal(refreshed, before + 1);
    const { active, versions } = await deps.workspace.listStepVersions("my/step");
    assert.equal(active, "v1");
    assert.deepEqual(versions, ["v1", "v2"]);

    const bad = await tools.set_active_version.execute({ kind: "step", name: "my/step", version: "v7" });
    assert.match(bad.error, /Version "v7" not found/);
  });

  it("set_active_version refuses step rollback when publishing is disabled", async () => {
    const tools = buildTools(makeDeps({ publishingEnabled: false })) as any;
    const res = await tools.set_active_version.execute({ kind: "step", name: "my/step", version: "v1" });
    assert.match(res.error, /disabled/);
  });

  it("create_step rejects an existing step name", async () => {
    const deps = makeDeps();
    const tools = buildTools(deps) as any;
    await tools.create_step.execute({ name: "my/step", code: code(1) });
    const again = await tools.create_step.execute({ name: "my/step", code: code(2) });
    assert.ok(again.error && /already exists/.test(again.error));
  });

  it("edit_step rejects a step that does not exist", async () => {
    const deps = makeDeps();
    const tools = buildTools(deps) as any;
    const res = await tools.edit_step.execute({ type: "nope/missing", code: code(1) });
    assert.ok(res.error && /not found/.test(res.error));
  });

  it("edit_step is a no-op (changed:false) for identical content", async () => {
    const deps = makeDeps();
    const tools = buildTools(deps) as any;
    await tools.create_step.execute({ name: "my/step", code: code(1) });
    const same = await tools.edit_step.execute({ type: "my/step", code: code(1) });
    assert.equal(same.changed, false);
    assert.equal(same.version, "v1");
  });

  it("both tools refuse when publishing is disabled", async () => {
    const deps = makeDeps({ publishingEnabled: false });
    const tools = buildTools(deps) as any;
    const c = await tools.create_step.execute({ name: "my/step", code: code(1) });
    assert.ok(c.error && /disabled/.test(c.error));
    const e = await tools.edit_step.execute({ type: "my/step", code: code(1) });
    assert.ok(e.error && /disabled/.test(e.error));
  });
});

describe("AI list_workflows / get_workflow tools", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-ai-wf-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeDeps() {
    const ws = new WorkspaceManager(tempDir);
    return {
      ws,
      deps: {
        workspace: ws,
        registry: {} as any,
        store: new MemoryRunStore(),
        getRegistry: async () => ({} as any),
      },
    };
  }

  const wfYaml = (name: string) =>
    `name: ${name}\nsteps:\n  - id: hello\n    type: log\n    config:\n      message: hi\n`;

  it("list_workflows returns slim entries; query filters; limit cuts with total + hint", async () => {
    const { ws, deps } = makeDeps();
    await ws.createWorkflow("alpha", wfYaml("alpha"), "first one");
    await ws.createWorkflow("beta", wfYaml("beta"));
    await ws.createWorkflow("youtube-clip", wfYaml("youtube-clip"), "cut a clip from a video", "media");
    const tools = buildTools(deps) as any;

    // No args: everything, under the default limit — no hint.
    const all = await tools.list_workflows.execute({});
    assert.deepEqual(all.workflows.map((w: any) => w.name).sort(), ["alpha", "beta", "youtube-clip"]);
    assert.equal(all.total, 3);
    assert.equal(all.hint, undefined);
    // The entry is what picking a workflow needs — versions and schedules
    // are get_workflow's / list_automations's, never in the list.
    assert.deepEqual(all.workflows.find((w: any) => w.name === "alpha"), { name: "alpha", activeVersion: "v1", description: "first one" });
    assert.deepEqual(all.workflows.find((w: any) => w.name === "youtube-clip"), {
      name: "youtube-clip", activeVersion: "v1", description: "cut a clip from a video", category: "media",
    });

    // query: every word must hit the name, category or description.
    const q = await tools.list_workflows.execute({ query: "youtube video" });
    assert.deepEqual(q.workflows.map((w: any) => w.name), ["youtube-clip"]);
    assert.equal(q.total, 1);
    assert.deepEqual(await tools.list_workflows.execute({ query: "nothing-like-this" }), { workflows: [], total: 0 });

    // limit: the cut is in the result, with the count and what to do.
    const cut = await tools.list_workflows.execute({ limit: 2 });
    assert.equal(cut.workflows.length, 2);
    assert.equal(cut.total, 3);
    assert.match(cut.hint, /Showing 2 of 3 workflows/);
    assert.match(cut.hint, /pass query/);
    const cutQ = await tools.list_workflows.execute({ query: "e", limit: 1 });
    assert.equal(cutQ.total, 3);
    assert.match(cutQ.hint, /1 of 3 workflows matching "e"/);
  });

  it("get_workflow returns the active version's YAML + metadata — any version by label, one metadata read", async () => {
    const { ws, deps } = makeDeps();
    await ws.createWorkflow("alpha", wfYaml("alpha"), "first one");
    await ws.publishWorkflow("alpha", "v2", wfYaml("alpha").replace("hi", "hello"), "second");
    const tools = buildTools(deps) as any;

    const res = await tools.get_workflow.execute({ name: "alpha" });
    assert.equal(res.name, "alpha");
    assert.equal(res.version, "v2");
    assert.equal(res.activeVersion, "v2");
    assert.deepEqual(res.versions, ["v1", "v2"]);
    assert.equal(res.description, "second");
    assert.ok(res.yaml.includes("message: hello"));

    const v1 = await tools.get_workflow.execute({ name: "alpha", version: "v1" });
    assert.equal(v1.version, "v1");
    assert.ok(v1.yaml.includes("message: hi"));
    const missing = await tools.get_workflow.execute({ name: "alpha", version: "v9" });
    assert.match(missing.error, /Version "v9" not found for "alpha"\. Available: v1, v2/);
    const gone = await tools.get_workflow.execute({ name: "nope" });
    assert.match(gone.error, /Workflow "nope" not found/);
  });

  it("create_workflow / edit_workflow refuse invalid YAML with a readable error; warnings ride along", async () => {
    const { ws, deps } = makeDeps();
    const echo = defineStep({ type: "echo", input: z.object({ message: z.string() }), output: z.any(), async run(c) { return c; } });
    const registry = await createRegistry([echo]);
    const tools = buildTools({ ...deps, registry, getRegistry: async () => registry }) as any;

    // Cycle + unknown type → refused, nothing written.
    const bad = await tools.create_workflow.execute({
      name: "broken",
      yaml: "name: broken\nsteps:\n  - id: a\n    type: echo\n    config: { message: x }\n    depends: b\n  - id: b\n    type: nope\n    config: {}\n    depends: a\n",
    });
    assert.match(bad.error, /^Not published: the workflow YAML has 2 validation errors \(nothing was written; no version was created\)/);
    assert.match(bad.error, /steps\[1\]\.type: Unknown step type "nope"/);
    assert.match(bad.error, /Dependency cycle/);
    assert.match(bad.error, /validate_workflow re-checks without publishing/);
    assert.equal(bad.validation.ok, false);
    assert.deepEqual(await ws.listWorkflows(), []);

    // Missing `name:` in YAML is fine — the tool's name is stamped in.
    // An unknown config field is a warning: published, warning returned.
    const ok = await tools.create_workflow.execute({
      name: "fine",
      yaml: "steps:\n  - id: a\n    type: echo\n    config: { message: x, extra: 1 }\n",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.version, "v1");
    assert.equal(ok.warnings.length, 1);
    assert.match(ok.warnings[0].message, /Unknown config field "extra"/);

    // edit_workflow: same gate; version stays v1 on refusal.
    const edit = await tools.edit_workflow.execute({
      name: "fine",
      yaml: "name: fine\nsteps:\n  - id: a\n    type: echo\n    config: { message: \"{{ nope.x }}\" }\n",
    });
    assert.match(edit.error, /^Not published: .*1 validation error /);
    assert.match(edit.error, /unknown root "nope"/);
    assert.equal((await tools.get_workflow.execute({ name: "fine" })).activeVersion, "v1");

    const clean = await tools.edit_workflow.execute({
      name: "fine",
      yaml: "name: fine\nsteps:\n  - id: a\n    type: echo\n    config: { message: y }\n",
    });
    assert.equal(clean.ok, true);
    assert.equal(clean.version, "v2");
    assert.equal("warnings" in clean, false);
  });

  it("get_workflow is capped by the document cap, every other tool by the ordinary one", async () => {
    const { ws, deps } = makeDeps();
    const big = wfYaml("big") + "  - id: more\n    type: log\n    config:\n      message: " + "m".repeat(3000) + "\n";
    await ws.createWorkflow("big", big, "d".repeat(400));
    // What the model reads: the capped output, or the raw one where the tool is left uncapped.
    const read = async (tools: any, name: string, input: any) => {
      const output = await tools[name].execute(input);
      const cap = tools[name].toModelOutput;
      return cap ? (await cap({ toolCallId: "c", input, output })).value : output;
    };
    // The ordinary cap alone (no document cap given): the document is cut like anything else.
    const plain = buildTools({ ...deps, toolResultMaxChars: 1000 }) as any;
    assert.ok((await read(plain, "get_workflow", { name: "big" })).yaml.includes("[TRUNCATED"));
    // The document cap: get_workflow comes back whole, a listing's long string is still cut.
    const tools = buildTools({ ...deps, toolResultMaxChars: 300, documentMaxChars: 100_000 }) as any;
    assert.equal((await read(tools, "get_workflow", { name: "big" })).yaml, big);
    const listed = await read(tools, "list_workflows", {});
    assert.ok(listed.workflows[0].description.includes("[TRUNCATED"));
    // `0` for the document cap leaves documents uncapped while the rest is still capped.
    const open = buildTools({ ...deps, toolResultMaxChars: 300, documentMaxChars: 0 }) as any;
    assert.equal((await read(open, "get_workflow", { name: "big" })).yaml, big);
    assert.ok((await read(open, "list_workflows", {})).workflows[0].description.includes("[TRUNCATED"));
  });

  it("edit_workflow takes `edits` over the active version's YAML — one line of a big file, never resent", async () => {
    const { ws, deps } = makeDeps();
    const echo = defineStep({ type: "echo", input: z.object({ message: z.string(), pages: z.number().optional() }), output: z.any(), async run(c) { return c; } });
    const registry = await createRegistry([echo]);
    const tools = buildTools({ ...deps, registry, getRegistry: async () => registry }) as any;
    const yaml =
      "name: study\nparams:\n  max_pages: 3\nsteps:\n  - id: a\n    type: echo\n    config: { message: x, pages: \"{{ params.max_pages }}\" }\n";
    await ws.createWorkflow("study", yaml);

    assert.match((await tools.edit_workflow.execute({ name: "study" })).error, /Pass the full workflow YAML or `edits`/);
    assert.match((await tools.edit_workflow.execute({ name: "study", yaml, edits: [{ old: "3", new: "100" }] })).error, /not both/);
    assert.match(
      (await tools.edit_workflow.execute({ name: "nope", edits: [{ old: "3", new: "100" }] })).error,
      /Workflow "nope" not found/,
    );
    // A no-match or a repeated match publishes nothing.
    assert.match((await tools.edit_workflow.execute({ name: "study", edits: [{ old: "max_pages: 4", new: "max_pages: 100" }] })).error, /^Edit 1: no match/);
    assert.match((await tools.edit_workflow.execute({ name: "study", edits: [{ old: "max_pages", new: "pages" }] })).error, /matches 2 times \(lines 3, 7\)/);
    // A validation error after the edit publishes nothing either.
    const broken = await tools.edit_workflow.execute({ name: "study", edits: [{ old: "type: echo", new: "type: nope" }] });
    assert.match(broken.error, /Unknown step type "nope"/);
    assert.equal((await tools.get_workflow.execute({ name: "study" })).activeVersion, "v1");

    const res = await tools.edit_workflow.execute({ name: "study", edits: [{ old: "max_pages: 3", new: "max_pages: 100" }] });
    assert.equal(res.ok, true);
    assert.equal(res.version, "v2");
    assert.equal(res.changed, true);
    const after = await tools.get_workflow.execute({ name: "study" });
    assert.equal(after.activeVersion, "v2");
    assert.equal(after.yaml, yaml.replace("max_pages: 3", "max_pages: 100"));
    // Edits apply to the ACTIVE version: rolled back to v1, the same edit lands on v1's text as v3.
    await tools.set_active_version.execute({ kind: "workflow", name: "study", version: "v1" });
    const again = await tools.edit_workflow.execute({ name: "study", edits: [{ old: "max_pages: 3", new: "max_pages: 50" }] });
    assert.equal(again.version, "v3");
    assert.match((await tools.get_workflow.execute({ name: "study" })).yaml, /max_pages: 50/);
  });

  it("set_active_version rolls a workflow back without publishing", async () => {
    const { ws, deps } = makeDeps();
    await ws.createWorkflow("alpha", wfYaml("alpha"));
    await ws.publishWorkflowByContent("alpha", wfYaml("alpha") + "  - id: more\n    type: log\n    config:\n      message: v2\n");
    const tools = buildTools(deps) as any;
    assert.equal((await tools.get_workflow.execute({ name: "alpha" })).activeVersion, "v2");

    const res = await tools.set_active_version.execute({ kind: "workflow", name: "alpha", version: "v1" });
    assert.deepEqual(res, { ok: true, kind: "workflow", name: "alpha", active: "v1" });
    const after = await tools.get_workflow.execute({ name: "alpha" });
    assert.equal(after.activeVersion, "v1");
    assert.deepEqual(after.versions, ["v1", "v2"]); // history kept
    assert.ok(!after.yaml.includes("message: v2"));

    const bad = await tools.set_active_version.execute({ kind: "workflow", name: "alpha", version: "v9" });
    assert.match(bad.error, /Version "v9" not found/);
    const missing = await tools.set_active_version.execute({ kind: "workflow", name: "nope", version: "v1" });
    assert.match(missing.error, /not found/);
  });

  it("get_workflow errors on unknown workflow and unknown version", async () => {
    const { ws, deps } = makeDeps();
    await ws.createWorkflow("alpha", wfYaml("alpha"));
    const tools = buildTools(deps) as any;

    const missing = await tools.get_workflow.execute({ name: "nope" });
    assert.ok(missing.error && /not found/.test(missing.error));

    const badVer = await tools.get_workflow.execute({ name: "alpha", version: "v9" });
    assert.ok(badVer.error && /v9/.test(badVer.error));
  });
});

describe("AI list_runs / get_run tools", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-ai-runs-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("list_runs + get_run surface run history and events from a FileRunStore", async () => {
    const echo = defineStep({
      type: "echo",
      input: z.object({ msg: z.string() }),
      output: z.any(),
      async run(cfg: any) {
        return { echoed: cfg.msg };
      },
    });
    const registry = await createRegistry([echo]);
    const ws = new WorkspaceManager(tempDir);
    const store = new FileRunStore(tempDir);
    const deps = {
      workspace: ws,
      registry,
      store,
      getRegistry: async () => registry,
    };

    await ws.createWorkflow(
      "greeter",
      `name: greeter\nsteps:\n  - id: say\n    type: echo\n    config:\n      msg: hello\n`,
    );
    const tools = buildTools(deps) as any;

    const run = await lastYield(tools.run_workflow.execute({ name: "greeter", input: {} }));
    assert.equal(run.status, "success");

    const { runs } = await tools.list_runs.execute({ name: "greeter" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, run.runId);
    assert.equal(runs[0].status, "success");

    // The tree, no payloads on listed steps by default.
    const slim = await tools.get_run.execute({ name: "greeter", runId: run.runId });
    assert.equal(slim.summary.status, "success");
    assert.deepEqual(slim.steps.map((s: any) => [s.id, s.status]), [["say", "success"]]);
    assert.ok(slim.steps.every((s: any) => !("input" in s) && !("output" in s)));
    assert.equal(slim.errors, undefined);

    // fullEvents puts payloads on the listed steps.
    const full = await tools.get_run.execute({ name: "greeter", runId: run.runId, fullEvents: true });
    assert.deepEqual(full.steps[0].output, { echoed: "hello" });

    // A zoom: the node is the focus, with its payloads, and its (no) children.
    const zoom = await tools.get_run.execute({ name: "greeter", runId: run.runId, path: "greeter/say" });
    assert.equal(zoom.focus.path, "greeter/say");
    assert.deepEqual(zoom.focus.output, { echoed: "hello" });
    assert.deepEqual(zoom.steps, []);
  });

  it("get_run errors for an unknown run id", async () => {
    const registry = await createRegistry([]);
    const deps = {
      workspace: new WorkspaceManager(tempDir),
      registry,
      store: new FileRunStore(tempDir),
      getRegistry: async () => registry,
    };
    const tools = buildTools(deps) as any;
    const res = await tools.get_run.execute({ name: "ghost", runId: "123" });
    assert.ok(res.error && /not found/.test(res.error));
  });

  it("run-history tools read from a MemoryRunStore like any other", async () => {
    const registry = await createRegistry([]);
    const store = new MemoryRunStore();
    await store.append("x", "1", { ts: new Date().toISOString(), runId: "1", path: "x", type: "run.start" });
    const deps = {
      workspace: new WorkspaceManager(tempDir),
      registry,
      store,
      getRegistry: async () => registry,
    };
    const tools = buildTools(deps) as any;
    const list = await tools.list_runs.execute({ name: "x", limit: 20 });
    assert.deepEqual(list.runs.map((r: { runId: string }) => r.runId), ["1"]);
    const get = await tools.get_run.execute({ name: "x", runId: "1", fullEvents: false });
    assert.equal(get.runId, "1");
    assert.equal(get.status, "running");
    assert.equal(get.summary.partial, true, "no summary yet: the view says so");
    assert.deepEqual(get.steps, []);
    const missing = await tools.get_run.execute({ name: "x", runId: "2", fullEvents: false });
    assert.ok(missing.error && /not found/.test(missing.error));
  });
});

// ── run_workflow coerces a stringified input ────────────────────────────────

describe("AI run_workflow tool: stringified input coercion", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-ai-runwf-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("parses an input passed as a JSON string so {{ input.* }} resolves", async () => {
    const echo = defineStep({
      type: "echo",
      input: z.any(),
      output: z.any(),
      async run(cfg) {
        return cfg;
      },
    });
    const registry = await createRegistry([echo]);
    const ws = new WorkspaceManager(tempDir);
    await ws.publishWorkflow("echo-wf", "v1", {
      steps: [
        { id: "a", type: "echo", config: { owner: "{{ input.owner }}", pull_number: "{{ input.pull_number }}" } },
      ],
    });

    const deps = {
      workspace: ws,
      registry,
      store: new MemoryRunStore(),
      getRegistry: async () => registry,
    };
    const tools = buildTools(deps) as any;

    // The model passes input as a JSON STRING (the exact bug from the logs).
    const res = await lastYield(tools.run_workflow.execute({
      name: "echo-wf",
      input: '{ "owner": "vercel", "pull_number": 1234 }',
    }));

    assert.equal(res.status, "success");
    assert.equal(res.output.owner, "vercel");
    assert.equal(res.output.pull_number, 1234);
    assert.equal(typeof res.output.pull_number, "number");
  });
});

// ── list_secrets tool ────────────────────────────────────────────────────────

describe("AI list_secrets tool", () => {
  function makeDeps(secrets?: MemorySecretStore) {
    const registry = {} as any;
    return {
      workspace: {} as any,
      registry,
      store: new MemoryRunStore(),
      getRegistry: async () => registry,
      secrets,
    };
  }

  it("returns secret NAMES + updatedAt, never values", async () => {
    const store = new MemorySecretStore();
    await store.set("GITHUB_TOKEN", "ghp_superSecret");
    await store.set("GOOGLE_SERVICE_ACCOUNT_JSON", '{"private_key":"xyz"}');

    const tools = buildTools(makeDeps(store)) as any;
    const res = await tools.list_secrets.execute({});

    assert.deepEqual(
      res.secrets.map((s: { name: string }) => s.name).sort(),
      ["GITHUB_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON"],
    );
    // The agent must never see values.
    const blob = JSON.stringify(res);
    assert.ok(!blob.includes("ghp_superSecret"));
    assert.ok(!blob.includes("private_key"));
    assert.ok(res.secrets.every((s: { updatedAt?: string }) => typeof s.updatedAt === "string"));
  });

  it("degrades gracefully when no secret store is wired", async () => {
    const tools = buildTools(makeDeps(undefined)) as any;
    const res = await tools.list_secrets.execute({});
    assert.ok(res.error && /not available/.test(res.error));
  });
});

// ── graph_get tool ───────────────────────────────────────────────────────────

describe("AI graph_get tool", () => {
  const calls: Array<{ cfg: any; services: unknown }> = [];
  const graphGet = defineStep({
    type: "graph/graph-get",
    input: z.object({ ref_id: z.string().optional(), node_type: z.string().optional(), name: z.string().optional(), children: z.string().optional() }),
    output: z.any(),
    async run(cfg, ctx) {
      calls.push({ cfg, services: ctx?.services });
      if (cfg.name === "boom") throw new Error("bolt down");
      return cfg.name === "nope" ? `node not found: ${cfg.node_type} "nope"` : { ref_id: "r1", name: cfg.name, children: [{ ref_id: "r2", name: "Janitor" }] };
    },
  });
  const services = { secrets: { get: async () => undefined } };
  function makeDeps(opts: { graph?: boolean; step?: boolean } = {}) {
    const registry = (opts.step === false ? {} : { "graph/graph-get": graphGet }) as any;
    return {
      workspace: {} as any,
      registry,
      store: new MemoryRunStore(),
      getRegistry: async () => registry,
      services,
      ...(opts.graph === false ? {} : { graph: { cfg: { namespace: "default" } } as any }),
    };
  }

  it("is offered only with a graph backend and the step in the registry", () => {
    assert.ok("graph_get" in buildTools(makeDeps()));
    assert.ok(!("graph_get" in buildTools(makeDeps({ graph: false }))));
    assert.ok(!("graph_get" in buildTools(makeDeps({ step: false }))));
  });

  it("is the step: its input schema, its run() with the chat's services, its output", async () => {
    const tools = buildTools(makeDeps()) as any;
    assert.equal(tools.graph_get.inputSchema, graphGet.input);
    calls.length = 0;
    const page = await tools.graph_get.execute({ node_type: "Concept", name: "Workflow Builder", children: "PARENT_OF" });
    assert.deepEqual(page, { ref_id: "r1", name: "Workflow Builder", children: [{ ref_id: "r2", name: "Janitor" }] });
    assert.deepEqual(calls, [{ cfg: { node_type: "Concept", name: "Workflow Builder", children: "PARENT_OF" }, services }]);
  });

  it("a miss is the step's message; a bad argument or a throw is an error, never a rejection", async () => {
    const tools = buildTools(makeDeps()) as any;
    assert.equal(await tools.graph_get.execute({ node_type: "Concept", name: "nope" }), 'node not found: Concept "nope"');
    assert.match((await tools.graph_get.execute({ ref_id: 7 })).error, /^invalid input: /);
    assert.deepEqual(await tools.graph_get.execute({ node_type: "Concept", name: "boom" }), { error: "bolt down" });
  });
});

describe("run_workflow dispatch mode (auto-detach)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `strut-ai-detach-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function setup(sleepMs: number) {
    const sleeper = defineStep({
      type: "sleeper",
      description: "sleeps then returns",
      input: z.object({ ms: z.number().default(0) }),
      output: z.any(),
      async run(cfg) {
        await new Promise((r) => setTimeout(r, cfg.ms));
        return { slept: cfg.ms };
      },
    });
    const registry = await createRegistry([sleeper]);
    const workspace = new WorkspaceManager(tempDir);
    await workspace.createWorkflow("nap", {
      steps: [{ id: "s", type: "sleeper", config: { ms: sleepMs } }],
    });
    return { workspace, registry };
  }

  it("fast runs return synchronously, exactly as without the detach seam", async () => {
    const { workspace, registry } = await setup(0);
    const detached: unknown[] = [];
    const tools = buildTools({
      workspace,
      registry,
      store: new MemoryRunStore(),
      getRegistry: async () => registry,
      detach: { waitMs: 2000, onDetach: (info: unknown) => detached.push(info) },
    } as any) as any;

    const res = await lastYield(tools.run_workflow.execute({ name: "nap", input: {} }));
    assert.equal(res.status, "success");
    assert.equal(typeof res.runId, "string");
    assert.deepEqual(res.output, { slept: 0 });
    assert.equal(detached.length, 0, "fast run must not detach");
  });

  it("announces the run at launch — a preliminary yield, before the run finishes", async () => {
    const { workspace, registry } = await setup(300);
    const store = new MemoryRunStore();
    const tools = buildTools({ workspace, registry, store, getRegistry: async () => registry } as any) as any;

    const it = tools.run_workflow.execute({ name: "nap", input: {} })[Symbol.asyncIterator]();
    const first = (await it.next()).value;
    assert.deepEqual(first, { status: "running", workflow: "nap", runId: first.runId });
    assert.equal(await store.getRunSummary("nap", first.runId), null, "not finished yet");

    const rest = await yields({ [Symbol.asyncIterator]: () => it });
    assert.equal(rest.length, 1);
    assert.equal(rest[0].status, "success");
    assert.equal(rest[0].runId, first.runId);
  });

  it("a run outliving the wait window returns a detached stub and hands the promise to onDetach", async () => {
    const { workspace, registry } = await setup(300);
    const detached: any[] = [];
    const tools = buildTools({
      workspace,
      registry,
      store: new MemoryRunStore(),
      getRegistry: async () => registry,
      detach: { waitMs: 40, onDetach: (info: any) => detached.push(info) },
    } as any) as any;

    const stub = await lastYield(tools.run_workflow.execute({ name: "nap", input: {} }));
    assert.equal(stub.status, "running");
    assert.equal(stub.detached, true);
    assert.equal(stub.workflow, "nap");
    assert.equal(typeof stub.runId, "string");
    assert.ok(/run-notification/.test(stub.note), "stub teaches the wake contract");

    assert.equal(detached.length, 1);
    assert.equal(detached[0].workflow, "nap");
    assert.equal(detached[0].runId, stub.runId);
    assert.equal(typeof detached[0].startedAt, "number");

    // The handed-off promise settles with the real result, same runId.
    const result = await detached[0].promise;
    assert.equal(result.status, "success");
    assert.equal(result.runId, stub.runId);
    assert.deepEqual(result.output, { slept: 300 });
  });

  it("without the detach seam, even slow runs are awaited to completion", async () => {
    const { workspace, registry } = await setup(150);
    const tools = buildTools({
      workspace,
      registry,
      store: new MemoryRunStore(),
      getRegistry: async () => registry,
    } as any) as any;

    const res = await lastYield(tools.run_workflow.execute({ name: "nap", input: {} }));
    assert.equal(res.status, "success");
    assert.deepEqual(res.output, { slept: 150 });
  });
});

describe("run control tools", () => {
  function baseDeps() {
    return {
      workspace: new WorkspaceManager("/nonexistent-run-control-test"),
      registry: {} as any,
      store: new MemoryRunStore(),
      getRegistry: async () => ({} as any),
    };
  }

  it("are absent unless the host wires controlRun", () => {
    const tools = buildTools(baseDeps());
    for (const t of ["cancel_run", "pause_run", "resume_run"]) assert.ok(!(t in tools), t);
  });

  it("relay (workflow, runId, action) to controlRun and return its result verbatim", async () => {
    const calls: unknown[] = [];
    const controlRun = async (workflow: string, runId: string, action: "cancel" | "pause" | "resume") => {
      calls.push([workflow, runId, action]);
      return action === "resume"
        ? ({ ok: false, error: "Run already terminal (success)" } as const)
        : ({ ok: true, runId, state: action === "cancel" ? "cancelling" : "pausing" } as const);
    };
    const tools = buildTools({ ...baseDeps(), controlRun }) as any;
    assert.deepEqual(await tools.cancel_run.execute({ name: "wf", runId: "r1" }), { ok: true, runId: "r1", state: "cancelling" });
    assert.deepEqual(await tools.pause_run.execute({ name: "wf", runId: "r2" }), { ok: true, runId: "r2", state: "pausing" });
    assert.deepEqual(await tools.resume_run.execute({ name: "wf", runId: "r3" }), { ok: false, error: "Run already terminal (success)" });
    assert.deepEqual(calls, [["wf", "r1", "cancel"], ["wf", "r2", "pause"], ["wf", "r3", "resume"]]);
  });
});

// ── peers: list_peers + `peer` on list_workflows / get_workflow / run_workflow ──

describe("AI peer tools", () => {
  const enc = new TextEncoder();
  const sse = (frames: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of frames) c.enqueue(enc.encode(f));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** A fake peer: one workflow, `echo`, whose run ends at once. */
  function fakePeers() {
    const seen: Array<{ path: string; method: string; actor?: string; body?: unknown }> = [];
    const peers = {
      list: async () => [{ id: "cloud", baseUrl: "http://cloud.test", label: "Cloud" }],
      fetch: async (id: string, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        if (id !== "cloud") throw new Error(`peer_unknown: no peer "${id}"`);
        seen.push({ path, method: init?.method ?? "GET", actor: init?.headers?.["x-strut-actor"], body: init?.body ? JSON.parse(init.body) : undefined });
        const u = new URL(`http://cloud.test${path}`);
        if (u.pathname === "/workflows") return json([{ name: "echo", activeVersion: "v1", versions: ["v1"], description: "echoes" }]);
        if (u.pathname === "/workflows/echo") return json({ active: "v1", versions: { v1: { description: "echoes" } } });
        if (u.pathname === "/workflows/echo/v1") return new Response("steps: []\n", { headers: { "content-type": "text/yaml" } });
        if (u.pathname === "/workflows/echo/run") return json({ runId: "r-cloud" }, 202);
        if (u.pathname === "/workflows/echo/runs/r-cloud/stream") {
          return sse([
            `data: ${JSON.stringify({ ts: "t", runId: "r-cloud", path: "echo", type: "run.start" })}\n\n`,
            `event: done\ndata: ${JSON.stringify({ runId: "r-cloud", status: "success", output: "hi" })}\n\n`,
          ]);
        }
        return json({ error: "nope" }, 404);
      },
    };
    return { peers, seen };
  }

  function makeDeps(peers?: ReturnType<typeof fakePeers>["peers"]) {
    const registry = {} as any;
    return { workspace: {} as any, registry, store: new MemoryRunStore(), getRegistry: async () => registry, actor: "alice-1", ...(peers ? { peers } : {}) };
  }

  it("list_peers names them, never a token; without the capability it says so", async () => {
    const { peers } = fakePeers();
    const tools = buildTools(makeDeps(peers)) as any;
    assert.deepEqual(await tools.list_peers.execute({}), { peers: [{ id: "cloud", baseUrl: "http://cloud.test", label: "Cloud" }] });
    const bare = buildTools(makeDeps()) as any;
    assert.match((await bare.list_peers.execute({})).error, /No peers are configured/);
    assert.match((await bare.list_workflows.execute({ peer: "cloud", limit: 10 })).error, /No peers/);
  });

  it("list_workflows / get_workflow with `peer` read the peer", async () => {
    const { peers, seen } = fakePeers();
    const tools = buildTools(makeDeps(peers)) as any;
    const list = await tools.list_workflows.execute({ query: "echo", limit: 10, peer: "cloud" });
    assert.deepEqual(list, { peer: "cloud", workflows: [{ name: "echo", activeVersion: "v1", description: "echoes" }], total: 1 });
    const wf = await tools.get_workflow.execute({ name: "echo", peer: "cloud" });
    assert.equal(wf.peer, "cloud");
    assert.equal(wf.yaml, "steps: []\n");
    assert.deepEqual(wf.versions, ["v1"]);
    assert.deepEqual(seen.map((s) => s.path), ["/workflows?q=echo", "/workflows/echo", "/workflows/echo/v1"]);
  });

  it("run_workflow with `peer` launches there as the chat's actor and waits for the result", async () => {
    const { peers, seen } = fakePeers();
    const tools = buildTools(makeDeps(peers)) as any;
    const res = await lastYield(tools.run_workflow.execute({ name: "echo", input: { q: "x" }, peer: "cloud" }, {}));
    assert.equal(res.peer, "cloud");
    assert.equal(res.runId, "r-cloud");
    assert.equal(res.status, "success");
    assert.equal(res.output, "hi");
    const launch = seen.find((s) => s.path === "/workflows/echo/run");
    assert.equal(launch?.method, "POST");
    assert.equal(launch?.actor, "alice-1");
    assert.deepEqual(launch?.body, { input: { q: "x" } });

    const bad = await lastYield(tools.run_workflow.execute({ name: "echo", input: {}, peer: "nope" }, {}));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /peer_unknown/);
  });
});
