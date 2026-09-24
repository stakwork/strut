import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { flow, step, defineStep, type RunEvent, type Step, type StepRegistry } from "./core.js";
import { runWorkflow } from "./runner.js";
import { MemoryRunStore } from "./store.js";
import { standardServices, type FetchLike } from "./capabilities.js";
import checkout from "./steps/lib/git/checkout.js";
import gitDiff from "./steps/lib/git/diff.js";
import gitApply from "./steps/lib/git/apply.js";
import gitPush from "./steps/lib/git/push.js";
import createPr, { openPullRequest, parseGithubRepo, type PullData, type PullsApi } from "./steps/lib/github/create-pr.js";
import pack from "./steps/core/pack.js";

// ── the landing primitives, offline (plans/code-change.md §6) ──────────────
//
// A bare origin in a temp dir stands in for GitHub: checkout → apply → push
// are the real steps over the real git; the commit lands in the bare repo
// where the test can read it back. GitHub's REST API (the identity behind
// the commit, the pull request) is a fake `fetch` / a fake Octokit slice.

const mk = (name: string, input: z.ZodTypeAny, ...steps: Step[]) => flow(name, { input, steps });
const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com"];
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function sh(args: string[], cwd: string): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Test-only: edit files in a working copy (what an agent step would do). */
const editStep = defineStep({
  type: "edit",
  input: z.object({ path: z.string(), files: z.record(z.string(), z.string()).default({}) }),
  output: z.any(),
  async run(cfg) {
    for (const [rel, content] of Object.entries(cfg.files)) {
      await mkdir(join(cfg.path, rel, ".."), { recursive: true });
      await writeFile(join(cfg.path, rel), content);
    }
    return { edited: Object.keys(cfg.files).length };
  },
});

const registry: StepRegistry = {
  "git/checkout": checkout,
  "git/diff": gitDiff,
  "git/apply": gitApply,
  "git/push": gitPush,
  pack,
  edit: editStep,
} as StepRegistry;

const TOKEN = "ghp_landing_token_0123456789abcdef";
const OCTOCAT = { login: "octocat", id: 583231 };

/** GitHub's `GET /user`, as the http capability's fetch sees it. */
function fakeGithub(answer: { status: number; body: unknown }, calls: { url: string; auth?: string }[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, auth: init?.headers?.["authorization"] });
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
      text: async () => JSON.stringify(answer.body),
    };
  };
}

describe("git/apply + git/push", () => {
  let root: string;
  let bare: string;
  let originUrl: string;
  let dataDir: string;
  let diff: string; // a change captured by git/diff against main

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-land-"));
    bare = join(root, "origin.git");
    dataDir = join(root, "data");
    const seed = join(root, "seed");
    await mkdir(seed, { recursive: true });
    sh(["init", "-q", "-b", "main"], seed);
    await writeFile(join(seed, "README.md"), "# hello\n");
    await writeFile(join(seed, "src.txt"), "one\n");
    sh(["add", "-A"], seed);
    sh(["commit", "-q", "-m", "init"], seed);
    sh(["init", "-q", "--bare", "-b", "main", bare]);
    sh(["push", "-q", bare, "main"], seed);
    originUrl = `file://${bare}`;

    // The diff a preview run would hand back (git/diff's bytes).
    const propose = mk(
      "propose",
      z.object({ repo: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}" }),
      step("edit", "edit", { path: "{{ checkout.path }}", files: { "README.md": "# hello\nchanged\n", "new.txt": "brand new\n" } }),
      step("diff", "git/diff", { path: "{{ checkout.path }}" }),
    );
    const res = await runWorkflow(propose, { repo: originUrl }, registry, { services: standardServices({ secretsSource: {}, dataDir }) });
    assert.equal(res.status, "success", JSON.stringify(res));
    diff = (res.output as { diff: string }).diff;
    assert.match(diff, /\+changed/);
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** The standard bag over a fake GitHub; `token: null` = no secret at all. */
  const services = (fetchImpl?: FetchLike, token: string | null = TOKEN) =>
    standardServices({ ...(fetchImpl ? { fetchImpl } : {}), secretsSource: token ? { GITHUB_TOKEN: token } : {}, dataDir });

  const landFlow = (apply: Record<string, unknown> = {}, push: Record<string, unknown> = {}) =>
    mk(
      "land",
      z.object({ repo: z.string(), diff: z.string(), diffSha256: z.string().optional(), branch: z.string(), title: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}", ref: "main" }),
      step("apply", "git/apply", { path: "{{ checkout.path }}", diff: "{{ input.diff }}", sha256: "{{ input.diffSha256 }}", ...apply }),
      step("push", "git/push", { path: "{{ checkout.path }}", branch: "{{ input.branch }}", message: "{{ input.title }}", ...push }),
      step("result", "pack", {
        branch: "{{ push.branch }}",
        sha: "{{ push.sha }}",
        login: "{{ push.login }}",
        base: "{{ checkout.branch }}",
        files: "{{ apply.files }}",
        filesChanged: "{{ apply.filesChanged }}",
        sha256: "{{ apply.sha256 }}",
        path: "{{ checkout.path }}",
      }),
    );

  it("applies the exact bytes, commits as the token's GitHub identity, pushes a new branch to origin", async () => {
    const calls: { url: string; auth?: string }[] = [];
    const events: RunEvent[] = [];
    const store = new MemoryRunStore();
    // hive stores the diff trimmed; the bytes it hashes are the bytes it sends.
    const sent = diff.replace(/\n$/, "");
    const res = await runWorkflow(
      landFlow(),
      { repo: originUrl, diff: sent, diffSha256: sha256(sent), branch: "jamie/abc12345-000001", title: "-- a title that looks like a flag\n\nbody" },
      registry,
      { services: services(fakeGithub({ status: 200, body: OCTOCAT }, calls)), store, onEvent: (e) => void events.push(e) },
    );
    assert.equal(res.status, "success", JSON.stringify(res));
    const out = res.output as Record<string, unknown>;
    assert.equal(out["branch"], "jamie/abc12345-000001");
    assert.equal(out["login"], "octocat");
    assert.equal(out["base"], "main");
    assert.deepEqual(out["files"], ["README.md", "new.txt"]);
    assert.equal(out["filesChanged"], 2);
    assert.equal(out["sha256"], sha256(sent), "the hash of the bytes as given, not of the newline-terminated patch");

    // The branch is on the remote, at the pushed sha, authored by the token's owner.
    const sha = out["sha"] as string;
    assert.equal(sh(["rev-parse", "refs/heads/jamie/abc12345-000001"], bare), sha);
    assert.equal(sh(["log", "-1", "--format=%an <%ae>|%cn <%ce>", sha], bare), "octocat <583231+octocat@users.noreply.github.com>|octocat <583231+octocat@users.noreply.github.com>");
    assert.equal(sh(["log", "-1", "--format=%B", sha], bare), "-- a title that looks like a flag\n\nbody");
    assert.equal(sh(["rev-parse", `${sha}^`], bare), sh(["rev-parse", "main"], bare), "one commit on top of main");
    assert.equal(sh(["show", `${sha}:README.md`], bare), "# hello\nchanged");
    assert.equal(sh(["show", `${sha}:new.txt`], bare), "brand new");
    assert.equal(sh(["rev-parse", "main"], bare), sh(["rev-parse", "main"], bare), "main untouched");

    // Identity came from GET /user with the token; the token is nowhere else.
    assert.deepEqual(calls, [{ url: "https://api.github.com/user", auth: `Bearer ${TOKEN}` }]);
    assert.ok(!JSON.stringify(events).includes(TOKEN), "events");
    assert.ok(!JSON.stringify(res).includes(TOKEN), "result");
    assert.ok(!JSON.stringify(await store.getSummary("land", res.runId)).includes(TOKEN), "summary");
    // The working copy is gone; the branch lives on the remote only.
    assert.ok(!existsSync(out["path"] as string), "worktree removed at run end");
  });

  it("a diff that no longer applies fails with patch_conflict:, touching nothing", async () => {
    const stale = "diff --git a/src.txt b/src.txt\n--- a/src.txt\n+++ b/src.txt\n@@ -1 +1 @@\n-two\n+three\n";
    const res = await runWorkflow(
      landFlow(),
      { repo: originUrl, diff: stale, branch: "jamie/conflict", title: "t" },
      registry,
      { services: services(fakeGithub({ status: 200, body: OCTOCAT })) },
    );
    assert.equal(res.status, "error");
    assert.match(res.error!.message, /^patch_conflict: /);
    assert.match(res.error!.message, /src\.txt/);
    assert.throws(() => sh(["rev-parse", "--verify", "refs/heads/jamie/conflict"], bare), "nothing was pushed");
  });

  it("refuses before any git call: sha mismatch, empty diff, binary patch", async () => {
    const noShell = { runId: "r", services: { shell: async () => assert.fail("git must not run") } } as never;
    const run = (cfg: Record<string, unknown>) => gitApply.run({ path: "/nowhere", timeoutMs: 1000, ...cfg } as never, noShell);
    await assert.rejects(run({ diff, sha256: sha256("other") }), (e: Error) => !e.message.startsWith("patch_conflict") && /sha256 mismatch/.test(e.message));
    await assert.rejects(run({ diff: "  \n" }), /diff is empty/);
    await assert.rejects(run({ diff: "diff --git a/x b/x\nGIT binary patch\nliteral 0\n" }), /binary patch/);
  });

  it("push: nothing staged is a plain error; a rejected token is no_push_permission:", async () => {
    const nothing = mk(
      "nothing",
      z.object({ repo: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}" }),
      step("push", "git/push", { path: "{{ checkout.path }}", branch: "jamie/empty", message: "t" }),
    );
    const empty = await runWorkflow(nothing, { repo: originUrl }, registry, { services: services(fakeGithub({ status: 200, body: OCTOCAT })) });
    assert.equal(empty.status, "error");
    assert.match(empty.error!.message, /nothing is staged/);
    assert.ok(!/^(patch_conflict|push_rejected|no_push_permission)/.test(empty.error!.message));

    const bad = await runWorkflow(
      landFlow(),
      { repo: originUrl, diff, branch: "jamie/badtoken", title: "t" },
      registry,
      { services: services(fakeGithub({ status: 401, body: { message: "Bad credentials" } })) },
    );
    assert.equal(bad.status, "error");
    assert.match(bad.error!.message, /^no_push_permission: /);
    assert.ok(!bad.error!.message.includes(TOKEN));
    assert.throws(() => sh(["rev-parse", "--verify", "refs/heads/jamie/badtoken"], bare), "nothing was pushed");
  });

  it("push: a non-fast-forward push is push_rejected: (never --force)", async () => {
    const first = await runWorkflow(
      landFlow(),
      { repo: originUrl, diff, branch: "jamie/twice", title: "first" },
      registry,
      { services: services(fakeGithub({ status: 200, body: OCTOCAT })) },
    );
    assert.equal(first.status, "success", JSON.stringify(first));
    const before = sh(["rev-parse", "refs/heads/jamie/twice"], bare);
    // A second attempt from main again diverges from what is on the branch.
    const second = await runWorkflow(
      landFlow(),
      { repo: originUrl, diff, branch: "jamie/twice", title: "second" },
      registry,
      { services: services(fakeGithub({ status: 200, body: OCTOCAT })) },
    );
    assert.equal(second.status, "error");
    assert.match(second.error!.message, /^push_rejected: /);
    assert.equal(sh(["rev-parse", "refs/heads/jamie/twice"], bare), before, "the remote branch was not rewritten");
  });

  it("push without a token: the fallback author, a remote that needs no credential", async () => {
    const res = await runWorkflow(landFlow(), { repo: originUrl, diff, branch: "jamie/notoken", title: "t" }, registry, {
      services: services(undefined, null),
    });
    assert.equal(res.status, "success", JSON.stringify(res));
    const out = res.output as Record<string, string>;
    assert.equal(out["login"], "strut");
    assert.equal(sh(["log", "-1", "--format=%an <%ae>", out["sha"]!], bare), "strut <strut@users.noreply.github.com>");
  });

  it("push: an invalid branch name is refused", async () => {
    const res = await runWorkflow(landFlow(), { repo: originUrl, diff, branch: "bad..name", title: "t" }, registry, {
      services: services(fakeGithub({ status: 200, body: OCTOCAT })),
    });
    assert.equal(res.status, "error");
    assert.match(res.error!.message, /not a valid branch name/);
  });
});

describe("github/create-pr", () => {
  const pr = (n: number, head = "jamie/x"): PullData => ({ html_url: `https://github.com/o/r/pull/${n}`, number: n, head: { ref: head, sha: "abc" }, base: { ref: "main" } });
  const args = { owner: "o", repo: "r", head: "jamie/x", base: "main", title: "T", body: "B" };

  function fake(o: { existing?: PullData[]; listError?: unknown; createError?: unknown }) {
    const calls: { list: unknown[]; create: unknown[] } = { list: [], create: [] };
    const api: PullsApi = {
      pulls: {
        async list(p) {
          calls.list.push(p);
          if (o.listError) throw o.listError;
          return { data: o.existing ?? [] };
        },
        async create(p) {
          calls.create.push(p);
          if (o.createError) throw o.createError;
          return { data: pr(7, p.head) };
        },
      },
    };
    return { api, calls };
  }

  it("returns the open PR for head instead of opening a second one", async () => {
    const { api, calls } = fake({ existing: [pr(3)] });
    assert.deepEqual(await openPullRequest(api, args), { url: "https://github.com/o/r/pull/3", number: 3, headSha: "abc", base: "main", head: "jamie/x", created: false });
    assert.deepEqual(calls.list, [{ owner: "o", repo: "r", head: "o:jamie/x", state: "open", per_page: 1 }]);
    assert.equal(calls.create.length, 0);
  });

  it("opens the PR when none is open for head", async () => {
    const { api, calls } = fake({});
    const res = await openPullRequest(api, { ...args, draft: true });
    assert.equal(res.created, true);
    assert.equal(res.number, 7);
    assert.deepEqual(calls.create, [{ owner: "o", repo: "r", head: "jamie/x", base: "main", title: "T", body: "B", draft: true }]);
  });

  it("maps GitHub's errors onto the contract's codes, never leaking a token", async () => {
    const forbidden = Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 });
    await assert.rejects(openPullRequest(fake({ listError: forbidden }).api, args), { message: /^no_push_permission: .*403/ });
    await assert.rejects(openPullRequest(fake({ createError: Object.assign(new Error("Bad credentials"), { status: 401 }) }).api, args), { message: /^no_push_permission: / });
    await assert.rejects(
      openPullRequest(fake({ createError: Object.assign(new Error("Validation Failed: No commits between main and jamie/x"), { status: 422 }) }).api, args),
      { message: /^pr_create_failed: 422 Validation Failed/ },
    );
    await assert.rejects(openPullRequest(fake({ createError: new TypeError("fetch failed") }).api, args), { message: /^pr_create_failed: error fetch failed/ });
  });

  it("the step needs a token, and reads the repo as a URL or owner/repo", async () => {
    assert.deepEqual(parseGithubRepo("https://github.com/stakwork/strut.git"), { owner: "stakwork", repo: "strut" });
    assert.deepEqual(parseGithubRepo("stakwork/strut"), { owner: "stakwork", repo: "strut" });
    assert.throws(() => parseGithubRepo("https://gitlab.com/a/b"), /owner\/repo/);
    const ctx = { runId: "r", services: { secrets: { get: async () => undefined } } } as never;
    await assert.rejects(createPr.run({ repo: "o/r", head: "h", base: "b", title: "t" } as never, ctx), /GITHUB_TOKEN/);
  });
});
