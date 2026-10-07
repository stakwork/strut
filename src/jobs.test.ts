import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { z } from "zod";
import { defineStep, flow, step, type RunEvent, type StepContext, type StepRegistry } from "./core.js";
import { runWorkflow } from "./runner.js";
import { MemoryRunStore } from "./store.js";
import { fileArtifactsCapability, shellCapability, standardServices, type StrutCapabilities } from "./capabilities.js";
import { readRunStart } from "./journal.js";
import { holdJob, jobHolder, jobRoot, listJobFiles, readJobRecord, sweepJobs, touchJob } from "./jobs.js";
import { RunController } from "./run-control.js";
import { artifactKind, resolveArtifactRefs } from "./artifact-refs.js";
import jobDir from "./steps/lib/job/dir.js";
import pack from "./steps/core/pack.js";
import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { WorkspaceManager } from "./workspace.js";

/** Test-only: what a step sees of its run. */
const probe = defineStep({
  type: "probe",
  input: z.object({ tpl: z.any().optional() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<unknown>) {
    return { job: ctx.job ?? null, tpl: cfg.tpl ?? null };
  },
});

/** Test-only: write a file under a directory (what an agent step would do). */
const writer = defineStep({
  type: "writer",
  input: z.object({ dir: z.string(), name: z.string(), text: z.string() }),
  output: z.any(),
  async run(cfg) {
    await mkdir(join(cfg.dir, cfg.name, ".."), { recursive: true });
    await writeFile(join(cfg.dir, cfg.name), cfg.text);
    return { wrote: cfg.name };
  },
});

// ── the stamp (plans/jobs.md §1) ─────────────────────────────────────────

describe("jobs — the `job` a run is launched under", () => {
  const registry: StepRegistry = { probe };
  const wf = flow("stamped", {
    input: z.any(),
    steps: [step("p", "probe", { tpl: "{{ $job }}" })],
  });

  it("is recorded on run.start and the summary, handed to steps, and seen by templates as $job", async () => {
    const store = new MemoryRunStore();
    const res = await runWorkflow(wf, {}, registry, { store, job: "j-1" });
    assert.equal(res.status, "success", JSON.stringify(res));
    assert.deepEqual(res.output, { job: "j-1", tpl: "j-1" });
    const events = await store.getRunEvents("stamped", res.runId);
    assert.equal(events.find((e) => e.type === "run.start")!.job, "j-1");
    assert.equal((await store.getRunSummary("stamped", res.runId))!.job, "j-1");
    assert.equal(readRunStart(events)!.job, "j-1", "a resume reads it back");
  });

  it("is absent everywhere on a plain run, and $job resolves to nothing", async () => {
    const store = new MemoryRunStore();
    const res = await runWorkflow(wf, {}, registry, { store });
    assert.deepEqual(res.output, { job: null, tpl: null });
    const events = await store.getRunEvents("stamped", res.runId);
    assert.equal("job" in events.find((e) => e.type === "run.start")!, false);
    assert.equal("job" in (await store.getRunSummary("stamped", res.runId))!, false);
  });
});

// ── the directory (§2) ───────────────────────────────────────────────────

describe("jobs — the directory", () => {
  let root: string;
  let dataDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-jobs-"));
    dataDir = join(root, "data");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Test-only: a step that waits until it is let go, holding its run open. */
  let letGo: () => void = () => {};
  let waiting: () => void = () => {};
  const gate = defineStep({
    type: "gate",
    input: z.object({}),
    output: z.any(),
    async run() {
      waiting();
      await new Promise<void>((r) => (letGo = r));
      return {};
    },
  });

  const registry: StepRegistry = { "job/dir": jobDir, probe, writer, gate };
  const services = () => ({
    ...standardServices({ secretsSource: {}, dataDir }),
    artifacts: fileArtifactsCapability(join(dataDir, "artifacts")),
  });
  const dirFlow = (...more: ReturnType<typeof step>[]) =>
    flow("dirs", { input: z.any(), steps: [step("dir", "job/dir", {}), ...more] });
  const runOf = async (f: ReturnType<typeof dirFlow>, opts: { job?: string; runId?: string } = {}) => {
    const store = new MemoryRunStore();
    const res = await runWorkflow(f, {}, registry, { services: services(), store, ...opts });
    const events: RunEvent[] = await store.getRunEvents("dirs", res.runId);
    const end = events.find((e) => e.type === "step.end" && e.path === "dirs/dir");
    return { res, out: end?.output as Record<string, any> | undefined };
  };

  it("job/dir creates <dataDir>/jobs/<job>/ once, with its record beside it, and returns the same path every run", async () => {
    const first = await runOf(dirFlow(step("w", "writer", { dir: "{{ dir.path }}", name: "plan.md", text: "v1" })), { job: "j-dir" });
    assert.equal(first.res.status, "success", JSON.stringify(first.res));
    assert.deepEqual(first.out, { path: jobRoot(dataDir, "j-dir"), job: "j-dir", created: true });
    assert.ok(existsSync(`${jobRoot(dataDir, "j-dir")}.json`), "the record sits beside the directory");
    assert.equal(await readFile(join(first.out!["path"], "plan.md"), "utf8"), "v1");

    const second = await runOf(dirFlow(step("w", "writer", { dir: "{{ dir.path }}", name: "plan.md", text: "v2" })), { job: "j-dir" });
    assert.deepEqual(second.out, { path: first.out!["path"], job: "j-dir", created: false });
    assert.equal(await readFile(join(first.out!["path"], "plan.md"), "utf8"), "v2", "the same file, revised");
  });

  it("without a job it hands out the run's own artifact directory, so the workflow is a one-shot", async () => {
    const { res, out } = await runOf(dirFlow());
    assert.equal(res.status, "success", JSON.stringify(res));
    assert.deepEqual(out, { path: join(dataDir, "artifacts", res.runId), created: false });
    assert.ok(!existsSync(join(dataDir, "jobs")));
  });

  it("one run at a time: a second run of the job is job_busy until the first ends", async () => {
    const held = new Promise<void>((r) => (waiting = r));
    const first = runOf(dirFlow(step("wait", "gate", {})), { job: "busy", runId: "run-a" });
    await held;
    const second = await runOf(dirFlow(), { job: "busy", runId: "run-b" });
    assert.equal(second.res.status, "error");
    assert.match(second.res.error!.message, /job_busy: job "busy" is in use by run run-a/);
    letGo();
    assert.equal((await first).res.status, "success");
    assert.equal((await runOf(dirFlow(), { job: "busy", runId: "run-c" })).res.status, "success");
  });

  it("holdJob: the same run may take a job twice; outside the runner nothing is held", () => {
    const r = jobRoot(dataDir, "h");
    const disposers: Array<() => unknown> = [];
    const ctx = { runId: "r1", onRunEnd: (fn: () => unknown) => void disposers.push(fn) };
    holdJob(ctx, r, "h");
    holdJob(ctx, r, "h");
    assert.throws(() => holdJob({ runId: "r2", onRunEnd: () => {} }, r, "h"), /job_busy/);
    for (const d of disposers) d();
    holdJob({ runId: "r2" }, r, "h"); // no onRunEnd: not held
    holdJob({ runId: "r3" }, r, "h");
  });

  it("holdJob: a child run of the holder shares the hold and leaves it with the holder; an unrelated run is still job_busy", () => {
    const r = jobRoot(dataDir, "tree");
    // The tree a nested launch builds: meta/run-workflow attaches the child's
    // controller under the launching run's (trackRun's parentRunId).
    const parent = new RunController("p", "job");
    const child = new RunController("c", "child", parent);
    const grandchild = new RunController("g", "grandchild", child);
    const other = new RunController("o", "job");
    const releases: Record<string, Array<() => unknown>> = { p: [], c: [], g: [], o: [], s: [] };
    const ctxOf = (c: RunController) => ({ runId: c.runId, onRunEnd: (fn: () => unknown) => void releases[c.runId]!.push(fn), control: c.forUnit() });

    holdJob(ctxOf(parent), r, "tree");
    holdJob(ctxOf(child), r, "tree");
    holdJob(ctxOf(grandchild), r, "tree");
    assert.equal(jobHolder(r), "p", "the holder is still the parent");
    assert.equal(releases["c"]!.length + releases["g"]!.length, 0, "a child registers no release of its own");

    assert.throws(() => holdJob(ctxOf(other), r, "tree"), /job_busy: job "tree" is in use by run p/);
    assert.throws(() => holdJob({ runId: "x", onRunEnd: () => {} }, r, "tree"), /job_busy/, "no control at all: not a child");
    // The holder's child may not be used as a door by a run outside the tree.
    const stranger = new RunController("s", "job", other);
    assert.throws(() => holdJob(ctxOf(stranger), r, "tree"), /job_busy/);

    for (const d of releases["p"]!) d();
    assert.equal(jobHolder(r), undefined, "released with the holder");
    holdJob(ctxOf(other), r, "tree");
    assert.equal(jobHolder(r), "o");
  });

  describe("the sweep (§2.1)", () => {
    const shell = shellCapability();
    const DAY = 86_400_000;
    /** A job on disk: files, and repositories the record names (whose
     *  caches do not exist — the sweep only removes their directories). */
    const seed = async (name: string, opts: { files?: string[]; repos?: string[]; idleDays: number }) => {
      const r = jobRoot(dataDir, name);
      await mkdir(r, { recursive: true });
      for (const f of opts.files ?? []) await writeFile(join(r, f), f);
      const rec = await touchJob(r, name);
      for (const repo of opts.repos ?? []) {
        await mkdir(join(r, repo), { recursive: true });
        await writeFile(join(r, repo, ".git"), "gitdir: nowhere");
        await touchJob(r, name, { dir: join(r, repo), cache: join(dataDir, "repos", `${repo}.git`), ref: "main" });
      }
      rec.usedAt = new Date(Date.now() - opts.idleDays * DAY).toISOString();
      const latest = (await readJobRecord(r))!;
      latest.usedAt = rec.usedAt;
      await writeFile(`${r}.json`, JSON.stringify(latest));
      return r;
    };

    it("removes an idle job's repositories and keeps its files and record", async () => {
      const r = await seed("mixed", { files: ["plan.md"], repos: ["hive"], idleDays: 8 });
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), ["mixed"]);
      assert.ok(!existsSync(join(r, "hive")));
      assert.equal(await readFile(join(r, "plan.md"), "utf8"), "plan.md");
      assert.deepEqual((await readJobRecord(r))!.repos, {});
      // Nothing left to sweep next time.
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), []);
    });

    it("removes a job with nothing left, with its record", async () => {
      const r = await seed("bare", { repos: ["hive"], idleDays: 8 });
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), ["bare"]);
      assert.ok(!existsSync(r));
      assert.ok(!existsSync(`${r}.json`));
    });

    it("leaves a job that is not idle, a held one, and everything when the TTL is 0", async () => {
      const fresh = await seed("fresh", { repos: ["hive"], idleDays: 1 });
      const heldJob = await seed("held", { repos: ["hive"], idleDays: 30 });
      const old = await seed("old", { repos: ["hive"], idleDays: 30 });
      holdJob({ runId: "r-hold", onRunEnd: () => {} }, heldJob, "held");
      assert.deepEqual(await sweepJobs(shell, dataDir, 0), []);
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), ["old"]);
      assert.ok(existsSync(join(fresh, "hive")));
      assert.ok(existsSync(join(heldJob, "hive")));
      assert.ok(!existsSync(old));
    });
  });

  it("listJobFiles: every file, recursive and sorted, skipping the job's repositories", async () => {
    const r = jobRoot(dataDir, "ls");
    await mkdir(join(r, "notes"), { recursive: true });
    await mkdir(join(r, "hive", "src"), { recursive: true });
    await writeFile(join(r, "plan.md"), "");
    await writeFile(join(r, "notes", "a.md"), "");
    await writeFile(join(r, "hive", "src", "index.ts"), "");
    await writeFile(join(r, "hive", ".git"), "gitdir: x");
    await touchJob(r, "ls", { dir: join(r, "hive"), cache: "/nowhere", ref: "main" });
    assert.deepEqual(await listJobFiles(r, await readJobRecord(r)), [join("notes", "a.md"), "plan.md"]);
    assert.deepEqual(await listJobFiles(jobRoot(dataDir, "never"), null), []);
  });
});

// ── deliverables (§3) ────────────────────────────────────────────────────

describe("jobs — artifact refs", () => {
  it("artifactKind reads the host's renderer name off the extension, `url` otherwise", () => {
    assert.equal(artifactKind("plan.md"), "markdown");
    assert.equal(artifactKind("out/index.html"), "html");
    assert.equal(artifactKind("shots/turn-7.PNG"), "image");
    assert.equal(artifactKind("clip.mp4"), "video");
    assert.equal(artifactKind("a.json"), "json");
    assert.equal(artifactKind("x.diff"), "diff");
    assert.equal(artifactKind("build.log"), "log");
    assert.equal(artifactKind("main.ts"), "code");
    assert.equal(artifactKind("https://pod.example/app?x=1"), "url");
    assert.equal(artifactKind("README"), "url");
    assert.equal(artifactKind(".env"), "url");
  });

  const at = (job?: string) => ({
    runId: "run-1",
    ...(job ? { job } : {}),
    exists: async (url: string) => !url.endsWith("/nope.md"),
  });

  it("resolves a path into the job's directory, or the run's artifact directory without a job", async () => {
    const output = { text: "done", artifacts: [{ id: "plan", title: "Plan", path: "plan.md" }] };
    assert.deepEqual(await resolveArtifactRefs(output, at("j-1")), [
      { id: "plan", kind: "markdown", title: "Plan", url: "/jobs/j-1/files/plan.md" },
    ]);
    assert.deepEqual(await resolveArtifactRefs(output, at()), [
      { id: "plan", kind: "markdown", title: "Plan", url: "/artifacts/run-1/plan.md" },
    ]);
  });

  it("passes urls and content through (both when both are given — the fields are not exclusive; a path takes a url's place), keeps label/summary and a given kind, and reports what it cannot resolve", async () => {
    const output = {
      artifacts: [
        { id: "pod", kind: "url", title: "Pod", label: "Sandbox", summary: "the app", url: "https://pod.example/" },
        { id: "clip", title: "Clip", url: "/artifacts/run-0/clip.mp4" },
        { id: "diff", kind: "diff", title: "Diff", content: "--- a\n+++ b\n" },
        { id: "gone", title: "Gone", path: "nope.md" },
        { id: "bad", title: "Bad", url: "ftp://x/y" },
        { id: "up", title: "Up", path: "../secrets.json" },
        { id: "both", title: "Both", path: "a.md", url: "/x" },
        { id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/a/b/pull/5", content: '{"url":"https://github.com/a/b/pull/5","repo":"a/b","number":5,"state":"open"}' },
        { id: "gone-but-inline", title: "Gone", path: "nope.md", content: "# still here" },
        { id: "none", title: "None" },
        { id: "big", title: "Big", content: "x".repeat(50_001) },
        { title: "no id", path: "a.md" },
        "not an entry",
      ],
    };
    assert.deepEqual(await resolveArtifactRefs(output, at("j-1")), [
      { id: "pod", kind: "url", title: "Pod", label: "Sandbox", summary: "the app", url: "https://pod.example/" },
      { id: "clip", kind: "video", title: "Clip", url: "/artifacts/run-0/clip.mp4" },
      { id: "diff", kind: "diff", title: "Diff", content: "--- a\n+++ b\n" },
      { id: "gone", kind: "markdown", title: "Gone", error: "not found" },
      { id: "bad", kind: "url", title: "Bad", error: "bad url" },
      { id: "up", kind: "json", title: "Up", error: "bad path" },
      { id: "both", kind: "markdown", title: "Both", url: "/jobs/j-1/files/a.md" },
      { id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/a/b/pull/5", content: '{"url":"https://github.com/a/b/pull/5","repo":"a/b","number":5,"state":"open"}' },
      { id: "gone-but-inline", kind: "markdown", title: "Gone", content: "# still here" },
      { id: "none", kind: "url", title: "None", error: "one of path, url or content is required" },
      { id: "big", kind: "url", title: "Big", error: "too large" },
    ]);
  });

  it("is undefined when the output declares none", async () => {
    assert.equal(await resolveArtifactRefs({ text: "hi" }, at()), undefined);
    assert.equal(await resolveArtifactRefs("a string", at()), undefined);
    assert.equal(await resolveArtifactRefs(undefined, at()), undefined);
  });
});

// ── over HTTP: the launch, the callback, the routes ───────────────────────

describe("jobs — over HTTP", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "strut-jobs-http-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A stand-in host: collects what strut posts. */
  async function callbackHost(): Promise<{ url: string; posts: any[]; close: () => void }> {
    const posts: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        posts.push(JSON.parse(body));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/hook?token=s3cret`, posts, close: () => server.close() };
  }

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(cond(), "condition never held");
  }

  const boot = async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([writer, probe, pack]),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
    });
    // The V1 job workflow's shape (plans/jobs.md §11), with a writer for the agent.
    await strut.workspace.publishWorkflow("deliver", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "w", type: "writer", config: { dir: "{{ dir.path }}", name: "plan.md", text: "# plan {{ input.n }}" } },
        {
          id: "result",
          type: "pack",
          config: {
            text: "wrote the plan",
            artifacts: [
              { id: "plan", title: "Plan", path: "plan.md" },
              { id: "pod", kind: "url", title: "Pod", url: "https://pod.example/" },
              { id: "missing", title: "Missing", path: "nope.md" },
            ],
          },
        },
      ],
    });
    const api = async (path: string, init?: { method?: string; body?: unknown }) => {
      const res = await strut.app.request(path, {
        method: init?.method ?? (init?.body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      });
      return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
    };
    return { strut, api };
  };

  it("a run launched with a job writes into the job's directory, and the callback carries its artifacts as links", async () => {
    const { strut, api } = await boot();
    const host = await callbackHost();
    try {
      const first = await api("/workflows/deliver/run", { body: { job: "j-http", input: { n: 1 }, callback: { url: host.url } } });
      assert.equal(first.status, 202, JSON.stringify(first.json));
      await until(() => host.posts.length === 1);
      const post = host.posts[0];
      assert.equal(post.status, "success", JSON.stringify(post));
      assert.deepEqual(post.artifacts, [
        { id: "plan", kind: "markdown", title: "Plan", url: "/jobs/j-http/files/plan.md" },
        { id: "pod", kind: "url", title: "Pod", url: "https://pod.example/" },
        { id: "missing", kind: "markdown", title: "Missing", error: "not found" },
      ]);
      // `output` is what the workflow packed, untouched.
      assert.deepEqual(post.output.artifacts[0], { id: "plan", title: "Plan", path: "plan.md" });
      assert.equal(await readFile(join(tempDir, "jobs", "j-http", "plan.md"), "utf8"), "# plan 1");

      // The next turn revises the same file behind the same link.
      const second = await api("/workflows/deliver/run", { body: { job: "j-http", input: { n: 2 }, callback: { url: host.url } } });
      assert.equal(second.status, 202);
      await until(() => host.posts.length === 2);
      assert.equal(host.posts[1].artifacts[0].url, "/jobs/j-http/files/plan.md");
      assert.equal(await readFile(join(tempDir, "jobs", "j-http", "plan.md"), "utf8"), "# plan 2");

      // The same list, for a host that missed the callback; the summary is stamped.
      const refs = await api(`/workflows/deliver/runs/${second.json.runId}/artifacts`);
      assert.equal(refs.status, 200);
      assert.equal(refs.json.job, "j-http");
      assert.deepEqual(refs.json.artifacts, host.posts[1].artifacts);
      assert.equal((await api(`/workflows/deliver/runs/${second.json.runId}`)).json.job, "j-http");

      // The files, served sandboxed.
      const list = await api("/jobs/j-http/files");
      assert.deepEqual(list.json, { job: "j-http", files: ["plan.md"] });
      const file = await strut.app.request("/jobs/j-http/files/plan.md");
      assert.equal(file.status, 200);
      assert.equal(await file.text(), "# plan 2");
      assert.equal(file.headers.get("content-type"), "text/markdown; charset=utf-8");
      assert.equal(file.headers.get("content-security-policy"), "sandbox");
      assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    } finally {
      host.close();
    }
  });

  it("without a job the same workflow delivers into the run's artifact directory", async () => {
    const { api } = await boot();
    const host = await callbackHost();
    try {
      const res = await api("/workflows/deliver/run", { body: { input: { n: 3 }, callback: { url: host.url } } });
      assert.equal(res.status, 202);
      await until(() => host.posts.length === 1);
      const runId = res.json.runId;
      assert.equal(host.posts[0].artifacts[0].url, `/artifacts/${runId}/plan.md`);
      assert.equal(await readFile(join(tempDir, "artifacts", runId, "plan.md"), "utf8"), "# plan 3");
      assert.equal("job" in (await api(`/workflows/deliver/runs/${runId}/artifacts`)).json, false);
      assert.ok(!existsSync(join(tempDir, "jobs")));
    } finally {
      host.close();
    }
  });

  it("a bad job id is a 400 and launches nothing; the file routes refuse escapes and unknown jobs", async () => {
    const { api, strut } = await boot();
    for (const job of ["", "/review", "a..b/", "has space", 42]) {
      assert.equal((await api("/workflows/deliver/run", { body: { job, input: {} } })).status, 400, JSON.stringify(job));
    }
    assert.equal((await api("/workflows/deliver/runs")).json.length, 0, "nothing launched");

    await mkdir(join(tempDir, "jobs", "j-files"), { recursive: true });
    await writeFile(join(tempDir, "jobs", "j-files", "a.txt"), "a");
    await writeFile(join(tempDir, "secret.txt"), "s");
    assert.equal((await api("/jobs/j-files/files/a.txt")).status, 200);
    assert.equal((await strut.app.request("/jobs/j-files/files/../secret.txt")).status, 404, "normalized away by the router or refused");
    assert.equal((await api("/jobs/j-files/files/..%2Fsecret.txt")).status, 400);
    assert.equal((await api("/jobs/j-files/files/nope.txt")).status, 404);
    assert.equal((await api("/jobs/never/files")).status, 404);
    assert.equal((await api("/jobs/%2Freview/files")).status, 400);
  });
});
