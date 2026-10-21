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
import { holdJob, jobHolder, jobRoot, jobsCapability, listJobFiles, notifyJob, readJobRecord, releaseWith, setJobCallback, sweepJobs, touchJob, turnOf, JOB_WORKFLOWS } from "./jobs.js";
import { RunController } from "./run-control.js";
import { artifactKind, jobFileUrl, resolveArtifactRefs } from "./artifact-refs.js";
import { captchaFiles } from "./browser/captcha.js";
import { mediaOf } from "./core.js";
import { MemorySessionStore } from "./session-store.js";
import { holdUrls } from "./job-index.js";
import jobDir from "./steps/lib/job/dir.js";
import jobRead from "./steps/lib/job/read.js";
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

/** Test-only: the release step a hold names (§6) — records what it was
 *  handed, or refuses when told to. */
const releases: Array<{ input: unknown; job?: string }> = [];
let releaseFails = false;
const releaser = defineStep({
  type: "fake/release",
  input: z.object({ podId: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<unknown>) {
    if (releaseFails) throw new Error("pool says no");
    releases.push({ input: cfg, ...(ctx.job ? { job: ctx.job } : {}) });
    return { ok: true };
  },
});

/** Test-only: what a claiming tool does — hold something on the run's job. */
const holder = defineStep({
  type: "holder",
  input: z.object({ id: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    await ctx.services.jobs!.hold(ctx.job!, { id: cfg.id, kind: "pod", release: { type: "fake/release", input: { podId: cfg.id } } });
    return { held: cfg.id };
  },
});

/** Test-only: a step that wrote a file the person may want to watch, and
 *  says so (plans/live-artifacts.md §3). */
const notifier = defineStep({
  type: "notifier",
  input: z.object({ path: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    ctx.services.jobs?.notify?.(ctx.job!, { kind: "image", url: jobFileUrl(ctx.job!, cfg.path), state: "done", runId: ctx.runId });
    return { told: cfg.path };
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

  it("records the run on the job through services.jobs at run.start — the launch's title and actor, a child's parent — and nothing on a resume (plans/job-index.md §1)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const jobs = { recordRun: async (job: string, run: object) => void calls.push({ job, ...run }) };
    const store = new MemoryRunStore();
    const res = await runWorkflow(wf, {}, registry, { store, job: "j-1", title: "First", actor: "ann", services: { jobs } });
    assert.equal(res.status, "success");
    assert.deepEqual(calls, [{ job: "j-1", workflow: "stamped", runId: res.runId, actor: "ann", title: "First" }]);

    const parent = new RunController("p", "job");
    const child = await runWorkflow(wf, {}, registry, { store, job: "j-1", controller: new RunController("c", "stamped", parent), services: { jobs } });
    assert.deepEqual(calls[1], { job: "j-1", workflow: "stamped", runId: child.runId, parentRunId: "p" });

    await runWorkflow(wf, {}, registry, { store, runId: res.runId, job: "j-1", resume: true, services: { jobs } });
    assert.equal(calls.length, 2, "a resume is already on the list");

    await runWorkflow(wf, {}, registry, { store, services: { jobs } });
    assert.equal(calls.length, 2, "no job, nothing to record");

    // Bookkeeping never fails a run.
    const broken = { recordRun: async () => { throw new Error("disk full"); } };
    assert.equal((await runWorkflow(wf, {}, registry, { store, job: "j-1", services: { jobs: broken } })).status, "success");
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

    it("keeps the record of a job with nothing left when it is the job's history — it has runs (plans/job-index.md, ruling 7)", async () => {
      const r = await seed("remembered", { repos: ["hive"], idleDays: 8 });
      const rec = (await readJobRecord(r))!;
      rec.runs = [{ workflow: "turn", runId: "1", at: rec.usedAt }];
      await writeFile(`${r}.json`, JSON.stringify(rec));
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), ["remembered"], "the repository still goes");
      assert.ok(!existsSync(join(r, "hive")));
      assert.ok(existsSync(`${r}.json`));
      assert.equal((await readJobRecord(r))!.runs!.length, 1);
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), [], "nothing left to change");
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

    // ── holds (§6) ──────────────────────────────────────────────────────

    /** Re-age a job after a hold stamped it used. */
    const age = async (r: string, days: number) => {
      const rec = (await readJobRecord(r))!;
      rec.usedAt = new Date(Date.now() - days * DAY).toISOString();
      await writeFile(`${r}.json`, JSON.stringify(rec));
    };
    const release = releaseWith({ "fake/release": releaser }, { probe: true });
    beforeEach(() => {
      releases.length = 0;
      releaseFails = false;
    });

    it("ctx.services.jobs records a hold with its release step beside the directory; the same id replaces; release drops it", async () => {
      const jobs = jobsCapability(dataDir);
      const pod = (id: string, podId = id) => ({ id, kind: "pod", release: { type: "fake/release", input: { podId } } });
      await jobs.hold("h-1", pod("pod-a"));
      await jobs.hold("h-1", { ...pod("pod-b"), note: "the second" });
      let holds = await jobs.holds("h-1");
      assert.deepEqual(holds.map((h) => [h.id, h.kind, h.note]), [["pod-a", "pod", undefined], ["pod-b", "pod", "the second"]]);
      assert.ok(holds.every((h) => !Number.isNaN(Date.parse(h.since))));
      assert.ok(existsSync(`${jobRoot(dataDir, "h-1")}.json`), "the record, before any job/dir");
      assert.ok(!existsSync(jobRoot(dataDir, "h-1")));

      await jobs.hold("h-1", { ...pod("pod-a", "pod-a-again"), url: "https://pod-a.example" });
      holds = await jobs.holds("h-1");
      assert.deepEqual(holds.map((h) => h.release.input), [{ podId: "pod-b" }, { podId: "pod-a-again" }], "a re-claim replaces");
      assert.deepEqual(holds.map((h) => h.url), [undefined, "https://pod-a.example"], "a hold's url round-trips (plans/job-claims.md §3)");
      assert.equal((await readJobRecord(jobRoot(dataDir, "h-1")))!.holds![1]!.url, "https://pod-a.example", "on the record");

      await jobs.release("h-1", "pod-b");
      await jobs.release("h-1", "never");
      assert.deepEqual((await jobs.holds("h-1")).map((h) => h.id), ["pod-a"]);
      await jobs.release("h-1", "pod-a");
      assert.equal("holds" in (await readJobRecord(jobRoot(dataDir, "h-1")))!, false);
      assert.deepEqual(await jobs.holds("nobody"), []);
      await assert.rejects(jobs.hold("/bad", pod("x")), /jobs: job id "\/bad"/);
    });

    it("the sweep lets an idle job's holds go through their release step — with a registry — then removes its repositories", async () => {
      const jobs = jobsCapability(dataDir);
      const r = await seed("podded", { files: ["plan.md"], repos: ["hive"], idleDays: 8 });
      await jobs.hold("podded", { id: "pod-1", kind: "pod", release: { type: "fake/release", input: { podId: "pod-1" } } });
      await age(r, 8);
      // Without a runner the job is left alone: only a caller with a registry can release.
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY), []);
      assert.ok(existsSync(join(r, "hive")));
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY, { release }), ["podded"]);
      assert.deepEqual(releases, [{ input: { podId: "pod-1" }, job: "podded" }]);
      assert.deepEqual(await jobs.holds("podded"), []);
      assert.ok(!existsSync(join(r, "hive")));
      assert.equal(await readFile(join(r, "plan.md"), "utf8"), "plan.md");
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY, { release }), []);
    });

    it("a hold that will not release stays for the next sweep and keeps the job", async () => {
      const jobs = jobsCapability(dataDir);
      const r = await seed("stuck", { repos: ["hive"], idleDays: 8 });
      await jobs.hold("stuck", { id: "pod-2", kind: "pod", release: { type: "fake/release", input: { podId: "pod-2" } } });
      await jobs.hold("stuck", { id: "pod-3", kind: "pod", release: { type: "no/such-step", input: {} } });
      await age(r, 8);
      releaseFails = true;
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY, { release }), ["stuck"], "the repositories still go");
      assert.ok(!existsSync(join(r, "hive")));
      assert.deepEqual((await jobs.holds("stuck")).map((h) => h.id), ["pod-2", "pod-3"]);
      assert.ok(existsSync(`${r}.json`), "a job with holds is not 'nothing left'");
      // Next time: pod-2 releases; pod-3's step is still not there.
      releaseFails = false;
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY, { release }), ["stuck"]);
      assert.deepEqual((await jobs.holds("stuck")).map((h) => h.id), ["pod-3"]);
      assert.deepEqual(await sweepJobs(shell, dataDir, 7 * DAY, { release }), [], "nothing changed: not reported");
      assert.ok(existsSync(`${r}.json`));
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

  it("a record is never read half-written: the readers take no lock, so every write is whole", async () => {
    const r = jobRoot(dataDir, "busy");
    await touchJob(r, "busy");
    let writing = true;
    const writes = (async () => {
      for (let i = 0; i < 300; i++) await touchJob(r, "busy", { dir: join(r, `repo-${i}`), cache: "/nowhere", ref: "main" });
      writing = false;
    })();
    let reads = 0;
    let misses = 0;
    while (writing) {
      reads++;
      if (!(await readJobRecord(r))) misses++;
    }
    await writes;
    assert.ok(reads > 0);
    assert.equal(misses, 0, `${misses} of ${reads} reads found no record while it was being written`);
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
    // A recording's manifest is known by its name (plans/live-artifacts.md §5).
    assert.equal(artifactKind("walkthroughs/004/walkthrough.json"), "walkthrough");
    assert.equal(artifactKind("/jobs/j-1/files/walkthroughs/004/walkthrough.json?t=x"), "walkthrough");
    assert.equal(artifactKind("walkthroughs/004/other.json"), "json");
    // So is a captcha round's, whatever round it is.
    assert.equal(artifactKind(captchaFiles(1).path), "captcha");
    assert.equal(artifactKind(`/jobs/j-1/files/${captchaFiles(12).path}?t=x`), "captcha");
    assert.equal(artifactKind("shots/captcha.json"), "json");
    assert.equal(artifactKind(captchaFiles(1).image), "image");
  });

  it("jobFileUrl is the link a deliverable's path resolves to, so a live update and the turn's deliverable name one file", async () => {
    assert.equal(jobFileUrl("j-1", "shots/001.png"), "/jobs/j-1/files/shots/001.png");
    assert.equal(jobFileUrl("a/b", "/shots/001.png"), "/jobs/a%2Fb/files/shots/001.png");
    const [ref] = (await resolveArtifactRefs({ artifacts: [{ id: "w", title: "W", path: "walkthroughs/004/walkthrough.json" }] }, { runId: "r", job: "a/b", exists: async () => true }))!;
    assert.deepEqual(ref, { id: "w", kind: "walkthrough", title: "W", url: jobFileUrl("a/b", "walkthroughs/004/walkthrough.json") });
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

  it("leaves an entry tagged with a peer as it came — its path and url are the peer's — and resolves the rest of the list", async () => {
    const checked: string[] = [];
    const output = {
      artifacts: [
        { id: "plan", title: "Plan", path: "plan.md" },
        { id: "far", title: "Far plan", path: "plan.md", peer: "acme-web", job: "peer/build-1" },
        { id: "far-gone", title: "Far ../", path: "../up.md", peer: "acme-web", job: "peer/build-1" },
        { id: "far-link", kind: "html", title: "Far page", url: "/jobs/peer%2Fbuild-1/files/page.html", peer: "acme-web" },
        { id: "far-pr", kind: "pull_request", title: "PR", url: "https://github.com/a/b/pull/5", peer: "acme-web", job: "peer/build-1" },
        { id: "far-inline", title: "Sample", content: "hello", peer: "acme-web" },
        { id: "far-empty", title: "Nothing", peer: "acme-web" },
      ],
    };
    const refs = await resolveArtifactRefs(output, { runId: "run-1", job: "build-1", exists: async (url) => (checked.push(url), true) });
    assert.deepEqual(refs, [
      { id: "plan", kind: "markdown", title: "Plan", url: "/jobs/build-1/files/plan.md" },
      { id: "far", kind: "markdown", title: "Far plan", path: "plan.md", peer: "acme-web", job: "peer/build-1" },
      { id: "far-gone", kind: "markdown", title: "Far ../", path: "../up.md", peer: "acme-web", job: "peer/build-1" },
      { id: "far-link", kind: "html", title: "Far page", url: "/jobs/peer%2Fbuild-1/files/page.html", peer: "acme-web" },
      { id: "far-pr", kind: "pull_request", title: "PR", url: "https://github.com/a/b/pull/5", peer: "acme-web", job: "peer/build-1" },
      { id: "far-inline", kind: "url", title: "Sample", content: "hello", peer: "acme-web" },
      { id: "far-empty", kind: "url", title: "Nothing", error: "one of path, url or content is required" },
    ]);
    assert.deepEqual(checked, ["/jobs/build-1/files/plan.md"], "nothing of the peer's is looked for here");
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
      registry: await createRegistry([writer, probe, pack, holder, releaser, notifier]),
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

  it("DELETE /jobs/:id lets every hold go through its release step, then removes the job; 409 while a run holds it, kept when a release fails", async () => {
    const { strut, api } = await boot();
    await strut.workspace.publishWorkflow("claim", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "w", type: "writer", config: { dir: "{{ dir.path }}", name: "plan.md", text: "plan" } },
        { id: "h", type: "holder", config: { id: "pod-9" } },
      ],
    });
    const host = await callbackHost();
    try {
      releases.length = 0;
      const run = await api("/workflows/claim/run", { body: { job: "j-del", input: {}, callback: { url: host.url } } });
      assert.equal(run.status, 202, JSON.stringify(run.json));
      await until(() => host.posts.length === 1);
      assert.equal(host.posts[0].status, "success", JSON.stringify(host.posts[0]));
      assert.deepEqual((await jobsCapability(tempDir).holds("j-del")).map((h) => h.id), ["pod-9"]);

      // A run holds the job: not now.
      const disposers: Array<() => unknown> = [];
      holdJob({ runId: "r-live", onRunEnd: (fn) => void disposers.push(fn) }, jobRoot(tempDir, "j-del"), "j-del");
      const busy = await api("/jobs/j-del", { method: "DELETE" });
      assert.equal(busy.status, 409);
      assert.match(busy.json.error, /job_busy: job "j-del" is in use by run r-live/);
      for (const d of disposers) d();

      // The pod will not release: the job is kept, with the hold, so it is not forgotten.
      releaseFails = true;
      const stuck = await api("/jobs/j-del", { method: "DELETE" });
      releaseFails = false;
      assert.equal(stuck.status, 500);
      assert.match(stuck.json.error, /could not release "pod-9" \(pool says no\); job "j-del" is kept/);
      assert.deepEqual((await api("/jobs/j-del/files")).json, { job: "j-del", files: ["plan.md"] });
      assert.deepEqual((await jobsCapability(tempDir).holds("j-del")).map((h) => h.id), ["pod-9"]);

      const gone = await api("/jobs/j-del", { method: "DELETE" });
      assert.deepEqual(gone.json, { ok: true, job: "j-del", released: ["pod-9"] });
      assert.deepEqual(releases, [{ input: { podId: "pod-9" }, job: "j-del" }]);
      assert.ok(!existsSync(join(tempDir, "jobs", "j-del")));
      assert.ok(!existsSync(join(tempDir, "jobs", "j-del.json")));
      assert.equal((await api("/jobs/j-del/files")).status, 404);
      assert.equal((await api("/jobs/j-del", { method: "DELETE" })).status, 404);
      // The run's record is untouched.
      assert.equal((await api(`/workflows/claim/runs/${run.json.runId}`)).json.job, "j-del");
    } finally {
      host.close();
    }
  });

  it("jobCallback (plans/live-artifacts.md §1): kept on the job apart from its record; every update of the job reaches it — a step's notify, a hold taken and let go — in order; the 202 says so", async () => {
    const { strut, api } = await boot();
    await strut.workspace.publishWorkflow("live", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "shot", type: "notifier", config: { path: "shots/001.png" } },
        { id: "h", type: "holder", config: { id: "pod-7" } },
      ],
    });
    const host = await callbackHost();
    try {
      const run = await api("/workflows/live/run", { body: { job: "j-live", input: {}, jobCallback: { url: host.url } } });
      assert.equal(run.status, 202, JSON.stringify(run.json));
      assert.equal(run.json.jobCallback, true, "the host's proof this server honors it");
      await until(() => host.posts.length === 2);
      assert.deepEqual(
        host.posts.map((p) => [p.event, p.job, p.kind, p.state, p.url ?? p.id]),
        [
          ["job.update", "j-live", "image", "done", "/jobs/j-live/files/shots/001.png"],
          ["job.update", "j-live", "pod", "held", "pod-7"],
        ],
      );
      assert.equal(host.posts[0].runId, run.json.runId);
      assert.equal(host.posts[1].runId, run.json.runId, "a hold names the run that took it (the job's turn in flight)");
      assert.ok(!Number.isNaN(Date.parse(host.posts[0].at)));

      // The URL is the host's credential: in its own owner-only file, never in the record, the index or the log.
      const file = join(tempDir, "jobs", ".callbacks", "j-live.json");
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { url: host.url });
      assert.ok(!(await readFile(join(tempDir, "jobs", "j-live.json"), "utf8")).includes("s3cret"));
      assert.ok(!JSON.stringify((await api("/jobs/j-live")).json).includes("s3cret"));
      assert.ok(!JSON.stringify((await api(`/workflows/live/runs/${run.json.runId}/events`)).json).includes("s3cret"));
      assert.deepEqual((await api("/jobs")).json.jobs.map((j: { job: string }) => j.job), ["j-live"], "the callbacks folder is never a job");

      // A hold let go says so too, and so does the delete that removes the job — and the file with it.
      await jobsCapability(tempDir).hold("j-live", { id: "pod-8", kind: "pod", url: "https://pod-8.example", release: { type: "fake/release", input: { podId: "pod-8" } } });
      await jobsCapability(tempDir).release("j-live", "pod-7");
      await until(() => host.posts.length === 4);
      assert.deepEqual(host.posts.slice(2).map((p) => [p.kind, p.state, p.id, p.url, p.runId]), [
        ["pod", "held", "pod-8", "https://pod-8.example", undefined],
        ["pod", "released", "pod-7", undefined, undefined],
      ], "taken outside a run: no run to name");
      const gone = await api("/jobs/j-live", { method: "DELETE" });
      assert.equal(gone.status, 200, JSON.stringify(gone.json));
      await until(() => host.posts.length === 5);
      assert.deepEqual([host.posts[4].kind, host.posts[4].state, host.posts[4].id], ["pod", "released", "pod-8"], "delivered on the way out");
      assert.ok(!existsSync(file));
    } finally {
      host.close();
    }
  });

  it("jobCallback: a bad URL is a 400; without a job it belongs to the run (what the jobs it starts inherit) and posts nothing by itself; `null` clears a job's; a job without one posts nothing", async () => {
    const { strut, api } = await boot();
    await strut.workspace.publishWorkflow("live", "v1", { steps: [{ id: "h", type: "holder", config: { id: "pod-1" } }] });
    await strut.workspace.publishWorkflow("plain", "v1", { steps: [{ id: "p", type: "probe", config: { tpl: "x" } }] });
    const host = await callbackHost();
    const done = await callbackHost();
    try {
      const jobless = await api("/workflows/plain/run", { body: { input: {}, jobCallback: { url: host.url }, callback: { url: done.url } } });
      assert.equal(jobless.status, 202, JSON.stringify(jobless.json));
      assert.equal(jobless.json.jobCallback, true);
      await until(() => done.posts.length === 1);
      assert.equal(host.posts.length, 0, "no job, no update");
      assert.equal(await strut.store.getRunJobCallback("plain", jobless.json.runId), host.url, "kept beside the run's log for the jobs it starts");
      done.posts.length = 0;
      assert.match((await api("/workflows/live/run", { body: { job: "j-q", input: {}, jobCallback: { url: "ftp://x" } } })).json.error, /http/);
      const set = await api("/workflows/live/run", { body: { job: "j-q", input: {}, jobCallback: { url: host.url }, callback: { url: done.url } } });
      await until(() => done.posts.length === 1 && host.posts.length === 1);
      const cleared = await api("/workflows/live/run", { body: { job: "j-q", input: {}, jobCallback: null, callback: { url: done.url } } });
      assert.equal(cleared.status, 202);
      assert.equal("jobCallback" in cleared.json, false);
      await until(() => done.posts.length === 2);
      assert.equal(done.posts[1].status, "success");
      jobsCapability(tempDir).notify!("j-q", { kind: "image", url: "/jobs/j-q/files/a.png" });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(host.posts.length, 1, "nothing after the clear");
      assert.ok(set.json.jobCallback);
      jobsCapability(tempDir).notify!("../escape", { kind: "image" }); // a bad id is ignored, never thrown
    } finally {
      host.close();
      done.close();
    }
  });

  it("notify coalesces per thing while a post is in flight: each thing's latest state, in the order of the latest changes", async () => {
    const posts: any[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        posts.push(JSON.parse(body));
        if (posts.length === 1) await gate; // the first post is slow
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const root = jobRoot(tempDir, "j-co");
      await setJobCallback(root, `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`);
      const walk = (frames: number) => notifyJob(root, "j-co", { kind: "walkthrough", url: "/jobs/j-co/files/walkthroughs/001/walkthrough.json", state: "recording", detail: { frames } });
      walk(1);
      await until(() => posts.length === 1);
      walk(2);
      notifyJob(root, "j-co", { kind: "evidence", id: "e-1", state: "supported" });
      walk(3);
      open();
      await until(() => posts.length === 3);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(
        posts.map((p) => [p.kind, p.detail?.frames ?? p.state]),
        [["walkthrough", 1], ["evidence", "supported"], ["walkthrough", 3]],
        "frame 2 was replaced by frame 3, which moved behind the evidence",
      );
    } finally {
      server.close();
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

// ── the index (plans/job-index.md) ───────────────────────────────────────

describe("jobs — the index (plans/job-index.md)", () => {
  let tempDir: string;
  let sessionStore: MemorySessionStore;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "strut-job-index-"));
    sessionStore = new MemorySessionStore();
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const boot = async () => {
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([writer, probe, pack]),
      store: new MemoryRunStore(),
      sessionStore,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      resolveActor: (c) => c.req.header("x-test-actor") || undefined,
    });
    // One turn of a job: writes a file into its directory, declares what it
    // delivered, and replies.
    await strut.workspace.publishWorkflow("turn", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "w", type: "writer", config: { dir: "{{ dir.path }}", name: "{{ input.name }}", text: "{{ input.text }}" } },
        { id: "result", type: "pack", config: { text: "{{ input.reply }}", artifacts: "{{ input.artifacts }}" } },
      ],
    });
    // The agent's door, from inside a run.
    await strut.workspace.publishWorkflow("inspect", "v1", {
      steps: [
        { id: "list", type: "job/list", config: { q: "{{ input.q }}" } },
        { id: "get", type: "job/get", config: { job: "{{ input.job }}" } },
        { id: "result", type: "pack", config: { list: "{{ list.jobs }}", get: "{{ get }}" } },
      ],
    });
    const api = async (path: string, init?: { body?: unknown; actor?: string }) => {
      const res = await strut.app.request(path, {
        method: init?.body ? "POST" : "GET",
        headers: { "content-type": "application/json", ...(init?.actor ? { "x-test-actor": init.actor } : {}) },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    const settled = async (workflow: string, runId: string) => {
      for (let i = 0; i < 400 && !(await strut.store.getRunSummary(workflow, runId)); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(await strut.store.getRunSummary(workflow, runId), `run ${runId} never settled`);
    };
    /** A turn of `job`, settled. */
    const turn = async (job: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}, actor?: string): Promise<string> => {
      const res = await api("/workflows/turn/run", { body: { job, input, ...extra }, ...(actor ? { actor } : {}) });
      assert.equal(res.status, 202, JSON.stringify(res.json));
      await settled("turn", res.json.runId);
      // Distinct `usedAt` stamps, for the ordering checks.
      await new Promise((r) => setTimeout(r, 5));
      return res.json.runId as string;
    };
    return { strut, api, settled, turn };
  };

  const plan = (text: string, summary?: string) => ({ id: "plan", title: "Plan", ...(summary ? { summary } : {}), path: "plan.md" });

  it("a launch with job + title names the job and records the run; later launches keep the title, or rename; a title without a job is a 400", async () => {
    const { api, turn } = await boot();
    const r1 = await turn("j-a", { name: "plan.md", text: "v1", reply: "drafted", artifacts: [plan("v1")] }, { title: "Landing page" });
    let rec = (await readJobRecord(jobRoot(tempDir, "j-a")))!;
    assert.equal(rec.title, "Landing page");
    assert.ok(rec.createdAt);
    assert.deepEqual(rec.runs!.map((r) => [r.workflow, r.runId, "parentRunId" in r]), [["turn", r1, false]]);

    const r2 = await turn("j-a", { name: "plan.md", text: "v2", reply: "revised", artifacts: [plan("v2")] });
    rec = (await readJobRecord(jobRoot(tempDir, "j-a")))!;
    assert.equal(rec.title, "Landing page", "kept");
    assert.deepEqual(rec.runs!.map((r) => r.runId), [r1, r2]);

    await turn("j-a", { name: "plan.md", text: "v3", reply: "final", artifacts: [plan("v3")] }, { title: "Landing page, final" });
    assert.equal((await readJobRecord(jobRoot(tempDir, "j-a")))!.title, "Landing page, final", "renamed");

    const bad = await api("/workflows/turn/run", { body: { title: "Nameless", input: {} } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /title/);
    assert.equal((await api("/jobs")).json.jobs.length, 1, "nothing launched");
  });

  it("GET /jobs lists newest-used first with counts; ?q= matches the title and a deliverable's words, every word required; ?workflow= keeps the jobs that ran it", async () => {
    const { api, turn, settled } = await boot();
    await turn("j-old", { name: "shot.png", text: "png", reply: "looked", artifacts: [{ id: "shot", title: "Screenshot", summary: "the checkout button", path: "shot.png" }] }, { title: "Checkout audit" });
    await turn("j-new", { name: "plan.md", text: "v1", reply: "planned", artifacts: [plan("v1", "a landing page for the beta")] }, { title: "Beta launch" });
    const all = await api("/jobs");
    assert.equal(all.status, 200);
    assert.deepEqual(
      all.json.jobs.map((j: any) => [j.job, j.title, j.runs, j.holds, "busy" in j]),
      [["j-new", "Beta launch", 1, 0, false], ["j-old", "Checkout audit", 1, 0, false]],
    );
    const ids = async (q: string) => (await api(`/jobs?${q}`)).json.jobs.map((j: any) => j.job);
    assert.deepEqual(await ids("q=landing%20page"), ["j-new"], "an artifact's summary");
    assert.deepEqual(await ids("q=checkout"), ["j-old"], "the title");
    assert.deepEqual(await ids("q=screenshot"), ["j-old"], "an artifact's title");
    assert.deepEqual(await ids("q=checkout%20beta"), [], "every word must hit one job");
    assert.deepEqual(await ids("q=j-old"), ["j-old"], "the id");
    assert.deepEqual(await ids("limit=1"), ["j-new"]);

    // ?workflow= keeps the jobs with a recorded run of that workflow — the
    // sidebar's filter when one is selected. A run of another workflow
    // under j-old makes it the newest-used, and the only match for that one.
    const inspect = await api("/workflows/inspect/run", { body: { job: "j-old", input: { q: "", job: "j-old" } } });
    assert.equal(inspect.status, 202, JSON.stringify(inspect.json));
    await settled("inspect", inspect.json.runId);
    assert.deepEqual(await ids("workflow=inspect"), ["j-old"]);
    assert.deepEqual(await ids("workflow=turn"), ["j-old", "j-new"], "every job ran `turn`; j-old is newest-used now");
    assert.deepEqual(await ids("workflow=nope"), []);
    assert.deepEqual(await ids("workflow=inspect&q=beta"), [], "both filters apply");
  });

  it("the record remembers everyone who launched a run of the job; GET /jobs?mine=1 keeps the request actor's jobs and names the actor; no actor, nothing", async () => {
    const { api, turn } = await boot();
    await turn("j-a", { name: "plan.md", text: "v1", reply: "drafted" }, { title: "Alice's" }, "alice");
    await turn("j-b", { name: "plan.md", text: "v1", reply: "drafted" }, { title: "Bob's" }, "bob");
    await turn("j-a", { name: "plan.md", text: "v2", reply: "revised" }, {}, "bob");
    await turn("j-a", { name: "plan.md", text: "v3", reply: "again" }, {}, "bob");
    const rec = (await readJobRecord(jobRoot(tempDir, "j-a")))!;
    assert.equal(rec.createdBy, "alice", "the first launch's actor");
    assert.deepEqual(rec.actors, ["alice", "bob"], "first seen first, each once");

    const all = await api("/jobs");
    assert.deepEqual(all.json.jobs.map((j: any) => [j.job, j.actors]), [["j-a", ["alice", "bob"]], ["j-b", ["bob"]]]);
    assert.equal("actor" in all.json, false, "no actor on the request");

    const ids = async (q: string, actor?: string) => {
      const r = await api(`/jobs${q}`, actor ? { actor } : undefined);
      return { ids: r.json.jobs.map((j: any) => j.job), actor: r.json.actor };
    };
    assert.deepEqual(await ids("?mine=1", "alice"), { ids: ["j-a"], actor: "alice" });
    assert.deepEqual(await ids("?mine=1", "bob"), { ids: ["j-a", "j-b"], actor: "bob" }, "newest-used first, as ever");
    assert.deepEqual(await ids("", "alice"), { ids: ["j-a", "j-b"], actor: "alice" }, "without mine, everyone's, the actor still named");
    assert.deepEqual(await ids("?mine=1"), { ids: [], actor: undefined }, "mine with no actor is nobody's");
    assert.deepEqual(await ids("?mine=1&workflow=turn", "alice"), { ids: ["j-a"], actor: "alice" }, "composes with the workflow filter");
  });

  it("GET /jobs/:id: runs with status, threads by the turn line's job and by name, deliverables folded newest-first by id behind one live file", async () => {
    const { api, turn } = await boot();
    const r1 = await turn("j-b", { name: "plan.md", text: "v1", reply: "first", artifacts: [plan("v1"), { id: "pod", kind: "url", title: "Pod", url: "https://pod.example/" }] }, { title: "B" });
    const r2 = await turn("j-b", { name: "plan.md", text: "v2", reply: "second", artifacts: [{ id: "plan", title: "Plan, revised", summary: "now with a budget", path: "plan.md" }] });
    const line = (job?: string) => ({ workflow: "turn", runId: r2, path: "turn/work", provider: "anthropic", model: "anthropic/x", routed: false, ...(job ? { job } : {}) });
    await sessionStore.appendTurn("thread-1", { system: "s", messages: [{ role: "user", content: "a" }], record: line("j-b") });
    await sessionStore.appendTurn("j-b/review", { system: "s", messages: [{ role: "user", content: "b" }], record: line() });
    await sessionStore.appendTurn("other", { system: "s", messages: [{ role: "user", content: "c" }], record: line("j-z") });

    const res = await api("/jobs/j-b");
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const v = res.json;
    assert.equal(v.title, "B");
    assert.deepEqual(v.runs.map((r: any) => [r.runId, r.status, typeof r.durationMs]), [[r2, "success", "number"], [r1, "success", "number"]]);
    assert.deepEqual(v.sessions.map((s: any) => s.id).sort(), ["j-b/review", "thread-1"]);
    assert.deepEqual(v.artifacts, [
      { id: "plan", kind: "markdown", title: "Plan, revised", summary: "now with a budget", url: "/jobs/j-b/files/plan.md", runId: r2, path: "plan.md" },
      { id: "pod", kind: "url", title: "Pod", url: "https://pod.example/", runId: r1 },
    ]);
    assert.equal(v.text, "second");
    assert.deepEqual(v.files, ["plan.md"]);
    assert.deepEqual([v.holds, v.repos], [[], []]);
    assert.equal(await readFile(join(tempDir, "jobs", "j-b", "plan.md"), "utf8"), "v2", "one live file behind the link");
    // The threads (plans/jobs-sidebar.md §1): no agent anywhere, so each run
    // is one turn at its root, chronological, carrying what it delivered.
    assert.deepEqual(
      v.threads.map((t: any) => [t.id, t.session, t.label, t.turns.map((x: any) => [x.runId, x.stepType, x.status, x.toolCalls, (x.artifacts ?? []).map((a: any) => a.id)])]),
      [[`${r1}/turn`, false, "turn", [[r1, "run", "success", 0, ["plan", "pod"]]]], [`${r2}/turn`, false, "turn", [[r2, "run", "success", 0, ["plan"]]]]],
    );
    assert.equal(v.threads[0].totals.turns, 1);
    assert.equal("omittedRuns" in v, false);
    const slim = (await api("/jobs/j-b?threads=0")).json;
    assert.equal("threads" in slim, false, "?threads=0 leaves the fold out");
    const capped = (await api("/jobs/j-b?limit=1")).json;
    assert.deepEqual([capped.threads.length, capped.omittedRuns], [1, 1]);
    assert.equal((await api("/jobs/nope")).status, 404);
    assert.equal((await api("/jobs/bad%20id")).status, 400);
  });

  it("GET /jobs/:id passes the holds through, url included, and folds `urls` by kind — the first hold of each kind with one wins, one without is skipped", async () => {
    const { api } = await boot();
    const jobs = jobsCapability(tempDir);
    const hold = (id: string, kind: string, url?: string) => ({ id, kind, release: { type: "fake/release", input: { id } }, ...(url ? { url } : {}) });
    await jobs.hold("j-u", hold("pod-1", "pod"));
    await jobs.hold("j-u", hold("pod-2", "pod", "https://pod-2.example"));
    await jobs.hold("j-u", hold("pod-3", "pod", "https://pod-3.example"));
    await jobs.hold("j-u", hold("vm-1", "vm"));
    await jobs.hold("j-u", hold("browser-1", "browser", "ws://browser-1.example"));
    const v = (await api("/jobs/j-u")).json;
    assert.deepEqual(
      v.holds.map((h: any) => [h.id, h.kind, h.url]),
      [["pod-1", "pod", undefined], ["pod-2", "pod", "https://pod-2.example"], ["pod-3", "pod", "https://pod-3.example"], ["vm-1", "vm", undefined], ["browser-1", "browser", "ws://browser-1.example"]],
    );
    assert.deepEqual(v.urls, { pod: "https://pod-2.example", browser: "ws://browser-1.example" });
    assert.deepEqual(holdUrls([]), {});
  });

  it("a run in flight is `running` and holds the job; a sealed workflow's run shows its status and nothing more", async () => {
    const { strut, api, settled } = await boot();
    await strut.workspace.publishWorkflowByContent(
      "harness",
      "name: harness\nsealed: true\nsteps:\n  - id: result\n    type: pack\n    config:\n      text: graded\n      artifacts:\n        - { id: verdict, title: Verdict, content: \"4/5\" }\n",
    );
    const graded = await api("/workflows/harness/run", { body: { job: "j-s", input: {}, title: "Graded" } });
    assert.equal(graded.status, 202);
    await settled("harness", graded.json.runId);
    const sealed = (await api("/jobs/j-s")).json;
    assert.deepEqual(sealed.runs, [{ workflow: "harness", runId: graded.json.runId, at: sealed.runs[0].at, status: "success", sealed: true }]);
    assert.deepEqual([sealed.artifacts, sealed.text, sealed.threads], [[], undefined, []], "a sealed run is in no thread either");

    await strut.workspace.publishWorkflow("slow", "v1", {
      steps: [{ id: "dir", type: "job/dir", config: {} }, { id: "z", type: "wait", config: { durationMs: 300 } }],
    });
    const slow = await api("/workflows/slow/run", { body: { job: "j-w", input: {} } });
    assert.equal(slow.status, 202);
    for (let i = 0; i < 100 && !jobHolder(jobRoot(tempDir, "j-w")); i++) await new Promise((r) => setTimeout(r, 5));
    const live = (await api("/jobs/j-w")).json;
    assert.deepEqual([live.busy, live.runs[0].status], [slow.json.runId, "running"]);
    assert.equal((await api("/jobs")).json.jobs.find((j: any) => j.job === "j-w").busy, slow.json.runId);
    await settled("slow", slow.json.runId);
    assert.equal("busy" in (await api("/jobs/j-w")).json, false);
  });

  it("a run in flight carries its job and the launch's title on its row and on /runs/active; the summary keeps the job only", async () => {
    const { strut, api, settled } = await boot();
    await strut.workspace.publishWorkflow("slow", "v1", { steps: [{ id: "z", type: "wait", config: { durationMs: 300 } }] });
    const slow = await api("/workflows/slow/run", { body: { job: "j-t", title: "Titled", input: {} } });
    assert.equal(slow.status, 202);
    const active = (await api("/runs/active")).json.find((r: any) => r.runId === slow.json.runId);
    assert.deepEqual([active.job, active.jobTitle], ["j-t", "Titled"]);
    let row: any;
    for (let i = 0; i < 100 && !row; i++) {
      row = (await api("/workflows/slow/runs")).json.find((r: any) => r.runId === slow.json.runId);
      if (!row) await new Promise((r) => setTimeout(r, 5));
    }
    assert.deepEqual([row.status, row.job, row.jobTitle], ["running", "j-t", "Titled"]);

    const plain = await api("/workflows/slow/run", { body: { input: {} } });
    const bare = (await api("/runs/active")).json.find((r: any) => r.runId === plain.json.runId);
    assert.deepEqual(["job" in bare, "jobTitle" in bare], [false, false]);

    await settled("slow", slow.json.runId);
    await settled("slow", plain.json.runId);
    const done = (await api("/workflows/slow/runs")).json.find((r: any) => r.runId === slow.json.runId);
    assert.deepEqual([done.status, done.job, "jobTitle" in done], ["success", "j-t", false]);
  });

  it("the agent's door: job/list and job/get from inside a run; job/read as text, as an image the model sees, capped, never outside the job", async () => {
    const { strut, turn } = await boot();
    await turn("j-c", { name: "notes.md", text: "# notes", reply: "ok", artifacts: [{ id: "notes", title: "Notes", path: "notes.md" }] }, { title: "C" });
    const res = await strut.run("inspect", { job: "j-c" });
    assert.equal(res.status, "success", JSON.stringify(res));
    const out = res.output as any;
    assert.deepEqual(out.list.map((j: any) => [j.job, j.title]), [["j-c", "C"]]);
    assert.equal(out.get.title, "C");
    assert.equal(out.get.dir, jobRoot(tempDir, "j-c"));
    assert.deepEqual(out.get.artifacts.map((a: any) => a.path), ["notes.md"]);

    const ctx = { runId: "r", path: "inspect/read", services: strut.services } as any;
    assert.deepEqual(await jobRead.run({ job: "j-c", path: "notes.md" }, ctx), { path: "notes.md", kind: "markdown", text: "# notes" });
    const capped = (await jobRead.run({ job: "j-c", path: "notes.md", maxChars: 4 }, ctx)) as any;
    assert.equal(capped.truncated, true);
    assert.match(capped.text, /^# \n\[\.\.\. 3 chars truncated \.\.\.\]\nes$/);
    await writeFile(join(tempDir, "jobs", "j-c", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const shot = (await jobRead.run({ job: "j-c", path: "shot.png" }, ctx)) as any;
    assert.deepEqual([shot.kind, shot.mediaType, shot.bytes, "image" in shot], ["image", "image/png", 4, false]);
    assert.equal(mediaOf(shot)![0]!.mediaType, "image/png");
    assert.equal(JSON.stringify(shot).includes("data"), false, "the bytes ride on the marker, not the output");
    await assert.rejects(() => jobRead.run({ job: "j-c", path: "../j-b/plan.md" }, ctx), /escapes/);
    await assert.rejects(() => jobRead.run({ job: "j-c", path: "nope.md" }, ctx), /No file/);
  });
});

describe("jobs — the job's newest turn (turnOf, plans/builder-job.md §2)", () => {
  const run = (workflow: string, runId: string, parentRunId?: string) => ({ workflow, runId, at: runId, ...(parentRunId ? { parentRunId } : {}) });

  it("is the newest run with no parent that ran a job-shaped workflow — what job/continue launches and GET /jobs/:id reports", () => {
    assert.deepEqual([...JOB_WORKFLOWS], ["job", "builder"]);
    assert.equal(turnOf(undefined), undefined);
    assert.equal(turnOf([]), undefined);
    assert.equal(turnOf([run("job", "1")])?.workflow, "job");
    // A builder job stays a builder job across turns.
    assert.equal(turnOf([run("builder", "1"), run("builder", "2")])?.runId, "2");
    // What a turn ran under the job (a child, by parentRunId) is not a turn;
    // nor is a run of some other workflow launched under the job id (a
    // captcha round, a check): the newest TURN decides.
    assert.equal(turnOf([run("builder", "1"), run("pod-pr", "2", "1"), run("browser-captcha", "3")])?.runId, "1");
    assert.equal(turnOf([run("browser-captcha", "1")]), undefined, "no job-shaped turn yet");
  });
});
