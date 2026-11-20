// Parked runs (src/park.ts, plans/human-steps.md §2): a run that waits leaves
// memory as `waiting`, and a source's wake resumes it from its journal.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { defineStep, type RunEvent, type RunSummary, type StepRegistry } from "./core.js";
import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { buildRegistryTools } from "./steps/core/agent.js";
import jobDir from "./steps/lib/job/dir.js";
import { ParkedError, isParkedError, mergeParked, parkPrefix, type ParkSource, type ParkWaker } from "./park.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the test source knows: the answers given so far, and the targets it
 *  was told were cancelled. `late` answers appear the moment the source is
 *  asked (a settle the server never woke for). */
function testSource() {
  const answers = new Map<string, unknown>();
  const late = new Map<string, unknown>();
  const cancelled: string[] = [];
  const asked: string[] = [];
  const source: ParkSource = {
    settled: async (on) => {
      asked.push(on);
      if (late.has(on)) answers.set(on, late.get(on));
      return answers.has(on);
    },
    cancelled: async (on) => {
      cancelled.push(on);
    },
  };
  return { answers, late, cancelled, asked, source };
}

/** `ans:<key>`'s answer, or the step parks on it. `calls` counts every run
 *  of the step's body, so a test sees what a wake re-ran. */
function waitStep(answers: Map<string, unknown>, calls: string[]) {
  return defineStep({
    type: "wait-for",
    input: z.object({ key: z.string(), prefix: z.string().default("ans") }),
    output: z.any(),
    async run(cfg, ctx) {
      const on = `${cfg.prefix}:${cfg.key}`;
      calls.push(on);
      if (answers.has(on)) return answers.get(on);
      return ctx.park!(on);
    },
  });
}

function countStep(calls: string[]) {
  return defineStep({
    type: "count",
    input: z.object({ name: z.string() }),
    output: z.any(),
    async run(cfg) {
      calls.push(cfg.name);
      return cfg.name;
    },
  });
}

const valueStep = defineStep({
  type: "value",
  input: z.object({ result: z.any() }),
  output: z.any(),
  async run(cfg) {
    return cfg.result;
  },
});

/** A step that blocks until the test releases it. */
function gateStep() {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let started = false;
  const def = defineStep({
    type: "gate",
    input: z.object({}).passthrough(),
    output: z.any(),
    async run() {
      started = true;
      await open;
      return "gate";
    },
  });
  return { def, release: () => release(), started: () => started };
}

async function makeServer(o: { dir?: string; steps?: Record<string, unknown>; register?: ParkSource; callbackPort?: number } = {}) {
  const dir = o.dir ?? join(tmpdir(), `strut-park-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const workspace = new WorkspaceManager(dir);
  const registry = { value: valueStep, ...(o.steps ?? {}) } as StepRegistry;
  const strut = await createStrut({ workspace, registry, serveUi: false, enableChat: false, autoResume: false, wakeDelayMs: 0 });
  const waker = o.register ? strut.parking.register("ans", o.register) : undefined;
  return { strut, workspace, dir, waker };
}

async function launch(strut: Strut, wf: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await strut.app.request(`/workflows/${wf}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: {}, ...body }),
  });
  assert.equal(res.status, 202, await res.clone().text());
  return ((await res.json()) as { runId: string }).runId;
}

/** The run's summary once `pred` holds (a woken run clears its summary and
 *  writes a new one when it parks again or ends). */
async function summaryWhen(strut: Strut, wf: string, runId: string, pred: (s: RunSummary) => boolean, ms = 4000): Promise<RunSummary> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await strut.store.getRunSummary(wf, runId);
    if (s && pred(s)) return s;
    if (Date.now() > deadline) throw new Error(`no summary matched (last: ${JSON.stringify(s?.status)})`);
    await sleep(10);
  }
}
/** The run waiting, and its launcher done with it: the end hooks (the
 *  waiting index's file among them) run after the summary is written. */
const waiting = async (strut: Strut, wf: string, runId: string, pred: (s: RunSummary) => boolean = () => true) => {
  const s = await summaryWhen(strut, wf, runId, (x) => x.status === "waiting" && pred(x));
  await released(strut, wf, runId);
  return s;
};
const ended = (strut: Strut, wf: string, runId: string) => summaryWhen(strut, wf, runId, (s) => s.status !== "waiting");

async function events(strut: Strut, wf: string, runId: string): Promise<RunEvent[]> {
  return strut.store.getRunEvents(wf, runId);
}

/** No controller left for the run: the launcher let it go. */
async function released(strut: Strut, wf: string, runId: string) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const active = (await (await strut.app.request("/runs/active")).json()) as Array<{ workflow: string; runId: string }>;
    if (!active.some((r) => r.workflow === wf && r.runId === runId)) return;
    if (Date.now() > deadline) throw new Error("the run kept its controller");
    await sleep(10);
  }
}

describe("park.ts", () => {
  it("a park target is <prefix>:<id>, the prefix lowercase letters", () => {
    assert.equal(parkPrefix("task:4f2c"), "task");
    assert.equal(parkPrefix("Task:1"), null);
    assert.equal(parkPrefix("task:"), null);
    assert.equal(parkPrefix("task"), null);
    assert.equal(parkPrefix(`task:${"x".repeat(300)}`), null);
  });

  it("several parked branches merge into one error on every target", () => {
    const merged = mergeParked([new ParkedError(["a:1"]), new ParkedError(["a:2", "a:1"]), new Error("not a park")]);
    assert.ok(isParkedError(merged));
    assert.deepEqual(merged.on, ["a:1", "a:2"]);
  });
});

describe("parked runs", () => {
  it("a run parks: step.parked, run.waiting, a `waiting` summary and no controller; a wake replays and finishes", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir, waker } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls), count: countStep(calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("review", "v1", {
        steps: [
          { id: "a", type: "count", config: { name: "a" } },
          { id: "b", type: "wait-for", config: { key: "k1" } },
          { id: "c", type: "value", config: { result: "{{ b.x }}" } },
        ],
      });
      const runId = await launch(strut, "review");
      const s = await waiting(strut, "review", runId);
      assert.deepEqual(s.waitingOn, ["ans:k1"]);
      assert.equal(s.output, undefined);
      await released(strut, "review", runId);

      const log = await events(strut, "review", runId);
      const parked = log.find((e) => e.type === "step.parked");
      assert.equal(parked?.path, "review/b");
      assert.deepEqual(parked?.on, ["ans:k1"]);
      assert.equal(log.at(-1)?.type, "run.waiting");
      assert.ok(!log.some((e) => e.type === "step.error" || e.type === "run.end" || e.type === "run.error"));
      assert.ok(!log.some((e) => e.path === "review/c"), "a dependent of a parked step never starts");
      // The run's stream closes with the run waiting.
      const stream = await (await strut.app.request(`/workflows/review/runs/${runId}/stream`)).text();
      assert.match(stream, /event: done\ndata: \{"runId":"[^"]+","status":"waiting"/);

      // Answered: the wake replays `a` and runs `b` again, which finds it.
      src.answers.set("ans:k1", { x: 42 });
      waker!.wake("review", runId);
      const done = await ended(strut, "review", runId);
      assert.equal(done.status, "success");
      assert.equal(done.output, 42);
      assert.equal(done.waitingOn, undefined);
      assert.deepEqual(calls, ["a", "ans:k1", "ans:k1"], "`a` ran once; `b` ran again on the wake");
      const after = await events(strut, "review", runId);
      const resumed = after.filter((e) => e.type === "run.resumed");
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0]!.woken, true);
      assert.ok(after.some((e) => e.type === "step.replayed" && e.path === "review/a"));
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a park in one branch lets the others run to their end", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls), count: countStep(calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("branches", "v1", {
        steps: [
          { id: "ask", type: "wait-for", config: { key: "k2" }, depends: [] },
          { id: "other", type: "count", config: { name: "other" }, depends: [] },
          { id: "after-other", type: "count", config: { name: "after-other" }, depends: ["other"] },
          { id: "after-ask", type: "count", config: { name: "after-ask" }, depends: ["ask"] },
        ],
      });
      const runId = await launch(strut, "branches");
      const s = await waiting(strut, "branches", runId);
      assert.deepEqual(s.waitingOn, ["ans:k2"]);
      assert.deepEqual(calls.sort(), ["after-other", "ans:k2", "other"]);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an error in another branch wins over a park: the run fails", async () => {
    const src = testSource();
    const calls: string[] = [];
    const boom = defineStep({ type: "boom", input: z.any(), output: z.any(), run: async () => { throw new Error("boom"); } });
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls), boom }, register: src.source });
    try {
      await workspace.publishWorkflow("mixed", "v1", {
        steps: [
          { id: "ask", type: "wait-for", config: { key: "k3" }, depends: [] },
          { id: "fail", type: "boom", config: {}, depends: [] },
        ],
      });
      const runId = await launch(strut, "mixed");
      const s = await ended(strut, "mixed", runId);
      assert.equal(s.status, "error");
      assert.match(s.error!.message, /boom/);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const concurrency of [1, 3]) {
    it(`a foreach of N parks once, on N waits (concurrency ${concurrency}), and waits on what is left after a wake`, async () => {
      const src = testSource();
      const calls: string[] = [];
      const { strut, workspace, dir, waker } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
      try {
        await workspace.publishWorkflow("each", "v1", {
          steps: [
            {
              id: "pages",
              type: "foreach",
              config: { items: [1, 2, 3], concurrency, body: { id: "page", type: "wait-for", config: { key: "p{{ $current }}" } } },
            },
          ],
        });
        const runId = await launch(strut, "each");
        const first = await waiting(strut, "each", runId);
        assert.deepEqual([...first.waitingOn!].sort(), ["ans:p1", "ans:p2", "ans:p3"]);
        const log = await events(strut, "each", runId);
        assert.deepEqual(
          log.filter((e) => e.type === "step.parked").map((e) => e.path).sort(),
          ["each/pages", "each/pages#0", "each/pages#1", "each/pages#2"],
        );
        assert.equal(log.filter((e) => e.type === "run.waiting").length, 1, "one pass makes every wait");

        // Two answered: the wake runs the open iterations again, and the run
        // waits on the one left.
        src.answers.set("ans:p1", "one");
        src.answers.set("ans:p3", "three");
        await released(strut, "each", runId);
        waker!.wake("each", runId);
        const second = await waiting(strut, "each", runId, (s) => s.waitingOn?.length === 1);
        assert.deepEqual(second.waitingOn, ["ans:p2"]);

        src.answers.set("ans:p2", "two");
        await released(strut, "each", runId);
        waker!.wake("each", runId);
        const done = await ended(strut, "each", runId);
        assert.equal(done.status, "success");
        assert.deepEqual(done.output, ["one", "two", "three"]);
        // p1 and p3 ran twice (parked, then answered); p2 three times.
        assert.equal(calls.filter((c) => c === "ans:p2").length, 3);
        assert.equal(calls.filter((c) => c === "ans:p1").length, 2);
      } finally {
        await strut.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("a park is not an error: no retry, no onError", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("guarded", "v1", {
        steps: [
          {
            id: "ask",
            type: "wait-for",
            config: { key: "k4" },
            options: { retry: { max: 3, delayMs: 0 }, onError: { id: "fallback", type: "value", config: { result: "guess" } } },
          },
        ],
      });
      const runId = await launch(strut, "guarded");
      await waiting(strut, "guarded", runId);
      assert.deepEqual(calls, ["ans:k4"]);
      const log = await events(strut, "guarded", runId);
      assert.ok(!log.some((e) => e.type === "step.retry" || e.path.endsWith("/onError")));
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no lost wake: a target that settled before the run parked wakes it at once", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("quick", "v1", { steps: [{ id: "ask", type: "wait-for", config: { key: "k5" } }] });
      // Settles as the run parks: the source says so when asked.
      src.late.set("ans:k5", "fast");
      const runId = await launch(strut, "quick");
      const done = await ended(strut, "quick", runId);
      assert.equal(done.status, "success");
      assert.equal(done.output, "fast");
      assert.ok(src.asked.includes("ans:k5"));
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a wake while the run is live is kept, and applied when it parks", async () => {
    const src = testSource();
    const calls: string[] = [];
    const gate = gateStep();
    const { strut, workspace, dir, waker } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls), gate: gate.def }, register: src.source });
    try {
      await workspace.publishWorkflow("busy", "v1", {
        steps: [
          { id: "ask", type: "wait-for", config: { key: "k6" }, depends: [] },
          { id: "slow", type: "gate", config: {}, depends: [] },
        ],
      });
      const runId = await launch(strut, "busy");
      const deadline = Date.now() + 2000;
      while (!(await events(strut, "busy", runId)).some((e) => e.type === "step.parked") || !gate.started()) {
        if (Date.now() > deadline) throw new Error("the step never parked");
        await sleep(10);
      }
      // Answered while the other branch still runs: nothing to resume yet.
      src.answers.set("ans:k6", "late");
      waker!.wake("busy", runId);
      await sleep(30);
      assert.equal(await strut.store.getRunSummary("busy", runId), null);
      gate.release();
      const done = await ended(strut, "busy", runId);
      assert.equal(done.status, "success");
      const resumed = (await events(strut, "busy", runId)).filter((e) => e.type === "run.resumed");
      assert.equal(resumed.length, 1);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cancel of a waiting run: finalized as cancelled where it waits, the source told, a later wake does nothing", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir, waker } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("cancel-me", "v1", { steps: [{ id: "ask", type: "wait-for", config: { key: "k7" } }] });
      const runId = await launch(strut, "cancel-me");
      await waiting(strut, "cancel-me", runId);
      assert.equal((await readdir(join(dir, "parking"))).length, 1);

      const pause = await strut.app.request(`/workflows/cancel-me/runs/${runId}/pause`, { method: "POST" });
      assert.equal(pause.status, 409);
      assert.match(((await pause.json()) as { error: string }).error, /waiting/);

      const res = await strut.app.request(`/workflows/cancel-me/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(res.status, 202);
      const s = await strut.store.getRunSummary("cancel-me", runId);
      assert.equal(s?.status, "cancelled");
      assert.deepEqual(src.cancelled, ["ans:k7"]);
      assert.equal((await events(strut, "cancel-me", runId)).at(-1)?.type, "run.cancelled");
      assert.deepEqual(await readdir(join(dir, "parking")), []);

      src.answers.set("ans:k7", "too late");
      waker!.wake("cancel-me", runId);
      await sleep(50);
      assert.equal((await strut.store.getRunSummary("cancel-me", runId))?.status, "cancelled");
      assert.ok(!(await events(strut, "cancel-me", runId)).some((e) => e.type === "run.resumed"));
      // Twice is the same answer as any ended run.
      assert.equal((await strut.app.request(`/workflows/cancel-me/runs/${runId}/cancel`, { method: "POST" })).status, 409);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** `ask` parks while `slow`, a branch of its own, is past its checkpoint:
   *  the cancel (if any) comes after the last checkpoint of every branch. */
  async function parkedBesideGate(cancel: boolean) {
    const src = testSource();
    const calls: string[] = [];
    const gate = gateStep();
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls), gate: gate.def }, register: src.source });
    try {
      await workspace.publishWorkflow("late-cancel", "v1", {
        steps: [
          { id: "ask", type: "wait-for", config: { key: "k10" }, depends: [] },
          { id: "slow", type: "gate", config: {}, depends: [] },
        ],
      });
      const runId = await launch(strut, "late-cancel");
      const deadline = Date.now() + 2000;
      while (!(await events(strut, "late-cancel", runId)).some((e) => e.type === "step.parked") || !gate.started()) {
        if (Date.now() > deadline) throw new Error("the step never parked");
        await sleep(10);
      }
      if (cancel) assert.equal((await strut.app.request(`/workflows/late-cancel/runs/${runId}/cancel`, { method: "POST" })).status, 202);
      // `slow` ends as a success: the only branch left unfinished parked.
      gate.release();
      const s = await summaryWhen(strut, "late-cancel", runId, () => true);
      await released(strut, "late-cancel", runId);
      return { s, log: await events(strut, "late-cancel", runId), src, parking: await readdir(join(dir, "parking")).catch(() => []) };
    } finally {
      gate.release();
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("a cancel after the last checkpoint, with every open branch parked: the run ends cancelled, not waiting, and the source is told", async () => {
    const { s, log, src, parking } = await parkedBesideGate(true);
    assert.equal(s.status, "cancelled");
    assert.equal(s.waitingOn, undefined);
    assert.equal(log.at(-1)?.type, "run.cancelled");
    assert.ok(!log.some((e) => e.type === "run.waiting"));
    assert.deepEqual(src.cancelled, ["ans:k10"]);
    assert.deepEqual(parking, [], "not kept as a waiting run");
  });

  it("the same run with no cancel still ends waiting", async () => {
    const { s, log, src, parking } = await parkedBesideGate(false);
    assert.equal(s.status, "waiting");
    assert.deepEqual(s.waitingOn, ["ans:k10"]);
    assert.equal(log.at(-1)?.type, "run.waiting");
    assert.deepEqual(src.cancelled, []);
    assert.equal(parking.length, 1);
  });

  it("no run.end callback while the run waits; it goes at the real end", async () => {
    const posts: Array<{ event: string; status: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posts.push(JSON.parse(body));
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir, waker } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("hosted", "v1", { steps: [{ id: "ask", type: "wait-for", config: { key: "k8" } }] });
      const runId = await launch(strut, "hosted", { callback: { url: `http://127.0.0.1:${port}/done` } });
      await waiting(strut, "hosted", runId);
      await released(strut, "hosted", runId);
      await sleep(100);
      assert.deepEqual(posts, []);

      src.answers.set("ans:k8", "yes");
      waker!.wake("hosted", runId);
      await ended(strut, "hosted", runId);
      const deadline = Date.now() + 2000;
      while (!posts.length && Date.now() < deadline) await sleep(10);
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.event, "run.end");
      assert.equal(posts[0]!.status, "success");
    } finally {
      await strut.close();
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a restart between the settle and the wake: the source's registration wakes it at the next boot", async () => {
    const dir = join(tmpdir(), `strut-park-${randomUUID()}`);
    const src = testSource();
    const calls: string[] = [];
    const steps = { "wait-for": waitStep(src.answers, calls) };
    const one = await makeServer({ dir, steps, register: src.source });
    let two: Awaited<ReturnType<typeof makeServer>> | undefined;
    try {
      await one.workspace.publishWorkflow("survive", "v1", { steps: [{ id: "ask", type: "wait-for", config: { key: "k9" } }] });
      const runId = await launch(one.strut, "survive");
      await waiting(one.strut, "survive", runId);
      await released(one.strut, "survive", runId);
      await one.strut.close();

      // Answered while no process listened.
      src.answers.set("ans:k9", "while down");
      two = await makeServer({ dir, steps });
      assert.equal((await two.strut.store.getRunSummary("survive", runId))?.status, "waiting");
      two.strut.parking.register("ans", src.source);
      const done = await ended(two.strut, "survive", runId);
      assert.equal(done.status, "success");
      assert.equal(done.output, "while down");
      await released(two.strut, "survive", runId);
      assert.deepEqual(await readdir(join(dir, "parking")), [], "an ended run leaves the index");
    } finally {
      await two?.strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("boot auto-resume passes a waiting run over", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("idle", "v1", { steps: [{ id: "ask", type: "wait-for", config: { key: "k10" } }] });
      const runId = await launch(strut, "idle");
      await waiting(strut, "idle", runId);
      await released(strut, "idle", runId);
      const report = await strut.autoResumeStaleRuns({ since: 0 });
      assert.deepEqual(report, []);
      await sleep(30);
      assert.equal((await strut.store.getRunSummary("idle", runId))?.status, "waiting");
      assert.ok(!(await events(strut, "idle", runId)).some((e) => e.type === "run.resumed"));
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a crash while parking (run.waiting written, no summary): boot resumes it and it parks again; wakes are not counted as restarts", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("torn", "v1", { steps: [{ id: "ask", type: "wait-for", config: { key: "k11" } }] });
      const runId = "1700000000000";
      const ts = new Date().toISOString();
      const ev = (type: RunEvent["type"], path: string, more: Partial<RunEvent> = {}) => ({ ts, runId, path, type, ...more }) as RunEvent;
      await strut.store.append("torn", runId, ev("run.start", "torn", { input: {}, workflowHash: (await workspace.getWorkflowHash("torn")) ?? undefined }));
      // Six wakes before: past the crash-loop cap of five, were they counted.
      for (let i = 0; i < 6; i++) {
        await strut.store.append("torn", runId, ev("step.start", "torn/ask", { stepType: "wait-for" }));
        await strut.store.append("torn", runId, ev("step.parked", "torn/ask", { stepType: "wait-for", on: ["ans:k11"] }));
        await strut.store.append("torn", runId, ev("run.waiting", "torn", { on: ["ans:k11"] }));
        await strut.store.append("torn", runId, ev("run.resumed", "torn", { woken: true }));
      }
      await strut.store.append("torn", runId, ev("step.start", "torn/ask", { stepType: "wait-for" }));
      await strut.store.append("torn", runId, ev("step.parked", "torn/ask", { stepType: "wait-for", on: ["ans:k11"] }));
      await strut.store.append("torn", runId, ev("run.waiting", "torn", { on: ["ans:k11"] }));
      const report = await strut.autoResumeStaleRuns({ since: 0 });
      assert.deepEqual(report.map((r) => r.action), ["resumed"]);
      const s = await waiting(strut, "torn", runId);
      assert.deepEqual(s.waitingOn, ["ans:k11"]);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a park nobody can wake fails the step, as an error", async () => {
    const src = testSource();
    const calls: string[] = [];
    const { strut, workspace, dir } = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls) }, register: src.source });
    try {
      await workspace.publishWorkflow("orphan", "v1", { steps: [{ id: "ask", type: "wait-for", config: { key: "k12", prefix: "nobody" } }] });
      const runId = await launch(strut, "orphan");
      const s = await ended(strut, "orphan", runId);
      assert.equal(s.status, "error");
      assert.match(s.error!.message, /park_refused: .*no source for "nobody"/);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a single-step run and an agent's tool call cannot park", async () => {
    const src = testSource();
    const calls: string[] = [];
    const step = waitStep(src.answers, calls);
    const { strut, dir } = await makeServer({ steps: { "wait-for": step }, register: src.source });
    try {
      const res = await strut.app.request("/steps/wait-for/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { key: "k13" } }),
      });
      const out = (await res.json()) as { status: string; error?: { message: string } };
      assert.equal(out.status, "error");
      assert.match(out.error!.message, /park_refused: a single-step run cannot wait/);

      const tools = buildRegistryTools(["wait-for"], { "wait-for": step } as StepRegistry, undefined, (def) => def) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
      await assert.rejects(Object.values(tools)[0]!.execute({ key: "k14" }), /park_refused: .*an agent cannot wait in the middle of a turn/);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a prefix registers once, and only as lowercase letters", async () => {
    const { strut, dir } = await makeServer();
    try {
      const waker: ParkWaker = strut.parking.register("once", { settled: async () => false });
      assert.equal(typeof waker.wake, "function");
      assert.throws(() => strut.parking.register("once", { settled: async () => false }), /registered already/);
      assert.throws(() => strut.parking.register("Two", { settled: async () => false }), /lowercase letters/);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a parked run and its job (job/dir's hold)", () => {
  /** One-shot gates by name: a `gate` step blocks on its own until released. */
  function gates() {
    const all = new Map<string, { open: Promise<void>; release: () => void; started: boolean }>();
    const get = (name: string) => {
      let g = all.get(name);
      if (!g) {
        let release!: () => void;
        const open = new Promise<void>((r) => (release = r));
        g = { open, release: () => release(), started: false };
        all.set(name, g);
      }
      return g;
    };
    const def = defineStep({
      type: "gate",
      input: z.object({ name: z.string() }),
      output: z.any(),
      async run(cfg) {
        const g = get(cfg.name);
        g.started = true;
        await g.open;
        return cfg.name;
      },
    });
    return { def, get, releaseAll: () => all.forEach((g) => g.release()) };
  }

  async function jobServer() {
    const src = testSource();
    const calls: string[] = [];
    const g = gates();
    const boom = { on: false };
    const flaky = defineStep({ type: "flaky", input: z.object({}).passthrough(), output: z.any(), run: async () => { if (boom.on) throw new Error("boom"); return "ok"; } });
    const server = await makeServer({ steps: { "wait-for": waitStep(src.answers, calls), count: countStep(calls), gate: g.def, flaky, "job/dir": jobDir }, register: src.source });
    const { workspace } = server;
    await workspace.publishWorkflow("jobbed", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "ask", type: "wait-for", config: { key: "{{ input.key }}" } },
        { id: "slow", type: "gate", config: { name: "{{ input.gate }}" } },
        { id: "after", type: "count", config: { name: "after" } },
      ],
    });
    await workspace.publishWorkflow("touch", "v1", { steps: [{ id: "dir", type: "job/dir", config: {} }] });
    await workspace.publishWorkflow("holder", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "hold", type: "gate", config: { name: "{{ input.gate }}" } },
      ],
    });
    await workspace.publishWorkflow("fails-once", "v1", {
      steps: [
        { id: "dir", type: "job/dir", config: {} },
        { id: "flaky", type: "flaky", config: {} },
        { id: "slow", type: "gate", config: { name: "{{ input.gate }}" } },
      ],
    });
    return { ...server, src, calls, g, boom };
  }

  /** A run of `touch` under `job`: what it ended with. */
  async function touch(strut: Strut, job: string): Promise<RunSummary> {
    const runId = await launch(strut, "touch", { job });
    return ended(strut, "touch", runId);
  }

  it("a parked run lets go of its job; after its wake it holds it again, and a second run of the job is refused job_busy: while it is live", async () => {
    const { strut, dir, waker, src, g, calls } = await jobServer();
    try {
      const runId = await launch(strut, "jobbed", { job: "j-wake", input: { key: "w1", gate: "w1" } });
      await waiting(strut, "jobbed", runId);
      // While it waits the job is free.
      assert.equal((await touch(strut, "j-wake")).status, "success");

      src.answers.set("ans:w1", "yes");
      waker!.wake("jobbed", runId);
      const deadline = Date.now() + 3000;
      while (!g.get("w1").started) {
        if (Date.now() > deadline) throw new Error("the woken run never reached its gate");
        await sleep(10);
      }
      const busy = await touch(strut, "j-wake");
      assert.equal(busy.status, "error");
      assert.match(busy.error!.message, /^job_busy: job "j-wake" is in use by run /);

      g.get("w1").release();
      const done = await ended(strut, "jobbed", runId);
      assert.equal(done.status, "success");
      assert.deepEqual(calls.filter((c) => c === "after"), ["after"]);
      // The run's end lets it go.
      assert.equal((await touch(strut, "j-wake")).status, "success");
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a wake while another run holds the job: the woken run waits for it, live, and goes on once it lets go", async () => {
    const { strut, dir, waker, src, g, calls } = await jobServer();
    try {
      const runId = await launch(strut, "jobbed", { job: "j-queue", input: { key: "q1", gate: "q-own" } });
      await waiting(strut, "jobbed", runId);
      const holder = await launch(strut, "holder", { job: "j-queue", input: { gate: "q-holder" } });
      for (let i = 0; i < 300 && !g.get("q-holder").started; i++) await sleep(10);
      assert.ok(g.get("q-holder").started);

      g.get("q-own").release(); // the woken run's own gate never blocks: only the job holds it back
      src.answers.set("ans:q1", "yes");
      waker!.wake("jobbed", runId);
      for (let i = 0; i < 300 && !(await events(strut, "jobbed", runId)).some((e) => e.type === "run.resumed"); i++) await sleep(10);
      await sleep(400);
      // Live, held back at the job: not failed, not waiting, nothing after it run.
      assert.equal(await strut.store.getRunSummary("jobbed", runId), null);
      const active = (await (await strut.app.request("/runs/active")).json()) as Array<{ runId: string }>;
      assert.ok(active.some((r) => r.runId === runId), "the woken run is live");
      const log = await events(strut, "jobbed", runId);
      assert.ok(!log.some((e) => e.type === "step.error"));
      assert.ok(!log.some((e) => e.type === "step.replayed" && e.path === "jobbed/dir"), "the job's step has not gone by");
      assert.equal(calls.filter((c) => c === "ans:q1").length, 1, "the parked step has not run again");

      g.get("q-holder").release();
      assert.equal((await ended(strut, "holder", holder)).status, "success");
      const done = await ended(strut, "jobbed", runId);
      assert.equal(done.status, "success");
      assert.deepEqual(calls.filter((c) => c === "after"), ["after"]);
    } finally {
      g.releaseAll();
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a woken run waiting for its job can be cancelled", async () => {
    const { strut, dir, waker, src, g } = await jobServer();
    try {
      const runId = await launch(strut, "jobbed", { job: "j-stop", input: { key: "s1", gate: "s-own" } });
      await waiting(strut, "jobbed", runId);
      const holder = await launch(strut, "holder", { job: "j-stop", input: { gate: "s-holder" } });
      for (let i = 0; i < 300 && !g.get("s-holder").started; i++) await sleep(10);
      src.answers.set("ans:s1", "yes");
      waker!.wake("jobbed", runId);
      for (let i = 0; i < 300 && !(await events(strut, "jobbed", runId)).some((e) => e.type === "run.resumed"); i++) await sleep(10);
      assert.equal((await strut.app.request(`/workflows/jobbed/runs/${runId}/cancel`, { method: "POST" })).status, 202);
      const done = await ended(strut, "jobbed", runId);
      assert.equal(done.status, "cancelled");
      // The holder never noticed.
      g.get("s-holder").release();
      assert.equal((await ended(strut, "holder", holder)).status, "success");
    } finally {
      g.releaseAll();
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("any durable resume holds the job again: a person's resume of a failed run", async () => {
    const { strut, dir, g, boom } = await jobServer();
    try {
      boom.on = true;
      const runId = await launch(strut, "fails-once", { job: "j-resume", input: { gate: "r1" } });
      assert.equal((await ended(strut, "fails-once", runId)).status, "error");
      assert.equal((await touch(strut, "j-resume")).status, "success", "a failed run holds nothing");

      boom.on = false;
      const res = await strut.app.request(`/workflows/fails-once/runs/${runId}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.ok(res.status < 300, await res.clone().text());
      for (let i = 0; i < 300 && !g.get("r1").started; i++) await sleep(10);
      assert.ok(g.get("r1").started);
      const log = await events(strut, "fails-once", runId);
      assert.ok(log.some((e) => e.type === "step.replayed" && e.path === "fails-once/dir"));
      assert.match((await touch(strut, "j-resume")).error?.message ?? "", /^job_busy:/);

      g.get("r1").release();
      assert.equal((await ended(strut, "fails-once", runId)).status, "success");
    } finally {
      g.releaseAll();
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
