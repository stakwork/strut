import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTasks,
  memoryTaskStores,
  openTaskStores,
  tasksPath,
  TaskError,
  type AgreedTask,
  type GradeCall,
  type GradeVerdict,
  type TaskErrorCode,
  type TasksService,
  type TaskSettled,
  type WorkerTask,
} from "./tasks.js";
import { decideCopies, groupsOf } from "./task-copies.js";
import { DEFAULT_COPIES_RULE } from "./tasks.js";
import { MemoryLedgerStore } from "../payments/ledger-memory.js";

/**
 * Copies (plans/human-steps.md §7.6, item 4b; §7.10's "Copies" list), as
 * tests: one suite over the SQLite file and the memory twin through the
 * service, then the decision's pure parts. The `human` step's side — its
 * output, `task_disputed:` and `onError` — is in src/steps/core/human.test.ts.
 */

const T0 = Date.parse("2026-11-13T12:00:00Z");
const MIN = 60_000;
const TYPE = "ballot-signature";
const LABEL = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
const A = { label: "a" };
const B = { label: "b" };
const C = { label: "c" };
const COMPARE = "test/compare";

const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

interface Rig {
  svc: TasksService;
  clock: number;
  /** Each step comparison, held until the test answers it. */
  compares: Array<{ call: GradeCall; resolve(v: GradeVerdict): void; reject(e: Error): void }>;
  heard: TaskSettled[];
  agreed: AgreedTask[];
  ledger: MemoryLedgerStore;
}

const IMPLS = ["SQLite", "memory"] as const;

function rigFor(impl: (typeof IMPLS)[number], dir: string, keep?: Rig): Rig {
  const rig: Rig = keep ?? { svc: undefined as never, clock: T0, compares: [], heard: [], agreed: [], ledger: new MemoryLedgerStore() };
  rig.svc = createTasks({
    open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
    ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
    now: () => rig.clock,
    graderProblem: (step) => (step === COMPARE ? undefined : `${step} is not sealed`),
    grade: (call) => new Promise((resolve, reject) => rig.compares.push({ call, resolve, reject })),
    ledger: async () => rig.ledger,
    ledgerIfAny: async () => rig.ledger,
    principal: "client",
  });
  rig.svc.onSettle((s) => rig.heard.push(...s));
  rig.svc.onAgreed((a) => rig.agreed.push(a));
  return rig;
}

for (const impl of IMPLS) {
  describe(`copies: ${impl}`, () => {
    let dir: string;
    let rig: Rig;
    const tasks = () => rig.svc.capability;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-task-copies-"));
      rig = rigFor(impl, dir);
    });
    afterEach(async () => {
      await rig.svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    /** The type with a copies rule (§7.8's defaults under `copies`), and its workers. */
    const typeWith = async (copies: Record<string, unknown> | null, o: { paySats?: number; workers?: string[] } = {}) => {
      await tasks().setType(TYPE, { app: "workers", answer: LABEL, leaseSeconds: 600, withinHours: 48, copies, ...(o.paySats ? { open: false, paySats: o.paySats } : {}) }, "staff");
      for (const w of o.workers ?? ["ann", "bob", "cat", "dan"]) await tasks().grant(w, TYPE, "staff");
    };
    let n = 0;
    const ask = async (copies?: number) =>
      (await tasks().ensure({ type: TYPE, workflow: "ballots", runId: "r1", path: `ballots/sign#${n++}`, show: { ballot: 1 }, ...(copies === undefined ? {} : { copies }) })).task;
    /** The step's view of the task: `ensure` again by its key. */
    const asStep = (t: { workflow: string; runId: string; path: string }) => tasks().ensure({ type: TYPE, workflow: t.workflow, runId: t.runId, path: t.path });
    const take = async (worker: string) => {
      const got = await tasks().next(worker);
      assert.ok(!("none" in got), `${worker} gets a task`);
      return got as WorkerTask;
    };
    /** `worker` takes the next task and answers it, a minute after the last. */
    const answer = async (worker: string, a: unknown) => {
      const got = await take(worker);
      rig.clock += MIN;
      await tasks().submit(worker, { lease: got.lease, answer: a });
      return got;
    };
    const none = async (worker: string, why: string) => assert.deepEqual(await tasks().next(worker), { none: true }, why);
    /** Until `n` step comparisons wait (they start after the answer's call returns). */
    const comparing = async (n: number) => {
      for (let i = 0; i < 200 && rig.compares.length < n; i++) await new Promise((r) => setImmediate(r));
      assert.equal(rig.compares.length, n, `${n} comparison(s) waiting`);
    };

    it("copies: 2 gives two leases to two workers, never two to one, and settles only when both answers are in", async () => {
      await typeWith({});
      const t = await ask(2);
      assert.equal(t.copies, 2);
      const a = await take("ann");
      assert.equal((await take("ann")).lease, a.lease, "asked again, ann has her own lease back, not a second");
      const b = await take("bob");
      assert.notEqual(b.lease, a.lease);
      await none("cat", "two live leases: the task wants no third");
      rig.clock += MIN;
      await tasks().submit("ann", { lease: a.lease, answer: A });
      assert.equal((await tasks().task(t.id))!.status, "open", "one answer of two: still open");
      assert.deepEqual(rig.heard, [], "no run wakes on the first");
      await none("ann", "never a second lease on the task to one worker");
      await none("cat", "one live, one submitted: still full");
      rig.clock += MIN;
      await tasks().submit("bob", { lease: b.lease, answer: A });
      const done = (await tasks().task(t.id))!;
      assert.deepEqual([done.status, done.answer, done.by], ["settled", A, "ann"]);
      assert.deepEqual(rig.heard.map((h) => [h.id, h.status]), [[t.id, "settled"]]);
      assert.deepEqual(done.leases.map((l) => [l.worker, l.status, l.answer, l.agrees]), [
        ["ann", "submitted", A, true],
        ["bob", "submitted", A, true],
      ]);
    });

    it("a lease that runs out frees its copy for another worker; a skip too", async () => {
      await typeWith({});
      const t = await ask(2);
      const a = await take("ann");
      await take("bob");
      await tasks().skip("bob", { lease: (await take("bob")).lease });
      const c = await take("cat");
      assert.notEqual(c.lease, a.lease);
      rig.clock += 11 * MIN;
      const d = await take("dan");
      const view = (await tasks().task(t.id))!;
      assert.equal(view.leases.find((l) => l.id === d.lease)?.task, t.id, "ann's and cat's ran out: dan takes a copy");
      assert.equal(view.leases.length, 4);
    });

    it("agreement settles with the first agreeing answer and its by; every answer comes back in the order given", async () => {
      await typeWith({});
      const t = await ask(3);
      await answer("ann", B);
      await answer("bob", A);
      assert.equal((await tasks().task(t.id))!.status, "open", "two of three: no decision yet, even with agree 2");
      await answer("cat", A);
      const step = await asStep(t);
      assert.deepEqual([step.task.status, step.task.answer, step.task.by], ["settled", A, "bob"]);
      assert.deepEqual(step.answers, [
        { answer: B, by: "ann", agrees: false },
        { answer: A, by: "bob", agrees: true },
        { answer: A, by: "cat", agrees: true },
      ]);
      assert.equal(rig.agreed.length, 1);
      assert.deepEqual(
        { ...rig.agreed[0]!, answers: rig.agreed[0]!.answers.map((x) => [x.worker, x.agrees]) },
        { task: t.id, type: TYPE, agreed: true, answers: [["ann", false], ["bob", true], ["cat", true]], at: T0 + 3 * MIN },
      );
    });

    it("disagreement with `more` asks one more worker; at max the task is disputed, and its run wakes", async () => {
      await typeWith({});
      const t = await ask(2);
      await answer("ann", A);
      await answer("bob", B);
      const more = (await tasks().task(t.id))!;
      assert.deepEqual([more.status, more.copies], ["open", 3], "one more copy");
      assert.deepEqual(rig.heard, []);
      assert.deepEqual(rig.agreed, [], "nothing decided yet");
      await answer("cat", C);
      const done = (await tasks().task(t.id))!;
      assert.deepEqual([done.status, done.copies, done.answer, done.by], ["disputed", 3, undefined, undefined]);
      assert.deepEqual(rig.heard.map((h) => h.status), ["disputed"]);
      assert.deepEqual(done.leases.map((l) => [l.worker, l.answer, l.agrees]), [
        ["ann", A, false],
        ["bob", B, false],
        ["cat", C, false],
      ], "the answers stay for staff");
      assert.deepEqual(rig.agreed.map((a) => [a.agreed, a.answers.map((x) => x.agrees)]), [[false, [false, false, false]]]);
      assert.equal((await asStep(t)).answers, undefined, "a disputed task hands the step no answers: it fails");
      assert.deepEqual((await tasks().list({ status: "disputed" })).map((x) => x.id), [t.id]);
      await none("dan", "a disputed task is closed");
    });

    it("the extra copy may settle it: the answers regrouped, the first agreeing one wins", async () => {
      await typeWith({});
      const t = await ask(2);
      await answer("ann", A);
      await answer("bob", B);
      await answer("cat", B);
      const step = await asStep(t);
      assert.deepEqual([step.task.status, step.task.answer, step.task.by, step.task.copies], ["settled", B, "bob", 3]);
      assert.deepEqual(step.answers!.map((x) => x.agrees), [false, true, true]);
    });

    it("`fail` disputes at once; agree 1 settles on the largest group", async () => {
      await typeWith({ onDisagree: "fail" });
      const t = await ask(2);
      await answer("ann", A);
      await answer("bob", B);
      assert.equal((await tasks().task(t.id))!.status, "disputed");
      await typeWith({ agree: 1 });
      const u = await ask(3);
      await answer("cat", A);
      await answer("dan", B);
      await tasks().grant("eve", TYPE, "staff");
      await answer("eve", B);
      assert.deepEqual([(await tasks().task(u.id))!.answer, (await tasks().task(u.id))!.by], [B, "dan"]);
    });

    it("a step comparator decides outside the transaction and hands out no lease meanwhile", async () => {
      await typeWith({ compare: { step: COMPARE, config: { strict: false } } });
      const t = await ask(2);
      await answer("ann", A);
      const got = await take("bob");
      rig.clock += MIN;
      // The worker hears `ok` before anything is compared.
      assert.deepEqual(await tasks().submit("bob", { lease: got.lease, answer: B }), { ok: true });
      await comparing(1);
      const call = rig.compares[0]!.call;
      assert.deepEqual([call.step, call.config, call.input, call.principal], [COMPARE, { strict: false }, { answer: B, expected: A, show: { ballot: 1 }, type: TYPE }, "client"]);
      assert.equal((await tasks().task(t.id))!.status, "open", "undecided while the step runs");
      await none("cat", "every copy answered: no lease meanwhile");
      rig.compares.shift()!.resolve({ supports: true, content: "the same signature" });
      await rig.svc.grading();
      const done = (await tasks().task(t.id))!;
      assert.deepEqual([done.status, done.answer, done.by], ["settled", A, "ann"]);
      assert.deepEqual(done.leases.map((l) => l.agrees), [true, true]);
      assert.deepEqual(rig.heard.map((h) => h.status), ["settled"]);
      assert.equal(rig.agreed.length, 1);
    });

    it("a step comparator that fails leaves the task undecided; the sweep decides it", async () => {
      await typeWith({ compare: { step: COMPARE } });
      const t = await ask(2);
      await answer("ann", A);
      await answer("bob", A);
      await comparing(1);
      rig.compares.shift()!.reject(new Error("the model is down"));
      const errors: unknown[] = [];
      const was = console.error;
      console.error = (...a: unknown[]) => void errors.push(a);
      try {
        await rig.svc.grading();
      } finally {
        console.error = was;
      }
      assert.equal(errors.length, 1, "logged");
      assert.equal((await tasks().task(t.id))!.status, "open");
      assert.equal((await rig.svc.sweep()).deciding, 1);
      await comparing(1);
      rig.compares.shift()!.resolve({ supports: false, content: "different" });
      await rig.svc.grading();
      const more = (await tasks().task(t.id))!;
      assert.deepEqual([more.status, more.copies], ["open", 3], "they did not match: one more worker");
      assert.equal((await rig.svc.sweep()).deciding, 0, "a task wanting an answer is not undecided");
    });

    if (impl === "SQLite") {
      it("a restart between the last answer and the decision is decided by the sweep", async () => {
        await typeWith({ compare: { step: COMPARE } });
        const t = await ask(2);
        await answer("ann", A);
        await answer("bob", B);
        await comparing(1);
        await rig.svc.close();
        rig.compares.length = 0;
        rig = rigFor(impl, dir, rig);
        assert.equal((await tasks().task(t.id))!.status, "open", "undecided on file");
        await none("cat", "and still no lease handed out");
        const swept = await rig.svc.sweep();
        assert.equal(swept.deciding, 1);
        await comparing(1);
        rig.compares.shift()!.resolve({ supports: true, content: "same" });
        await rig.svc.grading();
        assert.deepEqual([(await tasks().task(t.id))!.status, (await tasks().task(t.id))!.by], ["settled", "ann"]);
        assert.equal((await rig.svc.sweep()).deciding, 0, "once");
      });
    }

    it("a decision that lands after the task closed changes nothing", async () => {
      await typeWith({ compare: { step: COMPARE } });
      const t = await ask(2);
      await answer("ann", A);
      await answer("bob", A);
      await comparing(1);
      await rig.svc.cancelRun("ballots", "r1");
      rig.compares.shift()!.resolve({ supports: true, content: "same" });
      await rig.svc.grading();
      assert.equal((await tasks().task(t.id))!.status, "cancelled");
      assert.deepEqual(rig.agreed, []);
    });

    it("with copies: 1 the task is as built: one lease, settled by the answer, no answers on leases or for the step", async () => {
      await typeWith({});
      const t = await ask();
      assert.equal(t.copies, 1);
      const a = await take("ann");
      await none("bob", "one copy: one worker");
      rig.clock += MIN;
      await tasks().submit("ann", { lease: a.lease, answer: A });
      const step = await asStep(t);
      assert.deepEqual([step.task.status, step.task.answer, step.task.by, step.answers], ["settled", A, "ann", undefined]);
      const [lease] = (await tasks().task(t.id))!.leases;
      assert.deepEqual([lease!.answer, lease!.agrees], [undefined, undefined]);
      assert.deepEqual(rig.agreed, [], "onAgreed is for copies");
    });

    it("each copy books its own earning, and every copy keeps it, a disagreeing one too", async () => {
      await typeWith({}, { paySats: 21 });
      const t = await ask(2);
      await answer("ann", A);
      await answer("bob", B);
      await answer("cat", A);
      const rows = await rig.ledger.payFor([t.id]);
      assert.deepEqual(rows.map((r) => [r.worker, r.msat, r.takenBack]).sort(), [
        ["ann", 21_000, undefined],
        ["bob", 21_000, undefined],
        ["cat", 21_000, undefined],
      ]);
      const step = await asStep(t);
      assert.deepEqual(step.pay, { msat: 63_000 }, "the step's pay is every copy's");
      assert.deepEqual(step.answers!.map((x) => [x.by, x.agrees]), [["ann", true], ["bob", false], ["cat", true]]);
    });

    it("how many copies a step may ask is the type's: more than max, or more than one without a rule, makes no task", async () => {
      await typeWith(null);
      await assert.rejects(ask(2), refused("bad_request", /asks one worker a task/));
      await typeWith({ max: 2 });
      await assert.rejects(ask(3), refused("bad_request", /at most 2 workers/));
      await assert.rejects(ask(0), refused("bad_request", /copies is a whole number/));
      await assert.rejects(ask(1.5), refused("bad_request"));
      assert.deepEqual(await tasks().list(), [], "nothing made");
      assert.equal((await ask(2)).copies, 2);
    });

    it("a type's copies rule: §7.8's defaults, checked when saved, a comparator sealed", async () => {
      await typeWith({});
      assert.deepEqual((await tasks().types())[0]!.copies, { max: 3, agree: 2, compare: "equal", onDisagree: "more" });
      await assert.rejects(typeWith({ agree: 4 }), refused("bad_request", /copies\.agree/));
      await assert.rejects(typeWith({ max: 11 }), refused("bad_request", /copies\.max/));
      await assert.rejects(typeWith({ onDisagree: "ask" }), refused("bad_request", /onDisagree/));
      await assert.rejects(typeWith({ quorum: 2 }), refused("bad_request", /not a copies rule/));
      await assert.rejects(typeWith({ compare: { step: "not/sealed" } }), refused("bad_grader", /^bad_grader: copies\.compare: not\/sealed is not sealed/));
      await typeWith(null);
      assert.equal((await tasks().types())[0]!.copies, undefined, "null is off");
    });

    it("a test made from a disputed task needs its answer, and no worker who answered it is served it", async () => {
      await tasks().setType(TYPE, { app: "workers", answer: LABEL, copies: { onDisagree: "fail" }, tests: { qualify: 0, rate: 1, newRate: 1 } }, "staff");
      for (const w of ["ann", "bob", "cat"]) await tasks().grant(w, TYPE, "staff");
      const t = await ask(2);
      await answer("ann", A);
      await answer("bob", B);
      assert.equal((await tasks().task(t.id))!.status, "disputed");
      await assert.rejects(rig.svc.tests.fromTask(t.id), refused("bad_request", /say what is expected/));
      await rig.svc.tests.fromTask(t.id, { expected: A });
      await ask();
      for (const w of ["ann", "bob"]) {
        const got = await take(w);
        const view = (await tasks().list({ test: true })).find((x) => x.leases.some((l) => l.id === got.lease));
        assert.equal(view, undefined, `${w} answered the task the test was made from`);
        await tasks().skip(w, { lease: got.lease });
      }
      const got = await take("cat");
      assert.ok((await tasks().list({ test: true })).some((x) => x.leases.some((l) => l.id === got.lease)), "cat never saw it");
    });
  });
}

describe("deciding copies, pure (§7.6)", () => {
  const same = (xs: unknown[]) => groupsOf(xs.length, (i, j) => xs[i] === xs[j]);
  it("each answer joins the first earlier answer it matches", () => {
    assert.deepEqual(same(["a", "b", "a", "b", "c"]), [0, 1, 0, 1, 4]);
    // A comparator that is not transitive: 2 matches 1 only, so it joins 1's group.
    assert.deepEqual(groupsOf(3, (i, j) => (i === 1 && j === 0) || (i === 2 && j === 1)), [0, 0, 0]);
    assert.deepEqual(groupsOf(3, (i, j) => i === 2 && j === 1), [0, 1, 1]);
  });
  it("a group of agree settles with its first answer; two such groups, the larger, then the earlier", () => {
    const rule = { ...DEFAULT_COPIES_RULE };
    assert.deepEqual(decideCopies(same(["a", "b", "b"]), rule, 3), { outcome: "agreed", index: 1, agrees: [false, true, true] });
    assert.deepEqual(decideCopies(same(["a", "b", "b", "a"]), { ...rule, max: 4 }, 4), { outcome: "agreed", index: 0, agrees: [true, false, false, true] });
    assert.deepEqual(decideCopies(same(["a", "b", "b", "a", "b"]), { ...rule, max: 5 }, 5), { outcome: "agreed", index: 1, agrees: [false, true, true, false, true] });
  });
  it("otherwise more until max, then disputed; agree is at most the copies the task wants", () => {
    const rule = { ...DEFAULT_COPIES_RULE };
    assert.deepEqual(decideCopies(same(["a", "b"]), rule, 2), { outcome: "more" });
    assert.deepEqual(decideCopies(same(["a", "b", "c"]), rule, 3), { outcome: "disputed" });
    assert.deepEqual(decideCopies(same(["a", "b"]), { ...rule, onDisagree: "fail" }, 2), { outcome: "disputed" });
    assert.deepEqual(decideCopies(same(["a"]), { ...rule, agree: 3 }, 1), { outcome: "agreed", index: 0, agrees: [true] });
    assert.deepEqual(decideCopies(same(["a", "a"]), { ...rule, agree: 3 }, 2), { outcome: "agreed", index: 0, agrees: [true, true] });
  });
});
