/**
 * The ROUND TRIP (src/packages/repos.ts; plans/app-repos.md §3): a strut
 * working on a git repository that is a package — Open, edit through the
 * meta surface, Commit, Pull with git's merge and its conflicts, Create from
 * bare items into an empty remote — against local bare repositories
 * (`git init --bare`, as `file://` URLs), over the HTTP routes.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { KitLocation } from "../apps/kit.js";
import { kitForTests } from "../test-util/app-kit.js";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import type { InstalledPackage } from "./installed.js";
import type { CommitResult, PullResult, RepoView } from "./repos.js";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const TOKEN = "ghp_SENTINELtoken0123456789abcdefSENTINEL";
const HELLO = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "__fixtures__", "hello");
const STEP = (type: string, body = "return { ok: true };") =>
  `import { z, defineStep } from "strut";\nexport default defineStep({ type: ${JSON.stringify(type)}, description: "x", input: z.object({}), output: z.any(), async run() { ${body} } });\n`;
/** A directory's files as \`POST /apps\` takes them. */
async function filesOf(dir: string): Promise<Record<string, { base64: string }>> {
  const out: Record<string, { base64: string }> = {};
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const at = join(d, e.name);
      if (e.isDirectory()) await walk(at);
      else out[relative(dir, at)] = { base64: (await readFile(at)).toString("base64") };
    }
  };
  await walk(dir);
  return out;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
}
const SCORE = (name: string, message: string) => `name: ${name}\ndescription: Keep the score\nsteps:\n  - id: say\n    type: log\n    config: { message: ${JSON.stringify(message)} }\n`;
const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let root: string;
let n = 0;
/** An empty bare repository, as a `file://` URL. */
async function bareRemote(): Promise<{ dir: string; url: string }> {
  const dir = join(root, `remote-${++n}.git`);
  await mkdir(dir, { recursive: true });
  git(dir, "init", "--bare", "--quiet");
  return { dir, url: pathToFileURL(dir).href };
}
/** A bare repository holding the package acme/moon on `main`. */
async function moonRemote(): Promise<{ dir: string; url: string }> {
  const remote = await bareRemote();
  const work = join(root, `seed-${n}`);
  git(root, "clone", "--quiet", remote.url, work);
  await write(work, { "strut.yaml": "package: acme/moon\nversion: 0.1.0\n", "README.md": "# Moon\n", "workflows/score.yaml": SCORE("acme/moon/score", "one") });
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "first");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  return remote;
}
/** A commit on the remote's main by someone else. */
async function pushElsewhere(remote: string, files: Record<string, string>, message: string): Promise<void> {
  const work = join(root, `other-${++n}`);
  git(root, "clone", "--quiet", "--branch", "main", remote, work);
  await write(work, files);
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", message);
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
}
const remoteFile = (dir: string, rev: string, path: string) => git(dir, "show", `${rev}:${path}`);

const boot = (dir: string, extra: Record<string, unknown> = {}): Promise<Strut> =>
  createStrut({
    ...extra,
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
    jamie: false,
    knowledge: false,
    concepts: false,
    stt: false,
    subscriptionPoll: false,
  });

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_PACKAGE_INDEXES", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
  delete process.env["STRUT_API_KEY"];
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
  process.env["STRUT_SECRET_KEY"] = "repos-test-secret";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("a repo", () => {
  let strut: Strut;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-repos-"));
    strut = await boot(join(root, "ws"));
  });
  afterEach(async () => {
    await strut.close?.();
    await rm(root, { recursive: true, force: true });
  });

  const req = (path: string, init?: RequestInit) => strut.app.request(path, init);
  const installed = async (): Promise<InstalledPackage | undefined> =>
    ((await (await req("/packages")).json()) as { packages: InstalledPackage[] }).packages.find((p) => p.package === "acme/moon");
  const editScore = async (from: string, to: string) => {
    const res = await req("/steps/meta%2Fedit-workflow/run", json({ config: { name: "acme/moon/score", edits: [{ old: from, new: to }] } }));
    const body = (await res.json()) as { status?: string; error?: unknown };
    assert.equal(body.status, "success", JSON.stringify(body.error));
  };

  it("opens, is edited through the meta surface, and commits straight to its branch: the remote holds the edit and the item is no fork", async () => {
    const remote = await moonRemote();
    const opened = await req("/packages/repos", json({ url: remote.url }));
    assert.equal(opened.status, 201, await opened.clone().text());
    const view = (await opened.json()) as RepoView;
    assert.equal(view.package, "acme/moon");
    assert.equal(view.branch, "main");
    const first = git(remote.dir, "rev-parse", "main");
    assert.equal(view.commit, first);
    assert.deepEqual(view.forked, []);
    // Installed through the repo door, at that commit.
    let pkg = await installed();
    assert.equal(pkg?.door, "repo");
    assert.equal(pkg?.items.find((i) => i.name === "acme/moon/score")?.modified, false);
    let meta = (await strut.workspace.getWorkflowMetadata("acme/moon/score"))!;
    assert.equal(meta.versions[meta.active]?.upstream?.commit, first);
    assert.equal(meta.versions[meta.active]?.upstream?.source.ref, `git+${remote.url}@main`);
    // The working copy is a checkout of the branch.
    assert.match(await readFile(join(view.workdir, "workflows", "score.yaml"), "utf8"), /"one"/);

    await editScore('"one"', '"two"');
    assert.equal((await installed())?.items.find((i) => i.name === "acme/moon/score")?.modified, true, "an edit is a fork");
    const repo = (await (await req("/packages/repos/acme/moon")).json()) as RepoView;
    assert.deepEqual(repo.forked, [{ kind: "workflow", name: "acme/moon/score" }]);
    const diff = (await (await req("/packages/repos/acme/moon/diff")).json()) as CommitResult["diff"];
    assert.deepEqual(diff.files, [{ path: "workflows/score.yaml", status: "modified" }]);
    assert.match(diff.patch, /\+.*"two"/);

    const committed = await req("/packages/repos/acme/moon/commit", json({ message: "Say two", branch: "main" }));
    assert.equal(committed.status, 201, await committed.clone().text());
    const done = (await committed.json()) as CommitResult;
    assert.equal(done.committed, true);
    assert.equal(done.pushed, true);
    assert.equal(done.branch, "main");
    assert.deepEqual(done.stamped, [{ kind: "workflow", name: "acme/moon/score" }]);
    // The remote's main moved to the commit, with the edit in it.
    assert.equal(git(remote.dir, "rev-parse", "main"), done.commit);
    assert.match(remoteFile(remote.dir, "main", "workflows/score.yaml"), /"two"/);
    assert.equal(git(remote.dir, "log", "-1", "--format=%s", "main"), "Say two");
    // No fork: the version was stamped with the commit, in place.
    pkg = await installed();
    assert.equal(pkg?.items.find((i) => i.name === "acme/moon/score")?.modified, false);
    meta = (await strut.workspace.getWorkflowMetadata("acme/moon/score"))!;
    assert.equal(Object.keys(meta.versions).length, 2, "the edit's version, stamped: no third version");
    assert.equal(meta.versions[meta.active]?.upstream?.commit, done.commit);
    assert.equal(meta.versions[meta.active]?.source, "repo");
    assert.equal(((await (await req("/packages/repos/acme/moon")).json()) as RepoView).commit, done.commit);
    // Nothing more to commit.
    const again = (await (await req("/packages/repos/acme/moon/commit", json({ message: "Nothing", branch: "main" }))).json()) as CommitResult;
    assert.equal(again.committed, false);
  });

  it("pulls: a conflict with the remote is named and installs nothing; resolved in the working copy, the next pull applies the merge", async () => {
    const remote = await moonRemote();
    const view = (await (await req("/packages/repos", json({ url: remote.url }))).json()) as RepoView;
    await editScore('"one"', '"mine"');
    await pushElsewhere(remote.url, { "workflows/score.yaml": SCORE("acme/moon/score", "theirs"), "workflows/extra.yaml": SCORE("acme/moon/extra", "x") }, "theirs");

    const conflicted = await req("/packages/repos/acme/moon/pull", json({}));
    assert.equal(conflicted.status, 409);
    const c = (await conflicted.json()) as PullResult & { error: string };
    assert.deepEqual(c.conflict, ["workflows/score.yaml"]);
    assert.match(c.error, /package_repo_conflict: git could not merge workflows\/score\.yaml/);
    assert.ok(c.local, "the workspace's edit was committed locally first");
    // Nothing installed: the fork is still active, the remote's new workflow is not here.
    const active = await strut.workspace.getWorkflowSource("acme/moon/score", (await strut.workspace.getWorkflowMetadata("acme/moon/score"))!.active);
    assert.match(active, /"mine"/);
    assert.equal(await strut.workspace.getWorkflowMetadata("acme/moon/extra"), null);
    // The working copy holds git's markers; a Commit waits for the pull.
    assert.match(await readFile(join(view.workdir, "workflows", "score.yaml"), "utf8"), /<<<<<<<[\s\S]*"mine"[\s\S]*=======[\s\S]*"theirs"/);
    assert.deepEqual(((await (await req("/packages/repos/acme/moon")).json()) as RepoView).conflict, ["workflows/score.yaml"]);
    assert.equal((await req("/packages/repos/acme/moon/commit", json({ message: "x", branch: "main" }))).status, 409);
    // Pulled again before it is resolved: still the conflict.
    assert.equal((await req("/packages/repos/acme/moon/pull", json({}))).status, 409);

    // A person resolves it in the working copy.
    await writeFile(join(view.workdir, "workflows", "score.yaml"), SCORE("acme/moon/score", "both"));
    git(view.workdir, "add", "workflows/score.yaml");
    const pulled = await req("/packages/repos/acme/moon/pull", json({}));
    assert.equal(pulled.status, 200, await pulled.clone().text());
    const p = (await pulled.json()) as PullResult;
    assert.equal(p.conflict, undefined);
    const meta = (await strut.workspace.getWorkflowMetadata("acme/moon/score"))!;
    assert.match(await strut.workspace.getWorkflowSource("acme/moon/score", meta.active), /"both"/);
    assert.equal(meta.versions[meta.active]?.upstream?.commit, p.commit);
    assert.ok(await strut.workspace.getWorkflowMetadata("acme/moon/extra"), "the remote's new workflow is installed");
    const pkg = await installed();
    assert.ok(pkg?.items.every((i) => i.modified === false), "nothing is a fork after the merge is applied");
    // The merge is the working copy's, not yet the remote's: a Commit pushes it.
    assert.match(remoteFile(remote.dir, "main", "workflows/score.yaml"), /"theirs"/);
    const done = (await (await req("/packages/repos/acme/moon/commit", json({ message: "Merge", branch: "main" }))).json()) as CommitResult;
    assert.equal(done.pushed, true);
    assert.match(remoteFile(remote.dir, "main", "workflows/score.yaml"), /"both"/);
  });

  it("pulls a remote change into the workspace with no conflict, and retires what the remote deleted", async () => {
    const remote = await moonRemote();
    await req("/packages/repos", json({ url: remote.url }));
    await pushElsewhere(remote.url, { "workflows/score.yaml": SCORE("acme/moon/score", "three"), "workflows/more.yaml": SCORE("acme/moon/more", "m") }, "three");
    let p = (await (await req("/packages/repos/acme/moon/pull", json({}))).json()) as PullResult;
    assert.equal(p.local, undefined, "nothing was edited here, so nothing was committed first");
    const meta = (await strut.workspace.getWorkflowMetadata("acme/moon/score"))!;
    assert.match(await strut.workspace.getWorkflowSource("acme/moon/score", meta.active), /"three"/);
    assert.ok(await strut.workspace.getWorkflowMetadata("acme/moon/more"));
    // The remote deletes a workflow: the next pull retires it here.
    const work = join(root, "deleter");
    git(root, "clone", "--quiet", "--branch", "main", remote.url, work);
    git(work, "rm", "--quiet", "workflows/more.yaml");
    git(work, "commit", "--quiet", "-m", "less");
    git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    p = (await (await req("/packages/repos/acme/moon/pull", json({}))).json()) as PullResult;
    assert.equal(await strut.workspace.getWorkflowMetadata("acme/moon/more"), null);
    assert.ok(p.install?.packages[0]?.items.some((i) => i.name === "acme/moon/more" && i.status === "retired"));
  });

  it("commits to a new branch, and a workflow deleted here is deleted in the commit", async () => {
    const remote = await moonRemote();
    await pushElsewhere(remote.url, { "workflows/gone.yaml": SCORE("acme/moon/gone", "g") }, "gone");
    await req("/packages/repos", json({ url: remote.url }));
    assert.equal((await req("/workflows/acme%2Fmoon%2Fgone", { method: "DELETE" })).status, 200);
    const repo = (await (await req("/packages/repos/acme/moon")).json()) as RepoView;
    assert.deepEqual(repo.deleted, [{ kind: "workflow", name: "acme/moon/gone" }]);
    const done = (await (await req("/packages/repos/acme/moon/commit", json({ message: "Drop gone", branch: "drop-gone" }))).json()) as CommitResult;
    assert.equal(done.branch, "drop-gone");
    assert.match(done.prSkipped ?? "", /not on GitHub/);
    assert.equal(git(remote.dir, "ls-tree", "--name-only", "drop-gone", "workflows/").includes("gone.yaml"), false);
    assert.match(git(remote.dir, "ls-tree", "--name-only", "main", "workflows/"), /gone\.yaml/, "main is untouched");
  });

  it("creates a repo from bare items in an EMPTY remote, opens it, and retires the originals only when asked", async () => {
    await strut.workspace.publishWorkflowByContent("hello", SCORE("hello", "hi"));
    const remote = await bareRemote();
    const created = await req("/packages/repos/create", json({ url: remote.url, package: "acme/made", version: "0.1.0", workflows: ["hello"] }));
    assert.equal(created.status, 201, await created.clone().text());
    const view = (await created.json()) as RepoView & { originals: unknown };
    assert.deepEqual(view.originals, [{ kind: "workflow", name: "hello" }]);
    assert.equal(view.branch, "main");
    // The remote's first commit is the package.
    assert.match(remoteFile(remote.dir, "main", "strut.yaml"), /package: acme\/made/);
    assert.match(remoteFile(remote.dir, "main", "workflows/hello.yaml"), /"hi"/);
    assert.equal(view.commit, git(remote.dir, "rev-parse", "main"));
    // Installed under the package; the original stays until retired.
    assert.ok(await strut.workspace.getWorkflowMetadata("acme/made/hello"));
    assert.ok(await strut.workspace.getWorkflowMetadata("hello"));
    // A non-empty remote is refused.
    const again = await req("/packages/repos/create", json({ url: remote.url, package: "acme/other", version: "0.1.0", workflows: ["hello"] }));
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /package_repo_not_empty/);
    // Retire on the person's word.
    const retired = (await (await req("/packages/repos/acme/made/retire", json({ items: [{ kind: "workflow", name: "hello" }, { kind: "workflow", name: "acme/made/hello" }] }))).json()) as {
      retired: unknown[];
      failed: Array<{ name: string }>;
    };
    assert.deepEqual(retired.retired, [{ kind: "workflow", name: "hello" }]);
    assert.deepEqual(retired.failed.map((f) => f.name), ["acme/made/hello"], "only an original Create named");
    assert.equal(await strut.workspace.getWorkflowMetadata("hello"), null);
    // Closed: the record and the working copy go, the items stay.
    assert.equal((await req("/packages/repos/acme/made", { method: "DELETE" })).status, 200);
    assert.equal((await req("/packages/repos/acme/made")).status, 404);
    assert.ok(await strut.workspace.getWorkflowMetadata("acme/made/hello"));
  });

  it("never writes, logs or answers with the token", async () => {
    assert.equal((await req("/secrets/GITHUB_TOKEN", json({ value: TOKEN }, "PUT"))).status, 200);
    const said: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...args: unknown[]) => void said.push(args.map(String).join(" "));
    try {
      const remote = await moonRemote();
      const opened = await req("/packages/repos", json({ url: remote.url }));
      assert.equal(opened.status, 201);
      const bodies = [await opened.text()];
      // A remote whose hook prints the environment it was pushed with — the
      // token is in it, on a local push — and refuses.
      await writeFile(join(remote.dir, "hooks", "pre-receive"), '#!/bin/sh\necho "env token=$STRUT_GIT_TOKEN" >&2\nexit 1\n');
      await chmod(join(remote.dir, "hooks", "pre-receive"), 0o755);
      await editScore('"one"', '"two"');
      const refused = await req("/packages/repos/acme/moon/commit", json({ message: "Say two", branch: "main" }));
      assert.equal(refused.status, 409);
      const error = ((await refused.json()) as { error: string }).error;
      assert.match(error, /push_rejected: .*env token=\*\*\*/, "the hook ran with the token, which the answer masks");
      bodies.push(error);
      bodies.push(await (await req("/packages/repos")).text());
      bodies.push(await (await req("/packages/repos/acme/moon/pull", json({}))).text());
      bodies.push(await (await req("/packages/repos", json({ url: pathToFileURL(join(root, "nowhere.git")).href }))).text());
      const onFile = await readFile(join(root, "ws", "packages", "repos.json"), "utf8");
      assert.match(onFile, /"package": "acme\/moon"/);
      for (const text of [onFile, ...bodies, ...said]) assert.equal(text.includes(TOKEN), false, `the token leaked: ${text.slice(0, 300)}`);
    } finally {
      Object.assign(console, orig);
    }
  });

  it("refuses package/commit outside an accepted proposal", async () => {
    const remote = await moonRemote();
    await req("/packages/repos", json({ url: remote.url }));
    const direct = (await (await req("/steps/package%2Fcommit/run", json({ config: { package: "acme/moon", message: "Push it" } }))).json()) as { status: string; error?: { message?: string } };
    assert.equal(direct.status, "error");
    assert.match(direct.error?.message ?? "", /runs only as a proposal a person accepted/);
    const door = (strut.services as { packages: { commit(p: string, o: { proposal: string; message: string }): Promise<unknown> } }).packages.commit;
    await assert.rejects(door("acme/moon", { proposal: "nope", message: "Push it" }), /package_commit_needs_person/);
    assert.equal(git(remote.dir, "log", "--format=%s", "main"), "first", "nothing was pushed");
  });
});

describe("adding to a repo", () => {
  let kit: KitLocation;
  let strut: Strut;
  before(async () => {
    kit = await kitForTests();
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-repos-add-"));
    strut = await boot(join(root, "ws"), { kit });
  });
  afterEach(async () => {
    await strut.close?.();
    await rm(root, { recursive: true, force: true });
  });
  const req = (path: string, init?: RequestInit) => strut.app.request(path, init);
  const publish = (name: string, message: string) => req("/workflows", json({ name, yaml: SCORE(name, message) }));

  it("takes a new workflow, step, helper and app under an OPEN repo's prefix, and a Commit writes them to the remote as the package's", async () => {
    const remote = await moonRemote();
    assert.equal((await req("/packages/repos", json({ url: remote.url }))).status, 201);
    // A new name under the package: the open repo takes it, from any door.
    const wf = await publish("acme/moon/ghost", "boo");
    assert.equal(wf.status, 201, await wf.clone().text());
    assert.equal((await req("/steps", json({ name: "acme/moon/_util", code: "export const twice = (n: number) => n * 2;\n" }))).status, 201);
    const step = await req("/steps", json({ name: "acme/moon/replay", code: STEP("acme/moon/replay") }));
    assert.equal(step.status, 201, await step.clone().text());
    const app = await req("/apps", json({ name: "acme/moon/game", files: await filesOf(HELLO) }));
    assert.equal(app.status, 201, await app.clone().text());
    const view = (await (await req("/packages/repos/acme/moon")).json()) as RepoView;
    assert.deepEqual(
      view.added.map((i) => `${i.kind}:${i.name}`).sort(),
      ["app:acme/moon/game", "step:acme/moon/_util", "step:acme/moon/replay", "workflow:acme/moon/ghost"],
    );
    assert.deepEqual(view.forked, []);

    const done = (await (await req("/packages/repos/acme/moon/commit", json({ message: "Add the ghost", branch: "main" }))).json()) as CommitResult;
    assert.equal(done.pushed, true, JSON.stringify(done));
    const files = git(remote.dir, "ls-tree", "-r", "--name-only", "main").split("\n");
    for (const f of ["workflows/ghost.yaml", "steps/replay.ts", "steps/_util.ts", "apps/game/app.yaml", "apps/game/src/App.tsx"]) assert.ok(files.includes(f), `${f} is in the commit: ${files.join(", ")}`);
    assert.equal(files.some((f) => f.startsWith("apps/game/dist/")), false, "no build output");
    assert.match(remoteFile(remote.dir, "main", "workflows/ghost.yaml"), /"boo"/);
    // The package's now: stamped with the commit, nothing new or edited.
    const meta = (await strut.workspace.getWorkflowMetadata("acme/moon/ghost"))!;
    assert.equal(meta.versions[meta.active]?.upstream?.commit, done.commit);
    const pkg = ((await (await req("/packages")).json()) as { packages: InstalledPackage[] }).packages.find((p) => p.package === "acme/moon");
    assert.deepEqual(
      pkg?.items.map((i) => `${i.kind}:${i.name}:${i.modified}`).sort(),
      ["app:acme/moon/game:false", "step:acme/moon/_util:false", "step:acme/moon/replay:false", "workflow:acme/moon/ghost:false", "workflow:acme/moon/score:false"],
    );
    const after = (await (await req("/packages/repos/acme/moon")).json()) as RepoView;
    assert.deepEqual([after.added, after.forked], [[], []]);
  });

  it("keeps the rule for a package installed the ordinary way, and puts it back when the repo is closed", async () => {
    // Installed from a file: a new name under it is refused, with the way to add one.
    const dir = join(root, "plain");
    await write(dir, { "strut.yaml": "package: acme/plain\nversion: 1.0.0\n", "workflows/one.yaml": SCORE("acme/plain/one", "1") });
    assert.equal((await req("/packages/install", json({ ref: `file:${dir}` }))).status, 201);
    const refused = await publish("acme/plain/two", "2");
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /package_conflict: acme\/plain\/two is under acme\/plain, an installed package.*open its git repository here \(Packages → Repos\)/);

    // An open repo takes one; closed, the next new name is refused again.
    const remote = await moonRemote();
    await req("/packages/repos", json({ url: remote.url }));
    assert.equal((await publish("acme/moon/ghost", "boo")).status, 201);
    assert.equal((await req("/packages/repos/acme/moon", { method: "DELETE" })).status, 200);
    const again = await publish("acme/moon/spirit", "s");
    assert.equal(again.status, 400);
    assert.match(((await again.json()) as { error: string }).error, /package_conflict: acme\/moon\/spirit is under acme\/moon/);
    // What was added and not committed stays, a local item that can still be edited.
    assert.ok(await strut.workspace.getWorkflowMetadata("acme/moon/ghost"));
    await strut.workspace.publishWorkflowByContent("acme/moon/ghost", SCORE("acme/moon/ghost", "boo again"));
    // Opened again, the next Commit writes it.
    assert.equal((await req("/packages/repos", json({ url: remote.url }))).status, 201);
    const done = (await (await req("/packages/repos/acme/moon/commit", json({ message: "The ghost", branch: "main" }))).json()) as CommitResult;
    assert.deepEqual(done.stamped, [{ kind: "workflow", name: "acme/moon/ghost" }]);
    assert.match(remoteFile(remote.dir, "main", "workflows/ghost.yaml"), /"boo again"/);
  });
});

describe("a name taken twice", () => {
  let strut: Strut;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-repos-twice-"));
    strut = await boot(join(root, "ws"));
  });
  afterEach(async () => {
    await strut.close?.();
    await rm(root, { recursive: true, force: true });
  });
  const req = (path: string, init?: RequestInit) => strut.app.request(path, init);
  /** The package acme/moon as a folder, installed the ordinary way from `file:`. */
  const plainMoon = async (message: string) => {
    const dir = join(root, `plain-${++n}`);
    await write(dir, { "strut.yaml": "package: acme/moon\nversion: 0.1.0\n", "workflows/score.yaml": SCORE("acme/moon/score", message) });
    return `file:${dir}`;
  };
  const emptyLog = (dir: string) => spawnSync("git", ["--git-dir", dir, "log", "--oneline", "--all"], { encoding: "utf8" }).stdout.trim();

  it("a first Open refuses items made here under the package's name, and keeps nothing", async () => {
    await strut.workspace.publishWorkflowByContent("acme/moon/score", SCORE("acme/moon/score", "mine"));
    await strut.workspace.publishWorkflowByContent("acme/moon/extra", SCORE("acme/moon/extra", "mine too"));
    const remote = await moonRemote();
    const res = await req("/packages/repos", json({ url: remote.url }));
    assert.equal(res.status, 409);
    const error = ((await res.json()) as { error: string }).error;
    assert.match(error, /package_conflict: .*the workflow acme\/moon\/extra is a local one under acme\/moon\//);
    assert.match(error, /the workflow acme\/moon\/score is a local one/);
    // Nothing kept: the local items as they were, no repo, no working copy.
    const meta = (await strut.workspace.getWorkflowMetadata("acme/moon/score"))!;
    assert.deepEqual(Object.keys(meta.versions), ["v1"]);
    assert.match(await strut.workspace.getWorkflowSource("acme/moon/score", "v1"), /"mine"/);
    assert.deepEqual(((await (await req("/packages/repos")).json()) as { repos: unknown[] }).repos, []);
    assert.equal(existsSync(join(root, "ws", "packages", "work", "acme", "moon")), false);
  });

  it("while a repo is open, no other door writes or removes its package", async () => {
    const remote = await moonRemote();
    assert.equal((await req("/packages/repos", json({ url: remote.url }))).status, 201);
    const other = await plainMoon("other");
    // A person's install of the same name.
    const installed = await req("/packages/install", json({ ref: other }));
    assert.equal(installed.status, 409);
    assert.match(((await installed.json()) as { error: string }).error, /package_repo_owned: acme\/moon is opened here as a git repo/);
    // The distro's (a subscription, a served box).
    await assert.rejects(strut.packages.install(other, { door: "distro" }), /package_repo_owned/);
    // An uninstall.
    const gone = await req("/packages/acme/moon", { method: "DELETE" });
    assert.equal(gone.status, 409);
    assert.match(((await gone.json()) as { error: string }).error, /package_repo_owned/);
    const meta = (await strut.workspace.getWorkflowMetadata("acme/moon/score"))!;
    assert.match(await strut.workspace.getWorkflowSource("acme/moon/score", meta.active), /"one"/, "the repo's, untouched");
    // Closed, it uninstalls; then the same name installs from elsewhere.
    assert.equal((await req("/packages/repos/acme/moon", { method: "DELETE" })).status, 200);
    assert.equal((await req("/packages/acme/moon", { method: "DELETE" })).status, 200);
    assert.equal((await req("/packages/install", json({ ref: other }))).status, 201);
  });

  it("Create repo refuses a name installed here, or one with items under it, before pushing anything", async () => {
    await strut.workspace.publishWorkflowByContent("hello", SCORE("hello", "hi"));
    assert.equal((await req("/packages/install", json({ ref: await plainMoon("plain") }))).status, 201);
    const remote = await bareRemote();
    const installedHere = await req("/packages/repos/create", json({ url: remote.url, package: "acme/moon", version: "1.0.0", workflows: ["hello"] }));
    assert.equal(installedHere.status, 409);
    assert.match(((await installedHere.json()) as { error: string }).error, /package_conflict: acme\/moon is installed here already \(from file:.*Create repo makes a NEW package/);
    assert.equal(emptyLog(remote.dir), "", "nothing pushed");

    await strut.workspace.publishWorkflowByContent("acme/made/hello", SCORE("acme/made/hello", "made"));
    const under = await req("/packages/repos/create", json({ url: remote.url, package: "acme/made", version: "1.0.0", workflows: ["hello"] }));
    assert.equal(under.status, 409);
    assert.match(((await under.json()) as { error: string }).error, /package_conflict: acme\/made\/hello is already here under acme\/made\//);
    assert.equal(emptyLog(remote.dir), "", "nothing pushed");
  });
});
