/**
 * BUNDLES (stadeum plans/software.md §3.3, §5 item 5): one subscription to
 * a repository whose `strut.yaml` lists other packages by the branch each
 * is followed at (`bundle:`, ./format.ts), each followed as a part of its
 * own (./subscriptions.ts).
 *
 * The fixture repositories are on disk; a shell in front of git plays them
 * as GitHub's (`https://github.com/acme/<name>`), so each read is sent the
 * token the subscription's person has for github.com, and records it.
 * Each repository's `stable` branch is moved by the test's commits.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageAutomationId } from "../automations.js";
import { createStrut, type Strut } from "../createStrut.js";
import type { AutomationView } from "../scheduler.js";
import { runProcess, type ProcessRequest, type ProcessResult } from "../shell.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { readPackage } from "./format.js";
import type { InstalledPackage } from "./installed.js";
import { partIdOf, type SubscriptionInfo, type SyncOutcome } from "./subscriptions.js";

const KEY = "bundles-api-key";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Where each fixture repository is "hosted": GitHub, so a person's own GITHUB_TOKEN reads it. */
const remote = (name: string) => `https://github.com/acme/${name}`;
const refOf = (name: string, branch = "stable") => `git+${remote(name)}@${branch}`;
const SUITE = refOf("suite");

/** The package `acme/<name>` at `version`: one workflow, and what `extra` adds to its strut.yaml. */
const PKG = (name: string, version: string, extra = ""): Record<string, string> => ({
  "strut.yaml": `package: acme/${name}\nversion: ${version}\n${extra}`,
  "workflows/sync.yaml": `name: acme/${name}/sync\ndescription: ${name} ${version}\nsteps:\n  - id: say\n    type: log\n    config: { message: "${name} ${version}" }\n`,
});
const NEEDS_KEY = "requires:\n  secrets: [TWO_KEY]\n";
const SCHEDULED = "schedules:\n  - workflow: sync\n    trigger: { every: interval, minutes: 15 }\n";
/** The bundle `acme/suite` at `version`, listing `refs`. */
const BUNDLE = (version: string, refs: string[]): Record<string, string> => ({
  "strut.yaml": `package: acme/suite\nversion: ${version}\ndescription: Everything acme ships\nbundle:\n${refs.map((r) => `  - ${r}\n`).join("")}`,
  "README.md": "# acme's suite\n",
});

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_SECRET_KEY"] = "bundles-secret";
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("a bundle", () => {
  let root: string;
  let ws: WorkspaceManager;
  let store: MemoryRunStore;
  let strut: Strut;
  /** Each fixture repository's directory, by name. */
  let repos: Record<string, string>;
  /** The token each fetch was sent, by repository (undefined: none). */
  let fetched: Array<{ repo: string; token: string | undefined }>;

  /** git, with every fixture repository answering for its github.com URL. */
  const shell = async (req: ProcessRequest): Promise<ProcessResult> => {
    if (req.cmd !== "git") return runProcess(req);
    const via = Object.entries(repos).flatMap(([name, dir]) => ["-c", `url.${pathToFileURL(dir).href}.insteadOf=${remote(name)}`]);
    // A fetch runs in the repository's bare cache, `…/github.com/acme/<name>.git`.
    if (req.args?.includes("fetch")) fetched.push({ repo: (req.cwd ?? "").split("/").pop()!.replace(/\.git$/, ""), token: req.env?.["STRUT_GIT_TOKEN"] });
    return runProcess({ ...req, args: [...via, ...(req.args ?? [])] });
  };
  /** Commit `files` (relative to the repository) on the repository's current branch. */
  const commit = async (name: string, files: Record<string, string>): Promise<string> => {
    if (!repos[name]) {
      repos[name] = join(root, "repos", name);
      await mkdir(repos[name], { recursive: true });
      git(repos[name], "-c", "init.defaultBranch=stable", "init", "--quiet");
    }
    const dir = repos[name];
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", "release");
    return git(dir, "rev-parse", "HEAD");
  };

  const call = async (method: string, path: string, body?: unknown, as?: string) => {
    const res = await strut.app.request(path, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(as ? { "x-strut-actor": as } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  /** Follow `ref` as `id` (made by `as`), then sync it now: the outcome of a sync after the PUT's own. */
  const follow = async (id: string, ref: string, as?: string): Promise<SyncOutcome> => {
    const put = await call("PUT", `/packages/subscriptions/${id}`, { ref }, as);
    assert.equal(put.status, 200, JSON.stringify(put.json));
    return sync(id);
  };
  const sync = async (id = "suite"): Promise<SyncOutcome> => {
    const out = await call("POST", `/packages/subscriptions/${id}/sync`);
    assert.equal(out.status, 200, JSON.stringify(out.json));
    return out.json;
  };
  const subscriptions = async (): Promise<SubscriptionInfo[]> => (await call("GET", "/packages/subscriptions")).json.subscriptions;
  const subscription = async (id = "suite"): Promise<SubscriptionInfo> => (await subscriptions()).find((s) => s.id === id)!;
  const installed = async (name: string): Promise<InstalledPackage | undefined> => ((await call("GET", "/packages")).json.packages as InstalledPackage[]).find((p) => p.package === name);
  /** Who installed a package (`source.ref`), and at which version; undefined when it is not here. */
  const at = async (name: string) => {
    const p = await installed(name);
    return p ? { by: p.source?.ref, version: p.version } : undefined;
  };
  const part = (name: string) => partIdOf("suite", refOf(name));
  const by = (name: string) => `subscription:${part(name)}`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-bundles-"));
    repos = {};
    fetched = [];
    ws = new WorkspaceManager(join(root, "box"));
    store = new MemoryRunStore();
    strut = await createStrut({
      workspace: ws,
      store,
      dataDir: join(root, "data"),
      services: { shell },
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      concepts: false,
      stt: false,
      subscriptionPoll: false,
    });
  });
  afterEach(async () => {
    await strut.close();
    await rm(root, { recursive: true, force: true });
  });

  it("is followed as one: each part on its own branch, a part's release with no release of the bundle", async () => {
    const one1 = await commit("one", PKG("one", "0.1.0"));
    const two1 = await commit("two", PKG("two", "0.1.0"));
    const suite1 = await commit("suite", BUNDLE("0.1.0", [refOf("one"), refOf("two")]));

    const first = await follow("suite", SUITE);
    assert.notEqual(first.status, "error", JSON.stringify(first));
    // One subscription: the parts are in it, never beside it.
    const subs = await subscriptions();
    assert.deepEqual(subs.map((s) => s.id), ["suite"]);
    let s = subs[0]!;
    assert.deepEqual(s.applied?.bundle, { package: "acme/suite", version: "0.1.0", refs: [refOf("one"), refOf("two")] });
    assert.deepEqual([s.applied?.commit, s.applied?.packages, s.error], [suite1, [], undefined], "nothing of the bundle itself is installed");
    assert.deepEqual(
      s.parts!.map((p) => [p.id, p.ref, p.applied?.commit, p.packages.map((x) => `${x.package}@${x.version}`)]),
      [
        [part("one"), refOf("one"), one1, ["acme/one@0.1.0"]],
        [part("two"), refOf("two"), two1, ["acme/two@0.1.0"]],
      ],
    );
    assert.deepEqual(s.packages.map((p) => p.package), ["acme/one", "acme/two"], "the bundle's packages are its parts'");
    assert.deepEqual(s.parts!.map((p) => p.checkedAt), [s.checkedAt, s.checkedAt], "the bundle's read is done when its parts' are");
    assert.match(part("one"), /^suite\/one-[0-9a-f]{8}$/);
    assert.deepEqual([await at("acme/one"), await at("acme/two")], [{ by: by("one"), version: "0.1.0" }, { by: by("two"), version: "0.1.0" }]);
    assert.equal((await installed("acme/one"))?.door, "distro");

    // A release of one part: the next sync moves it alone, with no bundle release.
    const one2 = await commit("one", PKG("one", "0.2.0"));
    let out = await sync();
    assert.equal(out.status, "applied");
    assert.deepEqual([out.from, out.to], [suite1, suite1], "the bundle did not move");
    assert.deepEqual(out.parts!.map((p) => [p.id, p.status, p.from, p.to]), [[part("one"), "applied", one1, one2], [part("two"), "current", two1, two1]]);
    assert.deepEqual([(await at("acme/one"))?.version, (await at("acme/two"))?.version], ["0.2.0", "0.1.0"]);

    // The other part's release, then nothing new.
    await commit("two", PKG("two", "0.2.0"));
    out = await sync();
    assert.deepEqual(out.parts!.map((p) => p.status), ["current", "applied"]);
    assert.equal((await at("acme/two"))?.version, "0.2.0");
    out = await sync();
    assert.deepEqual([out.status, ...out.parts!.map((p) => p.status)], ["current", "current", "current"]);
    s = await subscription();
    assert.deepEqual(s.parts!.map((p) => p.applied?.packages.map((x) => x.version)), [["0.2.0"], ["0.2.0"]]);

    // Nothing installs a bundle: it is followed.
    const install = await call("POST", "/packages/install", { ref: SUITE });
    assert.equal(install.status, 400);
    assert.match(install.json.error, /^package_is_bundle: acme\/suite is a bundle of 2 package\(s\), followed by their branches, not installed — subscribe to its repository/);
  });

  it("a part that waits for its secret holds back no other, and goes in once the secret is set", async () => {
    await commit("one", PKG("one", "0.1.0"));
    await commit("two", PKG("two", "0.1.0", NEEDS_KEY));
    await commit("suite", BUNDLE("0.1.0", [refOf("one"), refOf("two")]));

    let out = await follow("suite", SUITE);
    assert.equal(out.status, "waiting");
    assert.deepEqual(out.waiting, { secrets: ["TWO_KEY"] });
    assert.deepEqual(out.parts!.map((p) => [p.status, p.waiting?.secrets]), [["current", undefined], ["waiting", ["TWO_KEY"]]]);
    let s = await subscription();
    assert.deepEqual(s.waiting, { secrets: ["TWO_KEY"] }, "what its parts wait for, on the bundle");
    assert.deepEqual(s.parts!.map((p) => p.waiting), [undefined, { secrets: ["TWO_KEY"] }]);
    assert.deepEqual([await at("acme/one"), await at("acme/two")], [{ by: by("one"), version: "0.1.0" }, undefined], "one is in; two, nothing of it");

    // The secret set: the next sync brings it in, with no release of anything.
    assert.equal((await call("PUT", "/secrets/TWO_KEY", { value: "k" })).status, 200);
    out = await sync();
    assert.equal(out.status, "applied");
    assert.deepEqual(out.parts!.map((p) => p.status), ["current", "applied"]);
    assert.deepEqual(await at("acme/two"), { by: by("two"), version: "0.1.0" });
    s = await subscription();
    assert.equal(s.waiting, undefined);

    // Removed: two goes out at the next sync, one stays.
    assert.equal((await call("DELETE", "/secrets/TWO_KEY")).status, 200);
    out = await sync();
    assert.deepEqual([out.status, ...out.parts!.map((p) => p.status)], ["waiting", "current", "waiting"]);
    assert.deepEqual([await at("acme/one"), await at("acme/two")], [{ by: by("one"), version: "0.1.0" }, undefined]);
  });

  it("is its person's: they own what every part installs, each repository is read with their own token, and a part's schedule runs as them", async () => {
    await commit("one", PKG("one", "0.1.0", SCHEDULED));
    await commit("two", PKG("two", "0.1.0"));
    await commit("suite", BUNDLE("0.1.0", [refOf("one"), refOf("two")]));
    // A deployment value that happens to be set: no person's subscription reads with it.
    assert.equal((await call("PUT", "/secrets/GITHUB_TOKEN", { value: "deployment-token" })).status, 200);
    assert.equal((await call("PUT", "/actors/alice/secrets/GITHUB_TOKEN", { value: "alice-token" })).status, 200);

    const out = await follow("suite", SUITE, "alice");
    assert.notEqual(out.status, "error", JSON.stringify(out));
    const s = await subscription();
    assert.deepEqual([s.actor, ...s.parts!.map((p) => p.actor)], ["alice", "alice", "alice"]);
    assert.deepEqual([...new Set(fetched.map((f) => f.repo))].sort(), ["one", "suite", "two"]);
    assert.deepEqual([...new Set(fetched.map((f) => f.token))], ["alice-token"], "the bundle and every part read with her own token, never the deployment's");
    const owner = async (wf: string) => (await ws.getWorkflowMetadata(wf))?.owner;
    assert.deepEqual([await owner("acme/one/sync"), await owner("acme/two/sync")], ["alice", "alice"]);

    // The part's schedule: an automation that runs as her.
    const id = packageAutomationId("acme/one", "sync");
    const a = ((await call("GET", "/automations")).json.automations as AutomationView[]).find((x) => x.id === id)!;
    assert.deepEqual([a.workflow, a.runsAs, a.nobodyToRunAs], ["acme/one/sync", "alice", undefined]);
    const fired = await call("POST", `/workflows/${encodeURIComponent("acme/one/sync")}/automations/${id}/fire`);
    assert.equal(fired.status, 202, JSON.stringify(fired.json));
    let start;
    for (let i = 0; i < 400 && !start; i++) {
      start = (await store.getRunEvents("acme/one/sync", fired.json.runId)).find((e) => e.type === "run.start");
      if (!start) await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(start?.principal, "alice");
  });

  it("follows a release of the bundle that adds a part and drops one, and one that moves a part to another branch", async () => {
    await commit("one", PKG("one", "0.1.0"));
    await commit("two", PKG("two", "0.1.0"));
    await commit("three", PKG("three", "0.1.0"));
    await commit("suite", BUNDLE("0.1.0", [refOf("one"), refOf("two")]));
    await follow("suite", SUITE);
    assert.deepEqual([(await at("acme/one"))?.by, (await at("acme/two"))?.by], [by("one"), by("two")]);
    // Edited here: a fork, which outlives the part.
    await ws.publishWorkflow("acme/two/sync", "v9", "name: acme/two/sync\nsteps:\n  - { id: s, type: log, config: { message: mine } }\n");

    await commit("suite", BUNDLE("0.2.0", [refOf("one"), refOf("three")]));
    let out = await sync();
    assert.equal(out.status, "applied");
    assert.deepEqual(out.parts!.map((p) => [p.id, p.status]), [[part("one"), "current"], [part("three"), "applied"]]);
    const s = await subscription();
    assert.deepEqual(s.applied?.bundle?.version, "0.2.0");
    assert.deepEqual(s.parts!.map((p) => p.id), [part("one"), part("three")]);
    assert.deepEqual(await at("acme/three"), { by: by("three"), version: "0.1.0" });
    // Two stopped as a subscription stops with ?uninstall=1: what was untouched goes, the fork stays.
    const two = await installed("acme/two");
    assert.deepEqual(two?.items.map((i) => [i.name, i.modified]), [["acme/two/sync", true]], "only the fork is left");
    assert.equal((await ws.getWorkflowMetadata("acme/two/sync"))?.active, "v9");
    // What is left is nobody's to follow: two's release moves nothing.
    await commit("two", PKG("two", "0.2.0"));
    out = await sync();
    assert.deepEqual(out.parts!.map((p) => p.status), ["current", "current"]);
    assert.equal((await ws.getWorkflowMetadata("acme/two/sync"))?.active, "v9");

    // One part moved to another branch: the same part, updated in place.
    git(repos["one"]!, "checkout", "--quiet", "-b", "next");
    const next = await commit("one", PKG("one", "0.9.0"));
    git(repos["one"]!, "checkout", "--quiet", "stable");
    await commit("suite", BUNDLE("0.3.0", [refOf("one", "next"), refOf("three")]));
    out = await sync();
    assert.equal(partIdOf("suite", refOf("one", "next")), part("one"), "a part is its repository folder, at any branch");
    assert.deepEqual(out.parts!.map((p) => [p.id, p.status, p.to]), [[part("one"), "applied", next], [part("three"), "current", out.parts![1]!.to]]);
    assert.deepEqual(await at("acme/one"), { by: by("one"), version: "0.9.0" });
    assert.equal((await ws.getWorkflowMetadata("acme/one/sync"))?.active, "v2", "updated, never uninstalled and installed again");
  });

  it("stops as one: with uninstall everything it brought goes, without it stays and nothing follows it", async () => {
    await commit("one", PKG("one", "0.1.0"));
    await commit("two", PKG("two", "0.1.0"));
    await commit("suite", BUNDLE("0.1.0", [refOf("one"), refOf("two")]));
    await follow("suite", SUITE);

    // Without uninstall: the subscription and its parts go; the packages stay, the distro's.
    let del = await call("DELETE", "/packages/subscriptions/suite");
    assert.deepEqual([del.status, del.json.removed, del.json.uninstalled], [200, true, []]);
    assert.deepEqual(await subscriptions(), []);
    assert.deepEqual([(await installed("acme/one"))?.door, (await at("acme/one"))?.by], ["distro", by("one")]);
    await commit("one", PKG("one", "0.2.0"));
    assert.deepEqual(await strut.subscriptions.syncAll(), [], "nothing follows them");
    assert.equal((await at("acme/one"))?.version, "0.1.0");

    // Followed again: the parts are the same, and take their packages back.
    const out = await follow("suite", SUITE);
    assert.deepEqual([out.status, (await subscription()).parts!.map((p) => p.id)], ["current", [part("one"), part("two")]]);
    assert.deepEqual([await at("acme/one"), await at("acme/two")], [{ by: by("one"), version: "0.2.0" }, { by: by("two"), version: "0.1.0" }]);

    // With uninstall: everything every part installed goes.
    del = await call("DELETE", "/packages/subscriptions/suite?uninstall=1");
    assert.deepEqual([del.status, del.json.uninstalled.sort()], [200, ["acme/one", "acme/two"]]);
    assert.deepEqual([await at("acme/one"), await at("acme/two"), await ws.getWorkflowMetadata("acme/one/sync")], [undefined, undefined, null]);
    assert.deepEqual(await subscriptions(), []);
  });

  it("one package, one subscription: a package another follows is left to it; one installed by another door is taken", async () => {
    await commit("one", PKG("one", "0.1.0"));
    await commit("two", PKG("two", "0.1.0"));
    await commit("suite", BUNDLE("0.1.0", [refOf("one"), refOf("two")]));
    // One followed by itself; two installed by a person's door.
    assert.notEqual((await follow("one", refOf("one"))).status, "error");
    const installTwo = await call("POST", "/packages/install", { ref: refOf("two") });
    assert.equal(installTwo.status, 201, JSON.stringify(installTwo.json));
    assert.deepEqual([(await installed("acme/two"))?.door, (await at("acme/two"))?.by], ["install", refOf("two")]);

    let out = await follow("suite", SUITE);
    assert.equal(out.status, "held");
    assert.deepEqual(out.held, [{ package: "acme/one", by: "subscription:one" }]);
    assert.deepEqual(out.parts!.map((p) => [p.status, p.held]), [["held", [{ package: "acme/one", by: "subscription:one" }]], ["current", undefined]]);
    assert.deepEqual(await at("acme/one"), { by: "subscription:one", version: "0.1.0" }, "left to the subscription that follows it");
    assert.deepEqual([(await installed("acme/two"))?.door, (await at("acme/two"))?.by], ["distro", by("two")], "nobody followed it: the part does now");
    const s = await subscription();
    assert.deepEqual(s.held, [{ package: "acme/one", by: "subscription:one" }]);
    assert.deepEqual(s.parts![0]!.packages, [], "a held package is not the part's");

    // The other one moves it; the part still leaves it alone.
    await commit("one", PKG("one", "0.2.0"));
    assert.equal((await sync("one")).status, "applied");
    assert.deepEqual((await sync()).parts!.map((p) => p.status), ["held", "current"]);
    assert.deepEqual(await at("acme/one"), { by: "subscription:one", version: "0.2.0" });

    // It stops (its package stays): the part takes it at its next sync.
    assert.equal((await call("DELETE", "/packages/subscriptions/one")).status, 200);
    out = await sync();
    assert.deepEqual([out.status, out.held, ...out.parts!.map((p) => p.status)], ["applied", undefined, "applied", "current"]);
    assert.deepEqual(await at("acme/one"), { by: by("one"), version: "0.2.0" });

    // And the other way: a subscription made now leaves it to the part.
    const late = await follow("late", refOf("one"));
    assert.deepEqual([late.status, late.held], ["held", [{ package: "acme/one", by: by("one") }]]);
    assert.equal((await at("acme/one"))?.by, by("one"));
  });

  it("never lists a bundle: such a part fails and says so, and the others go in", async () => {
    await commit("one", PKG("one", "0.1.0"));
    await commit("inner", { "strut.yaml": `package: acme/inner\nversion: 0.1.0\nbundle:\n  - ${refOf("two")}\n` });
    await commit("suite", BUNDLE("0.1.0", [refOf("one"), refOf("inner")]));
    const out = await follow("suite", SUITE);
    assert.equal(out.status, "error");
    assert.equal(out.error, undefined, "the bundle itself was read");
    assert.deepEqual(out.parts!.map((p) => p.status), ["current", "error"]);
    assert.match(out.parts![1]!.error!, /^package_is_bundle: .*inner@stable holds the bundle acme\/inner, and a bundle lists packages, not bundles/);
    assert.match((await subscription()).parts![1]!.error!, /^package_is_bundle:/);
    assert.equal((await at("acme/one"))?.by, by("one"));
  });
});

describe("a bundle's manifest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-bundle-manifest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const write = async (files: Record<string, string>) => {
    await rm(dir, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
  };
  const refused = async (files: Record<string, string>, re: RegExp) => {
    await write(files);
    await assert.rejects(readPackage(dir), (err: Error) => {
      assert.match(err.message, re);
      return true;
    });
  };

  it("an older-shaped manifest still loads; a bundle lists branches and holds nothing of its own", async () => {
    await write(PKG("one", "0.1.0"));
    const pkg = await readPackage(dir);
    assert.deepEqual([pkg.manifest.bundle, pkg.items.map((i) => i.name)], [undefined, ["acme/one/sync"]]);

    await write(BUNDLE("0.1.0", [refOf("one"), `${refOf("two", "main")}#package`, `git+${remote("two")}#other`]));
    const bundle = await readPackage(dir);
    assert.deepEqual([bundle.manifest.package, bundle.items, bundle.manifest.bundle?.length], ["acme/suite", [], 3]);
    assert.match(bundle.digest, /^sha256:[0-9a-f]{64}$/);
  });

  it("refuses what a bundle leaves out, each with its reason", async () => {
    const bundle = (lines: string, files: Record<string, string> = {}) => ({ "strut.yaml": `package: acme/suite\nversion: 0.1.0\n${lines}`, ...files });
    const one = `bundle:\n  - ${refOf("one")}\n`;
    await refused(bundle(one, { "workflows/sync.yaml": "steps: []\n" }), /^bad_package: workflows\/: a bundle lists packages and holds no items of its own — put them in a package the bundle lists$/);
    await refused(bundle(`${one}requires:\n  secrets: [X]\n`), /strut\.yaml: requires: a bundle lists packages and has no requires of its own/);
    await refused(bundle(`${one}job:\n  tools: [claim]\n`), /strut\.yaml: job: a bundle lists packages and has no job of its own/);
    await refused(bundle(`${one}schedules:\n  - { workflow: sync, trigger: { every: interval, minutes: 5 } }\n`), /strut\.yaml: schedules: a bundle/);
    await refused(bundle("bundle: []\n"), /strut\.yaml: bundle: a bundle lists at least one package/);
    await refused(bundle(`bundle:\n  - pk:47pj/acme/one\n`), /strut\.yaml: bundle\[0\]: pk:47pj\/acme\/one: a git ref starts with git\+/);
    await refused(bundle(`bundle:\n  - file:/tmp/one\n`), /bundle\[0\]: file:\/tmp\/one: a git ref starts with git\+/);
    await refused(bundle(`bundle:\n  - git+${remote("one")}@${"a".repeat(40)}\n`), /bundle\[0\]: .*names a commit, which does not move — a subscription follows a branch/);
    await refused(bundle(`bundle:\n  - ${refOf("one")}\n  - ${refOf("ONE", "main")}\n`), /bundle\[1\]: .* reads the folder bundle\[0\] reads — a bundle lists a package once, at one branch/);
    await refused(bundle(`bundle:\n  - { ref: ${refOf("one")} }\n`), /strut\.yaml: bundle\[0\]: /);
  });
});
