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
import { seedConcepts, STRUT_CONCEPTS } from "../concept-seed.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
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

  it("wait: false answers at once with the install's id; its record says how far it is and how it ended, the same answer as a wait", async () => {
    const dir = await writeTree(PACKAGE);
    const res = await api.req("/packages/install", json({ ref: `file:${dir}`, wait: false }));
    assert.equal(res.status, 202);
    const { install } = (await res.json()) as { install: { id: string; status: string; phase: string; ref: string; door: string } };
    assert.match(install.id, /^inst_[0-9a-f]{16}$/);
    assert.deepEqual([install.ref, install.door], [`file:${dir}`, "install"]);
    type State = { id: string; status: string; phase: string; result?: InstallResult; error?: string; finishedAt?: number };
    const read = async (id: string) => (await (await api.req(`/packages/installs/${id}`)).json()) as State;
    let state = await read(install.id);
    for (let i = 0; i < 200 && !state.finishedAt; i++) {
      await new Promise((r) => setTimeout(r, 25));
      state = await read(install.id);
    }
    assert.equal(state.status, "done", JSON.stringify(state));
    assert.equal(state.result!.package, "acme/linear");
    assert.deepEqual(state.result!.packages[0]!.items.map((i) => [i.kind, i.name, i.status]), [["step", "acme/linear/_shared", "installed"], ["step", "acme/linear/create-issue", "installed"], ["workflow", "acme/linear/sync", "installed"]]);
    assert.equal(state.phase, "workflows", "the last phase it was in");

    // A refusal is on the record as the route would have answered it.
    const bad = (await (await api.req("/packages/install", json({ ref: `file:${join(root, "nowhere")}`, wait: false }))).json()) as { install: { id: string } };
    let failed = await read(bad.install.id);
    for (let i = 0; i < 200 && !failed.finishedAt; i++) {
      await new Promise((r) => setTimeout(r, 25));
      failed = await read(bad.install.id);
    }
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /^package_/);

    const all = ((await (await api.req("/packages/installs")).json()) as { installs: State[] }).installs;
    assert.deepEqual(all.map((s) => s.id), [bad.install.id, install.id], "newest first");
    assert.equal((await api.req("/packages/installs/inst_0000000000000000")).status, 404);
    assert.equal((await api.req("/packages/install", json({ ref: `file:${dir}`, wait: "no" }))).status, 400);
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
    assert.deepEqual({ ...listed, items: undefined }, { package: "acme/linear", version: "1.4.0", digest, source: { ref: `file:${dir}` }, secrets: ["LINEAR_API_KEY"], door: "install", items: undefined });
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
    // An app under strut/ is strut's own (plans/jamie-app.md §3): no package installs one.
    r = await api.install(
      `file:${await writeTree({ "strut.yaml": "package: strut/extras\nversion: '1'\n", "apps/panel/app.yaml": "title: Panel\n", "apps/panel/src/App.tsx": "export default function App() { return null; }\n" }, "strut-extras")}`,
    );
    assert.equal(r.status, 409);
    assert.match(r.body.error!, /the app strut\/extras\/panel is under strut\/: those are strut's/);
    await nothing();

    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ ...PACKAGE, "workflows/sync.yaml": WORKFLOW("acme/linear/sync", "nope/missing") }, /names the step nope\/missing, which is neither on this strut server nor in the packages/],
      [{ ...PACKAGE, "workflows/sync.yaml": WORKFLOW("other-name") }, /workflows\/sync\.yaml says name: other-name — a workflow's name is its path, acme\/linear\/sync/],
      [{ ...PACKAGE, "workflows/sync.yaml": `${WORKFLOW("acme/linear/sync")}  - id: sub\n    type: subflow\n    config: { workflow: nowhere }\n` }, /calls the workflow nowhere/],
      [{ ...PACKAGE, "steps/create-issue.claims.yaml": "- text: it creates one issue\n" }, /steps\/create-issue\.claims\.yaml: .*checks/],
      // Found only once the steps are written: the install takes them back.
      [{ ...PACKAGE, "steps/create-issue.ts": STEP("acme/linear/other") }, /the step acme\/linear\/create-issue — its defineStep says type "acme\/linear\/other"/],
      [{ ...PACKAGE, "steps/create-issue.ts": "export default {;" }, /bad_package: the step acme\/linear\/create-issue — /],
      [{ ...PACKAGE, "apps/issues/app.yaml": "title: Issues\n" }, /bad_package: the app acme\/linear\/issues does not build on this strut server — entry: "src\/App\.tsx" is not a file/],
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
    assert.match(next.body.error!, /^package_installed: acme\/linear 1\.4\.0 is installed here at sha256:[0-9a-f]+, and this is sha256:[0-9a-f]+ — installing does not update it: POST \/packages\/acme\/linear\/update does/);
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
    assert.match(refused.body.error!, new RegExp(`package_conflict: carol/x requires bob/util at ${other}, and this strut server has it at ${utilDigest}`));
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

  describe("through the distro's door", () => {
    const distro = { door: "distro" as const };
    const RELEASE_1: Record<string, string> = {
      "strut.yaml": "package: acme/linear\nversion: 1.0.0\nrequires:\n  secrets: [LINEAR_API_KEY]\n",
      "steps/create-issue.ts": STEP("acme/linear/create-issue"),
      "steps/close-issue.ts": STEP("acme/linear/close-issue", "bye"),
      "steps/_shared.ts": 'export const greeting = "hello";\n',
      "workflows/sync.yaml": WORKFLOW("acme/linear/sync"),
      "workflows/report.yaml": WORKFLOW("acme/linear/report"),
      "workflows/old.yaml": WORKFLOW("acme/linear/old"),
    };
    // 1.1 changes a step, its helper and a workflow, leaves a workflow as it
    // was, drops a step and a workflow, and adds a workflow.
    const RELEASE_2: Record<string, string> = {
      "strut.yaml": RELEASE_1["strut.yaml"]!.replace("1.0.0", "1.1.0"),
      "steps/create-issue.ts": `${STEP("acme/linear/create-issue")}// 1.1\n`,
      "steps/_shared.ts": 'export const greeting = "hi";\n',
      "workflows/sync.yaml": WORKFLOW("acme/linear/sync"),
      "workflows/report.yaml": WORKFLOW("acme/linear/report").replace("Sync the issues", "Report the issues"),
      "workflows/triage.yaml": WORKFLOW("acme/linear/triage"),
    };

    it("fast-forwards what the package wrote, records a release beside a fork, retires what it drops, and keeps a dropped fork", async () => {
      const d1 = await writeTree(RELEASE_1, "r1");
      const first = await strut.packages.install(`file:${d1}`, distro);
      assert.equal(first.packages[0]!.status, "installed");
      assert.equal((await ws.getStepMetadata("acme/linear/create-issue"))!.versions["v1"]?.source, "distro");
      // Forks on this strut: one the release changes, one it drops.
      await ws.publishWorkflow("acme/linear/report", "v2", WORKFLOW("acme/linear/report").replace("Sync the issues", "forked here"));
      await ws.publishWorkflow("acme/linear/old", "v2", WORKFLOW("acme/linear/old").replace("Sync the issues", "forked here"));

      const d2 = await writeTree(RELEASE_2, "r2");
      const [{ digest: digest1 }, { digest: digest2 }] = await Promise.all([readPackage(d1), readPackage(d2)]);
      const [p] = (await strut.packages.install(`file:${d2}`, distro)).packages;
      assert.equal(p!.status, "updated");
      assert.deepEqual(p!.from, { version: "1.0.0", digest: digest1 });
      assert.deepEqual(p!.items.map((i) => [i.kind, i.name, i.status, i.reason]), [
        ["step", "acme/linear/_shared", "updated", undefined],
        ["step", "acme/linear/close-issue", "retired", undefined],
        ["step", "acme/linear/create-issue", "updated", undefined],
        ["workflow", "acme/linear/old", "kept", "modified here (a fork)"],
        ["workflow", "acme/linear/report", "diverged", undefined],
        ["workflow", "acme/linear/sync", "present", undefined],
        ["workflow", "acme/linear/triage", "installed", undefined],
      ]);

      const step = (await ws.getStepMetadata("acme/linear/create-issue"))!;
      assert.equal(step.active, "v2");
      assert.equal(step.versions["v2"]?.upstream?.digest, digest2);
      assert.equal(await ws.getStepMetadata("acme/linear/close-issue"), null, "untouched and dropped: retired");
      const report = (await ws.getWorkflowMetadata("acme/linear/report"))!;
      assert.equal(report.active, "v2", "the fork stays active");
      assert.equal(report.versions["v3"]?.source, "distro");
      assert.equal(report.versions["v3"]?.upstream?.digest, digest2, "the release is recorded beside it");
      assert.equal((await ws.getWorkflowMetadata("acme/linear/old"))?.active, "v2", "a dropped fork is kept");
      const run = await strut.run("acme/linear/sync", {});
      assert.deepEqual(run.output, { greeting: "hi", LINEAR_API_KEY: "lin_123" }, "the updated step and helper run");

      const [listed] = await api.list();
      assert.deepEqual([listed!.version, listed!.digest, listed!.door], ["1.1.0", digest2, "distro"], "at the release, though a kept fork names the one before");
      assert.deepEqual(listed!.items.filter((i) => i.kind === "workflow").map((i) => [i.name, i.installed, i.active, i.modified]), [
        ["acme/linear/old", "v1", "v2", true],
        ["acme/linear/report", "v3", "v2", true],
        ["acme/linear/sync", "v1", "v1", false],
        ["acme/linear/triage", "v1", "v1", false],
      ]);

      // The same release again writes nothing.
      const again = await strut.packages.install(`file:${d2}`, distro);
      assert.deepEqual(again.packages[0]!.items.filter((i) => i.status !== "present").map((i) => [i.name, i.status]), [
        ["acme/linear/old", "kept"],
        ["acme/linear/report", "diverged"],
      ]);
      assert.equal((await ws.getWorkflowMetadata("acme/linear/report"))!.versions["v4"], undefined);

      // A person makes the release active on the fork: it follows the next one.
      await ws.setActiveVersion("acme/linear/report", "v3");
      const d3 = await writeTree({ ...RELEASE_2, "strut.yaml": RELEASE_2["strut.yaml"]!.replace("1.1.0", "1.2.0"), "workflows/report.yaml": WORKFLOW("acme/linear/report").replace("Sync the issues", "Report v1.2") }, "r3");
      const third = await strut.packages.install(`file:${d3}`, distro);
      assert.equal(third.packages[0]!.items.find((i) => i.name === "acme/linear/report")?.status, "updated");
      assert.equal((await ws.getWorkflowMetadata("acme/linear/report"))?.active, "v4");
    });

    it("refuses a release whose step does not load, before it writes anything", async () => {
      await strut.packages.install(`file:${await writeTree(RELEASE_1, "r1")}`, distro);
      const broken = { ...RELEASE_2, "steps/create-issue.ts": `${STEP("acme/linear/create-issue")}throw new Error("boom at load");\n` };
      await assert.rejects(strut.packages.install(`file:${await writeTree(broken, "broken")}`, distro), /^Error: bad_package: the step acme\/linear\/create-issue — .*boom at load/);
      const step = (await ws.getStepMetadata("acme/linear/create-issue"))!;
      assert.deepEqual([step.active, Object.keys(step.versions)], ["v1", ["v1"]], "no version written");
      assert.equal((await ws.getStepMetadata("acme/linear/_shared"))!.active, "v1");
      assert.equal(await ws.getWorkflowMetadata("acme/linear/triage"), null);
      assert.ok(await ws.getStepMetadata("acme/linear/close-issue"), "nothing retired");
    });

    it("keeps what the distro wrote the distro's, and takes over what a person installed", async () => {
      const d1 = await writeTree(RELEASE_1, "r1");
      assert.equal((await api.install(`file:${d1}`)).status, 201);
      const r = await strut.packages.install(`file:${await writeTree(RELEASE_2, "r2")}`, distro);
      assert.equal(r.packages[0]!.status, "updated");
      assert.equal((await api.list())[0]!.door, "distro");

      const again = await api.install(`file:${d1}`);
      assert.equal(again.status, 409);
      assert.match(again.body.error!, /^package_distro_owned: acme\/linear was installed here by the distro/);
      const removal = await api.uninstall("acme/linear");
      assert.equal(removal.status, 409);
      assert.match(removal.body.error!, /^package_distro_owned:/);
      const out = await strut.packages.uninstall("acme/linear", distro);
      assert.ok(out.removed.some((i) => i.name === "acme/linear/sync"));
    });

    it("updates a package it requires first, where a person's door refuses", async () => {
      const util = (v: string) => ({
        "strut.yaml": `package: bob/util\nversion: '${v}'\n`,
        "steps/fmt.ts": `import { z, defineStep } from "strut";\nexport default defineStep({ type: "bob/util/fmt", input: z.object({}), output: z.any(), async run() { return ${JSON.stringify(v)}; } });\n`,
      });
      const requiring = (v: string, digest: string, dir: string) => ({
        "strut.yaml": `package: acme/linear\nversion: '${v}'\nrequires:\n  packages:\n    - { package: bob/util, digest: "${digest}", source: "file:${dir}" }\n`,
        "workflows/sync.yaml": "name: acme/linear/sync\nsteps:\n  - { id: f, type: bob/util/fmt }\n",
      });
      const u1 = await writeTree(util("1"), "u1");
      const u2 = await writeTree(util("2"), "u2");
      await strut.packages.install(`file:${await writeTree(requiring("1", (await readPackage(u1)).digest, u1), "l1")}`, distro);
      assert.equal((await strut.run("acme/linear/sync", {})).output, "1");

      const l2 = await writeTree(requiring("2", (await readPackage(u2)).digest, u2), "l2");
      const refused = await api.install(`file:${l2}`);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error!, /package_conflict: acme\/linear requires bob\/util at sha256:[0-9a-f]+, and this strut server has it at sha256:[0-9a-f]+ — update bob\/util first \(POST \/packages\/bob\/util\/update\)/);
      const r = await strut.packages.install(`file:${l2}`, distro);
      assert.deepEqual(r.packages.map((p) => [p.package, p.status]), [
        ["bob/util", "updated"],
        ["acme/linear", "updated"],
      ]);
      assert.equal((await strut.run("acme/linear/sync", {})).output, "2");
    });
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
      // The schemas once, as a booted backend has them: the Strut domain and
      // the seed types (Concept, Claim, Check, Evidence), which a Ladybug
      // file holds from its open. Each case clears the data.
      await tb.wipe(backend);
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

      // An edit to one page in the graph is the person's: listed as modified, kept on uninstall —
      // and so is the page it hangs under, which would otherwise leave it with no parent.
      await backend.nodes.update((await conceptNode("Issues"))!.ref_id, { set: { docs: "Edited here." } });
      const [p] = await api.list();
      assert.deepEqual(p!.items.filter((i) => i.kind === "concept"), [
        { kind: "concept", name: "Issues", modified: true },
        { kind: "concept", name: "Linear", modified: false },
      ]);
      const out = await api.uninstall("acme/linear");
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.ok(!out.body.removed.some((i) => i.kind === "concept"));
      assert.deepEqual(out.body.kept, [
        { kind: "concept", name: "Issues", reason: "edited here" },
        { kind: "concept", name: "Linear", reason: "Issues hangs under it and stays, so it stays too" },
      ]);
      assert.equal((await conceptNode("Issues"))?.docs, "Edited here.");
      const under = await backend.tx(async (tx) => backend.edgeEngine.liveEdgesOf(tx, (await conceptNode("Linear"))!.ref_id, "PARENT_OF", true));
      assert.deepEqual(under?.edges.map((e) => e.other), [(await conceptNode("Issues"))!.ref_id], "still under Linear");
    });

    it("says how far it is: each phase in order, the Concepts and their tree counted", async () => {
      const seen: string[] = [];
      const files = { ...PACKAGE, ...CONCEPTS };
      const r = await strut.packages.install(`file:${await writeTree(files)}`, { progress: (p) => seen.push([p.phase, p.package, p.total === undefined ? "" : `${p.done}/${p.total}`].filter(Boolean).join(" ")) });
      assert.equal(r.package, "acme/linear");
      assert.deepEqual(seen, [
        "resolving",
        "checking acme/linear",
        "steps acme/linear 0/2",
        "steps acme/linear 1/2",
        "workflows acme/linear 0/1",
        "concepts acme/linear 0/2",
        "concepts acme/linear 2/2",
        "concept-tree acme/linear 1/1",
      ]);
      const [last] = strut.packages.installs.list();
      assert.deepEqual([last!.status, last!.phase, last!.done, last!.total, last!.result?.package], ["done", "concept-tree", 1, 1, "acme/linear"]);
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
      assert.match(changed.body.error!, /package_installed: acme\/ontology .* POST \/packages\/acme\/ontology\/update does/);
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

    it("installs a new-form page by its name whatever its file, under every parent — strut's Job among them, which strut's next boot seed leaves — with the attributes this graph declares", async () => {
      await seedConcepts(backend, [STRUT_CONCEPTS]);
      const files = {
        "strut.yaml": "package: acme/code\nversion: '1'\n",
        "concepts/linear.md": "---\nname: Linear\ndescription: The tracker\n---\nHow Linear works here.\n",
        "concepts/Code task.md": "---\nname: acme/linear\ndescription: Work on the tracker's code\nrepo: acme/linear\njurisdiction: Delaware\nparents:\n  - Job\n  - Linear\n---\nCheck out the repo first.\n",
      };
      const r = await api.install(`file:${await writeTree(files)}`);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body.warnings, ["the Concept acme/linear is installed without jurisdiction: this graph's Concept does not declare it"]);
      assert.deepEqual(r.body.packages[0]!.items.map((i) => [i.name, i.status]).sort(), [["Linear", "installed"], ["acme/linear", "installed"]]);
      const task = (await conceptNode("acme/linear"))!;
      assert.match(task.unique_source_id, /^pkg\/acme\/code\/Code task\.md@[0-9a-f]{12}$/, "stamped by its file, named by its name");
      const props = (await backend.tx((tx) => backend.nodeEngine.readRaw(tx, task.ref_id)))!.props;
      assert.deepEqual([props["description"], props["repo"], props["jurisdiction"] ?? null, props["docs"]], ["Work on the tracker's code", "acme/linear", null, "Check out the repo first."]);
      const parents = async () => {
        const out = await backend.tx((tx) => backend.edgeEngine.liveEdgesOf(tx, task.ref_id, "PARENT_OF", false));
        return (out?.edges ?? []).map((e) => e.other).sort();
      };
      const both = [(await conceptNode("Job"))!.ref_id, (await conceptNode("Linear"))!.ref_id].sort();
      assert.deepEqual(await parents(), both);
      // What the graph does not declare was never written, and is not an edit.
      assert.deepEqual((await api.list())[0]!.items, [{ kind: "concept", name: "acme/linear", modified: false }, { kind: "concept", name: "Linear", modified: false }]);

      // Strut's boot seeds its own pages again: the edge from its Job to a page it does not own stays.
      await seedConcepts(backend, [STRUT_CONCEPTS]);
      assert.deepEqual(await parents(), both);

      // An attribute the file carries, edited in the graph, is an edit.
      await backend.nodes.update(task.ref_id, { set: { repo: "acme/other" } });
      assert.deepEqual((await api.list())[0]!.items.find((i) => i.name === "acme/linear"), { kind: "concept", name: "acme/linear", modified: true });
      const out = await api.uninstall("acme/code");
      assert.deepEqual(out.body.kept, [
        { kind: "concept", name: "acme/linear", reason: "edited here" },
        { kind: "concept", name: "Linear", reason: "acme/linear hangs under it and stays, so it stays too" },
      ]);
      assert.ok(await conceptNode("Linear"), "the untouched page stays: the edited one still hangs under it");
      assert.deepEqual(await parents(), both);
    });

    it("updates a page the distro installed in the old form to the new one, under another file", async () => {
      const v1 = { "strut.yaml": "package: acme/ontology\nversion: '1'\n", ...CONCEPTS };
      assert.equal((await strut.packages.install(`file:${await writeTree(v1)}`, { door: "distro" })).packages[0]!.status, "installed");
      const before = (await conceptNode("Issues"))!;
      const v2 = {
        "strut.yaml": "package: acme/ontology\nversion: '2'\n",
        "concepts/concept-linear.md": "---\nname: Linear\ndescription: The tracker\n---\nHow Linear works here.\n",
        "concepts/concept-issues.md": "---\nname: Issues\ndescription: Its issues\nparents:\n  - Linear\n---\nOne issue per bug.\n",
      };
      const r = await strut.packages.install(`file:${await writeTree(v2)}`, { door: "distro" });
      assert.deepEqual(r.packages[0]!.items.map((i) => [i.name, i.status]), [["Issues", "updated"], ["Linear", "updated"]]);
      const after = (await conceptNode("Issues"))!;
      assert.equal(after.ref_id, before.ref_id, "the same node");
      assert.match(after.unique_source_id, /^pkg\/acme\/ontology\/concept-issues\.md@/);
      assert.deepEqual((await api.list())[0]!.items, [{ kind: "concept", name: "Issues", modified: false }, { kind: "concept", name: "Linear", modified: false }]);
    });

    it("keeps a page this strut added pages under, and every page above it, through an update that drops it and an uninstall", async () => {
      const v1 = {
        "strut.yaml": "package: acme/legal\nversion: '1'\n",
        "concepts/Firm.md": "---\ndescription: The firm's own lessons\n---\n",
        "concepts/Law.md": "---\ndescription: The law\n---\nAbout the law.\n",
        "concepts/Contracts.md": "---\ndescription: Contracts\nparent: Law\n---\nAbout contracts.\n",
        "concepts/Old.md": "---\nparent: Law\n---\nGoing away.\n",
      };
      assert.equal((await strut.packages.install(`file:${await writeTree(v1)}`, { door: "distro" })).packages[0]!.status, "installed");
      // This strut's own pages, under the package's root and under one of its pages.
      const own = async (name: string, parent: string) => {
        const { ref_id } = await backend.nodes.write({ type: "Concept", data: { name } }, "create");
        await backend.edges.write({ edge: "PARENT_OF", source_ref_id: (await conceptNode(parent))!.ref_id, target_ref_id: ref_id });
      };
      await own("Our Rule", "Firm");
      await own("Our Clause Note", "Contracts");
      const parentOf = async (name: string) => {
        const node = (await conceptNode(name))!;
        const edges = await backend.tx((tx) => backend.edgeEngine.liveEdgesOf(tx, node.ref_id, "PARENT_OF", false));
        return (edges?.edges ?? []).map((e) => e.other);
      };

      // A release that drops Contracts and Old: Old goes, Contracts stays with this strut's page under it.
      const v2 = {
        "strut.yaml": "package: acme/legal\nversion: '2'\n",
        "concepts/Firm.md": v1["concepts/Firm.md"],
        "concepts/Law.md": "---\ndescription: The law\n---\nAbout the law, now.\n",
      };
      const r = await strut.packages.install(`file:${await writeTree(v2)}`, { door: "distro" });
      assert.deepEqual(r.packages[0]!.items.map((i) => [i.name, i.status, i.reason]), [
        ["Contracts", "kept", "Our Clause Note hangs under it and stays, so it stays too"],
        ["Firm", "present", undefined],
        ["Law", "updated", undefined],
        ["Old", "retired", undefined],
      ]);
      assert.equal(await conceptNode("Old"), undefined);
      assert.deepEqual(await parentOf("Our Clause Note"), [(await conceptNode("Contracts"))!.ref_id]);
      assert.deepEqual(await parentOf("Our Rule"), [(await conceptNode("Firm"))!.ref_id], "the root this strut added a page under is as it was");

      // The uninstall: every page with this strut's pages under it stays, and Law above Contracts.
      const out = await strut.packages.uninstall("acme/legal", { door: "distro" });
      assert.deepEqual(out.removed.filter((i) => i.kind === "concept"), []);
      const kept = out.kept.filter((i) => i.kind === "concept");
      assert.deepEqual(kept.map((i) => i.name).sort(), ["Contracts", "Firm", "Law"]);
      assert.equal(kept.find((i) => i.name === "Firm")?.reason, "Our Rule hangs under it and stays, so it stays too");
      assert.deepEqual(await parentOf("Our Rule"), [(await conceptNode("Firm"))!.ref_id]);
      assert.deepEqual(await parentOf("Our Clause Note"), [(await conceptNode("Contracts"))!.ref_id]);
      assert.deepEqual(await parentOf("Contracts"), [(await conceptNode("Law"))!.ref_id]);
    });

    it("updates Concepts through the distro's door: an untouched page follows, an edited one is left, a dropped one is retired", async () => {
      const v1 = { "strut.yaml": "package: acme/ontology\nversion: '1'\n", ...CONCEPTS, "concepts/Old.md": "---\nparent: Linear\n---\nGoing away.\n" };
      assert.equal((await strut.packages.install(`file:${await writeTree(v1)}`, { door: "distro" })).packages[0]!.status, "installed");
      await backend.nodes.update((await conceptNode("Issues"))!.ref_id, { set: { docs: "Edited here." } });
      const v2 = {
        "strut.yaml": "package: acme/ontology\nversion: '2'\n",
        "concepts/Linear.md": "---\ndescription: The tracker\n---\nHow Linear works now.\n",
        "concepts/Issues.md": "---\ndescription: Its issues\nparent: Linear\n---\nTwo issues per bug.\n",
        "concepts/Cycles.md": "---\ndescription: Its sprints\nparent: Linear\n---\nOne cycle a fortnight.\n",
      };
      const r = await strut.packages.install(`file:${await writeTree(v2)}`, { door: "distro" });
      assert.deepEqual(r.packages[0]!.items.map((i) => [i.name, i.status]), [
        ["Cycles", "installed"],
        ["Issues", "modified"],
        ["Linear", "updated"],
        ["Old", "retired"],
      ]);
      assert.match((await conceptNode("Linear"))!.docs, /works now/);
      assert.equal((await conceptNode("Issues"))?.docs, "Edited here.", "the edit is left as it is");
      assert.equal(await conceptNode("Old"), undefined);
      const linear = await conceptNode("Linear");
      const children = await backend.tx((tx) => backend.edgeEngine.liveEdgesOf(tx, linear!.ref_id, "PARENT_OF", true));
      assert.deepEqual(new Set(children?.edges.map((e) => e.other)), new Set([(await conceptNode("Issues"))!.ref_id, (await conceptNode("Cycles"))!.ref_id]));
    });
  });
}
