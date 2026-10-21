import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { defineStep, type StepContext } from "./core.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import type { JobLaunch, JobsCapability } from "./jobs.js";
import { jobFileUrl } from "./artifact-refs.js";
import jobStart from "./steps/lib/job/start.js";
import jobContinue from "./steps/lib/job/continue.js";
import { standInMcp } from "./test-util/mcp-server.js";

// job/start and job/continue through a whole strut: an orchestrator
// workflow whose agent is granted them, a stand-in `job` workflow, a
// stand-in Anthropic endpoint behind both agents, and a stand-in host
// collecting the run.end callbacks. The turn ends while the job runs; the
// job's run.end reaches the host the turn was launched with.

const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const toolUse = (id: string, name: string, input: unknown) =>
  sse({
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 },
    },
  }) +
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
  sse({ type: "message_stop" });

const schema = {
  type: "object",
  required: ["text", "artifacts"],
  properties: {
    text: { type: "string" },
    artifacts: {
      type: "array",
      items: { type: "object", required: ["id", "title"], properties: { id: { type: "string" }, title: { type: "string" }, path: { type: "string" } } },
    },
  },
};

/** A file into a directory, as the agent's bash would have written it. */
const writeStep = defineStep({
  type: "test/write",
  input: z.object({ path: z.string(), text: z.string() }),
  output: z.any(),
  async run(cfg) {
    await writeFile(cfg.path, cfg.text);
    return { ok: true };
  },
});

/** A step that wrote a job file the person may want to watch, and says so
 *  (plans/live-artifacts.md §3) — what browser/screenshot does. */
const tellStep = defineStep({
  type: "test/tell",
  input: z.object({ path: z.string() }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const jobs = (ctx.services as { jobs?: JobsCapability }).jobs;
    jobs?.notify?.(ctx.job!, { kind: "image", url: jobFileUrl(ctx.job!, cfg.path), state: "done", runId: ctx.runId });
    return { told: cfg.path };
  },
});

describe("job/start and job/continue", () => {
  let dir = "";
  let provider: http.Server;
  let host: http.Server;
  let hostUrl = "";
  let posts: any[] = [];
  /** The requests each agent made, by its system prompt. */
  let seen: { orch: string[]; job: string[]; builder: string[] } = { orch: [], job: [], builder: [] };
  /** What the orchestrator calls on its first step; its second answers. */
  let orchTool: { name: string; input: unknown } = { name: "job_start", input: {} };
  /** Holds the job agent's reply until released. */
  let gate: Promise<void> | undefined;
  /** Waits for every run this strut still has in flight; set by `boot`. */
  let drain: () => Promise<void> = async () => {};
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-job-launch-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    posts = [];
    seen = { orch: [], job: [], builder: [] };
    gate = undefined;
    drain = async () => {};
    let n = 0;
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", async () => {
        const id = `toolu_${++n}`;
        const body = JSON.parse(raw);
        const last = body.messages.at(-1);
        const answered = Array.isArray(last?.content) && last.content.some((b: any) => b.type === "tool_result");
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (JSON.stringify(body.system).includes("ORCH")) {
          seen.orch.push(raw);
          res.end(
            answered
              ? toolUse(id, "final_answer", { text: "On it.", artifacts: [{ id: "note", title: "Note", path: "note.md" }] })
              : toolUse(id, orchTool.name, orchTool.input),
          );
        } else if (JSON.stringify(body.system).includes("BUILDER")) {
          seen.builder.push(raw);
          res.end(toolUse(id, "final_answer", { text: `Built ${seen.builder.length}`, artifacts: [] }));
        } else {
          seen.job.push(raw);
          await gate;
          res.end(toolUse(id, "final_answer", { text: `Found ${seen.job.length}`, artifacts: [{ id: "report", title: "Report", path: "report.md" }] }));
        }
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    host = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        posts.push(JSON.parse(raw));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    hostUrl = `http://127.0.0.1:${(host.address() as any).port}/hook?token=s3cret`;
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as any).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
  });
  afterEach(async () => {
    // A job runs detached, and its job.update / run.end reach the test before
    // its agent has committed its session under <dataDir>/sessions/: the tree
    // goes only once nothing is writing to it.
    await drain();
    provider.close();
    host.close();
    await rm(dir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const agent = (system: string, extra: Record<string, unknown>) => ({
    id: "work",
    type: "agent",
    config: { cwd: "{{ dir.path }}", system, prompt: "{{ input.prompt }}", model: "claude-sonnet-4-5", toolFilter: ["none"], schema, ...extra },
  });
  const pack = { id: "result", type: "pack", config: { text: "{{ work.object.text }}", artifacts: "{{ work.object.artifacts }}" } };

  const boot = async (opts: { builder?: boolean } = {}) => {
    const store = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(dir),
      registry: await createRegistry([writeStep, tellStep]),
      store,
      serveUi: false,
      enableChat: false,
      scheduler: false,
      // The shape of strut's own `job` and `builder`, without the seeds'
      // models and tools.
      job: false,
      builder: false,
    });
    await strut.workspace.publishWorkflow("job", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "report", type: "test/write", config: { path: "{{ dir.path }}/report.md", text: "# Flights" } },
        { id: "tell", type: "test/tell", config: { path: "report.md" } },
        agent("JOBAGENT", { session: "{{ input.session || $job }}" }),
        pack,
      ],
    });
    // The builder (plans/builder-job.md): job-shaped, no checkouts, and it
    // reports the `peer` its launch carried so a test can see it arrive.
    if (opts.builder !== false) {
      await strut.workspace.publishWorkflow("builder", "v1", {
        steps: [
          { id: "dir", type: "job/dir", config: {} },
          agent("BUILDER", { session: "{{ input.session || $job }}" }),
          { id: "result", type: "pack", config: { text: "{{ work.object.text }}", artifacts: "{{ work.object.artifacts }}", peer: "{{ input.peer }}" } },
        ],
      });
    }
    // The orchestrator: a plain run (no job), its files in its own run's
    // directory, granted the two launch steps and nothing else.
    await strut.workspace.publishWorkflow("orch", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "note", type: "test/write", config: { path: "{{ dir.path }}/note.md", text: "noted" } },
        agent("ORCH", { agentTools: ["job/start", "job/continue"] }),
        pack,
      ],
    });
    const post = (body: Record<string, unknown>) =>
      strut.app.request("/workflows/orch/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const launch = async (input: unknown, withCallback = true, extra: Record<string, unknown> = {}) => {
      const res = await post({ input, ...(withCallback ? { callback: { url: hostUrl } } : {}), ...extra });
      assert.equal(res.status, 202);
      return ((await res.json()) as any).runId as string;
    };
    const settle = async (workflow: string, runId: string) => {
      for (let i = 0; i < 1500; i++) {
        const summary = await store.getRunSummary(workflow, runId);
        if (summary) return summary;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`run ${runId} never settled`);
    };
    const until = async <T>(find: () => T | undefined): Promise<T> => {
      for (let i = 0; i < 1500; i++) {
        const v = find();
        if (v !== undefined) return v;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("never happened");
    };
    /** What the orchestrator's tool call returned, from its run's log. */
    const toolOutput = async (runId: string) => {
      const end = (await store.getRunEvents("orch", runId)).find((e) => e.type === "step.end" && /^tool:job_/.test(String(e.stepType)));
      // The log keeps a tool's output as its JSON text.
      return end ? JSON.parse((end as any).output) : undefined;
    };
    // /runs/active is the controllers' own list: a run leaves it after its
    // teardown, the detached job runs the turns started included.
    drain = async () => {
      for (let i = 0; i < 1500; i++) {
        const active = (await (await strut.app.request("/runs/active")).json()) as unknown[];
        if (!active.length) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("runs still in flight");
    };
    const jobs = (strut.services as { jobs: JobsCapability }).jobs;
    return { strut, store, post, launch, settle, until, toolOutput, jobs };
  };

  it("start: the turn ends at once, the job runs detached, and its run.end reaches the turn's callback with resolved artifacts", async () => {
    const { launch, settle, until, toolOutput, jobs } = await boot();
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    orchTool = { name: "job_start", input: { prompt: "Research flights to Lisbon in May", title: "Flights to Lisbon" } };

    const turn = await launch({ prompt: "research flights to Lisbon" });
    const summary = await settle("orch", turn);
    assert.equal(summary.status, "success", JSON.stringify(summary));
    const started = await toolOutput(turn);
    assert.equal(started.callback, true);
    assert.ok(started.job && started.runId, JSON.stringify(started));

    // The turn's run.end, with its OWN artifacts resolved in its run's
    // directory — while the job is still working.
    const orchEnd = await until(() => posts.find((p) => p.workflow === "orch"));
    assert.equal(orchEnd.runId, turn);
    assert.equal(orchEnd.job, undefined, "a plain run names no job");
    assert.deepEqual(orchEnd.artifacts, [{ id: "note", kind: "markdown", title: "Note", url: `/artifacts/${turn}/note.md` }]);
    await until(() => (seen.job.length === 1 ? true : undefined));
    assert.equal(posts.filter((p) => p.workflow === "job").length, 0, "the job is mid-call: it has not ended");
    const view = await jobs.get!(started.job, { threads: false });
    assert.equal(view?.title, "Flights to Lisbon");

    release();
    const jobEnd = await until(() => posts.find((p) => p.workflow === "job"));
    assert.equal(jobEnd.runId, started.runId);
    assert.equal(jobEnd.job, started.job);
    assert.equal(jobEnd.status, "success");
    assert.equal(jobEnd.output.text, "Found 1");
    assert.deepEqual(jobEnd.artifacts, [
      { id: "report", kind: "markdown", title: "Report", url: `/jobs/${encodeURIComponent(started.job)}/files/report.md` },
    ]);
    // The job's prompt is what the orchestrator wrote, not the person's words.
    assert.ok(seen.job[0]!.includes("Research flights to Lisbon in May"));
  });

  it("continue: the next turn of the same job and thread; refused while it runs and for a job not on file", async () => {
    const { launch, settle, until, toolOutput, jobs } = await boot();
    orchTool = { name: "job_start", input: { prompt: "Research flights", title: "Flights" } };
    const first = await launch({ prompt: "research flights" });
    await settle("orch", first);
    const { job } = await toolOutput(first);
    await until(() => posts.find((p) => p.workflow === "job"));

    // Busy: a continue while the job's second turn is held.
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    orchTool = { name: "job_continue", input: { job, prompt: "Only direct flights" } };
    const second = await launch({ prompt: "only direct ones" });
    await settle("orch", second);
    const continued = await toolOutput(second);
    assert.equal(continued.job, job);
    await until(() => (seen.job.length === 2 ? true : undefined));
    // The job's own thread: its second turn carries its first.
    assert.ok(seen.job[1]!.includes("Research flights") && seen.job[1]!.includes("Only direct flights"));

    const third = await launch({ prompt: "and add trains" });
    await settle("orch", third);
    assert.ok(seen.orch.at(-1)!.includes("job_busy:"), "the model is told the job is still working");

    orchTool = { name: "job_continue", input: { job: "no-such-job", prompt: "hi" } };
    const fourth = await launch({ prompt: "continue the other one" });
    await settle("orch", fourth);
    assert.ok(seen.orch.at(-1)!.includes('No job \\"no-such-job\\"'));

    release();
    const ends = await until(() => {
      const e = posts.filter((p) => p.workflow === "job");
      return e.length === 2 ? e : undefined;
    });
    assert.equal(ends[1].runId, continued.runId);
    assert.equal(ends[1].job, job);
    assert.equal(ends[1].output.text, "Found 2");
    const view = await jobs.get!(job, { threads: false });
    assert.equal(view?.runs.length, 2, "two turns of one job; the refused ones launched nothing");
  });

  it("start { workflow: builder, peer }: the builder workflow runs the turn with the peer; the job says which it is; continue names only the job and follows the record, peer included; peer and repos are refused on a code job", async () => {
    const { strut, launch, settle, until, toolOutput, jobs } = await boot();
    orchTool = { name: "job_start", input: { prompt: "Build a daily digest workflow", title: "Digest workflow", workflow: "builder", peer: "acme-web" } };
    const first = await launch({ prompt: "make me a digest workflow on @acme-web" });
    await settle("orch", first);
    const started = await toolOutput(first);
    assert.ok(started.job && started.runId, JSON.stringify(started));
    const end = await until(() => posts.find((p) => p.workflow === "builder"));
    assert.equal(end.runId, started.runId);
    assert.equal(end.job, started.job);
    assert.equal(end.output.text, "Built 1");
    assert.equal(end.output.peer, "acme-web", "the builder turn was handed the peer");
    assert.equal(seen.job.length, 0, "the job workflow never ran");
    // The job IS a builder job: the view and the listing say so.
    const view = await jobs.get!(started.job, { threads: false });
    assert.equal(view?.workflow, "builder");
    assert.deepEqual(view?.runs.map((r) => r.workflow), ["builder"]);
    const { jobs: rows } = (await (await strut.app.request("/jobs")).json()) as { jobs: Array<{ job: string; workflow?: string }> };
    assert.equal(rows.find((r) => r.job === started.job)?.workflow, "builder");

    // Continue names only the job: the launcher follows the record — the
    // builder again, on the same peer, in the builder's own thread.
    orchTool = { name: "job_continue", input: { job: started.job, prompt: "Also post it to Slack" } };
    const second = await launch({ prompt: "also slack" });
    await settle("orch", second);
    const ends = await until(() => {
      const e = posts.filter((p) => p.workflow === "builder");
      return e.length === 2 ? e : undefined;
    });
    assert.equal(ends[1].job, started.job);
    assert.equal(ends[1].output.text, "Built 2");
    assert.equal(ends[1].output.peer, "acme-web", "a continue carries the turn's peer along");
    assert.ok(seen.builder[1]!.includes("Build a daily digest workflow") && seen.builder[1]!.includes("Also post it to Slack"), "the builder's own thread");
    assert.equal(seen.job.length, 0);
    assert.equal((await jobs.get!(started.job, { threads: false }))?.workflow, "builder");

    // A code job runs here, with its repositories: `peer` is refused on it,
    // and `repos` on a builder job — nothing launched either way.
    orchTool = { name: "job_start", input: { prompt: "Fix the bug", title: "Bug", peer: "acme-web" } };
    const third = await launch({ prompt: "fix it there" });
    await settle("orch", third);
    assert.ok(seen.orch.at(-1)!.includes("only a builder job runs on another strut"), seen.orch.at(-1));
    orchTool = { name: "job_start", input: { prompt: "Build it", title: "Build", workflow: "builder", repos: ["https://github.com/acme/web"] } };
    const fourth = await launch({ prompt: "build with the repo" });
    await settle("orch", fourth);
    assert.ok(seen.orch.at(-1)!.includes("a builder job checks nothing out"), seen.orch.at(-1));
    assert.equal(posts.filter((p) => p.workflow === "job").length, 0);
    assert.equal(posts.filter((p) => p.workflow === "builder").length, 2);
  });

  it("start { workflow: builder } on a strut with no builder is refused by name, and nothing launches", async () => {
    const { launch, settle, jobs } = await boot({ builder: false });
    orchTool = { name: "job_start", input: { prompt: "Build a workflow", title: "Build", workflow: "builder" } };
    const run = await launch({ prompt: "build one" });
    await settle("orch", run);
    assert.ok(seen.orch.at(-1)!.includes('no_workflow: this strut has no \\"builder\\" workflow'), seen.orch.at(-1));
    assert.deepEqual(await jobs.list!(), [], "no record was written");
  });

  it("the caller's MCP servers reach the turn's agent and the job it starts; the logs name them by origin only", async () => {
    const TOKEN = "caller-t0ken-5678";
    const caller = await standInMcp([{ name: "lookup", call: () => ({ content: [{ type: "text", text: "x" }] }) }], { token: TOKEN });
    try {
      const { store, post, settle, until, toolOutput } = await boot();
      const mcp = [{ name: "caller", url: caller.url, token: TOKEN }];

      // Refused before anything launches, saying which entry.
      const bad = await post({ input: { prompt: "x" }, mcp: [{ name: "has space", url: caller.url }] });
      assert.equal(bad.status, 400);
      assert.match(((await bad.json()) as any).error, /mcp\[0\]\.name/);
      assert.equal(seen.orch.length, 0);

      orchTool = { name: "job_start", input: { prompt: "Do it", title: "It" } };
      const res = await post({ input: { prompt: "do it" }, callback: { url: hostUrl }, mcp });
      assert.equal(res.status, 202);
      const launched = (await res.json()) as any;
      assert.equal(launched.mcp, true, "the host's proof this server honors it");
      await settle("orch", launched.runId);
      const { runId: jobRun } = await toolOutput(launched.runId);
      await until(() => posts.find((p) => p.workflow === "job"));

      // Both agents had the caller's tool: the turn's, and the job's.
      assert.ok(seen.orch[0]!.includes('"name":"caller_lookup"'));
      assert.ok(seen.job[0]!.includes('"name":"caller_lookup"'));
      const origin = new URL(caller.url).origin;
      for (const [workflow, runId] of [["orch", launched.runId], ["job", jobRun]] as const) {
        const events = await store.getRunEvents(workflow, runId);
        assert.deepEqual(events.find((e) => e.type === "run.start")!.mcp, [{ name: "caller", origin }]);
        assert.ok(!JSON.stringify(events).includes(TOKEN), `${workflow}'s log holds no credential`);
        // Kept beside the log for a resume.
        assert.deepEqual(await store.getRunMcp(workflow, runId), mcp);
      }
      assert.ok(!JSON.stringify(posts).includes(TOKEN));
    } finally {
      await caller.close();
    }
  });

  it("a turn launched with a jobCallback and no job of its own hands it to the jobs it starts: their job.update events reach it, each naming the job and the run (CALLBACKS.md §5)", async () => {
    const { store, post, launch, settle, until, toolOutput } = await boot();
    // The host's job-events endpoint: ONE URL for the whole conversation,
    // not one per job — the events say which job and run they are about.
    const live: any[] = [];
    const liveHost = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        live.push(JSON.parse(raw));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => liveHost.listen(0, "127.0.0.1", r));
    const liveUrl = `http://127.0.0.1:${(liveHost.address() as any).port}/jobs?token=l1ve`;
    try {
      // Without a job of its own, the field is no longer refused: the 202 says it is honored.
      orchTool = { name: "job_start", input: { prompt: "Research flights", title: "Flights" } };
      const res = await post({ input: { prompt: "research flights" }, callback: { url: hostUrl }, jobCallback: { url: liveUrl } });
      const launched = (await res.json()) as any;
      assert.equal(res.status, 202, JSON.stringify(launched));
      assert.equal(launched.jobCallback, true, "the host's proof this server honors it");
      await settle("orch", launched.runId);
      const started = await toolOutput(launched.runId);

      // The job's first update reaches the turn's job callback: the job id
      // and the run that made the change ride in the payload, since the URL
      // is shared.
      const update = await until(() => live.find((p) => p.event === "job.update"));
      assert.equal(update.job, started.job);
      assert.equal(update.runId, started.runId);
      assert.deepEqual([update.kind, update.state, update.url], ["image", "done", `/jobs/${encodeURIComponent(started.job)}/files/report.md`]);
      // …and its run.end the turn's run callback, as before.
      const jobEnd = await until(() => posts.find((p) => p.workflow === "job"));
      assert.equal(jobEnd.job, started.job);
      assert.equal(posts.filter((p) => p.event === "job.update").length, 0, "updates never go to the run callback");
      assert.equal(live.filter((p) => p.event === "run.end").length, 0, "run.end never goes to the job callback");

      // On file for the JOB — the latest launch that carries one wins, as
      // over HTTP — and for the turn's run, beside its log; in no log.
      assert.deepEqual(JSON.parse(await readFile(join(dir, "jobs", ".callbacks", `${started.job}.json`), "utf8")), { url: liveUrl });
      assert.equal(await store.getRunJobCallback("orch", launched.runId), liveUrl);
      assert.equal(await store.getRunJobCallback("job", started.runId), liveUrl, "handed to the job's run, so a job that starts a job passes it on");
      for (const [wf, id] of [["orch", launched.runId], ["job", started.runId]] as const) {
        assert.ok(!JSON.stringify(await store.getRunEvents(wf, id)).includes("l1ve"), `${wf}'s log holds no credential`);
      }

      // A later turn WITHOUT one leaves the job's callback alone: its
      // continue still reports there.
      orchTool = { name: "job_continue", input: { job: started.job, prompt: "Only direct flights" } };
      const second = await launch({ prompt: "only direct ones" });
      await settle("orch", second);
      const continued = await toolOutput(second);
      const next = await until(() => live.find((p) => p.event === "job.update" && p.runId === continued.runId));
      assert.equal(next.job, started.job);
      assert.equal(await store.getRunJobCallback("orch", second), null);
    } finally {
      liveHost.close();
    }
  });

  it("a turn launched without a callback starts a job without one", async () => {
    const { launch, settle, toolOutput } = await boot();
    orchTool = { name: "job_start", input: { prompt: "Do it", title: "It" } };
    const turn = await launch({ prompt: "do it" }, false);
    await settle("orch", turn);
    const started = await toolOutput(turn);
    assert.equal(started.callback, false);
    assert.equal((await settle("job", started.runId)).status, "success");
    assert.equal(posts.length, 0);
  });
});

describe("job/start and job/continue on a resume", () => {
  /** A step's ctx with a stand-in launcher; `emitted` is the step's journal. */
  const ctxFor = (path: string, agentTool: boolean, journal?: Record<string, unknown>) => {
    const launched: JobLaunch[] = [];
    const emitted: Record<string, unknown> = {};
    const ctx = {
      runId: "r1", path, scope: {}, input: undefined, agentTool, actor: "tom",
      emit: async (e: any) => void (emitted[e.path] = e.output),
      services: { jobs: { launch: async (o: JobLaunch) => (launched.push(o), { runId: `run-${launched.length}`, callback: true }) } },
      ...(journal ? { journal } : {}),
    } as any;
    return { ctx, launched, emitted };
  };

  it("a tool call journals its launch beside the agent step, and the same call on a resume launches nothing", async () => {
    const first = ctxFor("orch/work/001-job_start", true);
    const started = await jobStart.run({ prompt: "p", title: "t" } as any, first.ctx);
    assert.equal(first.launched.length, 1);
    assert.equal(first.launched[0]!.from, "r1");
    assert.equal(first.launched[0]!.actor, "tom");
    // Under the agent step's own journal slice (`<agent path>#…`).
    assert.deepEqual(Object.keys(first.emitted), ["orch/work#001-job_start"]);

    const resumed = ctxFor("orch/work/001-job_start", true, first.emitted);
    assert.deepEqual(await jobStart.run({ prompt: "p", title: "t" } as any, resumed.ctx), started);
    assert.equal(resumed.launched.length, 0);
  });

  it("continue reattaches only to a launch of the same job; a DAG step journals at #launch", async () => {
    const first = ctxFor("orch/go", false);
    await jobContinue.run({ job: "j1", prompt: "p" } as any, first.ctx);
    assert.deepEqual(Object.keys(first.emitted), ["orch/go#launch"]);
    assert.equal((await jobContinue.run({ job: "j1", prompt: "p" } as any, ctxFor("orch/go", false, first.emitted).ctx)).runId, "run-1");
    const other = ctxFor("orch/go", false, first.emitted);
    await jobContinue.run({ job: "j2", prompt: "p" } as any, other.ctx);
    assert.equal(other.launched.length, 1, "a changed job is a fresh launch");
  });
});
