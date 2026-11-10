/**
 * A person's UPDATE of an installed package (plans/managed-packages.md §2,
 * §3) — `updatePackage` in install.ts, replay.ts, updates.ts — through the
 * HTTP routes on a filesystem workspace: what nobody changed follows the
 * release, a fork is carried onto it, and one that does not carry refuses
 * the whole update unless a patch covers it. Skipped where there is no git.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import type { GraphBackend } from "../graph/backend.js";
import { seedStrutDomain } from "../graph/schema-seed.js";
import { testBackends } from "../graph/test-util.js";
import { GraphWorkspaceStore } from "../graph/workspace-store.js";
import { MemoryRunStore } from "../store.js";
import { kitForTests } from "../test-util/app-kit.js";
import { WorkspaceManager, type WorkspaceStore } from "../workspace.js";
import { packageCache } from "./cache.js";
import { readPackage } from "./format.js";
import { updatePackage, type InstallResult } from "./install.js";
import type { InstalledPackage } from "./installed.js";
import { diffDirs, formatPatch, packageGit, PatchStore } from "./patch.js";
import type { RollbackResult } from "./updates.js";

const found = await packageGit();
const git = "path" in found ? found.path : "";

const STEP = (type: string, greeting?: string) => `import { z, defineStep } from "strut";
${greeting === undefined ? 'import { greeting } from "./_shared.js";' : `const greeting = ${JSON.stringify(greeting)};`}
export default defineStep({
  type: ${JSON.stringify(type)},
  input: z.object({}),
  output: z.any(),
  async run() {
    return { greeting };
  },
});
`;
const WORKFLOW = (name: string, description = "Sync the issues") => `name: ${name}
description: ${description}
steps:
  - id: create
    type: acme/linear/create-issue
`;
const NOTE = "  - id: note\n    type: log\n    config: { message: reported }\n";

const RELEASE_1: Record<string, string> = {
  "strut.yaml": "package: acme/linear\nversion: 1.0.0\n",
  "steps/create-issue.ts": STEP("acme/linear/create-issue"),
  "steps/close-issue.ts": STEP("acme/linear/close-issue", "bye"),
  "steps/_shared.ts": 'export const greeting = "hello";\n',
  "workflows/sync.yaml": WORKFLOW("acme/linear/sync"),
  "workflows/report.yaml": WORKFLOW("acme/linear/report"),
  "workflows/old.yaml": WORKFLOW("acme/linear/old"),
};
// 1.1 changes a step (at its end), its helper and a workflow (a step added at
// its end), leaves a workflow as it was, drops a step and a workflow, adds one.
const RELEASE_2: Record<string, string> = {
  "strut.yaml": "package: acme/linear\nversion: 1.1.0\n",
  "steps/create-issue.ts": `${STEP("acme/linear/create-issue")}// 1.1\n`,
  "steps/_shared.ts": 'export const greeting = "hi";\n',
  "workflows/sync.yaml": WORKFLOW("acme/linear/sync"),
  "workflows/report.yaml": `${WORKFLOW("acme/linear/report")}${NOTE}`,
  "workflows/triage.yaml": WORKFLOW("acme/linear/triage"),
};

let root: string;
async function writeTree(files: Record<string, string>, name: string = crypto.randomUUID()): Promise<string> {
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
type Answer<T> = { status: number; body: T & { error?: string } };

function client(strut: Strut) {
  const req = (path: string, init?: RequestInit) => strut.app.request(path, init);
  const post = async <T>(path: string, body: unknown): Promise<Answer<T>> => {
    const res = await req(path, json(body));
    return { status: res.status, body: (await res.json()) as T & { error?: string } };
  };
  return {
    req,
    install: (ref: string) => post<InstallResult>("/packages/install", { ref }),
    update: (pkg: string, body: Record<string, unknown> = {}) => post<InstallResult>(`/packages/${pkg}/update`, body),
    rollback: (pkg: string) => post<RollbackResult>(`/packages/${pkg}/rollback`, {}),
    list: async () => ((await (await req("/packages")).json()) as { packages: InstalledPackage[] }).packages,
    patch: (pkg: string) => req(`/packages/${pkg}/patch`),
  };
}

const statuses = (r: InstallResult) => r.packages.at(-1)!.items.map((i) => [i.kind, i.name, i.status]);

let saved: string | undefined;
before(() => {
  saved = process.env["STRUT_API_KEY"];
  delete process.env["STRUT_API_KEY"];
});
after(() => {
  if (saved !== undefined) process.env["STRUT_API_KEY"] = saved;
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-update-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("updating an installed package", { skip: git ? false : "no git here" }, () => {
  let strut: Strut;
  let ws: WorkspaceManager;
  let api: ReturnType<typeof client>;
  beforeEach(async () => {
    ws = new WorkspaceManager(join(root, "workspace"));
    strut = await boot(ws);
    api = client(strut);
  });
  afterEach(async () => {
    await strut.close?.();
  });

  /** A patch from the release's file to `resolved`, as a person or the builder would hand it in. */
  const patchFor = async (pkgDir: string, path: string, resolved: string, over: string): Promise<string> => {
    const layout = join(root, "lay", crypto.randomUUID());
    await mkdir(dirname(join(layout, "a", path)), { recursive: true });
    await mkdir(dirname(join(layout, "b", path)), { recursive: true });
    await writeFile(join(layout, "a", path), await readFile(join(pkgDir, path)));
    await writeFile(join(layout, "b", path), resolved);
    return formatPatch({ package: "acme/linear", onto: (await readPackage(pkgDir)).digest, over: { [path]: over } }, await diffDirs(git, layout));
  };
  const activeHash = async (workflow: string) => {
    const meta = (await ws.getWorkflowMetadata(workflow))!;
    return meta.versions[meta.active]!.hash!;
  };

  it("fast-forwards what nobody changed, carries each fork onto the release, retires what it drops — then rolls back", async () => {
    const d1 = await writeTree(RELEASE_1, "r1");
    assert.equal((await api.install(`file:${d1}`)).status, 201);
    assert.equal((await api.patch("acme/linear")).status, 204, "nothing was changed here");

    // Forks on this strut: a workflow and a step the release changes
    // elsewhere, and a workflow it drops.
    await ws.publishWorkflow("acme/linear/report", "v2", WORKFLOW("acme/linear/report", "forked here"));
    await ws.publishWorkflow("acme/linear/old", "v2", WORKFLOW("acme/linear/old", "forked here"));
    await ws.publishStep("acme/linear/create-issue", `// tuned here\n${STEP("acme/linear/create-issue")}`);
    await strut.rebuildRegistry();

    // What this strut changed, as one patch file.
    const d2 = await writeTree(RELEASE_2, "r2");
    const [{ digest: digest1 }, { digest: digest2 }] = await Promise.all([readPackage(d1), readPackage(d2)]);
    const local = await api.patch("acme/linear");
    assert.equal(local.status, 200);
    assert.match(local.headers.get("content-type")!, /^text\/x-diff/);
    const text = await local.text();
    assert.match(text, new RegExp(`^package: acme/linear\\nonto: ${digest1}\\nover: steps/create-issue\\.ts=\\S+ workflows/old\\.yaml=\\S+ workflows/report\\.yaml=\\S+\\ndiff --git `));
    assert.match(text, /\n-description: Sync the issues\n\+description: forked here\n/);
    assert.match(text, /\n\+\/\/ tuned here\n/);

    // Installing the release is not an update.
    const installed = await api.install(`file:${d2}`);
    assert.equal(installed.status, 409);
    assert.match(installed.body.error!, /^package_installed: acme\/linear 1\.0\.0 is installed here at sha256:[0-9a-f]+, and this is sha256:[0-9a-f]+ — installing does not update it: POST \/packages\/acme\/linear\/update does/);

    const r = await api.update("acme/linear", { ref: `file:${d2}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [p] = r.body.packages;
    assert.equal(p!.status, "updated");
    assert.deepEqual(p!.from, { version: "1.0.0", digest: digest1 });
    assert.deepEqual(p!.items.map((i) => [i.kind, i.name, i.status, i.previous]), [
      ["step", "acme/linear/_shared", "updated", "v1"],
      ["step", "acme/linear/close-issue", "retired", undefined],
      ["step", "acme/linear/create-issue", "replayed", "v2"],
      ["workflow", "acme/linear/old", "kept", undefined],
      ["workflow", "acme/linear/report", "replayed", "v2"],
      ["workflow", "acme/linear/sync", "present", undefined],
      ["workflow", "acme/linear/triage", "installed", undefined],
    ]);

    // The step: the release beside the fork (v3), the fork carried onto it (v4).
    const step = (await ws.getStepMetadata("acme/linear/create-issue"))!;
    assert.equal(step.active, "v4");
    assert.deepEqual([step.versions["v3"]?.source, step.versions["v3"]?.upstream?.digest], ["install", digest2]);
    assert.deepEqual([step.versions["v4"]?.source, step.versions["v4"]?.upstream?.digest, step.versions["v4"]?.upstream?.version], ["update", digest2, "1.1.0"]);
    assert.equal(step.versions["v4"]?.description, "Local changes carried onto acme/linear 1.1.0");
    const code = (await ws.getStepSource("acme/linear/create-issue"))!.code;
    assert.ok(code.startsWith("// tuned here\n") && code.endsWith("// 1.1\n"), "both changes are in it");
    assert.equal(await ws.getStepMetadata("acme/linear/close-issue"), null, "untouched and dropped: retired");
    // The workflow the same way.
    const report = (await ws.getWorkflowMetadata("acme/linear/report"))!;
    assert.equal(report.active, "v4");
    assert.equal(report.versions["v3"]?.source, "install");
    assert.deepEqual([report.versions["v4"]?.source, report.versions["v4"]?.upstream?.digest], ["update", digest2]);
    assert.equal(await ws.getWorkflowSource("acme/linear/report", "v4"), `${WORKFLOW("acme/linear/report", "forked here")}${NOTE}`);
    assert.equal((await ws.getWorkflowMetadata("acme/linear/old"))?.active, "v2", "a dropped fork is kept");
    assert.deepEqual((await strut.run("acme/linear/sync", {})).output, { greeting: "hi" }, "the carried step runs, with the updated helper");

    // The fold: at the release, the forks still forks, their base the release.
    const [listed] = await api.list();
    assert.deepEqual([listed!.version, listed!.digest, listed!.door], ["1.1.0", digest2, "install"]);
    assert.deepEqual(listed!.items.filter((i) => i.modified).map((i) => [i.name, i.installed, i.active]), [
      ["acme/linear/old", "v1", "v2"],
      ["acme/linear/report", "v3", "v4"],
      ["acme/linear/create-issue", "v3", "v4"],
    ]);
    // What is left of the local patch is the change made here, over 1.1.
    const left = await (await api.patch("acme/linear")).text();
    assert.match(left, new RegExp(`^package: acme/linear\\nonto: ${digest2}\\n`));
    assert.doesNotMatch(left, /id: note/, "the release's change is not this strut's");

    // The same release again writes nothing.
    const again = await api.update("acme/linear", { ref: `file:${d2}` });
    assert.equal(again.status, 200);
    assert.equal(again.body.packages[0]!.status, "present");
    assert.deepEqual(again.body.packages[0]!.items.filter((i) => i.status !== "present").map((i) => [i.name, i.status]), [
      ["acme/linear/create-issue", "modified"],
      ["acme/linear/old", "kept"],
      ["acme/linear/report", "modified"],
    ]);
    assert.equal((await ws.getWorkflowMetadata("acme/linear/report"))!.versions["v5"], undefined);

    // The way back: what the update moved, at the versions before it.
    const back = await api.rollback("acme/linear");
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual(back.body.from, { version: "1.1.0", digest: digest2 });
    assert.deepEqual(back.body.to, { version: "1.0.0", digest: digest1 });
    assert.deepEqual(back.body.restored, [
      { kind: "step", name: "acme/linear/_shared", version: "v1" },
      { kind: "step", name: "acme/linear/create-issue", version: "v2" },
      { kind: "workflow", name: "acme/linear/report", version: "v2" },
    ]);
    assert.deepEqual(back.body.left, []);
    assert.equal((await ws.getWorkflowMetadata("acme/linear/report"))!.active, "v2");
    assert.deepEqual((await strut.run("acme/linear/sync", {})).output, { greeting: "hello" });
    const none = await api.rollback("acme/linear");
    assert.equal(none.status, 404);
    assert.match(none.body.error!, /^package_no_update: /);
  });

  it("refuses the whole update for a fork that does not carry, then takes a patch that covers it", async () => {
    const d1 = await writeTree(RELEASE_1, "r1");
    await api.install(`file:${d1}`);
    await ws.publishWorkflow("acme/linear/report", "v2", WORKFLOW("acme/linear/report", "forked here"));
    // The release rewrites the line the fork changed.
    const d2 = await writeTree({ ...RELEASE_2, "workflows/report.yaml": WORKFLOW("acme/linear/report", "Report the issues") }, "r2");
    const { digest: digest2 } = await readPackage(d2);

    const refused = await api.update("acme/linear", { ref: `file:${d2}` });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(
      refused.body.error!,
      /^package_update_conflict: acme\/linear 1\.1\.0 was not applied, and nothing was written — the workflow acme\/linear\/report — its change here and the release's change touch the same lines\. Hand in a patch that covers it/,
    );
    assert.equal((await ws.getStepMetadata("acme/linear/create-issue"))!.active, "v1", "nothing was written");
    assert.equal((await ws.getStepMetadata("acme/linear/_shared"))!.active, "v1");
    assert.equal((await api.list())[0]!.version, "1.0.0");

    // A patch for another release, then one made before the fork moved.
    const resolved = WORKFLOW("acme/linear/report", "Report the issues, forked here");
    const patch = await patchFor(d2, "workflows/report.yaml", resolved, await activeHash("acme/linear/report"));
    const other = await api.update("acme/linear", { ref: `file:${d1}`, patch });
    assert.equal(other.status, 400);
    assert.match(other.body.error!, /^patch_mismatch: the patch applies to the release sha256:[0-9a-f]+, and this update is to sha256:/);
    const stale = await api.update("acme/linear", { ref: `file:${d2}`, patch: patch.replace(/(report\.yaml=)\S+/, "$1abc") });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error!, /^patch_stale: acme\/linear\/report was edited again after the patch was made/);
    const bad = await api.update("acme/linear", { ref: `file:${d2}`, patch: "not a patch" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error!, /^patch_invalid: /);
    const unknown = await api.update("acme/linear", { ref: `file:${d2}`, patch: digest2 });
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error!, /^patch_unknown: /);

    // Kept here by its digest, it lands: the patch's result on the release's file.
    const kept = await new PatchStore(join(root, "workspace", "packages", "patches")).put(patch);
    const r = await api.update("acme/linear", { ref: `file:${d2}`, patch: kept });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(statuses(r.body).filter(([, name]) => name === "acme/linear/report"), [["workflow", "acme/linear/report", "replayed"]]);
    const report = (await ws.getWorkflowMetadata("acme/linear/report"))!;
    assert.equal(report.versions[report.active]?.source, "update");
    assert.equal(await ws.getWorkflowSource("acme/linear/report", report.active), resolved);
    assert.equal((await ws.getStepMetadata("acme/linear/_shared"))!.active, "v2", "and the rest of the release with it");
  });

  it("makes an item untouched again when the release holds the change, and leaves a fork the release did not touch", async () => {
    const d1 = await writeTree(RELEASE_1, "r1");
    await api.install(`file:${d1}`);
    // Here: a description. 1.1's report has that description, and a step more.
    await ws.publishWorkflow("acme/linear/report", "v2", WORKFLOW("acme/linear/report", "forked here"));
    await ws.publishWorkflow("acme/linear/sync", "v2", WORKFLOW("acme/linear/sync", "forked here"));
    const d2 = await writeTree({ ...RELEASE_2, "workflows/report.yaml": `${WORKFLOW("acme/linear/report", "forked here")}${NOTE}` }, "r2");
    const r = await api.update("acme/linear", { ref: `file:${d2}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const of = (res: InstallResult, name: string) => res.packages[0]!.items.find((i) => i.name === name)!.status;
    assert.equal(of(r.body, "acme/linear/report"), "updated", "the patch is empty: the release's version is active");
    assert.equal(of(r.body, "acme/linear/sync"), "modified", "the release did not touch it: the fork stands");
    const report = (await ws.getWorkflowMetadata("acme/linear/report"))!;
    assert.equal(report.versions[report.active]?.source, "install");
    const listed = (await api.list())[0]!.items;
    assert.equal(listed.find((i) => i.name === "acme/linear/report")!.modified, false, "it follows the next release");
    assert.equal(listed.find((i) => i.name === "acme/linear/sync")!.modified, true);
    assert.deepEqual(Object.keys((await ws.getWorkflowMetadata("acme/linear/sync"))!.versions), ["v1", "v2"], "nothing was written for it");

    // A fork that already IS what the next release ships: nothing to write,
    // and nothing of this strut's in the local patch. Its version stays this
    // strut's on record until a release changes the item again.
    const next = `${WORKFLOW("acme/linear/report", "forked here")}${NOTE}${NOTE.replace("note", "more")}`;
    await ws.publishWorkflow("acme/linear/report", "v4", next);
    const d3 = await writeTree({ ...RELEASE_2, "strut.yaml": "package: acme/linear\nversion: 1.2.0\n", "steps/_shared.ts": 'export const greeting = "hey";\n', "workflows/report.yaml": next }, "r3");
    const third = await api.update("acme/linear", { ref: `file:${d3}` });
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.equal(of(third.body, "acme/linear/report"), "present");
    const local = await (await api.patch("acme/linear")).text();
    assert.match(local, /^package: acme\/linear\nonto: sha256:[0-9a-f]+\nover: workflows\/sync\.yaml=\S+\ndiff --git /, "only sync is this strut's change");
  });

  it("refuses a carried step that no longer loads, a package that is not here, and one the distro owns", async () => {
    const d1 = await writeTree(RELEASE_1, "r1");
    await api.install(`file:${d1}`);
    // The fork adds a line that uses a name the release stops importing: the
    // two merge, and what they make does not load.
    await ws.publishStep("acme/linear/create-issue", `${STEP("acme/linear/create-issue")}export const local = greeting;\n`);
    await strut.rebuildRegistry();
    const d2 = await writeTree({ ...RELEASE_2, "steps/_shared.ts": 'export const hello = "hi";\n', "steps/create-issue.ts": STEP("acme/linear/create-issue").replace("{ greeting } from", "{ hello } from").replace("{ greeting };", "{ greeting: hello };") }, "r2");
    const r = await api.update("acme/linear", { ref: `file:${d2}` });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error!, /^package_update_conflict: .* — the step acme\/linear\/create-issue — .*greeting.* \(with the changes carried onto the release\)/);
    assert.equal((await ws.getStepMetadata("acme/linear/_shared"))!.active, "v1", "nothing was written");

    const missing = await api.update("acme/other", {});
    assert.equal(missing.status, 404);
    assert.match(missing.body.error!, /^package_not_installed: /);
    const name = await api.update("acme/linear", { ref: `file:${await writeTree({ ...RELEASE_2, "strut.yaml": "package: acme/other\nversion: 1.0.0\n", "steps/create-issue.ts": STEP("acme/other/create-issue"), "workflows/sync.yaml": WORKFLOW("acme/other/sync"), "workflows/report.yaml": WORKFLOW("acme/other/report"), "workflows/triage.yaml": WORKFLOW("acme/other/triage") }, "other")}` });
    assert.equal(name.status, 400);
    assert.match(name.body.error!, /^package_name_mismatch: .* is the package acme\/other, not acme\/linear/);

    await strut.packages.install(`file:${await writeTree({ "strut.yaml": "package: ops/fleet\nversion: '1'\n", "workflows/go.yaml": "name: ops/fleet/go\nsteps:\n  - { id: s, type: log, config: { message: go } }\n" }, "fleet")}`, { door: "distro" });
    const owned = await api.update("ops/fleet", {});
    assert.equal(owned.status, 409);
    assert.match(owned.body.error!, /^package_distro_owned: /);
  });

  it("says what is missing where there is no git: a fork cannot be carried, nothing is written", async () => {
    const d1 = await writeTree(RELEASE_1, "r1");
    await api.install(`file:${d1}`);
    await ws.publishWorkflow("acme/linear/report", "v2", WORKFLOW("acme/linear/report", "forked here"));
    const deps = {
      workspace: strut.workspace,
      cache: packageCache(strut.dataDir),
      apps: strut.apps,
      getRegistry: async () => {
        await strut.rebuildRegistry();
        return strut.getRegistry();
      },
      git: async () => ({ missing: "git is not on PATH" }),
    };
    await assert.rejects(
      updatePackage(deps, "acme/linear", { ref: `file:${await writeTree(RELEASE_2, "r2")}` }),
      /^Error: package_update_conflict: .* — the workflow acme\/linear\/report — carrying a change onto a release needs git, and git is not on PATH/,
    );
    assert.equal((await ws.getStepMetadata("acme/linear/_shared"))!.active, "v1");
    // With no fork there is nothing to carry, and no git is asked for.
    await ws.setActiveVersion("acme/linear/report", "v1");
    const r = await updatePackage(deps, "acme/linear", { ref: `file:${await writeTree(RELEASE_2, "r2b")}` });
    assert.equal(r.packages[0]!.status, "updated");
  });
});

describe("updating a package's app", { skip: git ? false : "no git here" }, () => {
  let strut: Strut;
  let api: ReturnType<typeof client>;
  const APP = (title = "Board", body = "board") => ({
    "app.yaml": `title: ${title}\n`,
    "src/App.tsx": `import { Header } from "./Header";\nexport default function App() { return <main><Header />${body}</main>; }\n`,
    "src/Header.tsx": "export function Header() { return <h1>Board</h1>; }\n",
  });
  const release = (version: string, app: Record<string, string>) => ({
    "strut.yaml": `package: acme/board\nversion: ${version}\n`,
    ...Object.fromEntries(Object.entries(app).map(([rel, text]) => [`apps/ui/${rel}`, text])),
  });
  /** Publish `files` over the app, as a person editing it here. */
  const edit = async (files: Record<string, string>) => {
    const dir = join(strut.dataDir, "drafts", crypto.randomUUID());
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    const r = await strut.apps.publish(dir, "acme/board/ui", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    return r.version;
  };
  const fileOf = async (version: string, rel: string) => readFile(join((await strut.apps.versionDir("acme/board/ui", version))!.path, rel), "utf8");

  beforeEach(async () => {
    strut = await boot(new WorkspaceManager(join(root, "workspace")), { kit: await kitForTests() });
    api = client(strut);
  });
  afterEach(async () => {
    await strut.close?.();
  });

  it("merges it per file, builds the result, and makes a draft of it where a person holds the app", async () => {
    assert.equal((await api.install(`file:${await writeTree(release("1.0.0", APP()), "b1")}`)).status, 201);
    // Here: another header. Upstream: another body, a new file.
    const fork = await edit({ ...APP(), "src/Header.tsx": "export function Header() { return <h1>Our board</h1>; }\n" });
    const r = await api.update("acme/board", { ref: `file:${await writeTree(release("1.1.0", { ...APP("Board", "board 1.1"), "src/New.tsx": "export const NEW = 1;\n" }), "b2")}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.packages[0]!.items.map((i) => [i.kind, i.name, i.status, i.previous]), [["app", "acme/board/ui", "replayed", fork]]);
    const rec = (await strut.workspace.getApp("acme/board/ui"))!;
    const merged = rec.active;
    assert.equal(rec.versions[merged]?.source, "update");
    assert.equal(rec.versions[merged]?.upstream?.version, "1.1.0");
    assert.match(await fileOf(merged, "src/Header.tsx"), /Our board/);
    assert.match(await fileOf(merged, "src/App.tsx"), /board 1\.1/);
    assert.equal(await fileOf(merged, "src/New.tsx"), "export const NEW = 1;\n");
    assert.match(await fileOf(merged, "dist/index.html"), /<html/i, "it was built");

    // Held at what people use: the next update's result is a draft.
    await strut.apps.promote("acme/board/ui", merged);
    const held = await api.update("acme/board", { ref: `file:${await writeTree(release("1.2.0", { ...APP("Board", "board 1.2"), "src/New.tsx": "export const NEW = 1;\n" }), "b3")}` });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    const draft = held.body.packages[0]!.items[0]!;
    assert.equal(draft.status, "replayed");
    assert.equal((await strut.workspace.getApp("acme/board/ui"))!.active, merged, "what people open did not move");
    assert.match(await fileOf(draft.version!, "src/App.tsx"), /board 1\.2/);
    assert.match(await fileOf(draft.version!, "src/Header.tsx"), /Our board/);

    // The same file changed on both sides: not carried, nothing written.
    const clash = await api.update("acme/board", { ref: `file:${await writeTree(release("1.3.0", { ...APP("Board", "board 1.2"), "src/Header.tsx": "export function Header() { return <h1>The board</h1>; }\n", "src/New.tsx": "export const NEW = 1;\n" }), "b4")}` });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.match(clash.body.error!, /^package_update_conflict: acme\/board 1\.3\.0 was not applied, and nothing was written — the app acme\/board\/ui — its change here and the release's change collide in src\/Header\.tsx/);
  });
});

for (const tb of testBackends()) {
  describe(`updating an installed package on a graph workspace (${tb.name})`, { skip: tb.skip || (git ? false : "no git here") }, () => {
    let backend: GraphBackend;
    let scratch: string;
    let strut: Strut;
    let api: ReturnType<typeof client>;
    before(async () => {
      backend = await tb.open();
      await tb.wipe(backend);
      await seedStrutDomain(backend);
      backend.schemas.invalidate();
    });
    after(async () => {
      await tb.close(backend);
    });
    beforeEach(async () => {
      await tb.clear(backend);
      scratch = await mkdtemp(join(tmpdir(), "strut-update-graph-"));
      strut = await boot(new GraphWorkspaceStore(backend, { materializeDir: join(scratch, "steps"), appsDir: join(scratch, "apps") }), { dataDir: scratch });
      api = client(strut);
    });
    afterEach(async () => {
      await strut.close?.();
      await rm(scratch, { recursive: true, force: true });
    });

    it("carries a workflow and a step onto the release, and rolls back", async () => {
      const ws = strut.workspace;
      assert.equal((await api.install(`file:${await writeTree(RELEASE_1, "r1")}`)).status, 201);
      await ws.publishWorkflow("acme/linear/report", "v2", WORKFLOW("acme/linear/report", "forked here"));
      await ws.publishStep("acme/linear/create-issue", `// tuned here\n${STEP("acme/linear/create-issue")}`);
      await strut.rebuildRegistry();
      const d2 = await writeTree(RELEASE_2, "r2");
      const r = await api.update("acme/linear", { ref: `file:${d2}` });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(statuses(r.body).filter(([, , status]) => status === "replayed"), [
        ["step", "acme/linear/create-issue", "replayed"],
        ["workflow", "acme/linear/report", "replayed"],
      ]);
      const report = (await ws.getWorkflowMetadata("acme/linear/report"))!;
      assert.deepEqual([report.versions[report.active]?.source, report.versions[report.active]?.upstream?.digest], ["update", (await readPackage(d2)).digest]);
      assert.equal(await ws.getWorkflowSource("acme/linear/report", report.active), `${WORKFLOW("acme/linear/report", "forked here")}${NOTE}`);
      assert.deepEqual((await strut.run("acme/linear/sync", {})).output, { greeting: "hi" });
      assert.equal((await api.list())[0]!.version, "1.1.0");

      const back = await api.rollback("acme/linear");
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.deepEqual(back.body.restored.map((i) => i.name), ["acme/linear/_shared", "acme/linear/create-issue", "acme/linear/report"]);
      assert.deepEqual((await strut.run("acme/linear/sync", {})).output, { greeting: "hello" });
    });
  });
}
