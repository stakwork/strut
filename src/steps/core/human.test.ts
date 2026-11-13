// The `human` step (plans/human-steps.md §3) and the task store as the
// `task` source of parked runs (§2.3, §4.3 rules 7–8; §13's 2a/2b rows): a
// run asks a person, waits outside memory, and goes on with the answer.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { defineStep, type RunSummary, type StepContext, type StepRegistry } from "../../core.js";
import type { StrutCapabilities } from "../../capabilities.js";
import { createStrut, type Strut } from "../../createStrut.js";
import { WorkspaceManager } from "../../workspace.js";
import { jobRoot } from "../../jobs.js";
import { createTasks, openTaskStores, tasksPath, type TaskView } from "../../tasks/tasks.js";
import { buildRegistryTools } from "./agent.js";
import human from "./human.js";
import pack from "./pack.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MATCH = { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] };
const TYPE = "pet-match";
const WORKER = "ann";

/** Writes files where the run's files go: the job's directory on a job run,
 *  else the run's artifacts. */
const writeStep = defineStep({
  type: "write-files",
  input: z.object({ paths: z.array(z.string()) }),
  output: z.any(),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    for (const p of cfg.paths) {
      if (ctx!.job) {
        const abs = join(jobRoot(ctx!.services.dataDir!, ctx!.job), p);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, "x");
      } else {
        await ctx!.services.artifacts!.write(ctx!.runId, p, "x");
      }
    }
    return cfg.paths;
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

async function makeServer(o: { dir?: string; steps?: Record<string, unknown> } = {}) {
  const dir = o.dir ?? join(tmpdir(), `strut-human-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const workspace = new WorkspaceManager(dir);
  const registry = { human, pack, "write-files": writeStep, ...(o.steps ?? {}) } as StepRegistry;
  const strut = await createStrut({ workspace, registry, serveUi: false, enableChat: false, scheduler: false, autoResume: false, wakeDelayMs: 0 });
  return { strut, workspace, dir };
}

/** The task type and a worker who may take it. */
async function staff(strut: Strut, o: { withinHours?: number } = {}) {
  const t = strut.tasks.capability;
  await t.setType(TYPE, { app: "workers", answer: MATCH, ...(o.withinHours === undefined ? {} : { withinHours: o.withinHours }) });
  await t.grant(WORKER, TYPE);
}

/** The worker takes the next task and answers it. */
async function answerNext(strut: Strut, answer: unknown) {
  const got = await strut.tasks.capability.next(WORKER, { type: TYPE });
  assert.ok(!("none" in got), "a task to take");
  await strut.tasks.capability.submit(WORKER, { lease: got.lease, answer });
  return got;
}

async function launch(strut: Strut, wf: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<string> {
  const res = await strut.app.request(`/workflows/${wf}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ input: {}, ...body }),
  });
  assert.equal(res.status, 202, await res.clone().text());
  return ((await res.json()) as { runId: string }).runId;
}

async function summaryWhen(strut: Strut, wf: string, runId: string, pred: (s: RunSummary) => boolean, ms = 5000): Promise<RunSummary> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await strut.store.getRunSummary(wf, runId);
    if (s && pred(s)) return s;
    if (Date.now() > deadline) throw new Error(`no summary matched (last: ${JSON.stringify(s?.status)})`);
    await sleep(10);
  }
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
const waiting = async (strut: Strut, wf: string, runId: string, pred: (s: RunSummary) => boolean = () => true) => {
  const s = await summaryWhen(strut, wf, runId, (x) => x.status === "waiting" && pred(x));
  await released(strut, wf, runId);
  return s;
};
const ended = async (strut: Strut, wf: string, runId: string) => {
  const s = await summaryWhen(strut, wf, runId, (x) => x.status !== "waiting");
  await released(strut, wf, runId);
  return s;
};
const tasksOf = (strut: Strut, runId: string): Promise<TaskView[]> => strut.tasks.capability.list({ runId });

describe("the human step", () => {
  it("a run asks a person: it parks on the task, a worker answers, and it wakes with the answer as the step's output", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("pets", "v1", {
        steps: [
          { id: "review", type: "human", config: { task: TYPE, show: { lost: "{{ input.lost }}" } } },
          { id: "done", type: "pack", config: { same: "{{ review.answer.same }}", by: "{{ review.by }}", task: "{{ review.task }}" } },
        ],
      });
      const runId = await launch(strut, "pets", { input: { lost: "rex.jpg" } });
      const s = await waiting(strut, "pets", runId);
      const [task] = await tasksOf(strut, runId);
      assert.ok(task);
      assert.deepEqual([task.workflow, task.path, task.status, task.root, task.show], ["pets", "pets/review", "open", "run", { lost: "rex.jpg" }]);
      assert.deepEqual(s.waitingOn, [`task:${task.id}`]);

      const got = await answerNext(strut, { same: true });
      assert.deepEqual(got.show, { lost: "rex.jpg" });
      const done = await ended(strut, "pets", runId);
      assert.equal(done.status, "success", JSON.stringify(done.error));
      assert.deepEqual(done.output, { same: true, by: WORKER, task: task.id });
      const log = await strut.store.getRunEvents("pets", runId);
      const end = log.filter((e) => e.type === "step.end" && e.path === "pets/review").at(-1);
      assert.deepEqual(end?.output, { answer: { same: true }, by: WORKER, task: task.id });
      assert.equal(log.find((e) => e.type === "run.resumed")?.woken, true);
      assert.equal((await tasksOf(strut, runId)).length, 1);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("one task per run and path: a wake before the answer parks again on the same task", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("again", "v1", { steps: [{ id: "ask", type: "human", config: { task: TYPE } }] });
      const runId = await launch(strut, "again");
      const first = await waiting(strut, "again", runId);
      // Woken by hand, unanswered: the step finds its task and parks on it.
      const res = await strut.app.request(`/workflows/again/runs/${runId}/resume`, { method: "POST" });
      assert.equal(res.status, 202, await res.clone().text());
      const second = await waiting(strut, "again", runId, (x) => x.finishedAt !== first.finishedAt);
      assert.deepEqual(second.waitingOn, first.waitingOn);
      assert.equal((await tasksOf(strut, runId)).length, 1);
      assert.equal((await strut.store.getRunEvents("again", runId)).filter((e) => e.type === "step.parked").length, 2);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a task nobody answers in time fails the step with task_expired: retry reads the same task, onError runs", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("late", "v1", {
        steps: [
          {
            id: "ask",
            type: "human",
            config: { task: TYPE, withinHours: 0.00005 },
            options: {
              retry: { max: 2, delayMs: 0 },
              onError: { id: "guess", type: "pack", config: { same: false, by: "model", why: "{{ $error.message }}" } },
            },
          },
        ],
      });
      const runId = await launch(strut, "late");
      await waiting(strut, "late", runId);
      await sleep(250);
      // The sweep (rule 8; every minute in the server) expires it, and the
      // expiry wakes the run.
      const swept = await strut.tasks.sweep();
      assert.equal(swept.expired.length, 1);
      const done = await ended(strut, "late", runId);
      assert.equal(done.status, "success", JSON.stringify(done.error));
      const out = done.output as { same: boolean; by: string; why: string };
      assert.equal(out.by, "model");
      assert.match(out.why, /^task_expired: nobody answered task \w+ \(pet-match\)/);
      const tasks = await tasksOf(strut, runId);
      assert.deepEqual(
        tasks.map((t) => t.status),
        ["expired"],
        "retry made no second task",
      );
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("without onError an expired task fails the run", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("late2", "v1", { steps: [{ id: "ask", type: "human", config: { task: TYPE, withinHours: 0.00005 } }] });
      const runId = await launch(strut, "late2");
      await waiting(strut, "late2", runId);
      await sleep(250);
      await strut.tasks.sweep();
      const done = await ended(strut, "late2", runId);
      assert.equal(done.status, "error");
      assert.match(done.error!.message, /^task_expired: /);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("files: paths and patterns under the run's artifacts, fixed when the task is made", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("docs", "v1", {
        steps: [
          { id: "write", type: "write-files", config: { paths: ["notes.txt", "photos/a.jpg", "photos/b.jpg", "photos/.hidden.jpg", "photos/c.png", "pages/1/scan.jpg", "pages/2/scan.jpg"] } },
          { id: "ask", type: "human", config: { task: TYPE, files: ["notes.txt", "photos/*.jpg", "pages/?/scan.jpg", "photos/a.jpg"] } },
        ],
      });
      const runId = await launch(strut, "docs");
      const first = await waiting(strut, "docs", runId);
      const [task] = await tasksOf(strut, runId);
      const files = ["notes.txt", "photos/a.jpg", "photos/b.jpg", "pages/1/scan.jpg", "pages/2/scan.jpg"];
      assert.deepEqual(task!.files, files);
      assert.equal(task!.root, "run");

      // A file written later does not join the list; one removed does not
      // fail the step when it runs again.
      const arts = await strut.services.artifacts!.dir(runId);
      await writeFile(join(arts, "photos", "z.jpg"), "late");
      await unlink(join(arts, "notes.txt"));
      const res = await strut.app.request(`/workflows/docs/runs/${runId}/resume`, { method: "POST" });
      assert.equal(res.status, 202);
      await waiting(strut, "docs", runId, (x) => x.finishedAt !== first.finishedAt);
      assert.deepEqual((await tasksOf(strut, runId)).map((t) => t.files), [files]);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("files on a job run are the job's directory's", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("jobdocs", "v1", {
        steps: [
          { id: "write", type: "write-files", config: { paths: ["scans/p1.png", "scans/p2.png"] } },
          { id: "ask", type: "human", config: { task: TYPE, files: ["scans/*"] } },
        ],
      });
      const runId = await launch(strut, "jobdocs", { job: "matter-7" });
      await waiting(strut, "jobdocs", runId);
      const [task] = await tasksOf(strut, runId);
      assert.deepEqual([task!.root, task!.job, task!.files], ["job", "matter-7", ["scans/p1.png", "scans/p2.png"]]);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a files path that does not exist, or a pattern that matches nothing, fails the step and makes no task", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      for (const [name, files, re] of [
        ["nofile", ["missing.jpg"], /^task_file_missing: "missing.jpg" is not a file under the run's artifacts/],
        ["nomatch", ["photos/*.png"], /^task_file_missing: no file under the run's artifacts matches "photos\/\*\.png"/],
        ["adir", ["photos"], /^task_file_missing: "photos" is not a file/],
      ] as const) {
        await workspace.publishWorkflow(name, "v1", {
          steps: [
            { id: "write", type: "write-files", config: { paths: ["photos/a.jpg"] } },
            { id: "ask", type: "human", config: { task: TYPE, files: [...files] } },
          ],
        });
        const runId = await launch(strut, name);
        const done = await ended(strut, name, runId);
        assert.equal(done.status, "error", name);
        assert.match(done.error!.message, re);
        assert.deepEqual(await tasksOf(strut, runId), [], `${name}: no task`);
      }
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a task type that is not there, or is off, fails the step", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await workspace.publishWorkflow("notype", "v1", { steps: [{ id: "ask", type: "human", config: { task: "nobody-made-it" } }] });
      const a = await ended(strut, "notype", await launch(strut, "notype"));
      assert.match(a.error!.message, /^unknown_type: /);
      await strut.tasks.capability.setType("off", { app: "workers", answer: MATCH, enabled: false });
      await workspace.publishWorkflow("offtype", "v1", { steps: [{ id: "ask", type: "human", config: { task: "off" } }] });
      const b = await ended(strut, "offtype", await launch(strut, "offtype"));
      assert.match(b.error!.message, /^type_disabled: /);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a foreach of human steps parks once, on every task, and finishes when all are answered", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("each", "v1", {
        steps: [
          {
            id: "pages",
            type: "foreach",
            config: { items: [1, 2, 3], concurrency: 3, body: { id: "page", type: "human", config: { task: TYPE, show: { page: "{{ $current }}" } } } },
          },
        ],
      });
      const runId = await launch(strut, "each");
      const first = await waiting(strut, "each", runId);
      const tasks = await tasksOf(strut, runId);
      assert.equal(tasks.length, 3);
      assert.deepEqual([...first.waitingOn!].sort(), tasks.map((t) => `task:${t.id}`).sort());
      assert.equal((await strut.store.getRunEvents("each", runId)).filter((e) => e.type === "run.waiting").length, 1, "one pass makes every task");

      // Each answer wakes the run; the open ones park again on their own tasks.
      for (let i = 0; i < 3; i++) {
        await answerNext(strut, { same: true });
        await sleep(20);
      }
      const done = await ended(strut, "each", runId);
      assert.equal(done.status, "success", JSON.stringify(done.error));
      const out = done.output as Array<{ answer: { same: boolean }; by: string; task: string }>;
      assert.equal(out.length, 3);
      assert.ok(out.every((o) => o.by === WORKER));
      assert.deepEqual(out.map((o) => o.task).sort(), tasks.map((t) => t.id).sort());
      assert.equal((await tasksOf(strut, runId)).length, 3, "no task made twice across the wakes");
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cancel of a waiting run cancels its task", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.publishWorkflow("stop", "v1", { steps: [{ id: "ask", type: "human", config: { task: TYPE } }] });
      const runId = await launch(strut, "stop");
      await waiting(strut, "stop", runId);
      const res = await strut.app.request(`/workflows/stop/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(res.status, 202);
      assert.equal((await strut.store.getRunSummary("stop", runId))?.status, "cancelled");
      assert.deepEqual((await tasksOf(strut, runId)).map((t) => t.status), ["cancelled"]);
      assert.deepEqual(await strut.tasks.capability.next(WORKER, { type: TYPE }), { none: true });
      await sleep(30);
      assert.equal((await strut.store.getRunSummary("stop", runId))?.status, "cancelled", "the cancel's settle wakes nothing");
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a run cancelled while live closes the tasks it left open", async () => {
    const gate = gateStep();
    const { strut, workspace, dir } = await makeServer({ steps: { gate: gate.def } });
    try {
      await staff(strut);
      await workspace.publishWorkflow("busy", "v1", {
        steps: [
          { id: "ask", type: "human", config: { task: TYPE }, depends: [] },
          { id: "slow", type: "gate", config: {}, depends: [] },
          // The cancel lands at the checkpoint before this step.
          { id: "then", type: "pack", config: { ok: true }, depends: ["slow"] },
        ],
      });
      const runId = await launch(strut, "busy");
      for (let i = 0; i < 200 && !((await tasksOf(strut, runId)).length && gate.started()); i++) await sleep(10);
      assert.equal((await tasksOf(strut, runId))[0]?.status, "open");
      const res = await strut.app.request(`/workflows/busy/runs/${runId}/cancel`, { method: "POST" });
      assert.equal(res.status, 202);
      gate.release();
      const done = await ended(strut, "busy", runId);
      assert.equal(done.status, "cancelled");
      assert.deepEqual((await tasksOf(strut, runId)).map((t) => t.status), ["cancelled"]);
    } finally {
      gate.release();
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a restart between the answer and the wake: the next boot wakes the run", async () => {
    const dir = join(tmpdir(), `strut-human-${randomUUID()}`);
    const one = await makeServer({ dir });
    let two: Awaited<ReturnType<typeof makeServer>> | undefined;
    try {
      await staff(one.strut);
      await one.workspace.publishWorkflow("survive", "v1", { steps: [{ id: "ask", type: "human", config: { task: TYPE } }] });
      const runId = await launch(one.strut, "survive");
      await waiting(one.strut, "survive", runId);
      await one.strut.close();

      // Answered while no strut runs: the store alone, as the worker's door
      // would on another process.
      const alone = createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)) });
      const got = await alone.capability.next(WORKER, { type: TYPE });
      assert.ok(!("none" in got));
      await alone.capability.submit(WORKER, { lease: got.lease, answer: { same: false } });
      await alone.close();

      two = await makeServer({ dir });
      const done = await ended(two.strut, "survive", runId);
      assert.equal(done.status, "success", JSON.stringify(done.error));
      const [task] = await tasksOf(two.strut, runId);
      assert.deepEqual(done.output, { answer: { same: false }, by: WORKER, task: task!.id });
    } finally {
      await two?.strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refused before any task is made: a single-step run and an agent's tool call", async () => {
    const { strut, dir } = await makeServer();
    try {
      await staff(strut);
      const res = await strut.app.request("/steps/human/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { task: TYPE } }),
      });
      const out = (await res.json()) as { runId: string; status: string; error?: { message: string } };
      assert.equal(out.status, "error");
      assert.match(out.error!.message, /^park_refused: a single-step run cannot wait/);

      const ctx = { runId: "agent-run", path: "flow/agent", workflow: "flow", scope: {}, input: undefined, emit: async () => {}, services: strut.services } as unknown as StepContext;
      const tools = buildRegistryTools(["human"], { human } as StepRegistry, ctx, (def) => def) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
      await assert.rejects(Object.values(tools)[0]!.execute({ task: TYPE }), /park_refused: an agent cannot wait in the middle of a turn/);

      assert.deepEqual(await strut.tasks.capability.list(), [], "no task made");
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refused before any task is made: a stranger's public run", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.createWorkflow("open-ask", "name: open-ask\ninput:\n  pet: { type: string, default: rex }\nsteps:\n  - id: ask\n    type: human\n    config:\n      task: pet-match\n");
      const put = await strut.app.request("/public-view", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnable: [{ kind: "workflow", name: "open-ask", dailyCapUsd: 5 }] }),
      });
      assert.equal(put.status, 200, await put.clone().text());
      const pub = await strut.app.request("/public/workflows/open-ask/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(pub.status, 202, await pub.clone().text());
      const { runId } = (await pub.json()) as { runId: string };
      const done = await ended(strut, "open-ask", runId);
      assert.equal(done.status, "error");
      assert.match(done.error!.message, /^park_refused: a public run cannot wait/);
      assert.deepEqual(await strut.tasks.capability.list(), []);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the human step on a peer's launch", () => {
  const PEER = "human-peer-key";
  let saved: string | undefined;
  before(() => {
    saved = process.env["STRUT_PEER_KEY"];
    process.env["STRUT_PEER_KEY"] = PEER;
  });
  after(() => {
    if (saved === undefined) delete process.env["STRUT_PEER_KEY"];
    else process.env["STRUT_PEER_KEY"] = saved;
  });

  it("refused before any task is made: a run another strut launched with no person's credential", async () => {
    const { strut, workspace, dir } = await makeServer();
    try {
      await staff(strut);
      await workspace.createWorkflow("peer-ask", "name: peer-ask\npeer: true\nsteps:\n  - id: ask\n    type: human\n    config:\n      task: pet-match\n");
      const runId = await launch(strut, "peer-ask", {}, { authorization: `Bearer ${PEER}` });
      const done = await ended(strut, "peer-ask", runId);
      assert.equal(done.status, "error");
      assert.match(done.error!.message, /^refused: a stranger's public run, a run another strut launched without a person's credential/);
      assert.deepEqual(await strut.tasks.capability.list(), []);
    } finally {
      await strut.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
