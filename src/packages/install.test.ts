/**
 * Installing a package (plans/marketplace.md §3) — src/packages/install.ts,
 * installed.ts and fence.ts — through the HTTP routes: on the filesystem
 * workspace, then the Concepts and claims on every graph backend.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
import { seedJarvisOntology } from "../graph/ontology-seed.js";
import { seedStrutDomain } from "../graph/schema-seed.js";
import { testBackends } from "../graph/test-util.js";
import { GraphWorkspaceStore } from "../graph/workspace-store.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager, type WorkspaceStore } from "../workspace.js";
import { readPackage } from "./format.js";
import type { InstallResult } from "./install.js";
import type { InstalledPackage } from "./installed.js";

/** A step that reads one secret — LINEAR_API_KEY unless its config names
 *  another — with its greeting from its namespace's helper, or given. */
const STEP = (type: string, greeting?: string) => `import { z, defineStep } from "strut";
${greeting === undefined ? 'import { greeting } from "./_shared.js";' : `const greeting = ${JSON.stringify(greeting)};`}
export default defineStep({
  type: ${JSON.stringify(type)},
  input: z.object({ secret: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    const name = cfg.secret ?? "LINEAR_API_KEY";
    return { greeting, [name]: (await ctx.services.secrets.get(name)) ?? null };
  },
});
`;

const WORKFLOW = (name: string, step = "acme/linear/create-issue") => `name: ${name}
description: Sync the issues
steps:
  - id: create
    type: ${step}
    config: { secret: "{{ input.secret }}" }
`;

const PACKAGE: Record<string, string> = {
  "strut.yaml": "package: acme/linear\nversion: 1.4.0\ndescription: Linear issues\nrequires:\n  secrets: [LINEAR_API_KEY]\n",
  "steps/create-issue.ts": STEP("acme/linear/create-issue"),
  "steps/_shared.ts": 'export const greeting = "hello";\n',
  "workflows/sync.yaml": WORKFLOW("acme/linear/sync"),
};

let root: string;
async function writeTree(files: Record<string, string>, name = crypto.randomUUID()): Promise<string> {
  const dir = join(root, "src", name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

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

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function client(strut: Strut) {
  const req = (path: string, init?: RequestInit) => strut.app.request(path, init);
  return {
    install: async (ref: string, extra: Record<string, unknown> = {}) => {
      const res = await req("/packages/install", json({ ref, ...extra }));
      return { status: res.status, body: (await res.json()) as InstallResult & { error?: string } };
    },
    list: async () => ((await (await req("/packages")).json()) as { packages: InstalledPackage[] }).packages,
    uninstall: async (pkg: string) => {
      const res = await req(`/packages/${pkg}`, { method: "DELETE" });
      return { status: res.status, body: (await res.json()) as { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string; reason: string }>; error?: string } };
    },
    secret: (name: string, value: string) => req(`/secrets/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) }),
    req,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-install-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("installing a package on a filesystem workspace", () => {
  let strut: Strut;
  let ws: WorkspaceManager;
  let api: ReturnType<typeof client>;
  let saved: string | undefined;
  before(() => {
    saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
  });
  after(() => {
    if (saved !== undefined) process.env["STRUT_API_KEY"] = saved;
  });
  beforeEach(async () => {
    ws = new WorkspaceManager(join(root, "workspace"));
    strut = await boot(ws);
    api = client(strut);
    await api.secret("LINEAR_API_KEY", "lin_123");
    await api.secret("GITHUB_TOKEN", "ghp_456");
  });
  afterEach(async () => {
    await strut.close?.();
  });

  it("publishes its items stamped with where they came from, runs them, and lists them as installed", async () => {
    const dir = await writeTree(PACKAGE);
    const { digest } = await readPackage(dir);
    const { status, body } = await api.install(`file:${dir}`, {});
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.package, "acme/linear");
    assert.equal(body.digest, digest);
    assert.deepEqual(body.packages.map((p) => [p.package, p.status, p.items.map((i) => [i.kind, i.name, i.status])]), [
      ["acme/linear", "installed", [["step", "acme/linear/_shared", "installed"], ["step", "acme/linear/create-issue", "installed"], ["workflow", "acme/linear/sync", "installed"]]],
    ]);
    assert.deepEqual(body.missing, { secrets: [], binaries: [], runtimes: [] });

    const upstream = { package: "acme/linear", version: "1.4.0", digest, source: { ref: `file:${dir}` }, secrets: ["LINEAR_API_KEY"] };
    const wf = (await ws.getWorkflowMetadata("acme/linear/sync"))!;
    assert.deepEqual(wf.versions["v1"]?.upstream, upstream);
    assert.equal(wf.versions["v1"]?.source, "install");
    assert.equal(wf.versions["v1"]?.description, "Sync the issues");
    const step = (await ws.getStepMetadata("acme/linear/create-issue"))!;
    assert.deepEqual(step.versions["v1"]?.upstream, upstream);
    assert.equal(step.versions["v1"]?.source, "install");
    assert.ok(await ws.getStepMetadata("acme/linear/_shared"), "the helper rides with its namespace");

    const run = await strut.run("acme/linear/sync", {});
    assert.equal(run.status, "success", run.error?.message);
    assert.deepEqual(run.output, { greeting: "hello", LINEAR_API_KEY: "lin_123" });

    const [listed] = await api.list();
    assert.deepEqual({ ...listed, items: undefined }, { package: "acme/linear", version: "1.4.0", digest, source: { ref: `file:${dir}` }, secrets: ["LINEAR_API_KEY"], items: undefined });
    assert.deepEqual(listed!.items, [
      { kind: "workflow", name: "acme/linear/sync", installed: "v1", active: "v1", modified: false },
      { kind: "step", name: "acme/linear/_shared", helper: true, installed: "v1", active: "v1", modified: false },
      { kind: "step", name: "acme/linear/create-issue", installed: "v1", active: "v1", modified: false },
    ]);
  });

  it("fences an installed step to the secrets its package declares — a fork and a pinned version too", async () => {
    // No helper import: a pinned version is loaded from the version archive, where a relative import does not resolve.
    await api.install(`file:${await writeTree({ ...PACKAGE, "steps/create-issue.ts": STEP("acme/linear/create-issue", "hello") })}`);
    const fenced = await strut.run("acme/linear/sync", { secret: "GITHUB_TOKEN" });
    assert.equal(fenced.status, "error");
    assert.match(fenced.error!.message, /secret_fenced: acme\/linear\/create-issue came from the package acme\/linear, which declares only LINEAR_API_KEY — it may not read GITHUB_TOKEN/);

    // A local step is not fenced; the same code published locally reads anything.
    await ws.publishStep("local/reader", STEP("local/reader", "hello"));
    await ws.publishWorkflow("local-run", "v1", WORKFLOW("local-run", "local/reader"));
    await strut.rebuildRegistry();
    assert.deepEqual((await strut.run("local-run", { secret: "GITHUB_TOKEN" })).output, { greeting: "hello", GITHUB_TOKEN: "ghp_456" });

    // A fork carries the upstream, and with it the fence.
    const edit = await api.req("/steps", json({ name: "acme/linear/create-issue", code: STEP("acme/linear/create-issue", "forked") }));
    assert.equal(edit.status, 201);
    const forked = await strut.run("acme/linear/sync", {});
    assert.deepEqual(forked.output, { greeting: "forked", LINEAR_API_KEY: "lin_123" });
    assert.match((await strut.run("acme/linear/sync", { secret: "GITHUB_TOKEN" })).error!.message, /secret_fenced/);
    // A pinned version is fenced like the active one.
    await ws.publishWorkflow("pinned", "v1", WORKFLOW("pinned", "acme/linear/create-issue@v1"));
    assert.deepEqual((await strut.run("pinned", {})).output, { greeting: "hello", LINEAR_API_KEY: "lin_123" });
    assert.match((await strut.run("pinned", { secret: "GITHUB_TOKEN" })).error!.message, /secret_fenced/);
  });

  it("refuses the whole install, writing nothing, over a local item under the prefix or a file it cannot install", async () => {
    const nothing = async () => {
      assert.deepEqual(await api.list(), []);
      assert.equal(await ws.getStepMetadata("acme/linear/create-issue"), null);
      assert.equal(await ws.getWorkflowMetadata("acme/linear/sync"), null);
    };
    await ws.publishWorkflow("acme/linear/mine", "v1", WORKFLOW("acme/linear/mine", "log"));
    let r = await api.install(`file:${await writeTree(PACKAGE)}`);
    assert.equal(r.status, 409);
    assert.match(r.body.error!, /^package_conflict: the workflow acme\/linear\/mine is a local one under acme\/linear\//);
    await ws.deleteWorkflow("acme/linear/mine");
    await nothing();

    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...PACKAGE, "workflows/sync.yaml": WORKFLOW("acme/linear/sync", "nope/missing") }, /names the step nope\/missing, which is neither on this strut nor in the packages/],
      [{ ...PACKAGE, "workflows/sync.yaml": WORKFLOW("other-name") }, /workflows\/sync\.yaml says name: other-name — a workflow's name is its path, acme\/linear\/sync/],
      [{ ...PACKAGE, "workflows/sync.yaml": `${WORKFLOW("acme/linear/sync")}  - id: sub\n    type: subflow\n    config: { workflow: nowhere }\n` }, /calls the workflow nowhere/],
      [{ ...PACKAGE, "steps/create-issue.claims.yaml": "- text: it creates one issue\n" }, /steps\/create-issue\.claims\.yaml: .*checks/],
      // Found only once the steps are written: the install takes them back.
      [{ ...PACKAGE, "steps/create-issue.ts": STEP("acme/linear/other") }, /the step acme\/linear\/create-issue — its defineStep says type "acme\/linear\/other"/],
      [{ ...PACKAGE, "steps/create-issue.ts": "export default {;" }, /bad_package: the step acme\/linear\/create-issue — /],
      [{ ...PACKAGE, "apps/issues/app.yaml": "title: Issues\n" }, /package_unsupported: acme\/linear ships an app/],
    ];
    for (const [files, re] of cases) {
      r = await api.install(`file:${await writeTree(files)}`);
      assert.equal(r.status, 400, re.source);
      assert.match(r.body.error!, re);
      await nothing();
    }
    assert.equal((await api.install("git+https://example.com/acme/linear@v1")).status, 400);
    assert.equal((await api.install(`file:${join(root, "missing")}`)).status, 400);
    assert.equal((await api.req("/packages/install", json({}))).status, 400);
  });

  it("holds the prefix after install: a new name there is refused at every door, an edit is a fork", async () => {
    await api.install(`file:${await writeTree(PACKAGE)}`);
    const created = await api.req("/workflows", json({ name: "acme/linear/mine", yaml: WORKFLOW("acme/linear/mine", "log") }));
    assert.equal(created.status, 400);
    assert.match(((await created.json()) as { error: string }).error, /package_conflict: acme\/linear\/mine is under acme\/linear, an installed package/);
    const step = await api.req("/steps", json({ name: "acme/linear/extra", code: STEP("acme/linear/extra") }));
    assert.equal(step.status, 400);
    const fork = await api.req("/workflows/acme%2Flinear%2Fsync", json({ version: "v2", yaml: WORKFLOW("acme/linear/sync").replace("Sync the issues", "Mine now") }));
    assert.equal(fork.status, 201, await fork.text());
    const [p] = await api.list();
    assert.deepEqual(p!.items.find((i) => i.name === "acme/linear/sync"), { kind: "workflow", name: "acme/linear/sync", installed: "v1", active: "v2", modified: true });
  });

  it("installs the same digest again as what is missing, keeps a fork, and refuses another digest as an update", async () => {
    const dir = await writeTree(PACKAGE);
    await api.install(`file:${dir}`);
    await ws.publishWorkflow("acme/linear/sync", "v2", WORKFLOW("acme/linear/sync").replace("Sync the issues", "forked"));
    await ws.deleteStep("acme/linear/create-issue");
    const again = await api.install(`file:${dir}`);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.deepEqual(again.body.packages[0]!.items.map((i) => [i.name, i.status]), [
      ["acme/linear/_shared", "present"],
      ["acme/linear/create-issue", "installed"],
      ["acme/linear/sync", "modified"],
    ]);
    assert.equal((await ws.getWorkflowMetadata("acme/linear/sync"))?.active, "v2", "the fork stays active");
    assert.equal((await api.install(`file:${dir}`)).body.packages[0]!.status, "present");

    const next = await api.install(`file:${await writeTree({ ...PACKAGE, "strut.yaml": PACKAGE["strut.yaml"]!.replace("1.4.0", "1.5.0") })}`);
    assert.equal(next.status, 409);
    assert.match(next.body.error!, /^package_update_not_built: acme\/linear 1\.4\.0 is installed here at sha256:[0-9a-f]+; updating it to sha256:[0-9a-f]+ is not built yet/);
  });

  it("installs the packages it requires first, from a source relative to it, and refuses a pin that disagrees", async () => {
    const util = { "strut.yaml": "package: bob/util\nversion: 2.1.0\n", "steps/fmt.ts": 'import { z, defineStep } from "strut";\nexport default defineStep({ type: "bob/util/fmt", input: z.object({}), output: z.any(), async run() { return "fmt"; } });\n' };
    const utilDir = await writeTree(util, "util");
    const { digest: utilDigest } = await readPackage(utilDir);
    const requiring = (digest: string) => ({
      "strut.yaml": `package: acme/linear\nversion: 1.4.0\nrequires:\n  packages:\n    - { package: bob/util, digest: "${digest}", source: "file:../util" }\n`,
      "workflows/sync.yaml": "name: acme/linear/sync\nsteps:\n  - { id: f, type: bob/util/fmt }\n",
    });
    const r = await api.install(`file:${await writeTree(requiring(utilDigest), "linear")}`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.packages.map((p) => [p.package, p.digest === utilDigest || p.package === "acme/linear", p.source.ref]), [
      ["bob/util", true, "file:../util"],
      ["acme/linear", true, `file:${join(root, "src", "linear")}`],
    ]);
    assert.equal((await strut.run("acme/linear/sync", {})).output, "fmt");
    assert.deepEqual((await api.list()).map((p) => p.package), ["acme/linear", "bob/util"]);

    // bob/util is here at one digest; a package pinning another refuses whole.
    const other = `sha256:${"a".repeat(64)}`;
    const refused = await api.install(`file:${await writeTree({ ...requiring(other), "strut.yaml": requiring(other)["strut.yaml"].replace("acme/linear", "carol/x") }, "carol")}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error!, new RegExp(`package_conflict: carol/x requires bob/util at ${other}, and this strut has it at ${utilDigest}`));
  });

  it("reports what the deployment lacks, without refusing", async () => {
    const r = await api.install(
      `file:${await writeTree({
        ...PACKAGE,
        "strut.yaml": "package: acme/linear\nversion: '1'\nrequires:\n  secrets: [LINEAR_API_KEY, NOTION_KEY]\n  binaries: [sh, no-such-binary-strut]\n  runtimes: [{ name: kali, image: 'kali@sha256:x' }]\n",
      })}`,
    );
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.missing, { secrets: ["NOTION_KEY"], binaries: ["no-such-binary-strut"], runtimes: ["kali"] });
  });

  it("uninstalls what is still the package's own, keeps the forks, and frees the prefix once nothing of it is left", async () => {
    await api.install(`file:${await writeTree({ ...PACKAGE, "workflows/other.yaml": WORKFLOW("acme/linear/other") })}`);
    await strut.run("acme/linear/sync", {});
    await ws.publishWorkflow("acme/linear/other", "v2", WORKFLOW("acme/linear/other").replace("Sync the issues", "forked"));
    const out = await api.uninstall("acme/linear");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.removed.map((i) => i.name), ["acme/linear/sync", "acme/linear/_shared", "acme/linear/create-issue"]);
    assert.deepEqual(out.body.kept, [{ kind: "workflow", name: "acme/linear/other", reason: "modified here (a fork)" }]);
    assert.equal(await ws.getStepMetadata("acme/linear/create-issue"), null);
    assert.equal((await strut.store.listRuns("acme/linear/sync")).length, 1, "the runs stay");
    assert.deepEqual((await api.list()).map((p) => [p.package, p.items.map((i) => i.name)]), [["acme/linear", ["acme/linear/other"]]]);
    assert.equal((await api.req("/workflows", json({ name: "acme/linear/mine", yaml: WORKFLOW("acme/linear/mine", "log") }))).status, 400, "the fork still holds the prefix");
    await ws.deleteWorkflow("acme/linear/other");
    assert.equal((await api.uninstall("acme/linear")).status, 404);
    assert.equal((await api.req("/workflows", json({ name: "acme/linear/mine", yaml: WORKFLOW("acme/linear/mine", "log") }))).status, 201);
  });
});

for (const tb of testBackends()) {
  describe(`installing a package's Concepts and claims (${tb.name})`, { skip: tb.skip }, () => {
    let backend: GraphBackend;
    let scratch: string;
    let strut: Strut;
    let api: ReturnType<typeof client>;
    before(async () => {
      backend = await tb.open();
      // The schemas once, as a booted backend has them: the Strut domain, and
      // on Neo4j the jarvis ontology (Concept, Claim, Check, Evidence); a
      // Ladybug file holds them in its registry. Each case clears the data.
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
      scratch = await mkdtemp(join(tmpdir(), "strut-install-graph-"));
      strut = await boot(new GraphWorkspaceStore(backend, { materializeDir: join(scratch, "steps"), appsDir: join(scratch, "apps") }), { dataDir: scratch });
      api = client(strut);
    });
    afterEach(async () => {
      await strut.close?.();
      await rm(scratch, { recursive: true, force: true });
    });

    const CONCEPTS = {
      "concepts/Linear.md": "---\ndescription: The tracker\n---\nHow Linear works here.\n",
      "concepts/Issues.md": "---\ndescription: Its issues\nparent: Linear\n---\nOne issue per bug.\n",
    };
    const conceptNode = async (name: string) =>
      (await backend.query(`MATCH ${backend.dialect.node("c", "Concept", { namespace: "$ns", name: "$name" })} WHERE ${backend.dialect.live("c")} RETURN ${backend.dialect.project("c", ["ref_id", "unique_source_id", "docs"])} AS p`, { ns: backend.namespace, name }))[0]?.["p"] as
        | { ref_id: string; unique_source_id: string; docs: string }
        | undefined;

    it("writes the Concepts stamped by the package, records the claims as its own, and retires untouched pages on uninstall", async () => {
      const files = {
        ...PACKAGE,
        ...CONCEPTS,
        "steps/create-issue.claims.yaml": "- text: it reads its key\n  checks:\n    - { type: exec, config: { cmd: \"true\" } }\n",
        "workflows/sync.yaml": `${WORKFLOW("acme/linear/sync")}claims:\n  - text: the sync creates an issue\n    checks:\n      - { description: look at Linear }\n`,
      };
      const r = await api.install(`file:${await writeTree(files)}`);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.warnings, []);
      assert.deepEqual(r.body.packages[0]!.items.filter((i) => i.kind === "concept").map((i) => [i.name, i.status]).sort(), [["Issues", "installed"], ["Linear", "installed"]]);
      const linear = await conceptNode("Linear");
      assert.match(linear!.unique_source_id, /^pkg\/acme\/linear\/Linear\.md@[0-9a-f]{12}$/);
      const children = await backend.tx((tx) => backend.edgeEngine.liveEdgesOf(tx, linear!.ref_id, "PARENT_OF", true));
      assert.deepEqual(children?.edges.map((e) => e.other), [(await conceptNode("Issues"))!.ref_id]);

      const claims = async (kind: string, name: string) =>
        ((await (await api.req(`/claims?kind=${kind}&name=${encodeURIComponent(name)}`)).json()) as { claims: Array<{ text: string; speaker?: string }> }).claims.map((c) => [c.text, c.speaker]);
      assert.deepEqual(await claims("step", "acme/linear/create-issue"), [["it reads its key", "acme/linear"]]);
      assert.deepEqual(await claims("workflow", "acme/linear/sync"), [["the sync creates an issue", "acme/linear"]]);

      // An edit to one page in the graph is the person's: listed as modified, kept on uninstall.
      await backend.nodes.update((await conceptNode("Issues"))!.ref_id, { set: { docs: "Edited here." } });
      const [p] = await api.list();
      assert.deepEqual(p!.items.filter((i) => i.kind === "concept"), [
        { kind: "concept", name: "Issues", modified: true },
        { kind: "concept", name: "Linear", modified: false },
      ]);
      const out = await api.uninstall("acme/linear");
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.ok(out.body.removed.some((i) => i.kind === "concept" && i.name === "Linear"));
      assert.deepEqual(out.body.kept, [{ kind: "concept", name: "Issues", reason: "edited here" }]);
      assert.equal(await conceptNode("Linear"), undefined, "retired");
      assert.equal((await conceptNode("Issues"))?.docs, "Edited here.");
    });

    it("installs a package of Concepts alone, lists it with its digest, and refuses a page someone else holds", async () => {
      const dir = await writeTree({ "strut.yaml": "package: acme/ontology\nversion: '1'\n", ...CONCEPTS });
      const { digest } = await readPackage(dir);
      assert.equal((await api.install(`file:${dir}`)).status, 201);
      assert.deepEqual(await api.list(), [
        { package: "acme/ontology", digest, version: "1", items: [{ kind: "concept", name: "Issues", modified: false }, { kind: "concept", name: "Linear", modified: false }] },
      ]);
      assert.equal((await api.install(`file:${dir}`)).body.packages[0]!.status, "present", "the same files again: nothing to do");
      const changed = await api.install(`file:${await writeTree({ "strut.yaml": "package: acme/ontology\nversion: '2'\n", ...CONCEPTS, "concepts/Linear.md": "Changed.\n" })}`);
      assert.equal(changed.status, 409);
      assert.match(changed.body.error!, /package_update_not_built: acme\/ontology/);
      assert.equal((await api.uninstall("acme/ontology")).status, 200);
      assert.equal(await conceptNode("Linear"), undefined);

      // A page under the name that is not the package's — a person's — refuses the install.
      await backend.nodes.write({ type: "Concept", data: { name: "Roadmap", description: "A person's page" } });
      const taken = await api.install(`file:${await writeTree({ "strut.yaml": "package: acme/plans\nversion: '1'\n", "concepts/Roadmap.md": "x\n", "concepts/Q3.md": "---\nparent: Roadmap\n---\ny\n" })}`);
      assert.equal(taken.status, 409);
      assert.match(taken.body.error!, /package_conflict: the Concept Roadmap is in the graph already, made here/);
      assert.equal(await conceptNode("Q3"), undefined, "nothing written");
      const orphan = await api.install(`file:${await writeTree({ "strut.yaml": "package: acme/orphan\nversion: '1'\n", "concepts/Child.md": "---\nparent: Nowhere\n---\nx\n" })}`);
      assert.equal(orphan.status, 409);
      assert.match(orphan.body.error!, /the Concept Child hangs under Nowhere, which is neither in the graph nor in the packages/);
    });
  });
}
