/**
 * Package-first lookup (plans/packages-ux.md §2, src/package-lookup.ts):
 * inside a package a bare name is the package's own item first. The pure
 * rule, an agent's grants, the closure walk, and a package written with
 * bare references installed and run on a strut that has a local workflow
 * of the same bare name.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { flowClosure, stepHashesFor } from "./closure.js";
import type { Flow, StepRegistry } from "./core.js";
import { createStrut, type Strut } from "./createStrut.js";
import { nameInPackage, nameInsidePackage, packagePrefixOf, stepInPackage } from "./package-lookup.js";
import type { SubflowResolver } from "./runner.js";
import { buildRegistryTools, expandAgentTools, holdSubAgent } from "./steps/core/agent.js";
import { runSingleStep } from "./run-step.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import type { InstallResult } from "./packages/install.js";

describe("the rule", () => {
  it("a name's package is its prefix; a bare name is the package's own first", () => {
    assert.equal(packagePrefixOf("acme/tools/summarize"), "acme/tools");
    assert.equal(packagePrefixOf("acme/tools/media/clip"), "acme/tools");
    assert.equal(packagePrefixOf("clip/shout"), undefined);
    const has = (n: string) => n === "acme/tools/tidy" || n === "acme/tools/clip/shout";
    assert.equal(nameInPackage("acme/tools", "tidy", has), "acme/tools/tidy");
    assert.equal(nameInPackage("acme/tools", "other", has), "other", "not the package's: as written");
    assert.equal(nameInPackage("acme/tools", "acme/tools/tidy", has), "acme/tools/tidy", "a full name as it is");
    assert.equal(nameInPackage(undefined, "tidy", has), "tidy", "outside a package: as written");
    assert.equal(stepInPackage("acme/tools", "clip/shout@v2", has), "acme/tools/clip/shout@v2", "a pin kept");
    assert.equal(stepInPackage("acme/tools", "log", has), "log");
    assert.equal(nameInsidePackage("acme/tools", "acme/tools/clip/shout"), "clip/shout");
    assert.equal(nameInsidePackage("acme/tools", "graph/find"), "graph/find");
  });
});

describe("an agent's grants in a package", () => {
  const def = (type: string) => ({ type, description: type, input: z.object({}).passthrough(), output: z.any(), run: async () => type });
  const registry = Object.fromEntries(
    ["log", "graph/find", "graph/get", "acme/tools/graph/find", "acme/tools/clip/shout", "clip/shout"].map((t) => [t, def(t)]),
  ) as unknown as StepRegistry;

  it("a name is the package's own step first; a glob matches the package's and the strut's, the package's copy winning", () => {
    assert.deepEqual(expandAgentTools(["clip/shout", "log"], registry, "acme/tools"), ["acme/tools/clip/shout", "log"]);
    assert.deepEqual(expandAgentTools(["graph/*"], registry, "acme/tools"), ["acme/tools/graph/find", "graph/get"]);
    assert.deepEqual(expandAgentTools(["graph/*", "clip/shout"], registry), ["graph/find", "graph/get", "clip/shout"], "outside a package, as before");
  });

  it("shows the model a package's step by its name inside the package, and holds a sub-agent to the same grants", () => {
    const tools = buildRegistryTools(["clip/shout", "graph/*"], registry, { package: "acme/tools" } as never, (d: unknown) => d);
    assert.deepEqual(Object.keys(tools).sort(), ["clip_shout", "graph_find", "graph_get"]);
    assert.deepEqual(holdSubAgent({ agentTools: ["clip/shout"] }, ["clip/shout"], undefined, registry, "acme/tools"), { agentTools: ["clip/shout"] });
    assert.match(String(holdSubAgent({ agentTools: ["acme/tools/graph/find"] }, ["clip/shout"], undefined, registry, "acme/tools")), /may hold only the tools you hold/);
  });
});

describe("the closure walk in a package", () => {
  const flows: Record<string, Flow> = {
    "acme/tools/summarize": {
      name: "acme/tools/summarize",
      input: z.any(),
      steps: [
        { id: "a", type: "clip/shout", config: {} },
        { id: "b", type: "subflow", config: { workflow: "tidy" } },
        { id: "c", type: "agent", config: { agentTools: ["clip/shout", "graph/*"] } },
      ],
    } as Flow,
    "acme/tools/tidy": { name: "acme/tools/tidy", input: z.any(), steps: [{ id: "x", type: "clip/trim", config: {} }] } as Flow,
    tidy: { name: "tidy", input: z.any(), steps: [{ id: "y", type: "log", config: {} }] } as Flow,
  };
  const ws: SubflowResolver & { getActiveStepHashes(): Promise<Record<string, string>> } = {
    getWorkflow: async (n) => {
      if (!flows[n]) throw new Error(`Workflow "${n}" not found`);
      return flows[n]!;
    },
    getWorkflowVersion: async (n) => flows[n]!,
    getActiveStepHashes: async () => ({ "acme/tools/clip/shout": "h1", "acme/tools/clip/trim": "h2", "clip/shout": "h3" }),
  };
  const active = new Set(["acme/tools/clip/shout", "acme/tools/clip/trim", "clip/shout"]);

  it("reads the steps and workflows that run: the package's own first", async () => {
    const flow = flows["acme/tools/summarize"]!;
    const c = await flowClosure(flow, ws, undefined, { name: flow.name, stepExists: (t) => active.has(t) });
    assert.ok(c.types.has("acme/tools/clip/shout") && !c.types.has("clip/shout"));
    assert.ok(c.types.has("acme/tools/clip/trim"), "the child's steps, in the child's package");
    assert.deepEqual(c.workflows.map((w) => w.workflow), ["acme/tools/tidy"]);
    assert.ok(c.agentTools.has("acme/tools/clip/shout") && c.agentTools.has("graph/*") && c.agentTools.has("acme/tools/graph/*"));
    const plain = await flowClosure(flow, ws);
    assert.deepEqual(plain.workflows.map((w) => w.workflow), ["tidy"], "without a scope, as written");
    assert.deepEqual(await stepHashesFor(ws, flow), { "acme/tools/clip/shout": "h1", "acme/tools/clip/trim": "h2" }, "a run records the package's steps");
  });
});

// ── Installed and run ───────────────────────────────────────────────────────

/** A package written with BARE references — what the bare-name build
 *  writes (plans/packages-ux.md §3): each item's own name under the prefix,
 *  every reference as its author wrote it. */
const SHOUT = `import { z, defineStep } from "strut";
import { greeting } from "./_shared.js";
export default defineStep({
  type: "acme/tools/clip/shout",
  input: z.object({ text: z.string().optional() }),
  output: z.any(),
  async run(cfg) { return \`\${greeting} \${cfg.text ?? ""}\`.trim(); },
});
`;
const PACKAGE: Record<string, string> = {
  "strut.yaml": "package: acme/tools\nversion: 1.0.0\n",
  "steps/clip/_shared.ts": 'export const greeting = "HELLO";\n',
  "steps/clip/shout.ts": SHOUT,
  "workflows/summarize.yaml": `name: acme/tools/summarize
steps:
  - id: shout
    type: clip/shout
    config: { text: "{{ input.text }}" }
  - id: tidy
    type: subflow
    config: { workflow: tidy }
  - id: out
    type: pack
    config: { shout: "{{ shout }}", tidy: "{{ tidy }}" }
`,
  "workflows/tidy.yaml": `name: acme/tools/tidy
steps:
  - id: say
    type: log
    config: { message: the package's tidy }
`,
  "workflows/launcher.yaml": `name: acme/tools/launcher
steps:
  - id: go
    type: run/launch
    config: { workflow: tidy }
  - id: got
    type: run/get
    config: { workflow: tidy, runId: "{{ go.runId }}", wait: 10000 }
`,
};

let root: string;
let savedKey: string | undefined;
before(() => {
  savedKey = process.env["STRUT_API_KEY"];
  delete process.env["STRUT_API_KEY"];
});
after(() => {
  if (savedKey !== undefined) process.env["STRUT_API_KEY"] = savedKey;
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-lookup-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeTree(files: Record<string, string>, name: string): Promise<string> {
  const dir = join(root, "src", name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const boot = (dir: string) =>
  createStrut({
    workspace: new WorkspaceManager(dir),
    store: new MemoryRunStore(),
    serveUi: false,
    scheduler: false,
    enableChat: false,
    systemWorkflows: false,
    browserWorkflows: false,
    privacyWorkflows: false,
    job: false,
    orchestrator: false,
    builder: false,
    views: false,
    concepts: false,
    stt: false,
  });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function install(strut: Strut, ref: string) {
  const res = await strut.app.request("/packages/install", json({ ref }));
  return { status: res.status, body: (await res.json()) as InstallResult & { error?: string } };
}

describe("a package with bare references, installed", () => {
  let buyer: Strut;
  beforeEach(async () => {
    buyer = await boot(join(root, "buyer"));
    // The buyer's own `tidy`: outside the package it is the one, inside it is not.
    await buyer.workspace.publishWorkflow("tidy", "v1", "name: tidy\nsteps:\n  - id: say\n    type: log\n    config: { message: the buyer's tidy }\n");
    await buyer.rebuildRegistry();
  });
  afterEach(async () => {
    await buyer.close?.();
  });

  it("installs, and runs its own step and subflow by their bare names over the strut's own", async () => {
    const r = await install(buyer, `file:${await writeTree(PACKAGE, "tools")}`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const run = await buyer.run("acme/tools/summarize", { text: "there" });
    assert.equal(run.status, "success", run.error?.message);
    assert.deepEqual(run.output, { shout: "HELLO there", tidy: "the package's tidy" });

    const events = await buyer.store.getRunEvents("acme/tools/summarize", run.runId);
    const start = (path: string) => events.find((e) => e.type === "step.start" && e.path === path);
    assert.equal(start("acme/tools/summarize/shout")?.stepType, "acme/tools/clip/shout", "the step that ran, on the event");
    assert.equal(start("acme/tools/summarize/tidy")?.subflow?.workflow, "acme/tools/tidy", "the child that ran, on the event");
    const begun = events.find((e) => e.type === "run.start") as { stepHashes?: Record<string, string> } | undefined;
    assert.ok(begun?.stepHashes?.["acme/tools/clip/shout"], "the run records its package's step version");

    // Outside the package, a bare name is the strut's own.
    assert.equal((await buyer.run("tidy", {})).output, "the buyer's tidy");
  });

  it("launches and reads a run of its own workflow by its bare name", async () => {
    assert.equal((await install(buyer, `file:${await writeTree(PACKAGE, "tools")}`)).status, 201);
    const run = await buyer.run("acme/tools/launcher", {});
    assert.equal(run.status, "success", run.error?.message);
    const got = run.output as { workflow?: string; status?: string; output?: unknown };
    assert.equal(got.workflow, "acme/tools/tidy");
    assert.equal(got.status, "success");
    assert.equal(got.output, "the package's tidy");
  });

  it("a page of an app in the package calls the package's step by its bare name", async () => {
    assert.equal((await install(buyer, `file:${await writeTree(PACKAGE, "tools")}`)).status, 201);
    const r = await runSingleStep("clip/shout", buyer.getRegistry(), buyer.services, {
      app: { name: "acme/tools/board", version: "v1" },
      workspace: buyer.workspace,
      config: { text: "page" },
    });
    assert.equal(r.status, "success", r.error?.message);
    assert.equal(r.output, "HELLO page");
    assert.equal(r.events.find((e) => e.type === "step.start")?.stepType, "acme/tools/clip/shout");
    const outside = await runSingleStep("clip/shout", buyer.getRegistry(), buyer.services, { workspace: buyer.workspace });
    assert.equal(outside.status, "error", "outside the package there is no clip/shout here");
  });

  it("refuses a bare reference that is neither the package's nor the strut's", async () => {
    const broken = { ...PACKAGE, "workflows/summarize.yaml": PACKAGE["workflows/summarize.yaml"]!.replace("type: clip/shout", "type: clip/whisper") };
    const r = await install(buyer, `file:${await writeTree(broken, "broken")}`);
    assert.notEqual(r.status, 201);
    assert.match(r.body.error ?? "", /names the step clip\/whisper, which is neither on this strut nor in the packages/);
  });
});
