import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type StandingTask, type TaskErrorCode, type TasksService, type WorkerTask } from "./tasks.js";
import { memoryTestFiles } from "./test-files.js";
import { standingTask } from "./standing.js";
import type { TaskRecord, TaskSettled } from "./task-store.js";
import { createStrut, type Strut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";

/**
 * Standing task types (plans/human-steps.md §5.7, item 9): a worker's ask
 * makes the task and their lease together, and the type's workflow runs only
 * once they answer — launched under the run id the pick-up chose, its first
 * step the `human` step that finds its task already answered. Nothing exists
 * before someone picks one up; a skip or a lease that runs out closes it with
 * no run. One suite over the SQLite file and the memory twin; a strut runs
 * one end to end below.
 */

const T0 = Date.parse("2026-11-16T12:00:00Z");
const LABEL = { type: "object", properties: { product: { type: "string" } }, required: ["product"] };
const SHOW = { ask: "Photograph a nutrition label" };
const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

for (const impl of ["SQLite", "memory"] as const) {
  describe(`standing task types: ${impl}`, () => {
    let dir: string;
    let svc: TasksService;
    let clock = T0;
    let runs = 0;
    /** What `deps.standing` answers, by workflow. */
    let workflows: Record<string, StandingTask | { problem: string }>;
    /** The runs launched, and how many launches to fail first. */
    let launched: TaskRecord[];
    let failLaunches = 0;
    let heard: TaskSettled[];
    const tasks = () => svc.capability;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-standing-"));
      clock = T0;
      runs = 0;
      workflows = { "label-flow": { path: "label-flow/photo", show: SHOW } };
      launched = [];
      failLaunches = 0;
      heard = [];
      svc = createTasks({
        open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
        ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
        now: () => clock,
        random: () => 0.999,
        testFiles: memoryTestFiles(),
        standing: async (_type, workflow) => workflows[workflow] ?? { problem: `no workflow ${workflow} here` },
        launch: async (t) => {
          if (failLaunches > 0) {
            failLaunches--;
            throw new Error("draining");
          }
          launched.push(t);
        },
        runId: () => `run-${++runs}`,
      });
      svc.onSettle((s) => heard.push(...s));
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    const labels = (more: Record<string, unknown> = {}) => tasks().setType("labels", { app: "labelers", answer: LABEL, paySats: 5, standing: { workflow: "label-flow" }, ...more }, "staff");
    const take = async (actor: string, o: { type?: string; app?: string } = { app: "labelers" }) => {
      const got = await tasks().next(actor, o);
      assert.ok(!("none" in got), `${actor} got nothing`);
      return got as WorkerTask;
    };
    const taskOf = async (lease: string) => (await tasks().list({ limit: 1000 })).find((t) => t.leases.some((l) => l.id === lease))!;

    it("a type is saved standing only when its workflow can be one; null turns it off", async () => {
      await assert.rejects(tasks().setType("labels", { app: "labelers", answer: LABEL, standing: { workflow: "missing" } }, "staff"), refused("bad_request", /^bad_request: standing: no workflow missing here$/));
      await assert.rejects(tasks().setType("labels", { app: "labelers", answer: LABEL, standing: { workflow: "" } }, "staff"), refused("bad_request", /standing is \{ workflow \}/));
      await assert.rejects(tasks().setType("labels", { app: "labelers", answer: LABEL, standing: { workflow: "label-flow", every: 1 } as never }, "staff"), refused("bad_request", /standing is \{ workflow \}/));
      assert.deepEqual(await tasks().types(), [], "nothing saved");
      assert.deepEqual((await labels()).standing, { workflow: "label-flow" });
      assert.deepEqual((await tasks().types())[0]!.standing, { workflow: "label-flow" }, "read back");
      assert.equal((await labels({ standing: null })).standing, undefined);
    });

    it("an ask makes the task and its lease together; several workers at once each get their own, and nothing waits unheld", async () => {
      await labels();
      assert.deepEqual((await tasks().me("ann")).types.map((t) => [t.name, t.standing, t.waiting]), [["labels", true, 0]], "work whenever they ask, though nothing waits");
      const ann = await take("ann");
      const bob = await take("bob");
      assert.deepEqual(ann.show, SHOW);
      assert.equal(ann.payMsat, 5000, "the pay stamped on the lease");
      const [a, b] = [await taskOf(ann.lease), await taskOf(bob.lease)];
      assert.notEqual(a.id, b.id);
      assert.deepEqual([a.workflow, a.path, a.runId, a.root, a.files, a.status, a.standing], ["label-flow", "label-flow/photo", "run-1", "run", [], "open", true]);
      assert.equal(b.runId, "run-2");
      assert.equal(a.due, T0 + 600_000, "it lives as long as its lease");
      // Asking again hands back the lease in hand, never a second task.
      assert.equal((await take("ann")).lease, ann.lease);
      assert.equal((await tasks().list({ type: "labels" })).length, 2);
      const q = (await tasks().stats({ type: "labels" })).types[0]!;
      assert.deepEqual([q.waiting, q.working], [0, 2]);
      assert.deepEqual(launched, [], "no run before an answer");
    });

    it("an answer settles it and launches its run once — no settle listener told — and a skip or a lease run out closes it with no run", async () => {
      await labels();
      const ann = await take("ann");
      assert.deepEqual(await tasks().submit("ann", { lease: ann.lease, answer: { product: "oat milk" } }), { ok: true });
      const done = await taskOf(ann.lease);
      assert.deepEqual([done.status, done.answer, done.by, done.launchedAt], ["settled", { product: "oat milk" }, "ann", T0]);
      assert.deepEqual(
        launched.map((t) => [t.id, t.workflow, t.runId, t.path]),
        [[done.id, "label-flow", "run-1", "label-flow/photo"]],
      );
      // The run's `human` step finds its task by key, answered.
      const found = await tasks().ensure({ type: "labels", workflow: "label-flow", runId: "run-1", path: "label-flow/photo", show: SHOW });
      assert.deepEqual([found.created, found.task.status, found.task.answer], [false, "settled", { product: "oat milk" }]);

      const bob = await take("bob");
      assert.deepEqual(await tasks().skip("bob", { lease: bob.lease, reason: "no label to hand" }), { ok: true });
      const skipped = await taskOf(bob.lease);
      assert.equal(skipped.status, "expired");
      const cat = await take("cat");
      clock += 601_000;
      await svc.sweep();
      assert.equal((await taskOf(cat.lease)).status, "expired");
      assert.deepEqual(heard, [], "no run waits on a standing task");
      assert.equal(launched.length, 1, "only the answer started a run");
      // Staff's numbers: an answer, a skip and a lost lease — no expired task.
      const week = (await tasks().stats({ type: "labels" })).types[0]!.windows.week;
      assert.deepEqual([week.answered, week.skipped, week.leasesLost, week.expired], [1, 1, 1, 0]);
      // Bob asks again and is handed a new one; the skipped one never comes back.
      const again = await take("bob");
      assert.notEqual((await taskOf(again.lease)).id, skipped.id);
    });

    it("a launch that fails is the sweep's, once", async () => {
      await labels();
      failLaunches = 1;
      const ann = await take("ann");
      assert.deepEqual(await tasks().submit("ann", { lease: ann.lease, answer: { product: "rye" } }), { ok: true }, "the worker's answer stands");
      assert.deepEqual(launched, []);
      assert.equal((await taskOf(ann.lease)).launchedAt, undefined);
      assert.equal((await svc.sweep()).launched, 1);
      assert.deepEqual(launched.map((t) => t.runId), ["run-1"]);
      assert.equal((await svc.sweep()).launched, 0);
      assert.equal(launched.length, 1);
    });

    it("a run's task comes before a pick-up; a workflow that can no longer be one hands out nothing", async () => {
      await labels();
      await tasks().setType("recheck", { app: "labelers", answer: LABEL }, "staff");
      const made = (await tasks().ensure({ type: "recheck", workflow: "w", runId: "r1", path: "w/ask" })).task;
      const ann = await take("ann");
      assert.equal((await taskOf(ann.lease)).id, made.id, "the waiting run's task first");
      await tasks().submit("ann", { lease: ann.lease, answer: { product: "x" } });
      assert.equal((await taskOf((await take("ann")).lease)).standing, true, "then a pick-up");
      workflows["label-flow"] = { problem: "workflow label-flow is off" };
      assert.deepEqual(await tasks().next("bob", { app: "labelers" }), { none: true });
      // Turned off, a standing type hands out nothing either.
      workflows["label-flow"] = { path: "label-flow/photo", show: SHOW };
      await labels({ enabled: false });
      assert.deepEqual(await tasks().next("cat", { app: "labelers" }), { none: true });
    });
  });
}

describe("standingTask: what a pick-up is read off its workflow", () => {
  const flow = (steps: Array<Record<string, unknown>>, o: { input?: { parse(v: unknown): unknown }; params?: Record<string, unknown> } = {}) =>
    ({ name: "label-flow", input: o.input ?? { parse: (v: unknown) => ({ note: "", ...(v as object) }) }, params: o.params, steps }) as never;
  const human = (config: Record<string, unknown>) => ({ id: "photo", type: "human", config: { task: "labels", ...config } });

  it("its first step's path and show, resolved with the input defaults and params", () => {
    assert.deepEqual(standingTask(flow([human({ show: { ask: "{{ params.ask }}", note: "{{ input.note }}" } }), { id: "read", type: "log", config: {} }], { params: { ask: "Photograph a label" } }), "labels"), {
      path: "label-flow/photo",
      show: { ask: "Photograph a label", note: "" },
    });
  });

  it("refuses a workflow that cannot be one, saying why", () => {
    const problem = (f: unknown) => (standingTask(f as never, "labels") as { problem?: string }).problem;
    assert.match(problem(flow([]))!, /has no steps/);
    assert.match(problem(flow([{ id: "first", type: "log", config: {} }, human({})]))!, /starts with first \(log\)/);
    assert.match(problem(flow([human({ task: "other" })]))!, /asks for task type "other", not labels/);
    assert.match(problem(flow([{ ...human({}), depends: ["x"] }]))!, /waits on x/);
    assert.match(problem(flow([human({ files: ["photo.jpg"] })]))!, /names files/);
    assert.match(problem(flow([human({ show: { guess: "{{ match.object }}" } })]))!, /shows match; a standing task's show reads only input and params/);
    assert.match(problem(flow([human({})], { input: { parse: () => { throw new Error("required"); } } }))!, /needs input it has no default for/);
  });
});

// ── on a strut ──────────────────────────────────────────────────────────────

const KEY = "standing-key";
const WORKFLOW = `name: label-flow
params:
  ask: Photograph a nutrition label
steps:
  - id: photo
    type: human
    config:
      task: labels
      show:
        ask: "{{ params.ask }}"
  - id: done
    type: pack
    config:
      product: "{{ photo.answer.product }}"
      by: "{{ photo.by }}"
`;

describe("a standing type on a strut: a pick-up, an answer, the run", () => {
  let root: string;
  let strut: Strut;
  const saved: Record<string, string | undefined> = {};
  before(() => {
    saved["STRUT_API_KEY"] = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
  });
  after(() => {
    if (saved["STRUT_API_KEY"] === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved["STRUT_API_KEY"];
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-standing-run-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      autoResume: false,
      stt: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      workersApp: false,
      jamie: false,
      knowledge: false,
      earnings: false,
      concepts: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
    });
  });
  afterEach(async () => {
    await strut.close();
    await rm(root, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const putType = (body: Record<string, unknown>) => strut.app.request("/tasks/types/labels", { method: "PUT", headers: auth, body: JSON.stringify({ app: "labelers", answer: LABEL, ...body }) });

  it("each answer launches the workflow, whose human step returns the answer at once; a workflow that cannot be one is refused at the save", async () => {
    const missing = await putType({ standing: { workflow: "label-flow" } });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /standing: no workflow label-flow here/);
    await strut.workspace.publishWorkflowByContent("label-flow", WORKFLOW);
    const put = await putType({ standing: { workflow: "label-flow" } });
    assert.equal(put.status, 200, await put.clone().text());

    const worker = strut.tasks.worker;
    const [ann, bob] = (await Promise.all([worker.next("ann", { app: "labelers" }), worker.next("bob", { app: "labelers" })])) as WorkerTask[];
    assert.deepEqual(ann!.show, { ask: "Photograph a nutrition label" });
    const byLease = async (lease: string) => (await strut.tasks.capability.list({ type: "labels", limit: 100 })).find((t) => t.leases.some((l) => l.id === lease))!;
    assert.notEqual((await byLease(ann!.lease)).id, (await byLease(bob!.lease)).id);
    assert.deepEqual(await strut.store.listRuns("label-flow"), [], "no run before an answer");

    await worker.submit("ann", { lease: ann!.lease, answer: { product: "oat milk" } });
    const task = await byLease(ann!.lease);
    const deadline = Date.now() + 8000;
    let summary = await strut.store.getRunSummary("label-flow", task.runId);
    while (summary?.status !== "success" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      summary = await strut.store.getRunSummary("label-flow", task.runId);
    }
    assert.equal(summary?.status, "success", JSON.stringify(summary));
    assert.deepEqual(summary!.output, { product: "oat milk", by: "ann" });
    const events = await strut.store.getRunEvents("label-flow", task.runId);
    assert.ok(!events.some((e) => e.type === "step.parked"), "the human step never parked");
    assert.notEqual((await byLease(ann!.lease)).launchedAt, undefined);

    // Bob walks away: his task closes, and no run is ever made for it.
    await worker.skip("bob", { lease: bob!.lease });
    assert.deepEqual(await strut.store.listRuns("label-flow"), [task.runId]);

    // The workflow changed so it cannot be one: the save refuses, and nothing is handed out.
    await strut.workspace.publishWorkflowByContent("label-flow", WORKFLOW.replace('ask: "{{ params.ask }}"', 'ask: "{{ $runId }}"'));
    const bad = await putType({ standing: { workflow: "label-flow" } });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /show reads only input and params/);
    assert.deepEqual(await worker.next("cat", { app: "labelers" }), { none: true });
  });

  it("where every run needs someone to bill: an ownerless workflow bills who published its active version; with nobody at all it is refused", async () => {
    const was = process.env["STRUT_MOTHERSHIP_REQUIRED"];
    process.env["STRUT_MOTHERSHIP_REQUIRED"] = "1";
    try {
      await strut.workspace.publishWorkflowByContent("label-flow", WORKFLOW);
      const nobody = await putType({ standing: { workflow: "label-flow" } });
      assert.equal(nobody.status, 400);
      assert.match(((await nobody.json()) as { error: string }).error, /nobody to bill/);

      const v2 = WORKFLOW.replace("Photograph a nutrition label", "Photograph the label");
      await strut.workspace.publishWorkflowByContent("label-flow", v2, undefined, undefined, undefined, { source: "agent", actor: "ada" });
      await strut.workspace.setWorkflowOwner("label-flow", null);
      assert.equal((await strut.workspace.getWorkflowMetadata("label-flow"))?.owner, undefined);
      const put = await putType({ standing: { workflow: "label-flow" } });
      assert.equal(put.status, 200, await put.clone().text());

      const ann = (await strut.tasks.worker.next("ann", { app: "labelers" })) as WorkerTask;
      await strut.tasks.worker.submit("ann", { lease: ann.lease, answer: { product: "rye" } });
      const runId = (await strut.tasks.capability.list({ type: "labels", limit: 10 })).find((t) => t.leases.some((l) => l.id === ann.lease))!.runId;
      let start;
      for (let i = 0; i < 800 && !start; i++) {
        start = (await strut.store.getRunEvents("label-flow", runId)).find((e) => e.type === "run.start");
        if (!start) await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(start?.["principal"], "ada", JSON.stringify(start));
    } finally {
      if (was === undefined) delete process.env["STRUT_MOTHERSHIP_REQUIRED"];
      else process.env["STRUT_MOTHERSHIP_REQUIRED"] = was;
    }
  });
});
