import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { flow, step, defineStep, type RunEvent, type Step, type StepRegistry } from "./core.js";
import { runWorkflow } from "./runner.js";
import { MemoryRunStore } from "./store.js";
import { standardServices } from "./capabilities.js";
import checkout from "./steps/lib/git/checkout.js";
import gitDiff from "./steps/lib/git/diff.js";
import pack from "./steps/core/pack.js";
import { parseRepo, cachePath } from "./steps/lib/git/_shared.js";

/** `flow(name, { input, steps })` with the steps inline. */
const mk = (name: string, input: z.ZodTypeAny, ...steps: Step[]) => flow(name, { input, steps });

// ── a local origin ──────────────────────────────────────────────────────────
//
// Everything runs against a real repository in a temp dir (file:// URL): the
// steps shell out to the real git, so what they do to a cache and a worktree
// is what they'd do on a server. No network, no token needed — the token
// path is exercised by asserting where a configured token does NOT end up.

const GIT_ID = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

function sh(args: string[], cwd: string): string {
  const r = spawnSync("git", [...GIT_ID, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const hasGitleaks = spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;

/** Test-only: edit files in a working copy (what an agent step would do). */
const editStep = defineStep({
  type: "edit",
  input: z.object({
    path: z.string(),
    files: z.record(z.string(), z.string()).default({}),
  }),
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
  pack,
  edit: editStep,
} as StepRegistry;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("git/checkout + git/diff", () => {
  let root: string;
  let origin: string;
  let originUrl: string;
  let dataDir: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-git-"));
    origin = join(root, "origin");
    dataDir = join(root, "data");
    await mkdir(origin, { recursive: true });
    sh(["init", "-q", "-b", "main"], origin);
    await writeFile(join(origin, "README.md"), "# hello\n");
    await writeFile(join(origin, "src.txt"), "one\n");
    sh(["add", "-A"], origin);
    sh(["commit", "-q", "-m", "init"], origin);
    sh(["tag", "v1"], origin);
    sh(["switch", "-q", "-c", "feature"], origin);
    await writeFile(join(origin, "feature.txt"), "f\n");
    sh(["add", "-A"], origin);
    sh(["commit", "-q", "-m", "feature"], origin);
    sh(["switch", "-q", "main"], origin);
    originUrl = `file://${origin}`;
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const services = () => standardServices({ secretsSource: {}, dataDir });

  const proposeFlow = (extra: Record<string, unknown> = {}) =>
    mk(
      "propose",
      z.object({ repo: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}", ...extra }),
      step("edit", "edit", {
        path: "{{ checkout.path }}",
        files: { "README.md": "# hello\nchanged\n", "new.txt": "brand new\n" },
      }),
      step("diff", "git/diff", { path: "{{ checkout.path }}" }),
      step("result", "pack", {
        diff: "{{ diff.diff }}",
        files: "{{ diff.files }}",
        filesChanged: "{{ diff.filesChanged }}",
        sha256: "{{ diff.sha256 }}",
        scanned: "{{ diff.scanned }}",
        path: "{{ checkout.path }}",
        sha: "{{ checkout.sha }}",
        branch: "{{ checkout.branch }}",
        ref: "{{ checkout.ref }}",
      }),
    );

  it("checks out the default branch into an isolated working copy, captures the diff, removes the copy at run end", async () => {
    const res = await runWorkflow(proposeFlow(), { repo: originUrl }, registry, { services: services() });
    assert.equal(res.status, "success", JSON.stringify(res));
    const out = res.output as Record<string, unknown>;

    assert.equal(out["branch"], "main");
    assert.equal(out["ref"], "main");
    assert.equal(out["sha"], sh(["rev-parse", "main"], origin));
    assert.deepEqual(out["files"], ["README.md", "new.txt"]);
    assert.equal(out["filesChanged"], 2);
    const diff = out["diff"] as string;
    assert.match(diff, /\+\+\+ b\/new\.txt/);
    assert.match(diff, /\+brand new/);
    assert.match(diff, /\+changed/);
    assert.equal(out["sha256"], sha256(diff));
    assert.equal(out["scanned"], hasGitleaks);

    // The working copy was under the run's worktree dir, and is gone now.
    const path = out["path"] as string;
    assert.ok(path.startsWith(join(dataDir, "worktrees", res.runId)), path);
    assert.ok(!existsSync(path), "worktree removed by ctx.onRunEnd");
    assert.ok(!existsSync(join(dataDir, "worktrees", res.runId)), "run's worktree root removed");
    // The cache stays, bare and credential-free, and registers no stale worktree.
    const cache = cachePath(dataDir, parseRepo(originUrl));
    assert.ok(existsSync(join(cache, "HEAD")));
    assert.equal(sh(["worktree", "list", "--porcelain"], cache).split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
    // The origin's own working tree was never touched.
    assert.equal(await readFile(join(origin, "README.md"), "utf8"), "# hello\n");
  });

  it("checks out a branch, a tag, and a commit sha", async () => {
    const one = mk(
      "co",
      z.object({ repo: z.string(), ref: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}", ref: "{{ input.ref }}" }),
    );
    for (const [ref, expect] of [
      ["feature", sh(["rev-parse", "feature"], origin)],
      ["v1", sh(["rev-parse", "v1^{commit}"], origin)],
      [sh(["rev-parse", "main"], origin), sh(["rev-parse", "main"], origin)],
    ] as const) {
      const res = await runWorkflow(one, { repo: originUrl, ref }, registry, { services: services() });
      assert.equal(res.status, "success", JSON.stringify(res));
      const out = res.output as Record<string, unknown>;
      assert.equal(out["sha"], expect, ref);
      assert.equal(out["ref"], ref);
      assert.equal(out["branch"], "main", "branch is always the remote's default");
    }
  });

  it("an unknown ref fails the step with a plain message", async () => {
    const one = mk("co", z.object({ repo: z.string() }), step("checkout", "git/checkout", { repo: "{{ input.repo }}", ref: "nope" }));
    const res = await runWorkflow(one, { repo: originUrl }, registry, { services: services() });
    assert.equal(res.status, "error");
    assert.match(res.error!.message, /ref "nope" not found/);
  });

  it("a later checkout fetches new commits into the cache", async () => {
    await writeFile(join(origin, "later.txt"), "later\n");
    sh(["add", "-A"], origin);
    sh(["commit", "-q", "-m", "later"], origin);
    const head = sh(["rev-parse", "main"], origin);
    const one = mk("co", z.object({ repo: z.string() }), step("checkout", "git/checkout", { repo: "{{ input.repo }}" }));
    const res = await runWorkflow(one, { repo: originUrl }, registry, { services: services() });
    assert.equal(res.status, "success", JSON.stringify(res));
    assert.equal((res.output as Record<string, unknown>)["sha"], head);
  });

  it("nothing changed → an empty diff, zero files, no scan", async () => {
    const quiet = mk(
      "quiet",
      z.object({ repo: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}" }),
      step("diff", "git/diff", { path: "{{ checkout.path }}" }),
    );
    const res = await runWorkflow(quiet, { repo: originUrl }, registry, { services: services() });
    assert.equal(res.status, "success", JSON.stringify(res));
    assert.deepEqual(res.output, { diff: "", files: [], filesChanged: 0, sha256: sha256(""), scanned: false });
  });

  it("caps: too many files, too many bytes", async () => {
    const capped = (cfg: Record<string, unknown>) =>
      mk(
        "capped",
        z.object({ repo: z.string() }),
        step("checkout", "git/checkout", { repo: "{{ input.repo }}" }),
        step("edit", "edit", { path: "{{ checkout.path }}", files: { "a.txt": "a\n", "b.txt": "b\n" } }),
        step("diff", "git/diff", { path: "{{ checkout.path }}", ...cfg }),
      );
    const files = await runWorkflow(capped({ maxFiles: 1 }), { repo: originUrl }, registry, { services: services() });
    assert.equal(files.status, "error");
    assert.match(files.error!.message, /touches 2 files \(max 1\)/);
    const bytes = await runWorkflow(capped({ maxBytes: 20 }), { repo: originUrl }, registry, { services: services() });
    assert.equal(bytes.status, "error");
    assert.match(bytes.error!.message, /larger than 20 bytes/);
  });

  it("the token never reaches the run log, the cache, or the working copy", async () => {
    const TOKEN = "ghp_sekrit_token_value_0123456789";
    const events: RunEvent[] = [];
    const store = new MemoryRunStore();
    const res = await runWorkflow(proposeFlow(), { repo: originUrl }, registry, {
      services: standardServices({ secretsSource: { GITHUB_TOKEN: TOKEN }, dataDir }),
      store,
      onEvent: (e) => void events.push(e),
    });
    assert.equal(res.status, "success", JSON.stringify(res));
    assert.ok(!JSON.stringify(events).includes(TOKEN), "events");
    assert.ok(!JSON.stringify(res).includes(TOKEN), "result");
    assert.ok(!JSON.stringify(await store.getSummary("propose", res.runId)).includes(TOKEN), "summary");
    const cache = cachePath(dataDir, parseRepo(originUrl));
    assert.ok(!(await readFile(join(cache, "config"), "utf8")).includes(TOKEN), "cache config");
    assert.equal(sh(["config", "--get", "remote.origin.url"], cache), originUrl, "the remote URL stays clean");
  });

  it("a secret in the change fails the step, naming the rule and file but not the value", { skip: !hasGitleaks }, async () => {
    const token = "ghp_" + "wmlTQsFq3O0uO4B7FfQHcNYrnDu8S9fkSGq";
    const leaky = mk(
      "leaky",
      z.object({ repo: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}" }),
      step("edit", "edit", { path: "{{ checkout.path }}", files: { "config.txt": `token = "${token}"\n` } }),
      step("diff", "git/diff", { path: "{{ checkout.path }}" }),
    );
    const res = await runWorkflow(leaky, { repo: originUrl }, registry, { services: services() });
    assert.equal(res.status, "error");
    assert.match(res.error!.message, /contains a secret/);
    assert.match(res.error!.message, /config\.txt/);
    assert.ok(!res.error!.message.includes(token), "the value is never surfaced");
  });

  it("two concurrent runs of the same repo both succeed (one writer per cache)", async () => {
    const one = mk(
      "co",
      z.object({ repo: z.string() }),
      step("checkout", "git/checkout", { repo: "{{ input.repo }}" }),
      step("edit", "edit", { path: "{{ checkout.path }}", files: { "x.txt": "x\n" } }),
      step("diff", "git/diff", { path: "{{ checkout.path }}" }),
    );
    const [a, b] = await Promise.all([
      runWorkflow(one, { repo: originUrl }, registry, { services: services() }),
      runWorkflow(one, { repo: originUrl }, registry, { services: services() }),
    ]);
    assert.equal(a.status, "success", JSON.stringify(a));
    assert.equal(b.status, "success", JSON.stringify(b));
    assert.equal((a.output as { filesChanged: number }).filesChanged, 1);
    assert.equal((b.output as { filesChanged: number }).filesChanged, 1);
  });
});

describe("parseRepo", () => {
  it("accepts https and file URLs, strips .git, splits owner/name", () => {
    assert.deepEqual(parseRepo("https://github.com/stakwork/strut.git/"), {
      url: "https://github.com/stakwork/strut.git",
      host: "github.com",
      owner: "stakwork",
      name: "strut",
    });
    const f = parseRepo("file:///tmp/x/origin");
    assert.equal(f.host, "local");
    assert.equal(f.owner, "tmp/x");
    assert.equal(f.name, "origin");
  });
  it("rejects ssh remotes, credentials in the URL, and a bare host", () => {
    assert.throws(() => parseRepo("git@github.com:stakwork/strut.git"), /http\(s\) URL/);
    assert.throws(() => parseRepo("https://x:tok@github.com/stakwork/strut"), /must not carry credentials/);
    assert.throws(() => parseRepo("https://github.com/strut"), /owner and a name/);
    assert.throws(() => parseRepo("https://github.com/a/..%2fb"), /invalid path segment/);
  });
});
