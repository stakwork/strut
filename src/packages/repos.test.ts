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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import type { InstalledPackage } from "./installed.js";
import type { CommitResult, PullResult, RepoView } from "./repos.js";

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const TOKEN = "ghp_SENTINELtoken0123456789abcdefSENTINEL";

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

const boot = (dir: string): Promise<Strut> =>
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
