import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTasks, memoryTaskStores, openTaskStores, percentiles, tasksPath, TaskError, type TasksService, type TypeStats, type WorkerTask } from "./tasks.js";
import type { RunFile } from "../runs.js";

/**
 * The staff's reads (plans/human-steps.md §9.4, §9.11's "The stats" and
 * "The reads"): the queue computed on read, one worker's week and leases,
 * the tasks one worker answered, a task's file read without a lease — one
 * suite over the SQLite file and the memory twin, with a fixed clock.
 */

const T0 = Date.parse("2026-11-12T12:00:00Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const MATCH = { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] };

/** Every file a task names reads as its own path. */
const file = async (_t: unknown, path: string): Promise<RunFile> => ({ path, mediaType: "text/plain", bytes: path.length, text: `the file ${path}` });

const impls = [
  { name: "SQLite", make: (dir: string, now: () => number) => createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)), now, file }) },
  { name: "memory", make: (_dir: string, now: () => number) => createTasks({ open: async () => memoryTaskStores(), now, file }) },
];

for (const impl of impls) {
  describe(`the staff's reads: ${impl.name}`, () => {
    let dir: string;
    let clock: number;
    let svc: TasksService;
    const t = () => svc.capability;
    const row = async (type: string): Promise<TypeStats> => (await t().stats({ type })).types[0]!;
    const make = (type: string, runId: string, more: { withinHours?: number; copies?: number; files?: string[] } = {}) =>
      t().ensure({ type, workflow: "wf", runId, path: "ask", show: { runId }, ...more });
    const take = async (actor: string, type?: string) => (await t().next(actor, { ...(type ? { type } : {}) })) as WorkerTask;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-staff-reads-"));
      clock = T0;
      svc = impl.make(dir, () => clock);
      await t().setType("pets", { app: "workers", answer: MATCH, leaseSeconds: 600 });
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("waiting and being worked; a lease past its expiry is waiting and lost before the sweep marks it; due soon and the oldest", async () => {
      await t().grant("w1", "pets");
      await t().grant("w2", "pets");
      for (const r of ["r0", "r1", "r2"]) await make("pets", r);
      await make("pets", "soon", { withinHours: 0.5 });
      clock = T0 + 5 * MIN;
      let s = await row("pets");
      assert.deepEqual([s.waiting, s.working, s.oldest, s.dueSoon, s.dueHour, s.granted, s.holding], [4, 0, 5 * MIN, 1, 1, 2, 0]);
      assert.deepEqual([s.app, s.enabled], ["workers", true]);

      const a = await take("w1");
      s = await row("pets");
      assert.deepEqual([s.waiting, s.working, s.holding], [3, 1, 1]);
      assert.equal((await t().stats()).holding, 1, "across types");

      // Past its 10 minutes, with no sweep: waiting again, and lost.
      clock = T0 + 16 * MIN;
      s = await row("pets");
      assert.deepEqual([s.waiting, s.working, s.holding, s.windows.hour.leasesLost], [4, 0, 0, 1]);
      await svc.sweep();
      s = await row("pets");
      assert.deepEqual([s.waiting, s.windows.hour.leasesLost, s.windows.week.leasesLost], [4, 1, 1], "the sweep's mark counts once");

      // A skip, an answer, and a task past due before the sweep: expired at its due.
      const b = await take("w2");
      assert.notEqual(b.lease, a.lease);
      await t().skip("w2", { lease: b.lease });
      const c = await take("w1");
      clock = T0 + 18 * MIN;
      await t().submit("w1", { lease: c.lease, answer: { same: true } });
      clock = T0 + 31 * MIN;
      s = await row("pets");
      assert.deepEqual(
        [s.waiting, s.dueSoon, s.windows.hour.skipped, s.windows.hour.answered, s.windows.hour.expired],
        [2, 0, 1, 1, 1],
        "the task due at 30 min is expired, not waiting",
      );
      assert.deepEqual(s.windows.hour.toAnswer, { p50: 18 * MIN, p90: 18 * MIN });
      assert.deepEqual(s.windows.hour.work, { p50: 2 * MIN, p90: 2 * MIN });
    });

    it("each window's edges: an answer exactly an hour old is the hour's, a millisecond older the day's alone", async () => {
      await t().grant("w1", "pets");
      await make("pets", "r0");
      const a = await take("w1");
      await t().submit("w1", { lease: a.lease, answer: { same: false } });
      clock = T0 + HOUR;
      let s = await row("pets");
      assert.deepEqual([s.windows.hour.answered, s.windows.day.answered, s.windows.week.answered], [1, 1, 1]);
      clock = T0 + HOUR + 1;
      s = await row("pets");
      assert.deepEqual([s.windows.hour.answered, s.windows.day.answered, s.windows.week.answered], [0, 1, 1]);
      assert.equal(s.windows.hour.toAnswer, undefined, "no answer, no times");
      clock = T0 + 7 * 24 * HOUR + 1;
      s = await row("pets");
      assert.deepEqual([s.windows.day.answered, s.windows.week.answered], [0, 0]);
    });

    it("the medians: p50 and p90 by nearest rank over the answers in the window", async () => {
      await t().grant("w1", "pets");
      for (let k = 1; k <= 10; k++) await make("pets", `r${k}`);
      for (let k = 1; k <= 10; k++) {
        clock = T0 + k * MIN;
        const l = await take("w1");
        clock += k * 10 * SEC;
        await t().submit("w1", { lease: l.lease, answer: { same: true } });
      }
      const s = await row("pets");
      assert.deepEqual(s.windows.hour.work, { p50: 50 * SEC, p90: 90 * SEC });
      assert.deepEqual(s.windows.hour.toAnswer, { p50: 5 * MIN + 50 * SEC, p90: 9 * MIN + 90 * SEC });
      assert.deepEqual(percentiles([3, 1, 2]), { p50: 2, p90: 3 });
      assert.equal(percentiles([]), undefined);
    });

    it("asking while a task/next is held; the workers by status across types", async () => {
      await t().setType("boxes", { app: "workers", answer: MATCH });
      await t().grant("w3", "boxes");
      await t().me("w4");
      const held = t().next("w3", { type: "boxes", wait: 25 });
      await new Promise((r) => setTimeout(r, 20));
      const all = await t().stats();
      assert.equal(all.types.find((x) => x.type === "boxes")!.asking, 1);
      assert.equal(all.types.find((x) => x.type === "pets")!.asking, 0);
      assert.deepEqual([all.asking, all.workers.active, all.workers.new], [1, 1, 1]);
      // A task made wakes the held wait.
      await make("boxes", "b0");
      assert.ok("lease" in (await held));
      assert.equal((await t().stats()).asking, 0);
      await assert.rejects(() => t().stats({ type: "nope" }), (e: unknown) => e instanceof TaskError && e.code === "unknown_type");
    });

    it("the tasks one worker answered, a copy's included; their week by type and newest leases; their live lease on the list", async () => {
      await t().setType("pets", { app: "workers", answer: MATCH, copies: { max: 3, agree: 2 } });
      for (const w of ["w1", "w2"]) await t().grant(w, "pets");
      await make("pets", "two", { copies: 2 });
      await make("pets", "one");
      const a = await take("w1");
      const b = await take("w2");
      assert.equal(a.lease !== b.lease, true);
      await t().submit("w1", { lease: a.lease, answer: { same: true } });
      await t().submit("w2", { lease: b.lease, answer: { same: true } });
      const theirs = async (by: string) => (await t().list({ by })).map((x) => x.runId);
      assert.deepEqual(await theirs("w2"), ["two"], "w2 gave a copy: not the task's `by`, still theirs");
      assert.deepEqual(await theirs("w1"), ["two"]);
      const c = await take("w1");
      const workers = await t().workers();
      const w1 = workers.find((w) => w.actor === "w1")!;
      assert.deepEqual([w1.week, w1.holding], [1, "pets"]);
      assert.equal(workers.find((w) => w.actor === "w2")!.holding, undefined);

      clock = T0 + 20 * MIN; // c ran out
      const act = (await t().activity("w1"))!;
      assert.equal(act.holding, undefined, "a lease past its expiry is not held");
      assert.deepEqual(act.week, { pets: { answered: 1, skipped: 0, lost: 1 } });
      assert.deepEqual(act.recent.map((r) => [r.lease.id, r.task.runId]), [[c.lease, "one"], [a.lease, "two"]], "newest first, each with its task");
      assert.equal(await t().activity("nobody"), undefined);
    });

    it("a task's file read by staff without a lease, only a path on its list (not_listed otherwise)", async () => {
      const { task } = await make("pets", "f", { files: ["page-12.png"] });
      assert.equal((await t().taskFile(task.id, "page-12.png")).text, "the file page-12.png");
      await assert.rejects(() => t().taskFile(task.id, "page-13.png"), (e: unknown) => e instanceof TaskError && e.code === "not_listed");
      await assert.rejects(() => t().taskFile("nope", "page-12.png"), (e: unknown) => e instanceof TaskError && e.code === "unknown_task");
    });
  });
}
