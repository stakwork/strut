import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type TaskErrorCode, type TasksService, type TaskTypeInput, type WorkerTask } from "./tasks.js";
import { MemoryLedgerStore } from "../payments/ledger-memory.js";
import { RunController } from "../run-control.js";

/**
 * A task type that pays on ok (`payOn: "ok"`): an answer earns only once a
 * verdict says ok — staff's review, or the run that asked, through
 * `task/reply`'s `verdict` — so a photo the workflow refused, and then a
 * retake of it, are paid once between them, never twice. One suite over the
 * SQLite file and the memory twin, through the service.
 */

const T0 = Date.parse("2026-11-22T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const TYPE = "scan-page";
const WORKFLOW = "scan";
const PAGE = { type: "object", properties: { title: { type: "string" } } };
const SAT = 1000;

const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

interface Rig {
  svc: TasksService;
  clock: number;
  ledger: MemoryLedgerStore;
}

const IMPLS = ["SQLite", "memory"] as const;

function rigFor(impl: (typeof IMPLS)[number], dir: string): Rig {
  const rig: Rig = { svc: undefined as never, clock: T0, ledger: new MemoryLedgerStore() };
  rig.svc = createTasks({
    open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
    ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
    now: () => rig.clock,
    random: () => 0.5,
    ledger: async () => rig.ledger,
    ledgerIfAny: async () => rig.ledger,
    principal: "client",
  });
  return rig;
}

for (const impl of IMPLS) {
  describe(`a type that pays on ok: ${impl}`, () => {
    let dir: string;
    let rig: Rig;
    const tasks = () => rig.svc.capability;
    const run = new RunController("r1", WORKFLOW).forUnit();

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-pay-on-ok-"));
      rig = rigFor(impl, dir);
    });
    afterEach(async () => {
      await rig.svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    const typeWith = async (o: Partial<TaskTypeInput> = {}) => {
      await tasks().setType(TYPE, { app: "scanner", answer: PAGE, leaseSeconds: 600, withinHours: 48, open: false, paySats: 4, payOn: "ok", ...o }, "staff");
      for (const w of ["ann", "bob"]) await tasks().grant(w, TYPE, "staff");
    };
    let n = 0;
    const ask = async () => (await tasks().ensure({ type: TYPE, workflow: WORKFLOW, runId: "r1", path: `scan/ask#${n++}`, show: { ask: "the next page" } })).task;
    /** `worker` takes the next task and answers it, a minute later. */
    const answer = async (worker = "ann", title = "Dune") => {
      const got = await tasks().next(worker);
      assert.ok(!("none" in got), `${worker} gets a task`);
      rig.clock += MIN;
      await tasks().submit(worker, { lease: (got as WorkerTask).lease, answer: { title } });
      return got as WorkerTask;
    };
    /** The run that asked judges its task's answer (`task/reply`). */
    const judge = (task: string, verdict: "ok" | "rejected", why?: string) => tasks().reply({ task, verdict, ...(why ? { why } : {}) }, { control: run });
    const withdrawable = async (w = "ann") => (await rig.ledger.payeeBalance(w, { now: rig.clock })).withdrawableMsat;
    const pending = async (w = "ann") => (await tasks().me(w)).pendingMsat ?? 0;

    it("Tom's book: 4 photos, 2 refused by the run and retaken — 16 sats, not 24", async () => {
      await typeWith();
      const first = [await ask(), await ask(), await ask(), await ask()];
      for (let i = 0; i < 4; i++) await answer();
      assert.equal(await pending(), 16 * SAT, "4 answers wait for their ok");
      assert.equal(await withdrawable(), 0, "and nothing is earned yet");
      await judge(first[0]!.id, "ok");
      await judge(first[1]!.id, "ok");
      await judge(first[2]!.id, "rejected", "blurry: take it again");
      await judge(first[3]!.id, "rejected", "the page is cut off");
      assert.equal(await withdrawable(), 8 * SAT, "the two OK'd pages");
      assert.equal(await pending(), 0, "a rejected one waits for nothing");
      const retakes = [await ask(), await ask()];
      for (let i = 0; i < 2; i++) await answer();
      for (const t of retakes) await judge(t.id, "ok");
      assert.equal(await withdrawable(), 16 * SAT, "every page paid once");
      assert.equal((await rig.svc.sweep()).booked, 0, "the sweep books no rejected answer");
      assert.equal(await withdrawable(), 16 * SAT);
      const lease = (await tasks().task(first[2]!.id))!.leases[0]!;
      assert.deepEqual([lease.review?.verdict, lease.review?.by, lease.earning], ["rejected", `workflow:${WORKFLOW}`, undefined], "the run's verdict, by its workflow; nothing booked");
    });

    it("before its ok an answer is owed nothing: pending on the worker's page, left by the sweep; staff's ok books it from then", async () => {
      await typeWith();
      const t = await ask();
      const got = await answer();
      assert.equal(got.payOn, "ok", "the worker's task says it pays on ok");
      assert.equal(await rig.ledger.payOf((await tasks().task(t.id))!.leases[0]!.id), undefined, "not booked as it is answered");
      assert.equal((await rig.svc.sweep()).booked, 0, "nor by the sweep");
      const [item] = (await tasks().history("ann")).items;
      assert.deepEqual([item!.pending, item!.earned], [{ msat: 4 * SAT }, undefined], "the worker sees it waiting");
      assert.equal(await pending(), 4 * SAT);
      rig.clock += 5 * HOUR;
      const out = await rig.svc.review({ task: t.id, verdict: "ok", by: "ada" });
      assert.deepEqual([out.earning?.msat, out.earning?.at, out.earning?.releases], [4 * SAT, rig.clock, rig.clock], "earned at the ok, no hold");
      assert.equal(out.review.final, true, "paid and past its hold (none): final");
      const [after] = (await tasks().history("ann")).items;
      assert.deepEqual([after!.pending, after!.earned?.msat], [undefined, 4 * SAT]);
      assert.equal((await tasks().me("ann")).pendingMsat, undefined, "nothing waits");
      assert.equal(await withdrawable(), 4 * SAT);
    });

    it("a rejection moves no money, so it can change at any time: a later ok pays", async () => {
      await typeWith();
      const t = await ask();
      await answer();
      const no = await judge(t.id, "rejected", "blurry");
      assert.equal(no.task, t.id);
      const l = (await tasks().task(t.id))!.leases[0]!;
      assert.deepEqual([l.review?.until, l.review?.final, l.earning], [undefined, false, undefined], "no hold to end: never final");
      const [item] = (await tasks().history("ann")).items;
      assert.deepEqual([item!.pending, item!.earned, item!.review?.verdict], [undefined, undefined, "rejected"], "gone from pending; sent back");
      rig.clock += 1000 * HOUR;
      const yes = await rig.svc.review({ task: t.id, verdict: "ok", by: "ada" });
      assert.equal(yes.earning?.msat, 4 * SAT, "staff overrule the run, and it is paid");
      await assert.rejects(rig.svc.review({ task: t.id, verdict: "rejected", why: "after all" }), refused("final"), "paid with no hold: final");
    });

    it("with a hold, the ok starts it: a rejection inside takes the earning back, ok restores it", async () => {
      await typeWith({ holdHours: 24 });
      const t = await ask();
      await answer();
      rig.clock += HOUR;
      const ok = await judge(t.id, "ok");
      assert.equal(ok.task, t.id);
      const lease = (await tasks().task(t.id))!.leases[0]!;
      assert.deepEqual([lease.earning?.at, lease.earning?.releases, lease.review?.until], [rig.clock, rig.clock + 24 * HOUR, rig.clock + 24 * HOUR], "the hold runs from the ok");
      rig.clock += HOUR;
      const back = await rig.svc.review({ task: t.id, verdict: "rejected", why: "the wrong book", by: "ada" });
      assert.ok(back.earning?.takenBack, "taken back inside the hold");
      const again = await rig.svc.review({ task: t.id, verdict: "ok", by: "ada" });
      assert.equal(again.earning?.takenBack, undefined, "restored");
    });

    it("the run's verdict: on the task it asked, with why for a rejection; a reply may be a verdict alone", async () => {
      await typeWith();
      const t = await ask();
      await answer();
      await assert.rejects(judge(t.id, "rejected"), refused("bad_request", /a rejection says why/));
      await assert.rejects(tasks().reply({ task: t.id, why: "x" }, { control: run }), refused("bad_request", /why goes with a verdict/));
      await assert.rejects(tasks().reply({ task: t.id, verdict: "maybe" as never }, { control: run }), refused("bad_request", /verdict is ok or rejected/));
      await assert.rejects(tasks().reply({ task: t.id, verdict: "ok" }, { control: new RunController("r2", WORKFLOW).forUnit() }), refused("unknown_task"), "another run's task");
      await tasks().reply({ task: t.id, show: { title: "OK" }, group: "Dune", verdict: "ok" }, { control: run });
      const got = (await tasks().task(t.id))!;
      assert.deepEqual([got.reply?.show, got.group, got.leases[0]!.review?.verdict, got.leases[0]!.earning?.msat], [{ title: "OK" }, "Dune", "ok", 4 * SAT], "told, grouped and paid in one reply");
    });

    it("a test's answer earns by its grade, as a real one by its verdict: a pass is paid, a fail never", async () => {
      // Every task a test while real ones wait (rate 1), graded `equal`.
      await typeWith({ tests: { qualify: 0, rate: 1, newRate: 1, window: 20, minGraded: 10, threshold: 0.1 } });
      await ask();
      await ask();
      for (let i = 0; i < 2; i++) await rig.svc.tests.create({ type: TYPE, show: { ask: "a page" }, expected: { title: "Dune" } }, "staff");
      // `equal` grades in the queue as the answer lands; `grading()` waits for it.
      await answer("ann", "Dune");
      await rig.svc.grading();
      assert.deepEqual([await withdrawable(), await pending()], [4 * SAT, 0], "the pass is paid");
      await answer("ann", "Emma");
      await rig.svc.grading();
      assert.equal(await pending(), 0, "a fail waits for nothing");
      assert.equal(await withdrawable(), 4 * SAT, "the fail never");
      assert.equal(await pending(), 0);
      assert.equal((await rig.svc.sweep()).booked, 0);
    });

    it("saved and read in both stores; a bad value refused; null is back to paying as answered", async () => {
      await typeWith();
      assert.equal((await tasks().types()).find((k) => k.name === TYPE)?.payOn, "ok");
      await assert.rejects(typeWith({ payOn: "later" as never }), refused("bad_request", /payOn is "answer" or "ok"/));
      await typeWith({ payOn: null });
      assert.equal((await tasks().types()).find((k) => k.name === TYPE)?.payOn, undefined);
      await typeWith({ payOn: "answer" });
      assert.equal((await tasks().types()).find((k) => k.name === TYPE)?.payOn, undefined, "the default is never stored");
    });

    it("a type that pays as answered is as before: booked as answered, and the run's rejection inside the hold takes it back", async () => {
      await typeWith({ payOn: null, holdHours: 24 });
      const t = await ask();
      const got = await answer();
      assert.equal(got.payOn, undefined);
      assert.equal((await tasks().task(t.id))!.leases[0]!.earning?.msat, 4 * SAT, "booked as answered");
      assert.equal(await pending(), 0);
      await judge(t.id, "rejected", "a duplicate");
      assert.ok((await tasks().task(t.id))!.leases[0]!.earning?.takenBack, "taken back");
    });
  });
}
