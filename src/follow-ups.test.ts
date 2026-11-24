import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyStepDef, StepContext } from "./core.js";
import { createStrut } from "./createStrut.js";
import { FOLLOW_UP_SENT, createFollowUps, settled, settledPrompt, timedOutPrompt, type FollowUpsDeps } from "./follow-ups.js";
import { jobRoot, jobsCapability, readJobRecord, recordJobRunCost, setJobBudget, type FollowUp, type JobsCapability } from "./jobs.js";
import { MemoryRunStore } from "./store.js";
import { buildRegistry } from "./steps/registry.js";
import { WorkspaceManager } from "./workspace.js";

const LOOK = { type: "acme/bake", input: { status: true } };

describe("follow-ups: the words", () => {
  it("settled is the look's own `settled: true`, nothing else", () => {
    assert.equal(settled({ settled: true, images: [] }), true);
    for (const v of [{ settled: false }, { settled: "true" }, {}, null, "settled", true]) assert.equal(settled(v), false);
  });

  it("the turn carries the look and its answer; a timeout its last answer or error", () => {
    const f = { id: "bake", look: LOOK, everyMs: 60_000, at: "2026-11-24T06:00:00.000Z", until: "2026-11-24T06:45:00.000Z", by: { runId: "r1" } } as FollowUp;
    assert.equal(settledPrompt(f, { settled: true, image: 3 }), `acme/bake {"status":true} settled. Its answer:\n{"settled":true,"image":3}`);
    assert.equal(timedOutPrompt(f, { answer: { image: 3, state: "building" } }), `acme/bake {"status":true} didn't settle in 45 minutes, and strut stopped looking. Its last answer:\n{"image":3,"state":"building"}`);
    assert.equal(timedOutPrompt(f, { error: "502 bad gateway" }), `acme/bake {"status":true} didn't settle in 45 minutes, and strut stopped looking. Its last look failed: 502 bad gateway`);
    assert.equal(timedOutPrompt(f), `acme/bake {"status":true} didn't settle in 45 minutes, and strut stopped looking.`);
  });
});

describe("follow-ups: asked for, looked at, sent once", () => {
  let dir = "";
  let jobs: JobsCapability;
  let t = 0;
  let answer: unknown;
  let busy = false;
  let refuse: string | undefined;
  let looks: Array<{ job: string; f: FollowUp }>;
  let launches: Array<Parameters<FollowUpsDeps["launch"]>[0]>;
  let warnings: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-follow-ups-"));
    jobs = jobsCapability(dir);
    await jobs.recordRun("j-1", { workflow: "job", runId: "r1", actor: "bob" });
    t = Date.parse("2026-11-24T06:00:00.000Z");
    answer = { settled: false };
    busy = false;
    refuse = undefined;
    looks = [];
    launches = [];
    warnings = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const make = () =>
    createFollowUps({
      dataDir: dir,
      person: async (_rec, runId) =>
        runId === "r1" ? { actor: "bob", principal: "bob", conversation: "bob/c-1", model: "sonnet" } : runId === "r-trial" ? { actor: "bob", trial: true } : undefined,
      look: async (job, f) => {
        looks.push({ job, f });
        if (answer instanceof Error) throw answer;
        return answer;
      },
      busy: () => busy,
      launch: async (o) => {
        if (refuse) throw new Error(refuse);
        launches.push(o);
        return `turn-${launches.length}`;
      },
      now: () => t,
      warn: (m) => warnings.push(m),
    });
  const record = async () => readJobRecord(jobRoot(dir, "j-1"));
  const mark = () => join(dir, "jobs", ".follow-ups", "j-1");

  it("a run that is not the job's, or a trial's, asks for nothing", async () => {
    const fu = make();
    await assert.rejects(fu.ask({ job: "j-1", runId: "elsewhere", look: LOOK }), /run elsewhere is not a run of job "j-1"/);
    await assert.rejects(fu.ask({ job: "nobody", runId: "r1", look: LOOK }), /not a run of job "nobody"/);
    await jobs.recordRun("j-1", { workflow: "job", runId: "r-trial" });
    await assert.rejects(fu.ask({ job: "j-1", runId: "r-trial", look: LOOK }), /a trial's run asks for no follow-up/);
    assert.equal((await record())?.followUps, undefined);
    await fu.stop();
  });

  it("kept on the record with the run's person, read by strut; the same id again replaces it", async () => {
    const fu = make();
    assert.deepEqual(await fu.ask({ job: "j-1", runId: "r1", id: "bake", look: LOOK, limitMinutes: 45 }), { id: "bake", until: "2026-11-24T06:45:00.000Z" });
    await fu.ask({ job: "j-1", runId: "r1", id: "bake", look: { type: "acme/bake", input: { status: true, again: 1 } }, everySeconds: 5 });
    const [f, ...rest] = (await record())!.followUps!;
    assert.deepEqual(rest, []);
    assert.deepEqual(f, {
      id: "bake",
      look: { type: "acme/bake", input: { status: true, again: 1 } },
      everyMs: 30_000,
      at: "2026-11-24T06:00:00.000Z",
      until: "2026-11-24T07:00:00.000Z",
      by: { runId: "r1", actor: "bob", principal: "bob", conversation: "bob/c-1", model: "sonnet" },
    });
    assert.ok(existsSync(mark()), "the job is marked");
    await fu.stop();
  });

  it("looks once an interval has passed; settled: ONE turn, as the person, naming the conversation, carrying the answer; then gone", async () => {
    const fu = make();
    await fu.ask({ job: "j-1", runId: "r1", look: LOOK });
    await fu.tick();
    assert.equal(looks.length, 0, "the work just started");
    t += 60_000;
    await fu.tick();
    assert.equal(looks.length, 1);
    assert.deepEqual(looks[0]!.f.look, LOOK);
    assert.equal(launches.length, 0, "not settled");
    t += 30_000;
    await fu.tick();
    assert.equal(looks.length, 1, "not before its interval");
    t += 30_000;
    answer = { settled: true, image: 3 };
    await fu.tick();
    assert.deepEqual(launches, [
      {
        job: "j-1",
        workflow: "job",
        prompt: `acme/bake {"status":true} settled. Its answer:\n{"settled":true,"image":3}\n\n${FOLLOW_UP_SENT}`,
        conversation: "bob/c-1",
        actor: "bob",
        principal: "bob",
        model: "sonnet",
      },
    ]);
    assert.equal((await record())!.followUps, undefined);
    assert.equal(existsSync(mark()), false, "the mark goes with it");
    t += 600_000;
    await fu.tick();
    assert.equal(launches.length, 1, "never again");
    await fu.stop();
  });

  it("settled while a run of the job is in flight: kept ready on the record, sent once the job is free — after a restart too, without looking again", async () => {
    const fu = make();
    await fu.ask({ job: "j-1", runId: "r1", look: LOOK });
    busy = true;
    answer = { settled: true };
    t += 60_000;
    await fu.tick();
    assert.equal(launches.length, 0);
    assert.equal((await record())!.followUps![0]!.ready, `acme/bake {"status":true} settled. Its answer:\n{"settled":true}`);
    await fu.stop();

    const after = make();
    answer = new Error("never looked at again");
    t += 15_000;
    await after.tick();
    assert.equal(launches.length, 0, "still busy");
    busy = false;
    await after.tick();
    assert.equal(looks.length, 1);
    assert.equal(launches.length, 1);
    assert.match(launches[0]!.prompt, /^acme\/bake \{"status":true\} settled\./);
    assert.equal((await record())!.followUps, undefined);
    await after.stop();
  });

  it("a launch that is refused puts it back, and the next tick sends it; a race to job_busy is not warned", async () => {
    const fu = make();
    await fu.ask({ job: "j-1", runId: "r1", look: LOOK });
    answer = { settled: true };
    t += 60_000;
    refuse = "job_busy: job \"j-1\" has a run in flight";
    await fu.tick();
    assert.equal(launches.length, 0);
    assert.ok((await record())!.followUps![0]!.ready, "put back");
    assert.deepEqual(warnings, []);
    refuse = "no_workflow: gone";
    await fu.tick();
    await fu.tick();
    assert.equal(warnings.length, 1, "warned once, not every tick");
    assert.match(warnings[0]!, /the turn was not launched: no_workflow: gone/);
    refuse = undefined;
    await fu.tick();
    assert.equal(launches.length, 1);
    assert.equal(looks.length, 1, "looked at once");
    await fu.stop();
  });

  it("past its limit: one turn saying so, with the last answer or the last error; a look that throws is tried again", async () => {
    const fu = make();
    await fu.ask({ job: "j-1", runId: "r1", look: LOOK, limitMinutes: 3 });
    answer = new Error("502 bad gateway");
    t += 60_000;
    await fu.tick();
    answer = { settled: false, state: "building" };
    t += 60_000;
    await fu.tick();
    assert.equal(looks.length, 2, "tried again after a failure");
    t += 60_000;
    await fu.tick();
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.prompt, `acme/bake {"status":true} didn't settle in 3 minutes, and strut stopped looking. Its last answer:\n{"settled":false,"state":"building"}\n\n${FOLLOW_UP_SENT}`);
    assert.equal(looks.length, 2, "no look past the limit");
    await fu.stop();
  });

  it("two ready together go as one turn", async () => {
    const fu = make();
    await fu.ask({ job: "j-1", runId: "r1", id: "a", look: LOOK });
    await fu.ask({ job: "j-1", runId: "r1", id: "b", look: { type: "acme/deploy", input: {} } });
    answer = { settled: true };
    t += 60_000;
    await fu.tick();
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.prompt, [`acme/bake {"status":true} settled. Its answer:\n{"settled":true}`, `acme/deploy {} settled. Its answer:\n{"settled":true}`, FOLLOW_UP_SENT].join("\n\n"));
    await fu.stop();
  });

  it("a mark whose job is gone is dropped", async () => {
    const fu = make();
    await fu.ask({ job: "j-1", runId: "r1", look: LOOK });
    await rm(`${jobRoot(dir, "j-1")}.json`);
    await fu.tick();
    assert.equal(existsSync(mark()), false);
    await fu.stop();
  });
});

describe("follow-ups through a whole strut", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-follow-ups-e2e-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const until = async <T>(find: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 1500; i++) {
      const v = await find();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${what} never happened`);
  };

  /** A strut whose stand-in `job` turn asks for a follow-up when told to
   *  bake; the asking turn has run on j-1, as bob, and the process has gone. */
  const askingTurn = async () => {
    const state: { answer: unknown; seen: Array<{ actor?: string; principal?: string; job?: string }> } = { answer: { settled: false }, seen: [] };
    const ask: AnyStepDef = {
      type: "test/ask",
      input: { parse: (v: unknown) => v },
      async run(cfg: unknown, ctx?: StepContext<any>) {
        if ((cfg as { prompt?: string }).prompt !== "bake") return {};
        return (ctx!.services as { jobs: JobsCapability }).jobs.followUp!({ job: ctx!.job!, runId: ctx!.runId, id: "bake", look: { type: "test/look", input: { status: true } } });
      },
    } as unknown as AnyStepDef;
    const look: AnyStepDef = {
      type: "test/look",
      input: { parse: (v: unknown) => v },
      async run(_cfg: unknown, ctx?: StepContext<any>) {
        state.seen.push({ ...(ctx!.actor ? { actor: ctx!.actor } : {}), ...(ctx!.principal ? { principal: ctx!.principal } : {}), ...(ctx!.job ? { job: ctx!.job } : {}) });
        return state.answer;
      },
    } as unknown as AnyStepDef;
    const registry = { ...(await buildRegistry()).registry, "test/ask": ask, "test/look": look };
    // The run store outlives the process, as a file store does.
    const store = new MemoryRunStore();
    const boot = () =>
      createStrut({
        workspace: new WorkspaceManager(dir),
        store,
        dataDir: join(dir, "data"),
        registry,
        serveUi: false,
        enableChat: false,
        scheduler: false,
        job: false,
        builder: false,
        autoResume: false,
        orchestrator: false,
        resolveActor: (c) => c.req.header("x-test-actor"),
      });

    const first = await boot();
    await first.workspace.publishWorkflow("job", "v1", {
      steps: [
        { id: "ask", type: "test/ask", config: { prompt: "{{ input.prompt }}" } },
        { id: "result", type: "pack", config: { text: "{{ input.prompt }}" } },
      ],
    });
    const res = await first.app.request("/workflows/job/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": "bob" },
      body: JSON.stringify({ job: "j-1", input: { prompt: "bake", kind: "Pod Setup" }, conversation: "bob/c-1", wake: true }),
    });
    assert.equal(res.status, 202);
    const { runId } = (await res.json()) as { runId: string };
    await until(async () => ((await first.store.getRunEvents("job", runId)).some((e) => e.type === "run.end") ? true : undefined), "the asking turn's end");
    const asked = (await readJobRecord(jobRoot(first.dataDir, "j-1")))!.followUps!;
    assert.deepEqual(asked.map((f) => [f.id, f.look, f.by]), [["bake", { type: "test/look", input: { status: true } }, { runId, actor: "bob", principal: "bob", conversation: "bob/c-1" }]]);
    await first.close();
    return { boot, runId, state, root: jobRoot(join(dir, "data"), "j-1") };
  };

  it("a turn's step asks; after a restart strut looks as the turn's person, and its settling sends the job one turn that wakes the conversation", async () => {
    const { boot, state } = await askingTurn();
    // The process went; the next one looks at once, and the build is done.
    state.answer = { settled: true, image: 3 };
    const second = await boot();
    try {
      const rec = await until(async () => {
        const r = await readJobRecord(jobRoot(second.dataDir, "j-1"));
        return r?.runs?.length === 2 && !r.followUps ? r : undefined;
      }, "the follow-up's turn");
      assert.deepEqual(state.seen, [{ actor: "bob", principal: "bob", job: "j-1" }], "looked once, as the turn's person, on the job");
      const turn = rec.runs![1]!.runId;
      await until(async () => ((await second.store.getRunEvents("job", turn)).some((e) => e.type === "run.end") ? true : undefined), "the follow-up turn's end");
      const start = (await second.store.getRunEvents("job", turn)).find((e) => e.type === "run.start")!;
      assert.deepEqual(start.input, { prompt: `test/look {"status":true} settled. Its answer:\n{"settled":true,"image":3}\n\n${FOLLOW_UP_SENT}`, kind: "Pod Setup" }, "the job's kind, as a continue carries it");
      assert.equal(start.conversation, "bob/c-1", "its end wakes the asking turn's conversation");
      assert.equal(start.wakeAsked, true);
      assert.equal(start.actor, "bob");
      assert.equal(existsSync(join(second.dataDir, "jobs", ".follow-ups", "j-1")), false);
    } finally {
      await second.close();
    }
  });

  it("a job that has spent its budget starts no turn: the settled follow-up waits on the record", async () => {
    const { boot, runId, state, root } = await askingTurn();
    await setJobBudget(root, "j-1", 1);
    await recordJobRunCost(root, runId, 1.5);
    state.answer = { settled: true };
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (m: unknown) => void warned.push(String(m));
    const second = await boot();
    try {
      const rec = await until(async () => {
        const r = await readJobRecord(root);
        return r?.followUps?.[0]?.ready && warned.length ? r : undefined;
      }, "the refused turn");
      assert.equal(rec.runs?.length, 1, "no turn ran");
      assert.match(warned.join("\n"), /job j-1: the turn was not launched: job_budget_spent:/);
      assert.equal(existsSync(join(second.dataDir, "jobs", ".follow-ups", "j-1")), true, "still pending");
    } finally {
      console.warn = warn;
      await second.close();
    }
  });
});
