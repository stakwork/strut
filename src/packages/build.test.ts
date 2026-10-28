/**
 * Building a package (plans/marketplace.md §2) — src/packages/build.ts — and
 * the round trip the plan's "Validation" asks for: build on one strut,
 * install on a fresh one, run it, and the fence holds. First on the
 * filesystem workspace (the closure, the pins, the refusals, `requires`),
 * then the Concepts and a step's claims on every graph backend, installed on
 * a cleared graph and on a filesystem workspace. Apps last: carried with
 * their grants and imports, built against the buyer's kit, held to the
 * prefix — on the filesystem, then on every graph backend.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KitLocation } from "../apps/kit.js";
import { readBuildInfo } from "../apps/build.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
import { seedJarvisOntology } from "../graph/ontology-seed.js";
import { seedStrutDomain } from "../graph/schema-seed.js";
import { testBackends } from "../graph/test-util.js";
import { GraphWorkspaceStore } from "../graph/workspace-store.js";
import { MemoryRunStore } from "../store.js";
import { kitForTests } from "../test-util/app-kit.js";
import { hashTree } from "../version.js";
import { WorkspaceManager, type WorkspaceStore } from "../workspace.js";
import { loadYaml } from "../yaml.js";
import { buildPackage, type BuildDeps, type BuildRequest, type BuildResult } from "./build.js";
import { packageCache } from "./cache.js";
import { readPackage } from "./format.js";
import type { InstallResult } from "./install.js";

/** Reads LINEAR_API_KEY by name, or the secret its config names; its
 *  greeting comes from its namespace's helper. */
const STEP = (type: string) => `import { z, defineStep } from "strut";
import { greeting } from "./_shared.js";
export default defineStep({
  type: ${JSON.stringify(type)},
  input: z.object({ secret: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    const key = cfg.secret ? await ctx.services.secrets.get(cfg.secret) : await ctx.services.secrets.get("LINEAR_API_KEY");
    return { greeting, key: key ?? null };
  },
});
`;
const HELPER = 'export const greeting = "hello";\n';
const PLAIN = (type: string, out = "ok") =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}).passthrough(), output: z.any(), async run() { return ${JSON.stringify(out)}; } });\n`;

const SYNC = `name: acme/linear/sync
description: Sync the issues
steps:
  - id: check
    type: exec
    config: { cmd: sh, args: ["-c", "true"], secretsEnv: [NOTION_KEY] }
  - id: create
    type: acme/linear/create-issue
    config: { secret: "{{ input.secret }}" }
`;
/** A workflow named bare, over a bare custom step and a bare subflow. */
const SUMMARIZE = `name: summarize
description: Summarize, then tidy
steps:
  - id: shout
    type: clip/shout
  - id: tidy
    type: subflow
    config: { workflow: tidy }
`;
const flow = (name: string, ...steps: string[]) => `name: ${name}\nsteps:\n${steps.map((s, i) => `  - { id: s${i}, ${s} }\n`).join("")}`;

const boot = (workspace: WorkspaceStore, extra: Record<string, unknown> = {}) =>
  createStrut({
    workspace,
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
    ...extra,
  });

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const depsOf = (strut: Strut): BuildDeps => ({
  workspace: strut.workspace,
  cache: packageCache(strut.dataDir),
  apps: strut.apps,
  ...(strut.workspace.graph ? { graph: strut.workspace.graph } : {}),
  claims: strut.claims ? { reader: strut.claims } : null,
  getRegistry: async () => {
    await strut.rebuildRegistry();
    return strut.getRegistry();
  },
});
const build = (strut: Strut, req: Partial<BuildRequest>): Promise<BuildResult> => buildPackage(depsOf(strut), { package: "acme/linear", version: "1.4.0", ...req });
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail("the build was not refused");
};

async function install(strut: Strut, ref: string) {
  const res = await strut.app.request("/packages/install", json({ ref }));
  return { status: res.status, body: (await res.json()) as InstallResult & { error?: string } };
}
const putSecret = (strut: Strut, name: string, value: string) => strut.app.request(`/secrets/${name}`, json({ value }, "PUT"));

/** The source strut's package: a workflow over a custom step that imports its helper. */
async function publishLinear(ws: WorkspaceStore): Promise<void> {
  await ws.publishStep("acme/linear/_shared", HELPER);
  await ws.publishStep("acme/linear/create-issue", STEP("acme/linear/create-issue"));
  await ws.publishWorkflow("acme/linear/sync", "v1", SYNC);
}

/** Install `dir` on `buyer`, run it, and hold it to its fence. */
async function roundTrip(buyer: Strut, dir: string): Promise<InstallResult> {
  await putSecret(buyer, "LINEAR_API_KEY", "lin_123");
  await putSecret(buyer, "NOTION_KEY", "notion_1");
  await putSecret(buyer, "GITHUB_TOKEN", "ghp_456");
  const r = await install(buyer, `file:${dir}`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const run = await buyer.run("acme/linear/sync", {});
  assert.equal(run.status, "success", run.error?.message);
  assert.deepEqual(run.output, { greeting: "hello", key: "lin_123" });
  const fenced = await buyer.run("acme/linear/sync", { secret: "GITHUB_TOKEN" });
  assert.equal(fenced.status, "error");
  assert.match(fenced.error!.message, /secret_fenced: acme\/linear\/create-issue came from the package acme\/linear, which declares only LINEAR_API_KEY, NOTION_KEY — it may not read GITHUB_TOKEN/);
  return r.body;
}

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
  root = await mkdtemp(join(tmpdir(), "strut-build-"));
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

describe("building a package on a filesystem workspace", () => {
  let src: Strut;
  let ws: WorkspaceManager;
  const struts: Strut[] = [];
  const fresh = async (name: string) => {
    const s = await boot(new WorkspaceManager(join(root, name)));
    struts.push(s);
    return s;
  };
  beforeEach(async () => {
    ws = new WorkspaceManager(join(root, "source"));
    src = await boot(ws);
    struts.push(src);
    await publishLinear(ws);
  });
  afterEach(async () => {
    for (const s of struts.splice(0)) await s.close?.();
  });

  it("writes what the workflow can execute, with the manifest it needs, into the cache — and it installs, runs and is fenced", async () => {
    const built = await build(src, { description: "Linear issues", license: "Apache-2.0", workflows: ["acme/linear/sync"] });
    assert.deepEqual(built.files, ["steps/_shared.ts", "steps/create-issue.ts", "strut.yaml", "workflows/sync.yaml"]);
    assert.deepEqual(built.warnings, []);
    assert.deepEqual(loadYaml(await readFile(join(built.dir, "strut.yaml"), "utf-8")), {
      package: "acme/linear",
      version: "1.4.0",
      description: "Linear issues",
      license: "Apache-2.0",
      requires: { secrets: ["LINEAR_API_KEY", "NOTION_KEY"], binaries: ["sh"] },
    });
    assert.equal(await readFile(join(built.dir, "workflows/sync.yaml"), "utf-8"), SYNC, "the YAML as published");
    assert.equal(await readFile(join(built.dir, "steps/_shared.ts"), "utf-8"), HELPER);
    assert.equal((await readPackage(built.dir)).digest, built.digest);
    assert.equal(built.dir, packageCache(src.dataDir).dirOf(built.digest));
    assert.equal((await build(src, { description: "Linear issues", license: "Apache-2.0", workflows: ["acme/linear/sync"] })).digest, built.digest, "the same workspace, the same digest");

    const archive = await src.app.request(`/packages/acme/linear/archive?digest=${built.digest}`);
    assert.equal(archive.status, 200, "the archive route serves what was built");

    const r = await roundTrip(await fresh("buyer"), built.dir);
    assert.deepEqual(r.packages[0]!.items.map((i) => [i.kind, i.name, i.status]), [
      ["step", "acme/linear/_shared", "installed"],
      ["step", "acme/linear/create-issue", "installed"],
      ["workflow", "acme/linear/sync", "installed"],
    ]);
  });

  it("pins a package it reaches at the digest it was installed at, and installs it first", async () => {
    const util = await writeTree({ "strut.yaml": "package: bob/util\nversion: 2.1.0\n", "steps/fmt.ts": PLAIN("bob/util/fmt", "fmt") }, "util");
    const { digest } = await readPackage(util);
    assert.equal((await install(src, `file:${util}`)).status, 201);
    await ws.publishWorkflow("acme/linear/fmt", "v1", flow("acme/linear/fmt", "type: bob/util/fmt"));
    // A seed's workflow is strut's own (or the host's): recorded nowhere, like a core step.
    await ws.publishWorkflowByContent("seeded", flow("seeded", "type: log, config: { message: hi }"), undefined, undefined, undefined, { source: "seed" });
    await ws.publishWorkflow("acme/linear/both", "v1", flow("acme/linear/both", "type: subflow, config: { workflow: acme/linear/fmt }", "type: subflow, config: { workflow: seeded }"));

    const built = await build(src, { workflows: ["acme/linear/both"] });
    assert.deepEqual(built.files, ["steps/_shared.ts", "strut.yaml", "workflows/both.yaml", "workflows/fmt.yaml"]);
    assert.deepEqual(built.manifest.requires, { packages: [{ package: "bob/util", digest, source: `file:${util}` }] });

    const buyer = await fresh("buyer");
    await buyer.workspace.publishWorkflowByContent("seeded", flow("seeded", "type: log, config: { message: hi }"), undefined, undefined, undefined, { source: "seed" });
    const r = await install(buyer, `file:${built.dir}`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.packages.map((p) => p.package), ["bob/util", "acme/linear"]);
    assert.equal((await buyer.run("acme/linear/fmt", {})).output, "fmt");
  });

  it("pins a sibling package built on this strut, through the route, by the digest its build returned", async () => {
    type Built = { package: string; version: string; digest: string; files: string[]; requires: Record<string, unknown>; warnings: string[]; error?: string };
    const post = async (body: unknown) => {
      const res = await src.app.request("/packages/build", json(body));
      return { status: res.status, body: (await res.json()) as Built };
    };
    await ws.publishStep("acme/util/fmt", PLAIN("acme/util/fmt", "fmt"));
    await ws.publishWorkflow("acme/linear/fmt", "v1", flow("acme/linear/fmt", "type: acme/util/fmt"));
    const linear = (requires?: unknown) => post({ package: "acme/linear", version: "1", workflows: ["acme/linear/fmt"], ...(requires ? { requires } : {}) });

    let r = await linear();
    assert.equal(r.status, 400);
    assert.match(r.body.error!, /^package_build_refused: acme\/linear\/fmt reaches the step acme\/util\/fmt, which is under acme\/util\/, another package of acme — build that package and require it \(requires\.packages\)/);

    const util = await post({ package: "acme/util", version: "1", steps: ["acme/util/fmt"] });
    assert.equal(util.status, 201, JSON.stringify(util.body));
    assert.deepEqual(util.body, { package: "acme/util", version: "1", digest: util.body.digest, files: ["steps/fmt.ts", "strut.yaml"], requires: {}, warnings: [] });
    r = await linear({ packages: [{ package: "acme/util", digest: util.body.digest }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.files, ["steps/_shared.ts", "strut.yaml", "workflows/fmt.yaml"]);
    const cache = packageCache(src.dataDir);
    assert.deepEqual(r.body.requires, { packages: [{ package: "acme/util", digest: util.body.digest, source: `file:${cache.dirOf(util.body.digest)}` }] });

    // The buyer installs the sibling first, from the source it is pinned at.
    const buyer = await fresh("buyer");
    const installed = await install(buyer, `file:${cache.dirOf(r.body.digest)}`);
    assert.equal(installed.status, 201, JSON.stringify(installed.body));
    assert.deepEqual(installed.body.packages.map((p) => p.package), ["acme/util", "acme/linear"]);
    assert.equal((await buyer.run("acme/linear/fmt", {})).output, "fmt");

    // The sibling changed here since its build: rebuild it, and require the new digest.
    await ws.publishStep("acme/util/fmt", PLAIN("acme/util/fmt", "fmt, edited"));
    r = await linear({ packages: [{ package: "acme/util", digest: util.body.digest }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error!, new RegExp(`reaches the step acme/util/fmt, which acme/util at ${util.body.digest} holds as it was, not as it is here — rebuild acme/util and require its new digest`));
    const other = `sha256:${"a".repeat(64)}`;
    assert.match((await linear({ packages: [{ package: "acme/util", digest: other }] })).body.error!, new RegExp(`this strut's cache holds no acme/util at ${other} — build it first`));
    assert.match((await linear({ packages: [{ package: "acme/linear", digest: other }] })).body.error!, /acme\/linear cannot require itself/);

    // The shape, before anything is read.
    assert.equal((await post({ package: "acme/linear" })).status, 400);
    assert.equal((await post({ package: "acme/linear", version: "1", workflows: "acme/linear/fmt" })).status, 400);
    assert.equal((await linear({ packages: "acme/util" })).status, 400);
    assert.equal((await post({ package: "acme/linear", version: "1", workflows: ["acme/linear/sync"], apps: ["acme/linear/issues"] })).status, 400);
  });

  it("refuses what it cannot carry, naming each — a version label, two digests, a sealed namespace", async () => {
    await ws.publishStep("local/judge", PLAIN("local/judge"));
    await ws.publishWorkflow("acme/linear/judged", "v1", flow("acme/linear/judged", "type: local/judge", "type: acme/linear/create-issue@v1"));
    let msg = await refusal(build(src, { workflows: ["acme/linear/judged"] }));
    assert.match(msg, /^package_build_refused: /);
    assert.doesNotMatch(msg, /local\/judge/, "a local step is carried, whatever its name");
    assert.match(msg, /acme\/linear\/judged pins acme\/linear\/create-issue@v1: a version label is this strut's own/);

    // One package reached at two digests.
    await install(src, `file:${await writeTree({ "strut.yaml": "package: bob/util\nversion: '2'\n", "steps/fmt.ts": PLAIN("bob/util/fmt") }, "util")}`);
    const other = `sha256:${"a".repeat(64)}`;
    await ws.publishStep("bob/util/other", PLAIN("bob/util/other"), undefined, undefined, { source: "install", upstream: { package: "bob/util", version: "1", digest: other, source: { ref: "file:/elsewhere" }, secrets: [] } });
    await ws.publishWorkflow("acme/linear/two", "v1", flow("acme/linear/two", "type: bob/util/fmt", "type: bob/util/other"));
    msg = await refusal(build(src, { workflows: ["acme/linear/two"] }));
    assert.match(msg, new RegExp(`bob/util is reached at two digests, sha256:[0-9a-f]{64} \\(bob/util/fmt\\) and ${other} \\(bob/util/other\\)`));

    // A sealed namespace is strut's.
    await ws.publishStep("eval/kit/score", PLAIN("eval/kit/score"));
    await ws.publishWorkflow("eval/kit/run", "v1", flow("eval/kit/run", "type: eval/kit/score"));
    msg = await refusal(buildPackage(depsOf(src), { package: "eval/kit", version: "1", workflows: ["eval/kit/run"] }));
    assert.match(msg, /eval\/kit\/run is in a sealed namespace/);
    assert.match(msg, /eval\/kit\/score is in a sealed namespace/);

    assert.match(await refusal(build(src, { workflows: ["acme/linear/sync"], apps: ["acme/linear/issues"] })), /the request names the app acme\/linear\/issues, which is not here/);
    assert.match(await refusal(build(src, { workflows: ["acme/linear/missing"] })), /no workflow acme\/linear\/missing here/);
    assert.match(await refusal(build(src, { steps: ["log"] })), /log is a step strut ships, not one a package carries/);
    assert.match(await refusal(build(src, {})), /name at least one workflow, step, Concept or app/);
    assert.match(await refusal(build(src, { package: "Acme", workflows: ["acme/linear/sync"] })), /publisher\/name/);
    assert.match(await refusal(build(src, { concepts: ["Linear"] })), /there are no Concepts to package: this workspace has no graph/);
  });

  it("builds a closure it cannot read whole only when the request lists what it reaches", async () => {
    await ws.publishWorkflow("acme/linear/dispatch", "v1", flow("acme/linear/dispatch", 'type: subflow, config: { workflow: "{{ input.target }}" }'));
    const msg = await refusal(build(src, { workflows: ["acme/linear/dispatch"] }));
    assert.match(msg, /the closure of acme\/linear\/dispatch cannot be read whole \(step s0 calls a workflow named by a template\) — list what it reaches in workflows \/ steps/);
    const built = await build(src, { workflows: ["acme/linear/dispatch", "acme/linear/sync"] });
    assert.deepEqual(built.files, ["steps/_shared.ts", "steps/create-issue.ts", "strut.yaml", "workflows/dispatch.yaml", "workflows/sync.yaml"]);
    assert.match(built.warnings.join("\n"), /the closure of acme\/linear\/dispatch cannot be read whole .*: the package holds what the request lists/);
  });

  it("reads requires off the closure: secret names in configs and a step def's defaults, literal commands and runtimes", async () => {
    await ws.publishWorkflow(
      "acme/linear/tools",
      "v1",
      flow(
        "acme/linear/tools",
        "type: exec, config: { cmd: ffmpeg, runtime: media }",
        'type: exec, config: { cmd: "{{ input.cmd }}" }',
        "type: exec, config: { cmd: /usr/bin/env }",
        "type: git/checkout, config: { repo: https://github.com/acme/x }",
        'type: agent, config: { prompt: hi, secretsEnv: [OPENAI_KEY], agentTools: ["acme/linear/*"] }',
      ),
    );
    const built = await build(src, { workflows: ["acme/linear/tools"] });
    assert.deepEqual(built.files, ["steps/_shared.ts", "steps/create-issue.ts", "strut.yaml", "workflows/tools.yaml"], "a glob grant over the prefix carries what it matches");
    assert.deepEqual(built.manifest.requires, {
      secrets: ["GITHUB_TOKEN", "LINEAR_API_KEY", "OPENAI_KEY"],
      binaries: ["ffmpeg"],
      runtimes: [{ name: "media" }],
    });
  });

  it("carries a step alone, with its helpers", async () => {
    const built = await build(src, { steps: ["acme/linear/create-issue"] });
    assert.deepEqual(built.files, ["steps/_shared.ts", "steps/create-issue.ts", "strut.yaml"]);
    assert.deepEqual(built.manifest.requires, { secrets: ["LINEAR_API_KEY"] });
  });
});

describe("building a package from bare names (plans/packages-ux.md §3)", () => {
  let src: Strut;
  let ws: WorkspaceManager;
  const struts: Strut[] = [];
  beforeEach(async () => {
    ws = new WorkspaceManager(join(root, "source"));
    src = await boot(ws);
    struts.push(src);
    await ws.publishStep("clip/_shared", HELPER);
    await ws.publishStep("clip/shout", STEP("clip/shout"));
    await ws.publishWorkflow("tidy", "v1", flow("tidy", "type: log, config: { message: tidy }"));
    await ws.publishWorkflow("summarize", "v1", SUMMARIZE);
  });
  afterEach(async () => {
    for (const s of struts.splice(0)) await s.close?.();
  });
  const tools = (req: Partial<BuildRequest>) => buildPackage(depsOf(src), { package: "acme/tools", version: "1.0.0", ...req });

  it("carries local items at the paths of their names, writes only their own names under the prefix, and keeps references as written", async () => {
    const built = await tools({ workflows: ["summarize"] });
    assert.deepEqual(built.files, ["steps/clip/_shared.ts", "steps/clip/shout.ts", "strut.yaml", "workflows/summarize.yaml", "workflows/tidy.yaml"]);
    assert.deepEqual(built.warnings, []);
    assert.equal(await readFile(join(built.dir, "workflows/summarize.yaml"), "utf-8"), SUMMARIZE.replace("name: summarize", "name: acme/tools/summarize"), "its own name, nothing else");
    assert.equal(await readFile(join(built.dir, "workflows/tidy.yaml"), "utf-8"), flow("acme/tools/tidy", "type: log, config: { message: tidy }"));
    const step = await readFile(join(built.dir, "steps/clip/shout.ts"), "utf-8");
    assert.equal(step, STEP("acme/tools/clip/shout"), "the defineStep type, and the helper import as it was");
    assert.equal(await readFile(join(built.dir, "steps/clip/_shared.ts"), "utf-8"), HELPER, "the helper the step imports, beside it");
    assert.equal((await readPackage(built.dir)).digest, built.digest, "a package the format reads");
    assert.equal((await tools({ workflows: ["summarize"] })).digest, built.digest, "the same picks, the same digest");

    // The workspace is as it was: nothing renamed here.
    assert.equal(await ws.getWorkflowSource("summarize", "v1"), SUMMARIZE);

    // What the release holds, by the names inside the package.
    const res = await src.app.request(`/packages/acme/tools/items?digest=${built.digest}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { package: string; version: string; items: Array<{ kind: string; name: string }> };
    assert.equal(body.version, "1.0.0");
    assert.deepEqual(body.items.map((i) => `${i.kind} ${i.name}`).sort(), ["step clip/shout", "workflow summarize", "workflow tidy"]);
    assert.equal((await src.app.request(`/packages/acme/other/items?digest=${built.digest}`)).status, 404);
    assert.equal((await src.app.request("/packages/acme/tools/items")).status, 400);
  });

  it("refuses to install until a bare reference can be found in the package (work item 4)", async () => {
    const built = await tools({ workflows: ["summarize"] });
    const buyer = await boot(new WorkspaceManager(join(root, "buyer")));
    struts.push(buyer);
    const r = await install(buyer, `file:${built.dir}`);
    assert.notEqual(r.status, 201);
    assert.match(r.body.error ?? "", /names the step clip\/shout, which is neither on this strut nor in the packages/);
    assert.deepEqual(await buyer.workspace.listWorkflows(), [], "nothing written");
  });

  it("leaves the host's items out and refuses what it cannot carry", async () => {
    // A step a service published is the host's: the installing strut has its own.
    await ws.publishStep("lab/ping", PLAIN("lab/ping"), undefined, "lab");
    await ws.publishWorkflow("pinged", "v1", flow("pinged", "type: lab/ping", "type: clip/shout"));
    const built = await tools({ workflows: ["pinged"] });
    assert.deepEqual(built.files, ["steps/clip/_shared.ts", "steps/clip/shout.ts", "strut.yaml", "workflows/pinged.yaml"]);

    // A local name and the same name under the prefix are one path.
    await ws.publishWorkflow("acme/tools/tidy", "v1", flow("acme/tools/tidy", "type: log, config: { message: other }"));
    await ws.publishWorkflow("both", "v1", flow("both", "type: subflow, config: { workflow: tidy }", "type: subflow, config: { workflow: acme/tools/tidy }"));
    assert.match(await refusal(tools({ workflows: ["both"] })), /the workflows (acme\/tools\/tidy and tidy|tidy and acme\/tools\/tidy) would both be acme\/tools\/tidy/);

    // A step whose type is no literal cannot be written under the prefix.
    await ws.publishStep("dyn/x", `import { z, defineStep } from "strut";\nconst T = "dyn/x";\nexport default defineStep({ type: T, input: z.object({}).passthrough(), output: z.any(), async run() { return 1; } });\n`);
    await ws.publishWorkflow("dynamic", "v1", flow("dynamic", "type: dyn/x"));
    assert.match(await refusal(tools({ workflows: ["dynamic"] })), /the step dyn\/x names its type with no literal type: "dyn\/x" — the build writes acme\/tools\/dyn\/x there/);

    // A step that imports a file the package does not carry.
    await ws.publishStep("lab/_util", HELPER, undefined, "lab");
    await ws.publishStep("odd/one", `import { greeting } from "../lab/_util.js";\n${PLAIN("odd/one")}`);
    await ws.publishWorkflow("oddly", "v1", flow("oddly", "type: odd/one"));
    assert.match(await refusal(tools({ workflows: ["oddly"] })), /the step odd\/one imports lab\/_util, which is not this package's to carry/);

    assert.match(await refusal(tools({ workflows: ["missing"] })), /no workflow missing here/);
  });
});

/** An app on the source strut: its files, published as a person would. */
async function publishApp(strut: Strut, name: string, files: Record<string, string | Buffer>): Promise<string> {
  const dir = join(strut.dataDir, "drafts", ...name.split("/"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  const r = await strut.apps.publish(dir, name, { surface: "person" });
  assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  return r.hash;
}
/** Not UTF-8: an app's files are bytes. */
const DOT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
const UI = { "app.yaml": "title: Linear UI\n", "src/index.ts": 'export const LABEL = "linear-label";\n', "src/App.tsx": "export default () => null;\n", "public/dot.png": DOT };
const ISSUES = (body = "{LABEL}") => ({
  "app.yaml": "title: Issues\ngrants:\n  workflows: [acme/linear/sync]\n  automations: [acme/linear/report]\n  steps: [acme/linear/create-issue, run/*]\n",
  "src/App.tsx": `import { LABEL } from "acme/linear/ui";\nexport default function App() { return <p>${body}</p>; }\n`,
});
const REPORT = flow("acme/linear/report", "type: log, config: { message: weekly }");

describe("building and installing a package with apps (filesystem)", () => {
  let kit: KitLocation;
  let src: Strut;
  const struts: Strut[] = [];
  const fresh = async (name: string) => {
    const s = await boot(new WorkspaceManager(join(root, name)), { kit });
    struts.push(s);
    return s;
  };
  before(async () => {
    kit = await kitForTests();
  });
  beforeEach(async () => {
    src = await fresh("source");
    await publishLinear(src.workspace);
    await src.workspace.publishWorkflow("acme/linear/report", "v1", REPORT);
    await src.rebuildRegistry();
  });
  afterEach(async () => {
    for (const s of struts.splice(0)) await s.close?.();
  });

  it("carries an app with what its grants execute and the apps it imports; its item hash is its version hash; it installs, builds and lists as installed", async () => {
    const uiHash = await publishApp(src, "acme/linear/ui", UI);
    const issuesHash = await publishApp(src, "acme/linear/issues", ISSUES());
    const built = await build(src, { apps: ["acme/linear/issues"] });
    assert.deepEqual(built.files, [
      "apps/issues/app.yaml",
      "apps/issues/src/App.tsx",
      "apps/ui/app.yaml",
      "apps/ui/public/dot.png",
      "apps/ui/src/App.tsx",
      "apps/ui/src/index.ts",
      "steps/_shared.ts",
      "steps/create-issue.ts",
      "strut.yaml",
      "workflows/report.yaml",
      "workflows/sync.yaml",
    ]);
    assert.deepEqual(built.manifest.requires, { secrets: ["LINEAR_API_KEY", "NOTION_KEY"], binaries: ["sh"] });
    assert.deepEqual(built.warnings, []);
    assert.deepEqual(await readFile(join(built.dir, "apps/ui/public/dot.png")), DOT, "bytes, not text");
    const appFiles = (app: string) => built.files.filter((f) => f.startsWith(`apps/${app}/`)).map((f) => f.slice(`apps/${app}/`.length));
    assert.equal(await hashTree(join(built.dir, "apps/issues"), appFiles("issues")), issuesHash, "the item hash is the version hash");
    assert.equal(await hashTree(join(built.dir, "apps/ui"), appFiles("ui")), uiHash);
    assert.deepEqual((await readPackage(built.dir)).items.filter((i) => i.kind === "app").map((i) => i.name), ["acme/linear/issues", "acme/linear/ui"]);

    const buyer = await fresh("buyer");
    const r = await roundTrip(buyer, built.dir);
    assert.deepEqual(r.packages[0]!.items.map((i) => [i.kind, i.name, i.status, i.version]), [
      ["step", "acme/linear/_shared", "installed", "v1"],
      ["step", "acme/linear/create-issue", "installed", "v1"],
      ["workflow", "acme/linear/report", "installed", "v1"],
      ["workflow", "acme/linear/sync", "installed", "v1"],
      ["app", "acme/linear/issues", "installed", "v1"],
      ["app", "acme/linear/ui", "installed", "v1"],
    ]);
    const issues = (await buyer.apps.get("acme/linear/issues"))!;
    assert.deepEqual([issues.hash, issues.stale, issues.versions["v1"]?.source, issues.upstream?.package, issues.upstream?.digest], [issuesHash, false, "install", "acme/linear", built.digest]);
    // Built here, against the buyer's kit, importing the buyer's copy of the kit app.
    assert.deepEqual((await readBuildInfo(issues.dir))!.imports, [{ name: "acme/linear/ui", version: "v1", hash: uiHash }]);
    assert.ok((await readFile(join(issues.dir, "dist", "index.html"), "utf-8")).includes("linear-label"));

    const listed = (await (await buyer.app.request("/packages")).json()) as { packages: Array<{ package: string; items: Array<{ kind: string; name: string; installed?: string; modified?: boolean }> }> };
    assert.deepEqual(listed.packages[0]!.items.filter((i) => i.kind === "app"), [
      { kind: "app", name: "acme/linear/issues", installed: "v1", active: "v1", modified: false },
      { kind: "app", name: "acme/linear/ui", installed: "v1", active: "v1", modified: false },
    ]);

    // The prefix is the package's: a new app there is refused; an edit is a fork.
    const draft = join(buyer.dataDir, "drafts", "mine");
    await buyer.apps.checkout("acme/linear/issues", draft);
    await assert.rejects(buyer.apps.publish(draft, "acme/linear/mine", { surface: "person" }), /package_conflict: acme\/linear\/mine is under acme\/linear, an installed package/);
    await writeFile(join(draft, "src", "App.tsx"), 'import { LABEL } from "acme/linear/ui";\nexport default function App() { return <p>{LABEL} forked</p>; }\n');
    const forked = await buyer.apps.publish(draft, "acme/linear/issues", { surface: "person" });
    assert.ok(forked.ok && forked.version === "v2");

    // The same digest again: what is here stays as it is.
    const again = await install(buyer, `file:${built.dir}`);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.packages[0]!.status, "present");
    assert.deepEqual(again.body.packages[0]!.items.filter((i) => i.kind === "app").map((i) => [i.name, i.status]), [["acme/linear/issues", "modified"], ["acme/linear/ui", "present"]]);

    // Uninstall: the fork stays, the rest goes.
    const gone = await buyer.app.request("/packages/acme/linear", { method: "DELETE" });
    const body = (await gone.json()) as { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string }> };
    assert.deepEqual(body.kept.map((i) => [i.kind, i.name]), [["app", "acme/linear/issues"]]);
    assert.ok(body.removed.some((i) => i.kind === "app" && i.name === "acme/linear/ui"));
    assert.equal(await buyer.apps.get("acme/linear/ui"), null);
    assert.equal((await buyer.apps.get("acme/linear/issues"))?.version, "v2");
  });

  it("refuses an app it cannot carry: an import pinned to a version, a name the format cannot hold", async () => {
    await publishApp(src, "local-ui", UI);
    await publishApp(src, "acme/linear/ui", UI);
    await publishApp(src, "acme/linear/outer", { "app.yaml": "title: Outer\n", "src/App.tsx": 'import { LABEL } from "local-ui";\nexport default function App() { return <p>{LABEL}</p>; }\n' });
    await publishApp(src, "acme/linear/pinned", { "app.yaml": "title: Pinned\n", "src/App.tsx": 'import { LABEL } from "acme/linear/ui@v1";\nexport default function App() { return <p>{LABEL}</p>; }\n' });
    await publishApp(src, "acme/linear/deep/board", { "app.yaml": "title: Deep\n", "src/App.tsx": "export default () => null;\n" });
    const msg = await refusal(build(src, { apps: ["acme/linear/outer", "acme/linear/pinned", "acme/linear/deep/board"] }));
    assert.match(msg, /^package_build_refused: /);
    assert.doesNotMatch(msg, /local-ui/, "a local app is carried, whatever its name");
    assert.match(msg, /acme\/linear\/pinned@v1 imports acme\/linear\/ui@v1: a version label is this strut's own — import the app by name/);
    assert.match(msg, /the app acme\/linear\/deep\/board cannot be a package folder, apps\/deep\/board\/: an app has one segment in a package/);
  });

  it("refuses the whole install, writing nothing, when an app does not build here, grants a step nobody has, or its name is a local app's", async () => {
    const buyer = await fresh("buyer");
    const pkg = (app: Record<string, string>) => ({
      "strut.yaml": "package: acme/linear\nversion: 1.4.0\nrequires:\n  secrets: [LINEAR_API_KEY]\n",
      "steps/_shared.ts": HELPER,
      "steps/create-issue.ts": STEP("acme/linear/create-issue"),
      "workflows/sync.yaml": SYNC,
      ...Object.fromEntries(Object.entries(app).map(([k, v]) => [`apps/issues/${k}`, v])),
    });
    const nothing = async () => {
      assert.deepEqual((await buyer.workspace.listWorkflows()).map((w) => w.name), []);
      assert.deepEqual(Object.keys(await buyer.workspace.getActiveStepHashes()), []);
      assert.deepEqual(await buyer.workspace.listApps(), []);
    };
    const cases: Array<[Record<string, string>, RegExp]> = [
      // The buyer's kit lacks the import: the build names it.
      [{ "app.yaml": "title: Issues\n", "src/App.tsx": 'import pad from "left-pad";\nexport default function App() { return <p>{pad}</p>; }\n' }, /bad_package: the app acme\/linear\/issues does not build on this strut — .*left-pad/],
      [{ "app.yaml": "title: Issues\ngrants:\n  workflows: [acme/linear/nowhere]\n", "src/App.tsx": "export default () => null;\n" }, /the app acme\/linear\/issues does not build on this strut — grants\.workflows: no workflow "acme\/linear\/nowhere"/],
      [{ "app.yaml": "title: Issues\ngrants:\n  steps: [nope/missing]\n", "src/App.tsx": "export default () => null;\n" }, /the app acme\/linear\/issues grants the step nope\/missing, which is neither on this strut nor in the packages/],
      [{ "app.yaml": "title: [\n", "src/App.tsx": "export default () => null;\n" }, /apps\/issues\/app\.yaml: /],
    ];
    for (const [app, re] of cases) {
      const r = await install(buyer, `file:${await writeTree(pkg(app), crypto.randomUUID())}`);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error!, re);
      await nothing();
    }
    // A local app under the prefix.
    await publishApp(buyer, "acme/linear/mine", UI);
    const r = await install(buyer, `file:${await writeTree(pkg({ "app.yaml": "title: Issues\n", "src/App.tsx": "export default () => null;\n" }), "ok")}`);
    assert.equal(r.status, 409);
    assert.match(r.body.error!, /package_conflict: the app acme\/linear\/mine is a local one under acme\/linear\//);
  });
});

for (const tb of testBackends()) {
  describe(`building a package with Concepts and step claims (${tb.name})`, { skip: tb.skip }, () => {
    let backend: GraphBackend;
    let scratch: string;
    const struts: Strut[] = [];
    before(async () => {
      backend = await tb.open();
      await tb.wipe(backend);
      await seedJarvisOntology(backend);
      await seedStrutDomain(backend);
      backend.schemas.invalidate();
    });
    after(async () => {
      await tb.close(backend);
    });
    beforeEach(async () => {
      await tb.clear(backend);
      scratch = await mkdtemp(join(tmpdir(), "strut-build-graph-"));
    });
    afterEach(async () => {
      for (const s of struts.splice(0)) await s.close?.();
      await rm(scratch, { recursive: true, force: true });
    });
    /** A strut on the graph with strut's own Concepts seeded (`Job`, …). */
    const graphStrut = async (name: string, extra: Record<string, unknown> = {}) => {
      const dir = join(scratch, name);
      const s = await boot(new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps"), appsDir: join(dir, "apps") }), { dataDir: dir, concepts: undefined, ...extra });
      struts.push(s);
      return s;
    };
    const conceptRef = async (name: string) =>
      ((await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { namespace: "$ns", name: "$name" })} WHERE ${backend.dialect.live("c")} RETURN c.ref_id AS r`, { ns: backend.namespace, name }))[0]?.["r"] as string | undefined);
    const page = async (name: string, data: Record<string, string>, parent?: string) => {
      const { ref_id } = await backend.nodes.write({ type: "Concept", data: { name, ...data } }, "create");
      if (parent) await backend.edges.write({ edge: "PARENT_OF", source_ref_id: (await conceptRef(parent))!, target_ref_id: ref_id });
    };

    it("writes the pages under a Concept and the step's claims that stay inside, and installs on a cleared graph and on a filesystem", async () => {
      const src = await graphStrut("source");
      await publishLinear(src.workspace);
      await src.workspace.publishStep("local/judge", PLAIN("local/judge"));
      await src.rebuildRegistry();
      await page("Linear", { description: "The tracker", docs: "How Linear works here." }, "Job");
      await page("Issues", { description: "Its issues", docs: "---\nOne issue per bug." }, "Linear");
      await page("Notes", { description: "A person's page" });
      await page("Roadmap", { docs: "Where it goes." }, "Notes");
      const claim = async (text: string, check: Record<string, unknown>) => {
        const res = await src.app.request("/claims", json({ text, checks: [check], subjects: [{ kind: "step", name: "acme/linear/create-issue" }] }));
        assert.equal(res.status, 200, await res.text());
      };
      await claim("it reads its key", { type: "exec", config: { cmd: "true" } });
      await claim("a judge likes it", { type: "local/judge", config: {} });

      const built = await build(src, { workflows: ["acme/linear/sync"], concepts: ["Linear"] });
      assert.deepEqual(built.files, ["concepts/Issues.md", "concepts/Linear.md", "steps/_shared.ts", "steps/create-issue.claims.yaml", "steps/create-issue.ts", "strut.yaml", "workflows/sync.yaml"]);
      assert.equal(await readFile(join(built.dir, "concepts/Linear.md"), "utf-8"), "---\ndescription: The tracker\nparent: Job\n---\nHow Linear works here.\n");
      assert.equal(await readFile(join(built.dir, "concepts/Issues.md"), "utf-8"), "---\ndescription: Its issues\nparent: Linear\n---\n---\nOne issue per bug.\n");
      assert.deepEqual(loadYaml(await readFile(join(built.dir, "steps/create-issue.claims.yaml"), "utf-8")), [
        { text: "it reads its key", checks: [{ type: "exec", config: { cmd: "true" }, name: "exec", when: "run", policy: "always" }] },
      ]);
      assert.deepEqual(built.manifest.requires, { secrets: ["LINEAR_API_KEY", "NOTION_KEY"], binaries: ["sh", "true"] });
      assert.match(built.warnings.join("\n"), /the claim "a judge likes it" of acme\/linear\/create-issue is left out: the check local\/judge: it runs local\/judge, outside the package/);

      // A page another seeder stamped is not the package's; a top page under a person's page is said.
      assert.match(await refusal(build(src, { concepts: ["Job"] })), /the Concept Job is strut\/concepts\/Job\.md's \(its stamp\): a package carries pages of its own/);
      const notes = await build(src, { package: "acme/notes", concepts: ["Roadmap"] });
      assert.deepEqual(notes.files, ["concepts/Roadmap.md", "strut.yaml"]);
      assert.match(notes.warnings.join("\n"), /the Concept Roadmap hangs under Notes, which is not in the package: the strut that installs it must have a Concept Notes/);

      // On a filesystem workspace: no Concepts, no claims, said.
      const fsBuyer = await boot(new WorkspaceManager(join(scratch, "fs-buyer")));
      struts.push(fsBuyer);
      const onFs = await roundTrip(fsBuyer, built.dir);
      assert.match(onFs.warnings.join("\n"), /the Concepts \(Issues, Linear\) were not installed: this workspace has no graph/);
      assert.match(onFs.warnings.join("\n"), /the claims of acme\/linear\/create-issue were not recorded/);

      // On a cleared graph, a fresh strut: the pages hang where they did, the claim is the package's.
      for (const s of struts.splice(0)) await s.close?.();
      await tb.clear(backend);
      const buyer = await graphStrut("buyer");
      const onGraph = await roundTrip(buyer, built.dir);
      assert.deepEqual(onGraph.warnings, []);
      const linear = await conceptRef("Linear");
      const parents = await backend.tx((tx) => backend.edgeEngine.liveEdgesOf(tx, linear!, "PARENT_OF", false));
      assert.deepEqual(parents?.edges.map((e) => e.other), [await conceptRef("Job")]);
      const listed = (await (await buyer.app.request(`/claims?kind=step&name=${encodeURIComponent("acme/linear/create-issue")}`)).json()) as { claims: Array<{ text: string; speaker?: string }> };
      assert.deepEqual(listed.claims.map((c) => [c.text, c.speaker]), [["it reads its key", "acme/linear"]]);
    });

    it("carries apps, installs them on a cleared graph, holds the prefix, and installs again after an uninstall", async () => {
      const kit = await kitForTests();
      const src = await graphStrut("source", { kit });
      await publishLinear(src.workspace);
      await src.workspace.publishWorkflow("acme/linear/report", "v1", REPORT);
      await src.rebuildRegistry();
      await publishApp(src, "acme/linear/ui", UI);
      const issuesHash = await publishApp(src, "acme/linear/issues", ISSUES());
      const built = await build(src, { apps: ["acme/linear/issues"] });
      assert.deepEqual(built.files.filter((f) => f.startsWith("apps/")), ["apps/issues/app.yaml", "apps/issues/src/App.tsx", "apps/ui/app.yaml", "apps/ui/public/dot.png", "apps/ui/src/App.tsx", "apps/ui/src/index.ts"]);

      for (const s of struts.splice(0)) await s.close?.();
      await tb.clear(backend);
      const buyer = await graphStrut("buyer", { kit });
      const r = await roundTrip(buyer, built.dir);
      assert.deepEqual(r.packages[0]!.items.filter((i) => i.kind === "app").map((i) => [i.name, i.status]), [["acme/linear/issues", "installed"], ["acme/linear/ui", "installed"]]);
      const issues = (await buyer.apps.get("acme/linear/issues"))!;
      assert.deepEqual([issues.hash, issues.stale, issues.upstream?.package], [issuesHash, false, "acme/linear"]);
      await assert.rejects(buyer.workspace.publishApp("acme/linear/mine", "h", issues.manifest), /package_conflict: acme\/linear\/mine is under acme\/linear/);

      const gone = await buyer.app.request("/packages/acme/linear", { method: "DELETE" });
      assert.equal(gone.status, 200, await gone.text());
      assert.deepEqual(await buyer.workspace.listApps(), []);
      const back = await install(buyer, `file:${built.dir}`);
      assert.equal(back.status, 201, JSON.stringify(back.body));
      assert.deepEqual((await buyer.apps.get("acme/linear/issues"))?.hash, issuesHash);
      const listed = (await (await buyer.app.request("/packages")).json()) as { packages: Array<{ items: Array<{ kind: string; name: string; modified?: boolean }> }> };
      assert.deepEqual(listed.packages[0]!.items.filter((i) => i.kind === "app").map((i) => [i.name, i.modified]), [["acme/linear/issues", false], ["acme/linear/ui", false]]);
    });
  });
}
