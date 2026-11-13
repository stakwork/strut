import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type TaskErrorCode, type TasksService, type TaskSettled, type WorkerTask } from "./tasks.js";
import type { TaskListQuery } from "./task-store.js";
import { MemoryLedgerStore } from "../payments/ledger-memory.js";

/**
 * The review verdict (plans/human-steps.md §9.6, ruled §9.12 4 and 5): a
 * person marks one ANSWER ok or rejected, with why. One suite over the
 * SQLite file and the memory twin, through the service. The route, the
 * `staff/review` step and who reaches them are in src/apps/staff.test.ts.
 */

const T0 = Date.parse("2026-11-13T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const TYPE = "pet-match";
const MATCH = { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] };
const YES = { same: true };
const NO = { same: false };

const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

interface Rig {
  svc: TasksService;
  clock: number;
  heard: TaskSettled[];
  ledger: MemoryLedgerStore;
}

const IMPLS = ["SQLite", "memory"] as const;

function rigFor(impl: (typeof IMPLS)[number], dir: string): Rig {
  const rig: Rig = { svc: undefined as never, clock: T0, heard: [], ledger: new MemoryLedgerStore() };
  rig.svc = createTasks({
    open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
    ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
    now: () => rig.clock,
    random: () => 0.5,
    ledger: async () => rig.ledger,
    ledgerIfAny: async () => rig.ledger,
    principal: "client",
  });
  rig.svc.onSettle((s) => rig.heard.push(...s));
  return rig;
}

for (const impl of IMPLS) {
  describe(`the review verdict: ${impl}`, () => {
    let dir: string;
    let rig: Rig;
    const tasks = () => rig.svc.capability;
    const review = (o: Parameters<TasksService["review"]>[0]) => rig.svc.review(o);

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-task-review-"));
      rig = rigFor(impl, dir);
    });
    afterEach(async () => {
      await rig.svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    const typeWith = async (o: { paySats?: number; holdHours?: number; copies?: Record<string, unknown>; tests?: Record<string, unknown> } = {}, workers = ["ann", "bob", "cat"]) => {
      await tasks().setType(TYPE, { app: "workers", answer: MATCH, leaseSeconds: 600, withinHours: 48, ...o }, "staff");
      for (const w of workers) await tasks().grant(w, TYPE, "staff");
    };
    let n = 0;
    const ask = async (copies?: number) =>
      (await tasks().ensure({ type: TYPE, workflow: "pets", runId: "r1", path: `pets/match#${n++}`, show: { photo: "a.jpg" }, ...(copies ? { copies } : {}) })).task;
    /** `worker` takes the next task and answers it, a minute later. */
    const answer = async (worker: string, a: unknown = YES) => {
      const got = await tasks().next(worker);
      assert.ok(!("none" in got), `${worker} gets a task`);
      rig.clock += MIN;
      await tasks().submit(worker, { lease: (got as WorkerTask).lease, answer: a });
      return got as WorkerTask;
    };
    const leaseOf = async (task: string, worker: string) => (await tasks().task(task))!.leases.find((l) => l.worker === worker && l.status === "submitted")!;
    const ids = async (q: TaskListQuery) => (await tasks().list(q)).map((t) => t.id);

    it("one verdict per answer: given, read back on its lease, changed in place; the review filter is the queue", async () => {
      await typeWith();
      const t = await ask();
      const other = await ask();
      await answer("ann");
      assert.deepEqual(await ids({ review: "none" }), [t.id], "answered and not reviewed; the open one is not in the queue");
      const out = await review({ task: t.id, verdict: "ok", by: "ada" });
      assert.deepEqual([out.task, out.worker, out.review.verdict, out.review.by, out.review.at, out.review.final], [t.id, "ann", "ok", "ada", rig.clock, false]);
      assert.equal(out.review.until, (await leaseOf(t.id, "ann")).closed! + 72 * HOUR, "unpaid: the type's hold from when it was answered");
      assert.deepEqual(await ids({ review: "none" }), []);
      assert.deepEqual(await ids({ review: "ok" }), [t.id]);
      rig.clock += HOUR;
      await review({ task: t.id, verdict: "rejected", why: "a cat, not a dog", by: "bo" });
      const l = await leaseOf(t.id, "ann");
      assert.deepEqual([l.review?.verdict, l.review?.why, l.review?.by, l.review?.at], ["rejected", "a cat, not a dog", "bo", rig.clock], "one row, replaced");
      assert.deepEqual([await ids({ review: "ok" }), await ids({ review: "rejected" })], [[], [t.id]]);
      assert.deepEqual(await ids({ review: "rejected", by: "ann" }), [t.id]);
      assert.deepEqual(await ids({ review: "rejected", by: "bob" }), []);
      assert.equal((await tasks().task(other.id))!.leases.length, 0);
      // The worker's page reads their verdicts on their newest leases.
      const act = await tasks().activity("ann");
      assert.equal(act!.recent[0]!.lease.review?.verdict, "rejected");
    });

    it("a copies task's answers are reviewed apart; with several, the verdict says whose", async () => {
      await typeWith({ copies: { max: 3, agree: 2, onDisagree: "fail" } });
      const t = await ask(2);
      await answer("ann", YES);
      await answer("bob", NO);
      assert.equal((await tasks().task(t.id))!.status, "disputed");
      await assert.rejects(review({ task: t.id, verdict: "ok" }), refused("bad_request", /2 answers: say whose/));
      await assert.rejects(review({ task: t.id, worker: "cat", verdict: "ok" }), refused("no_answer", /cat gave no answer/));
      await review({ task: t.id, worker: "ann", verdict: "ok" });
      assert.deepEqual(await ids({ review: "none" }), [t.id], "bob's answer waits");
      await review({ task: t.id, worker: "bob", verdict: "rejected", why: "the other pet" });
      const view = (await tasks().task(t.id))!;
      assert.deepEqual(
        view.leases.map((l) => [l.worker, l.review?.verdict]),
        [
          ["ann", "ok"],
          ["bob", "rejected"],
        ],
      );
      assert.deepEqual([await ids({ review: "none" }), await ids({ review: "ok" }), await ids({ review: "rejected" })], [[], [t.id], [t.id]]);
      assert.deepEqual([await ids({ review: "rejected", by: "ann" }), await ids({ review: "ok", by: "ann" })], [[], [t.id]]);
    });

    it("only an answer to a real task: an open task has none, a test is graded, and a rejection says why", async () => {
      await typeWith({ tests: { qualify: 1, rate: 0, newRate: 0, window: 4, minGraded: 1, threshold: 0.5 } }, []);
      await rig.svc.tests.create({ type: TYPE, show: { photo: "t.jpg" }, expected: YES }, "staff");
      await tasks().grant("ann", TYPE, "staff");
      const t = await ask();
      await assert.rejects(review({ task: t.id, verdict: "ok" }), refused("no_answer", /has no answer yet/));
      await assert.rejects(review({ task: "nope", verdict: "ok" }), refused("unknown_task"));
      await assert.rejects(review({ task: t.id, verdict: "fine" as never }), refused("bad_request", /verdict is ok or rejected/));
      const test = await answer("ann"); // qualifying: the test first
      await rig.svc.grading();
      const instance = (await tasks().list({ test: true }))[0]!;
      assert.ok(instance.leases.some((l) => l.id === test.lease));
      await assert.rejects(review({ task: instance.id, verdict: "rejected", why: "x" }), refused("bad_request", /is a test: its answer is graded, not reviewed/));
      await answer("ann");
      await assert.rejects(review({ task: t.id, verdict: "rejected" }), refused("bad_request", /a rejection says why/));
      await assert.rejects(review({ task: t.id, verdict: "rejected", why: "   " }), refused("bad_request", /a rejection says why/));
      assert.deepEqual(await ids({ review: "none" }), [t.id], "the queue holds real tasks alone");
    });

    it("a verdict changes until the answer's hold ends, then it is final; a first verdict after the hold is final at once", async () => {
      await typeWith({ paySats: 5, holdHours: 24 });
      const t = await ask();
      await answer("ann");
      const releases = (await leaseOf(t.id, "ann")).earning!.releases;
      const first = await review({ task: t.id, verdict: "rejected", why: "blurry" });
      assert.equal(first.review.until, releases, "paid: the earning's hold");
      rig.clock = releases - 1;
      const changed = await review({ task: t.id, verdict: "ok" });
      assert.deepEqual([changed.review.verdict, changed.review.final], ["ok", false], "inside the hold it changes");
      rig.clock = releases;
      await assert.rejects(review({ task: t.id, verdict: "rejected", why: "blurry after all" }), refused("final", /final: the hold on ann's answer .* ended at .*its verdict \(ok\) can no longer change/));
      await assert.rejects(review({ task: t.id, verdict: "ok", why: "again" }), refused("final"), "the same verdict too");
      const kept = await leaseOf(t.id, "ann");
      assert.deepEqual([kept.review?.verdict, kept.review?.final], ["ok", true]);

      // An unpaid answer: the type's hold (72 h by default) from when it was answered.
      await tasks().setType(TYPE, { app: "workers", answer: MATCH, leaseSeconds: 600, withinHours: 480 }, "staff");
      const late = await ask();
      await answer("bob");
      const answered = (await leaseOf(late.id, "bob")).closed!;
      rig.clock = answered + 72 * HOUR;
      const out = await review({ task: late.id, verdict: "rejected", why: "seen late" });
      assert.deepEqual([out.review.until, out.review.final], [answered + 72 * HOUR, true], "given after the hold: final at once");
      await assert.rejects(review({ task: late.id, verdict: "ok" }), refused("final"));
    });

    it("a verdict changes nothing in the run: the task, its answer and what the step reads stay; no run is told", async () => {
      await typeWith({ copies: { max: 2, agree: 2 } });
      const t = await ask(2);
      await answer("ann");
      await answer("bob");
      const key = { type: TYPE, workflow: t.workflow, runId: t.runId, path: t.path };
      const before = await tasks().ensure(key);
      const heard = rig.heard.length;
      await review({ task: t.id, worker: "ann", verdict: "rejected", why: "wrong" });
      await review({ task: t.id, worker: "bob", verdict: "ok" });
      const after = await tasks().ensure(key);
      assert.deepEqual([after.created, after.task.status, after.task.answer, after.task.by, after.answers], [false, before.task.status, before.task.answer, before.task.by, before.answers]);
      assert.equal(rig.heard.length, heard, "onSettle heard nothing: no run wakes");
      assert.equal(after.task.status, "settled");
    });

    it("standing: a rejection counts as a failed test in the window and can revoke; ok takes it out; a revoke stays", async () => {
      await typeWith({ tests: { qualify: 0, rate: 1, newRate: 1, window: 4, minGraded: 3, threshold: 0.6 } }, ["ann"]);
      const real = [await ask(), await ask(), await ask()];
      await rig.svc.tests.create({ type: TYPE, show: { photo: "t.jpg" }, expected: YES }, "staff");
      await answer("ann"); // the test, at rate 1
      await rig.svc.grading();
      for (let i = 0; i < 3; i++) await answer("ann");
      const standing = async () => (await tasks().worker("ann"))!.standing[TYPE];
      assert.deepEqual(pick(await standing()), { graded: 1, passed: 1, rejected: 0 }, "the test passed; real answers count for nothing yet");
      await review({ task: real[0]!.id, verdict: "rejected", why: "wrong" });
      assert.deepEqual(pick(await standing()), { graded: 2, passed: 1, rejected: 1 }, "a fail in the window; under minGraded, nothing is decided");
      await review({ task: real[0]!.id, verdict: "ok" });
      assert.deepEqual(pick(await standing()), { graded: 1, passed: 1, rejected: 0 }, "ok takes it out");
      await review({ task: real[1]!.id, verdict: "ok" });
      assert.deepEqual(pick(await standing()), { graded: 1, passed: 1, rejected: 0 }, "ok is no pass: tests score workers");
      await review({ task: real[0]!.id, verdict: "rejected", why: "wrong" });
      await review({ task: real[2]!.id, verdict: "rejected", why: "wrong too" });
      const w = (await tasks().worker("ann"))!;
      const g = w.grants.find((x) => x.type === TYPE)!;
      assert.deepEqual([g.revokedBy, g.why], ["standing", `standing: passed 1 of the last 3 tests of ${TYPE} (2 of them answers rejected in review), under 60%`]);
      await review({ task: real[2]!.id, verdict: "ok" });
      assert.ok((await tasks().worker("ann"))!.grants.find((x) => x.type === TYPE)!.revokedAt !== undefined, "a revoke is an act: staff grant again");
    });

    it("a rejection on a type without tests moves no standing: there are no rules to read", async () => {
      await typeWith();
      const t = await ask();
      await answer("ann");
      await review({ task: t.id, verdict: "rejected", why: "wrong" });
      const w = (await tasks().worker("ann"))!;
      assert.deepEqual([w.standing, w.grants[0]!.revokedAt], [{}, undefined]);
    });
  });
}

const pick = (s: { graded: number; passed: number; rejected: number } | undefined) => (s ? { graded: s.graded, passed: s.passed, rejected: s.rejected } : s);

describe("the review verdict: a tasks.db from before reviews", () => {
  it("opens, gains the table and keeps its rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-task-review-old-"));
    try {
      let clock = T0;
      const make = () => createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)), now: () => clock });
      let svc = make();
      await svc.capability.setType(TYPE, { app: "workers", answer: MATCH }, "staff");
      await svc.capability.grant("ann", TYPE, "staff");
      const t = (await svc.capability.ensure({ type: TYPE, workflow: "pets", runId: "r1", path: "pets/match", show: {} })).task;
      const got = (await svc.capability.next("ann")) as WorkerTask;
      clock += MIN;
      await svc.capability.submit("ann", { lease: got.lease, answer: YES });
      await svc.close();
      // As a strut before this one left it: no `reviews` table.
      const db = new DatabaseSync(tasksPath(dir));
      db.exec("drop index if exists reviews_rejected; drop table reviews");
      db.close();
      svc = make();
      assert.equal((await svc.capability.task(t.id))!.status, "settled", "its rows kept");
      await svc.review({ task: t.id, verdict: "rejected", why: "wrong" });
      assert.equal((await svc.capability.task(t.id))!.leases[0]!.review?.verdict, "rejected");
      await svc.close();
      const again = new DatabaseSync(tasksPath(dir));
      assert.equal((again.prepare("select count(*) as n from reviews").get() as { n: number }).n, 1);
      again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
