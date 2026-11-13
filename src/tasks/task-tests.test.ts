import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  createTasks,
  memoryTaskStores,
  openTaskStores,
  tasksPath,
  TaskError,
  type GradeCall,
  type GradedTest,
  type GradeVerdict,
  type TaskErrorCode,
  type TaskRecord,
  type TasksService,
  type TaskSettled,
  type WorkerTask,
} from "./tasks.js";
import { dirTestFiles, memoryTestFiles, testFilesRoot } from "./test-files.js";
import { graderProblem, stepGrader } from "./grade-step.js";
import { revokeWhy, sameJson } from "./task-tests.js";
import { MemoryLedgerStore } from "../payments/ledger-memory.js";
import type { LedgerStore } from "../payments/ledger.js";
import { fileResult } from "../runs.js";
import { createStrut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, type RunEvent, type StepContext } from "../core.js";
import { WorkspaceManager } from "../workspace.js";
import { hostConfigFromEnv } from "../server.js";

/**
 * Tests, grading, standing and qualifying (plans/human-steps.md §7, item 4a;
 * §7.10's list), as tests: one suite over the SQLite file and the memory
 * twin through the service, then a strut, for what the grader's run, the
 * routes and an older file do.
 */

const T0 = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const TYPE = "pet-match";

const MATCH = { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] };
const YES = { same: true };
const NO = { same: false };
const GRADER = "test/grader";

const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

interface Rig {
  svc: TasksService;
  clock: number;
  /** What `random` answers next, in order; 0.999 once empty (no test drawn
   *  at a rate under 1, and the last of tied tests). */
  draws: number[];
  /** Each step grading, held until the test answers it. */
  grades: Array<{ call: GradeCall; resolve(v: GradeVerdict): void; reject(e: Error): void }>;
  /** The steps that may grade (sealed). */
  sealed: Set<string>;
  heard: TaskSettled[];
  graded: GradedTest[];
  /** A real task's files, `${runId}\0${path}`. */
  runFiles: Map<string, Uint8Array>;
  ledger: LedgerStore;
}

const IMPLS = ["SQLite", "memory"] as const;

/** A service over `dir`, its deps the test's to steer. */
function rigFor(impl: (typeof IMPLS)[number], dir: string, o: { principal?: string; rig?: Rig } = {}): Rig {
  const rig: Rig = o.rig ?? {
    svc: undefined as never,
    clock: T0,
    draws: [],
    grades: [],
    sealed: new Set([GRADER]),
    heard: [],
    graded: [],
    runFiles: new Map(),
    ledger: new MemoryLedgerStore(),
  };
  const testFiles = impl === "SQLite" ? dirTestFiles(testFilesRoot(dir)) : memoryTestFiles();
  const bytes = async (t: TaskRecord, path: string) => (t.root === "test" ? testFiles.read(t.test!, path) : (rig.runFiles.get(`${t.runId}\0${path}`) ?? null));
  rig.svc = createTasks({
    open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
    ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
    now: () => rig.clock,
    random: () => (rig.draws.length ? rig.draws.shift()! : 0.999),
    testFiles,
    bytes,
    // As createStrut reads them: one function for both roots.
    file: async (t, path) => {
      const b = await bytes(t, path);
      return b ? fileResult(path, b) : null;
    },
    graderProblem: (step) => (rig.sealed.has(step) ? undefined : `${step} is not sealed`),
    grade: (call) => new Promise((resolve, reject) => rig.grades.push({ call, resolve, reject })),
    ledger: async () => rig.ledger,
    ledgerIfAny: async () => rig.ledger,
    ...(o.principal ? { principal: o.principal } : {}),
  });
  rig.svc.onSettle((s) => rig.heard.push(...s));
  rig.svc.onGraded((g) => rig.graded.push(g));
  return rig;
}

for (const impl of IMPLS) {
  describe(`tests, grading, standing and qualifying: ${impl}`, () => {
    let dir: string;
    let rig: Rig;
    const tasks = () => rig.svc.capability;
    const tests = () => rig.svc.tests;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-task-tests-"));
      rig = rigFor(impl, dir, { principal: "client" });
    });
    afterEach(async () => {
      await rig.svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    /** The type with tests on (§7.8's defaults under `tests`). */
    const typeWith = (tests: Record<string, unknown>, o: { paySats?: number; answer?: unknown; by?: string } = {}) =>
      tasks().setType(TYPE, { app: "workers", answer: o.answer ?? MATCH, leaseSeconds: 600, withinHours: 48, tests, ...(o.paySats ? { paySats: o.paySats } : {}) }, o.by ?? "staff");
    let n = 0;
    /** `count` real tasks of one run. */
    const real = async (count = 1, o: { files?: string[] } = {}) => {
      const out = [];
      for (let i = 0; i < count; i++) out.push((await tasks().ensure({ type: TYPE, workflow: "pets", runId: "r1", path: `pets/review#${n++}`, show: { photo: "a.jpg" }, files: o.files ?? [] })).task);
      return out;
    };
    /** `count` ready tests expecting `expected`. */
    const ready = async (count = 1, expected: unknown = YES) => {
      const out = [];
      for (let i = 0; i < count; i++) out.push(await tests().create({ type: TYPE, show: { photo: "a.jpg" }, expected }, "staff"));
      return out;
    };
    const take = async (actor: string) => {
      const got = await tasks().next(actor);
      assert.ok(!("none" in got), `${actor} got nothing`);
      return got as WorkerTask;
    };
    /** The task behind a lease, as staff read it. */
    const behind = async (lease: string) => (await tasks().list({ limit: 1000 })).find((t) => t.leases.some((l) => l.id === lease))!;
    /** Grading is out of sight: waits for the grader to be asked `n` times. */
    const asked = async (n = 1) => {
      for (let i = 0; i < 500 && rig.grades.length < n; i++) await new Promise((r) => setImmediate(r));
    };
    /** Answers the step gradings asked for, in order, and waits until each
     *  is graded (heard by `onGraded`): others may still be held. */
    const verdicts = async (...vs: Array<GradeVerdict | Error>) => {
      const target = rig.graded.length + vs.length;
      for (const v of vs) {
        await asked();
        const g = rig.grades.shift();
        assert.ok(g, "a grading was asked for");
        if (v instanceof Error) g.reject(v);
        else g.resolve(v);
      }
      for (let i = 0; i < 1000 && rig.graded.length < target; i++) await new Promise((r) => setImmediate(r));
      assert.equal(rig.graded.length, target, "graded");
    };
    const pass = { supports: true, content: "matches" };
    const fail = { supports: false, content: "does not match" };
    const grantOf = async (actor: string) => (await tasks().worker(actor))!.grants.find((g) => g.type === TYPE)!;

    // ── what a page sees ────────────────────────────────────────────────

    it("a page's view of a test instance equals a real task's, field for field, its file included", async () => {
      await typeWith({ rate: 0.5, qualify: 0 });
      await tasks().grant("ann", TYPE);
      await tasks().grant("bob", TYPE);
      const [r1] = await real(2, { files: ["a.jpg"] });
      rig.runFiles.set(`r1\0a.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]));
      const t = await tests().create({ type: TYPE, show: { photo: "a.jpg" }, files: ["a.jpg"], expected: YES });
      assert.equal(t.ready, false);
      assert.deepEqual(t.missing, ["a.jpg"]);
      await tests().putFile(t.id, "a.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]));

      rig.draws.push(0.9); // ann: no test drawn
      const a = await take("ann");
      rig.draws.push(0.1, 0); // bob: a test, the first of the ties
      const b = await take("bob");
      assert.equal((await behind(a.lease)).id, r1!.id, "ann holds a real task");
      const instance = await behind(b.lease);
      assert.equal(instance.test, t.id, "bob holds the test's instance");
      assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), "the same fields");
      assert.deepEqual({ ...b, lease: "" }, { ...a, lease: "" }, "the same values: show, files, expiry, answer schema, pay");
      assert.deepEqual(await tasks().file("bob", { lease: b.lease, path: "a.jpg" }), await tasks().file("ann", { lease: a.lease, path: "a.jpg" }), "the same file");
      const wrong = async (actor: string, lease: string) => (await tasks().submit(actor, { lease, answer: { same: "yes" } }).catch((e: Error) => e.message)) as string;
      assert.equal(await wrong("bob", b.lease), await wrong("ann", a.lease), "the same refusal");
      assert.deepEqual(await tasks().submit("bob", { lease: b.lease, answer: YES }), await tasks().submit("ann", { lease: a.lease, answer: YES }));
    });

    it("skip and a lease's expiry behave alike; a dead instance closes and never reopens", async () => {
      await typeWith({ rate: 0.5, qualify: 0 });
      for (const w of ["ann", "bob", "carol"]) await tasks().grant(w, TYPE);
      await real(3);
      await ready(2);
      rig.draws.push(0.9);
      const a = await take("ann");
      rig.draws.push(0.1, 0);
      const b = await take("bob");
      assert.deepEqual(await tasks().skip("bob", { lease: b.lease, reason: "blurry" }), await tasks().skip("ann", { lease: a.lease, reason: "blurry" }));
      assert.equal((await behind(b.lease)).status, "expired", "a skipped instance closes at once");
      assert.equal((await behind(a.lease)).status, "open", "a skipped real task waits for someone else");

      rig.draws.push(0.9);
      const a2 = await take("ann");
      rig.draws.push(0.1, 0);
      const b2 = await take("bob");
      assert.notEqual((await behind(b2.lease)).test, undefined);
      rig.clock += 600 * 1000;
      const late = async (actor: string, lease: string) => (await tasks().submit(actor, { lease, answer: YES }).catch((e: Error) => e.message)) as string;
      assert.equal(await late("bob", b2.lease), await late("ann", a2.lease), "the same refusal once the lease ran out");
      await rig.svc.sweep();
      assert.equal((await behind(b2.lease)).status, "expired", "an instance whose lease died closes");
      assert.deepEqual(rig.heard, [], "no run hears an instance close");
      // take never hands out an instance: carol, drawing no test, is handed
      // real tasks, then nothing.
      for (;;) {
        const got = await tasks().next("carol");
        if ("none" in got) break;
        assert.equal((await behind(got.lease)).test, undefined, "a real task, never an instance");
        await tasks().submit("carol", { lease: got.lease, answer: YES });
      }
      assert.deepEqual((await tasks().list({ test: true })).map((t) => t.status), ["expired", "expired"]);
      assert.equal((await tasks().list({ test: false })).length, 3);
    });

    it("a worker is served one test once, and never a test made from a task they answered", async () => {
      await typeWith({ rate: 1, newRate: 1, qualify: 0 });
      for (const w of ["ann", "bob"]) await tasks().grant(w, TYPE);
      const [t1] = await real(1);
      const first = await take("ann");
      assert.equal((await behind(first.lease)).id, t1!.id, "no test yet: the real task");
      await tasks().submit("ann", { lease: first.lease, answer: YES });
      const made = await tests().fromTask(t1!.id, {}, "staff");
      assert.deepEqual([made.fromTask, made.fromWorker, made.expected, made.ready], [t1!.id, "ann", YES, true], "its accepted answer expected");
      await real(2);

      rig.draws.push(0);
      const a = await take("ann");
      assert.equal((await behind(a.lease)).test, undefined, "ann answered the task the test was made from: she is never served it");
      rig.draws.push(0, 0);
      const b = await take("bob");
      assert.equal((await behind(b.lease)).test, made.id);
      await tasks().skip("bob", { lease: b.lease });
      rig.draws.push(0, 0);
      const b2 = await take("bob");
      assert.equal((await behind(b2.lease)).test, undefined, "served once, even skipped");
      assert.equal((await tests().list())[0]!.served, 1);
    });

    // ── the draw (§7.2) ─────────────────────────────────────────────────

    it("with random fixed: a test replaces a real task only when one was takeable, never into an empty queue; newRate gives way to rate after newTasks", async () => {
      await typeWith({ rate: 0.1, newRate: 0.5, newTasks: 2, qualify: 0 });
      await tasks().grant("ann", TYPE);
      await ready(3);
      rig.draws.push(0);
      assert.deepEqual(await tasks().next("ann"), { none: true }, "no real task: no test");
      assert.deepEqual(rig.draws, [0], "and nothing was drawn");
      rig.draws.length = 0;
      await real(5);
      const kinds: string[] = [];
      const step = async (draws: number[]) => {
        rig.draws.push(...draws);
        const got = await take("ann");
        const t = await behind(got.lease);
        kinds.push(t.test ? "test" : "real");
        await tasks().submit("ann", { lease: got.lease, answer: YES });
      };
      await step([0.4, 0]); // 0.4 < newRate: a test
      await step([0.6]); // a real task
      await step([0.6]); // a real task: two answered, newTasks reached
      await step([0.4]); // 0.4 ≥ rate: a real task now
      await step([0.05, 0]); // 0.05 < rate: a test
      assert.deepEqual(kinds, ["test", "real", "real", "real", "test"]);
      await rig.svc.grading();
    });

    // ── answering a test (§7.3, §7.9) ───────────────────────────────────

    it("answering a test wakes no run; it earns as a real answer does, a fail inside the hold takes it back, a pass keeps it, an error does nothing", async () => {
      await typeWith({ rate: 0.5, qualify: 0, grade: { step: GRADER } }, { paySats: 21 });
      for (const w of ["ann", "bob"]) await tasks().grant(w, TYPE);
      await real(3);
      await ready(3);
      rig.draws.push(0.9);
      const a = await take("ann");
      await tasks().submit("ann", { lease: a.lease, answer: YES });
      assert.equal(rig.heard.length, 1, "a real answer is heard: its run wakes");

      rig.draws.push(0.1, 0);
      const b = await take("bob");
      assert.equal(b.payMsat, a.payMsat, "the same pay, locked the same way");
      await tasks().submit("bob", { lease: b.lease, answer: NO });
      assert.equal(rig.heard.length, 1, "a test's answer is not: no run waits on it");
      await asked();
      assert.deepEqual((await tasks().me("bob")).balance, (await tasks().me("ann")).balance, "held alike until it is graded");
      assert.equal(rig.grades[0]!.call.principal, "client", "a step grader is billed to the grading principal");
      assert.deepEqual(rig.grades[0]!.call.input, { answer: NO, expected: YES, show: { photo: "a.jpg" }, type: TYPE });
      await verdicts(fail);
      assert.equal((await tasks().me("bob")).balance.totalMsat, 0, "a fail inside the hold took it back");
      const instance = await behind(b.lease);
      assert.deepEqual([instance.grade, instance.leases[0]!.earning?.takenBackBy], ["fail", "grading"]);

      rig.draws.push(0.1, 0);
      const b2 = await take("bob");
      await tasks().submit("bob", { lease: b2.lease, answer: YES });
      await verdicts(pass);
      rig.draws.push(0.1, 0);
      const b3 = await take("bob");
      await tasks().submit("bob", { lease: b3.lease, answer: YES });
      await verdicts(new Error("the provider is down"));
      assert.equal((await tasks().me("bob")).balance.totalMsat, 2 * 21_000, "a pass and an error keep what they earned");
      assert.deepEqual(
        rig.graded.map((g) => [g.result, g.worker, g.type, g.lease === b.lease || g.lease === b2.lease || g.lease === b3.lease]),
        [
          ["fail", "bob", TYPE, true],
          ["pass", "bob", TYPE, true],
          ["error", "bob", TYPE, true],
        ],
      );
      const g = rig.graded[0]!;
      assert.equal(g.task, instance.id);
      assert.equal(g.answeredAt, instance.settledAt);
      assert.equal(rig.heard.length, 1, "still nothing woken");
    });

    // ── qualifying (§7.5) ───────────────────────────────────────────────

    it("qualifying serves only tests, then nothing until they are graded; passing opens real tasks, failing revokes with its reason", async () => {
      await typeWith({ qualify: 2, window: 4, minGraded: 2, threshold: 0.5, grade: { step: GRADER } });
      await ready(3);
      await real(1);
      const granted = await tasks().grant("ann", TYPE, "staff");
      assert.equal(granted.grants[0]!.qualify, 2, "the grant records K");
      assert.equal(granted.notice, undefined);
      assert.deepEqual((await tasks().me("ann")).types.map((t) => t.qualifying), [true], "ruling 3: told, with no score");

      for (let i = 0; i < 2; i++) {
        const got = await take("ann");
        assert.notEqual((await behind(got.lease)).test, undefined, "a test, though a real task waits");
        await tasks().submit("ann", { lease: got.lease, answer: YES });
      }
      assert.deepEqual(await tasks().next("ann"), { none: true }, "K answered, not graded: nothing of the type");
      await verdicts(pass, pass);
      assert.deepEqual((await tasks().me("ann")).types.map((t) => t.qualifying), [false]);
      assert.equal((await behind((await take("ann")).lease)).test, undefined, "qualified: the real task");

      await tasks().grant("bob", TYPE, "staff");
      for (let i = 0; i < 2; i++) {
        const got = await take("bob");
        await tasks().submit("bob", { lease: got.lease, answer: NO });
      }
      await verdicts(fail, fail);
      const lost = await grantOf("bob");
      assert.deepEqual([lost.revokedBy, lost.why], ["standing", `qualifying: passed 0 of 2 tests of ${TYPE}, under 50%`]);
      assert.deepEqual((await tasks().me("bob")).types, []);
    });

    it("an error while qualifying counts for nothing, so another test takes its place; too few ready tests means no qualifying, and the grant says so", async () => {
      await typeWith({ qualify: 2, window: 4, minGraded: 2, threshold: 0.5, grade: { step: GRADER } });
      await ready(3);
      await real(1);
      await tasks().grant("carol", TYPE);
      const got = await take("carol");
      await tasks().submit("carol", { lease: got.lease, answer: YES });
      await verdicts(new Error("timeout"));
      for (let i = 0; i < 2; i++) {
        const t = await take("carol");
        assert.notEqual((await behind(t.lease)).test, undefined);
        await tasks().submit("carol", { lease: t.lease, answer: YES });
      }
      await verdicts(pass, pass);
      const standing = (await tasks().worker("carol"))!.standing[TYPE]!;
      assert.deepEqual([standing.qualifying, standing.graded, standing.passed, standing.errors, standing.pending], [false, 2, 2, 1, 0]);

      await typeWith({ qualify: 5, window: 10, grade: { step: GRADER } });
      const short = await tasks().grant("dave", TYPE);
      assert.equal(short.grants[0]!.qualify, 0);
      assert.match(short.notice!, /3 ready tests, fewer than the 5/);
      assert.equal((await tasks().me("dave")).types[0]!.qualifying, false);
    });

    // ── standing (§7.5) ─────────────────────────────────────────────────

    it("standing under the threshold revokes with revokedBy standing and the window in why, and expires the live lease; error grades never move it", async () => {
      await typeWith({ qualify: 0, rate: 1, newRate: 1, window: 4, minGraded: 3, threshold: 0.75, grade: { step: GRADER } });
      for (const w of ["ann", "bob"]) await tasks().grant(w, TYPE);
      await ready(6);
      await real(4);
      for (let i = 0; i < 3; i++) {
        const t = await take("ann");
        await tasks().submit("ann", { lease: t.lease, answer: YES });
      }
      await verdicts(pass, pass);
      const holding = await take("ann");
      await verdicts(fail);
      const lost = await grantOf("ann");
      assert.deepEqual([lost.revokedBy, lost.why], ["standing", `standing: passed 2 of the last 3 tests of ${TYPE}, under 75%`]);
      await assert.rejects(tasks().submit("ann", { lease: holding.lease, answer: YES }), refused("not_granted"));
      assert.equal((await behind(holding.lease)).leases.find((l) => l.id === holding.lease)!.status, "expired", "the live lease expired at once");

      for (let i = 0; i < 4; i++) {
        const t = await take("bob");
        await tasks().submit("bob", { lease: t.lease, answer: YES });
        await verdicts(new Error("the provider is down"));
      }
      const bob = (await tasks().worker("bob"))!;
      assert.equal(bob.grants[0]!.revokedAt, undefined, "errors never revoke");
      assert.deepEqual([bob.standing[TYPE]!.graded, bob.standing[TYPE]!.errors], [0, 4]);
    });

    it("a re-grant starts an empty window and qualifies again, unless qualify: false; a grant already live stays as it is", async () => {
      await typeWith({ qualify: 2, rate: 0.6, newRate: 0.6, window: 4, minGraded: 2, threshold: 0.5, grade: { step: GRADER } });
      await ready(6);
      await real(2);
      await tasks().grant("ann", TYPE, "staff", { qualify: false });
      assert.equal((await grantOf("ann")).qualify, 0, "staff know her");
      rig.draws.push(0.9);
      const first = await take("ann");
      assert.equal((await behind(first.lease)).test, undefined, "no qualifying: a real task");
      await tasks().submit("ann", { lease: first.lease, answer: YES });
      await tasks().grant("ann", TYPE, "staff");
      assert.equal((await grantOf("ann")).qualify, 0, "a live grant stays as it is");
      for (let i = 0; i < 2; i++) {
        rig.draws.push(0.5, 0);
        const t = await take("ann");
        await tasks().submit("ann", { lease: t.lease, answer: NO });
      }
      await verdicts(fail, fail);
      const revoked = await grantOf("ann");
      assert.match(revoked.why!, /^standing: passed 0 of the last 2/);

      rig.clock += MIN;
      await tasks().grant("ann", TYPE, "staff");
      const again = await grantOf("ann");
      assert.deepEqual([again.at, again.qualify, again.revokedAt], [rig.clock, 2, undefined]);
      const standing = (await tasks().worker("ann"))!.standing[TYPE]!;
      assert.deepEqual([standing.qualifying, standing.graded, standing.passed], [true, 0, 0], "the old grades count for nothing");
      assert.equal((await tests().get((await tests().list())[0]!.id))!.instances.length >= 0, true);

      await tasks().revoke("ann", TYPE, { by: "staff", why: "test" });
      rig.clock += MIN;
      await tasks().grant("ann", TYPE, "staff", { qualify: false });
      assert.equal((await grantOf("ann")).qualify, 0);
      assert.equal((await tasks().me("ann")).types[0]!.qualifying, false);
    });

    // ── graders (§7.4) ──────────────────────────────────────────────────

    it("a grader that throws, is no longer sealed or has nobody to bill records error; equal compares as JSON", async () => {
      await typeWith({ qualify: 0, rate: 1, newRate: 1, grade: { step: GRADER } }, { by: undefined as never });
      await tasks().grant("bob", TYPE);
      await ready(3);
      await real(1);
      const t1 = await take("bob");
      await tasks().submit("bob", { lease: t1.lease, answer: YES });
      await verdicts(new Error("boom"));
      const t2 = await take("bob");
      rig.sealed.delete(GRADER);
      await tasks().submit("bob", { lease: t2.lease, answer: YES });
      await rig.svc.grading();
      assert.equal(rig.grades.length, 0, "an unsealed grader never runs");
      const notes = async (lease: string) => {
        const t = await behind(lease);
        return (await tests().get(t.test!))!.instances[0]!;
      };
      assert.deepEqual([(await notes(t1.lease)).grade, (await notes(t1.lease)).note], ["error", "boom"]);
      assert.deepEqual([(await notes(t2.lease)).grade, (await notes(t2.lease)).note], ["error", `${GRADER} is not sealed`]);

      // No principal, and a type saved with no admin: nobody to bill.
      await rig.svc.close();
      rig = rigFor(impl, await mkdtemp(join(tmpdir(), "strut-task-tests-")), {});
      await tasks().setType(TYPE, { app: "workers", answer: MATCH, tests: { qualify: 0, rate: 1, newRate: 1, grade: { step: GRADER } } });
      await tasks().grant("bob", TYPE);
      await ready(1);
      await real(1);
      const t3 = await take("bob");
      await tasks().submit("bob", { lease: t3.lease, answer: YES });
      await rig.svc.grading();
      assert.equal(rig.grades.length, 0);
      assert.match((await notes(t3.lease)).note!, /^nobody to bill/);

      assert.ok(sameJson({ a: [1, { b: 2 }], c: "x" }, { c: "x", a: [1, { b: 2.0 }] }), "keys in any order, numbers by value");
      assert.ok(!sameJson([1, 2], [2, 1]), "arrays in order");
      assert.ok(!sameJson({ a: 1 }, { a: 1, b: 2 }));
    });

    it("a type or a test naming an unsealed grader is refused when saved", async () => {
      await assert.rejects(typeWith({ grade: { step: "x/open" } }), refused("bad_grader", /x\/open is not sealed/));
      await assert.rejects(typeWith({ grade: "close enough" }), refused("bad_request"));
      await assert.rejects(typeWith({ qualify: 30 }), refused("bad_request", /qualify/), "K is at most the window");
      await assert.rejects(typeWith({ treshold: 0.5 }), refused("bad_request", /not a test rule/));
      const kind = await typeWith({});
      assert.deepEqual(kind.tests, { rate: 0.05, newRate: 0.25, newTasks: 50, qualify: 10, window: 20, minGraded: 10, threshold: 0.8, grade: "equal", gradeCapUsd: 0.05 }, "§7.8's defaults");
      await assert.rejects(tests().create({ type: TYPE, expected: YES, grade: { step: "x/open" } }), refused("bad_grader"));
      const t = (await ready(1))[0]!;
      await assert.rejects(tests().update(t.id, { grade: { step: "x/open" } }), refused("bad_grader"));
      assert.equal((await tasks().setType(TYPE, { app: "workers", answer: MATCH })).tests, undefined, "a PUT without tests turns them off");
    });

    // ── authoring (§7.1) ────────────────────────────────────────────────

    it("authoring: expected fits the type's schema; ready once its files are there; edited only before it is served; retired is never served; deleting the type retires them", async () => {
      await typeWith({ qualify: 0, rate: 1, newRate: 1 });
      await assert.rejects(tests().create({ type: "nope", expected: YES }), refused("unknown_type"));
      await assert.rejects(tests().create({ type: TYPE, expected: { same: "yes" } }), refused("bad_answer", /^bad_answer: expected:/));
      await assert.rejects(tests().create({ type: TYPE, expected: YES, files: ["../x"] }), refused("bad_request"));
      const t = await tests().create({ type: TYPE, show: { photo: "b.jpg" }, files: ["b.jpg", "c/d.png"], expected: YES }, "staff");
      assert.deepEqual([t.ready, t.missing, t.createdBy, t.served], [false, ["b.jpg", "c/d.png"], "staff", 0]);
      await assert.rejects(tests().putFile(t.id, "e.jpg", new Uint8Array([1])), refused("not_listed"));
      await assert.rejects(tests().putFile(t.id, "b.jpg", new Uint8Array(3_800_001)), refused("bad_request", /at most/));
      assert.equal((await tests().putFile(t.id, "b.jpg", new Uint8Array([1]))).ready, false);
      await tasks().grant("bob", TYPE);
      await real(2);
      rig.draws.push(0, 0);
      assert.equal((await behind((await take("bob")).lease)).test, undefined, "not ready: never served");
      const done = await tests().putFile(t.id, "c/d.png", new Uint8Array([2]));
      assert.deepEqual([done.ready, done.missing], [true, undefined]);
      const edited = await tests().update(t.id, { show: { photo: "b2.jpg" }, expected: NO, grade: "equal" });
      assert.deepEqual([edited.show, edited.expected, edited.grade], [{ photo: "b2.jpg" }, NO, "equal"]);
      assert.equal((await tests().update(t.id, { grade: null })).grade, undefined, "null: the type's again");

      await tasks().grant("carol", TYPE);
      rig.draws.push(0, 0);
      const served = await take("carol");
      assert.equal((await behind(served.lease)).test, t.id);
      await assert.rejects(tests().update(t.id, { expected: YES }), refused("in_use", /never edited/), "ruling 8");
      await assert.rejects(tests().putFile(t.id, "b.jpg", new Uint8Array([9])), refused("in_use"));
      await tasks().submit("carol", { lease: served.lease, answer: NO });
      await rig.svc.grading();
      const listed = (await tests().list({ type: TYPE }))[0]!;
      assert.deepEqual([listed.served, listed.passed, listed.failed, listed.errors], [1, 1, 0, 0]);

      const retired = await tests().retire(t.id, "staff");
      assert.deepEqual([typeof retired.retired, retired.retiredBy], ["number", "staff"]);
      assert.deepEqual(await tests().list({ retired: false }), []);
      await tasks().grant("dave", TYPE);
      rig.draws.push(0, 0);
      assert.equal((await behind((await take("dave")).lease)).test, undefined, "retired: never served again");
      await assert.rejects(tests().retire("f".repeat(32)), refused("unknown_test"));

      const other = (await ready(1))[0]!;
      await tasks().setType("other", { app: "workers", answer: MATCH });
      await tasks().deleteType("other");
      await assert.rejects(tasks().deleteType(TYPE), refused("in_use"), "dave holds a task of it");
      assert.equal((await tests().get(other.id))!.test.retired, undefined);
    });

    it("a test made from a real task: its files copied, its answer expected unless one is given; never from an instance or an unanswered task without one", async () => {
      await typeWith({ qualify: 0, rate: 1, newRate: 1 });
      await tasks().grant("ann", TYPE);
      const [t1] = await real(1, { files: ["a.jpg", "gone.jpg"] });
      rig.runFiles.set(`r1\0a.jpg`, new Uint8Array([0, 7, 7]));
      await assert.rejects(tests().fromTask(t1!.id), refused("bad_request", /no accepted answer/));
      const disputed = await tests().fromTask(t1!.id, { expected: NO });
      assert.deepEqual([disputed.expected, disputed.fromWorker, disputed.ready, disputed.missing], [NO, undefined, false, ["gone.jpg"]], "a file gone already is left for staff to put");
      const got = await take("ann");
      await tasks().submit("ann", { lease: got.lease, answer: YES });
      const made = await tests().fromTask(t1!.id, {}, "staff");
      assert.deepEqual([made.expected, made.fromWorker, made.files], [YES, "ann", ["a.jpg", "gone.jpg"]]);
      await tests().putFile(made.id, "gone.jpg", new Uint8Array([1]));
      rig.runFiles.delete(`r1\0a.jpg`);
      await tasks().grant("bob", TYPE);
      await real(1);
      rig.draws.push(0, 0);
      const b = await take("bob");
      const inst = await behind(b.lease);
      assert.equal(inst.test, made.id);
      assert.deepEqual((await tasks().file("bob", { lease: b.lease, path: "a.jpg" })).base64, Buffer.from([0, 7, 7]).toString("base64"), "the copy, though the run's file is gone");
      await assert.rejects(tests().fromTask(inst.id), refused("bad_request", /instance/));
      await assert.rejects(tests().fromTask("nope"), refused("unknown_task"));
    });

    // ── what holds an expected answer (§7.1, §7.10) ─────────────────────

    it("no capability method holds an expected answer: only the test authoring does", async () => {
      const LABEL = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
      const MARK = "EXPECTED-7f3a";
      await typeWith({ qualify: 0, rate: 1, newRate: 1 }, { answer: LABEL });
      await tasks().grant("bob", TYPE);
      await tests().create({ type: TYPE, show: { photo: "a.jpg" }, expected: { label: MARK } });
      const [t] = await real(1);
      const got = await take("bob");
      const seen = [JSON.stringify(got)];
      await tasks().submit("bob", { lease: got.lease, answer: { label: "a cat" } });
      await rig.svc.grading();
      const inst = await behind(got.lease);
      assert.equal(inst.grade, "fail");
      seen.push(
        JSON.stringify(await tasks().types()),
        JSON.stringify(await tasks().list()),
        JSON.stringify(await tasks().list({ test: true })),
        JSON.stringify(await tasks().task(inst.id)),
        JSON.stringify(await tasks().task(t!.id)),
        JSON.stringify(await tasks().workers()),
        JSON.stringify(await tasks().worker("bob")),
        JSON.stringify(await tasks().me("bob")),
        JSON.stringify(await tasks().next("bob")),
        JSON.stringify(rig.graded),
      );
      for (const s of seen) assert.ok(!s.includes(MARK), `an expected answer leaked: ${s.slice(0, 200)}`);
      assert.ok(JSON.stringify(await tests().list()).includes(MARK));
      assert.ok(JSON.stringify(await tests().get(inst.test!)).includes(MARK));
    });

    if (impl === "SQLite") {
      it("a pending grade survives a restart and is graded by the sweep", async () => {
        await typeWith({ qualify: 0, rate: 1, newRate: 1, grade: { step: GRADER } });
        await tasks().grant("bob", TYPE);
        await ready(1);
        await real(1);
        const got = await take("bob");
        await tasks().submit("bob", { lease: got.lease, answer: YES });
        await asked();
        assert.equal(rig.grades.length, 1, "grading, not done");
        await rig.svc.close();
        rig.grades.length = 0;
        rig = rigFor(impl, dir, { principal: "client", rig });
        const inst = await behind(got.lease);
        assert.equal(inst.grade, undefined, "pending");
        const swept = await rig.svc.sweep();
        assert.equal(swept.grading, 1);
        await verdicts(pass);
        assert.equal((await behind(got.lease)).grade, "pass");
        assert.equal((await rig.svc.sweep()).grading, 0, "once");
      });
    }
  });
}

describe("the standing rule's sentences (§7.5)", () => {
  const rules = { rate: 0.05, newRate: 0.25, newTasks: 50, qualify: 10, window: 20, minGraded: 10, threshold: 0.8, grade: "equal" as const, gradeCapUsd: 0.05 };
  const row = (passed: number, graded: number, gradedAll = graded) => ({ worker: "w", type: TYPE, passed, graded, gradedAll, errors: 0, pending: 0, real: 0 });
  it("reads the newest window once minGraded are graded; qualifying decides at K", () => {
    assert.equal(revokeWhy(row(13, 20, 40), { qualify: 0 }, rules, TYPE), `standing: passed 13 of the last 20 tests of ${TYPE}, under 80%`);
    assert.equal(revokeWhy(row(16, 20, 40), { qualify: 0 }, rules, TYPE), undefined, "at the threshold it stands");
    assert.equal(revokeWhy(row(0, 9), { qualify: 0 }, rules, TYPE), undefined, "under minGraded nothing is read");
    assert.equal(revokeWhy(row(6, 10), { qualify: 10 }, rules, TYPE), `qualifying: passed 6 of 10 tests of ${TYPE}, under 80%`);
    assert.equal(revokeWhy(row(0, 9), { qualify: 10 }, rules, TYPE), undefined, "still qualifying");
    assert.equal(revokeWhy(row(3, 5), { qualify: 5 }, rules, TYPE), `qualifying: passed 3 of 5 tests of ${TYPE}, under 80%`, "K under minGraded: K decides");
  });
});

// ── in a strut ──────────────────────────────────────────────────────────────

const LABEL = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
const MARK = "EXPECTED-9c1d";

describe("tests in a strut: the grader's run and the routes (§7.1, §7.4)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-task-tests-strut-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const seen: Array<{ keys: string[]; principal?: string; cfg: Record<string, unknown> }> = [];
  const sealedGrader = defineStep({
    type: "test/grade-sealed",
    sealed: true,
    input: z.object({ answer: z.any(), expected: z.any(), show: z.any(), type: z.string(), strict: z.boolean().optional() }),
    output: z.any(),
    async run(cfg, ctx?: StepContext) {
      seen.push({ keys: Object.keys((ctx?.services ?? {}) as object).sort(), ...(ctx?.principal ? { principal: ctx.principal } : {}), cfg: cfg as Record<string, unknown> });
      return { supports: JSON.stringify(cfg.answer) === JSON.stringify(cfg.expected), content: `compared (strict: ${cfg.strict})` };
    },
  });
  const openGrader = defineStep({ type: "test/grade-open", input: z.any(), output: z.any(), async run() { return { supports: true, content: "" }; } });
  const slowGrader = defineStep({
    type: "test/grade-slow",
    sealed: true,
    input: z.any(),
    output: z.any(),
    async run(_cfg, ctx?: StepContext) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10_000);
        ctx?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      return { supports: true, content: "late" };
    },
  });
  const say = defineStep({ type: "test/say", input: z.any(), output: z.any(), async run() { return { said: true }; } });

  /** Every file under `dir` but the task store's own database, with its size. */
  const tree = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!/tasks[/\\]tasks\.db/.test(relative(dir, p))) out.push(`${relative(dir, p)}:${(await stat(p)).size}`);
      }
    };
    await walk(dir);
    return out.sort();
  };

  it("a step grader runs on secrets and llmAuth alone, billed to the principal: it writes nothing under dataDir and sends nothing to onRunEvent; only the test routes hold the expected answer", async () => {
    const events: RunEvent[] = [];
    const ws = join(root, "ws");
    const strut = await createStrut({
      workspace: new WorkspaceManager(ws),
      serveUi: false,
      scheduler: false,
      autoResume: false,
      enableChat: false,
      job: false,
      builder: false,
      orchestrator: false,
      jamie: false,
      registry: await createRegistry([sealedGrader, openGrader, slowGrader, say]),
      services: { onRunEvent: (_wf: string, e: RunEvent) => void events.push(e) },
      tasks: { principal: "client-billing" },
    });
    const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://strut.test${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    const json = async (path: string, init: RequestInit = {}, status = 200) => {
      const res = await req(path, init);
      const text = await res.text();
      assert.equal(res.status, status, `${init.method ?? "GET"} ${path}: ${text}`);
      return JSON.parse(text) as Record<string, any>;
    };
    try {
      const unsealed = await json(`/tasks/types/labels`, { method: "PUT", body: JSON.stringify({ app: "workers", answer: LABEL, tests: { qualify: 0, rate: 1, newRate: 1, grade: { step: "test/grade-open" } } }) }, 400);
      assert.equal(unsealed["code"], "bad_grader");
      const { type } = await json(`/tasks/types/labels`, { method: "PUT", body: JSON.stringify({ app: "workers", answer: LABEL, tests: { qualify: 0, rate: 1, newRate: 1, grade: { step: "test/grade-sealed", config: { strict: true } } } }) });
      assert.equal(type.tests.window, 20, "the defaults filled");
      const { test } = await json(`/tasks/tests`, { method: "POST", body: JSON.stringify({ type: "labels", show: { photo: "x.png" }, files: ["x.png"], expected: { label: MARK } }) });
      assert.deepEqual([test.ready, test.missing], [false, ["x.png"]]);
      const put = await json(`/tasks/tests/${test.id}/files/x.png`, { method: "PUT", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]), headers: { "content-type": "application/octet-stream" } });
      assert.equal(put["test"].ready, true);
      assert.ok(existsSync(join(testFilesRoot(ws), test.id, "x.png")), "under <dataDir>/tasks/tests/<id>/");
      await json(`/tasks/tests/${test.id}/files/y.png`, { method: "PUT", body: new Uint8Array([1]) }, 404);
      const real = (await strut.tasks.capability.ensure({ type: "labels", workflow: "w", runId: "r1", path: "w/label", show: { photo: "x.png" } })).task;
      const granted = await json(`/tasks/workers/bob/grants/labels`, { method: "PUT", body: "" });
      assert.equal(granted["worker"].grants[0].qualify, 0);
      await json(`/tasks/workers/bob/grants/labels`, { method: "PUT", body: JSON.stringify({ qualify: "no" }) }, 400);

      const got = (await strut.tasks.capability.next("bob", { app: "workers" })) as WorkerTask;
      assert.deepEqual(got.files, ["x.png"]);
      const file = await strut.tasks.capability.file("bob", { lease: got.lease, path: "x.png", app: "workers" });
      assert.equal(file.base64, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]).toString("base64"));

      const before = await tree(ws);
      const heard = events.length;
      await strut.tasks.capability.submit("bob", { lease: got.lease, answer: { label: "a cat" }, app: "workers" });
      await strut.tasks.grading();
      assert.deepEqual(await tree(ws), before, "the grader's run wrote nothing under dataDir");
      assert.equal(events.length, heard, "and sent nothing to onRunEvent");
      assert.equal(seen.length, 1);
      assert.ok(seen[0]!.keys.every((k) => k === "secrets" || k === "llmAuth"), `an allowlist bag: ${seen[0]!.keys.join(", ")}`);
      assert.equal(seen[0]!.principal, "client-billing", "billed to the grading principal");
      assert.deepEqual(seen[0]!.cfg, { answer: { label: "a cat" }, expected: { label: MARK }, show: { photo: "x.png" }, type: "labels", strict: true });

      const one = await json(`/tasks/tests/${test.id}`);
      assert.deepEqual([one["instances"][0].grade, one["instances"][0].note, one["instances"][0].worker], ["fail", "compared (strict: true)", "bob"]);
      const inst = one["instances"][0].task as string;
      const { worker } = await json(`/tasks/workers/bob`);
      assert.deepEqual([worker.standing.labels.graded, worker.standing.labels.passed, worker.standing.labels.qualifying], [1, 0, false]);
      await json(`/tasks/workers/nobody`, {}, 404);
      assert.deepEqual((await json(`/tasks?test=true`))["tasks"].map((t: TaskRecord) => t.id), [inst]);
      assert.deepEqual((await json(`/tasks?test=false`))["tasks"].map((t: TaskRecord) => t.id), [real.id]);
      for (const path of ["/tasks", `/tasks/${inst}`, `/tasks/${real.id}`, "/tasks/types", "/tasks/workers", "/tasks/workers/bob"]) {
        assert.ok(!(await (await req(path)).text()).includes(MARK), `${path} holds no expected answer`);
      }
      assert.ok(!JSON.stringify(await strut.tasks.capability.me("bob")).includes(MARK));
      for (const path of ["/tasks/tests", `/tasks/tests/${test.id}`]) assert.ok((await (await req(path)).text()).includes(MARK), `${path} does`);

      const edit = await json(`/tasks/tests/${test.id}`, { method: "PUT", body: JSON.stringify({ expected: { label: "x" } }) }, 409);
      assert.equal(edit["code"], "in_use");
      const fromTask = await json(`/tasks/${real.id}/test`, { method: "POST", body: JSON.stringify({ expected: { label: "a dog" } }) });
      assert.equal(fromTask["test"].fromTask, real.id);
      const retired = await json(`/tasks/tests/${test.id}`, { method: "DELETE" });
      assert.equal(typeof retired["test"].retired, "number");
      assert.equal((await json(`/tasks/tests?retired=true`))["tests"].length, 1);

      // The spy is live: an ordinary run's events reach it.
      await strut.workspace.createWorkflow("say", "name: say\nsteps:\n  - id: s\n    type: test/say\n");
      assert.equal((await strut.run("say", {})).status, "success");
      assert.ok(events.length > heard, "an ordinary run is heard");
    } finally {
      await strut.close();
    }
  });

  it("a step grader past its time is stopped and throws; graderProblem refuses a step not sealed or not here", async () => {
    const registry = await createRegistry([sealedGrader, openGrader, slowGrader, say]);
    const grade = stepGrader({ registry: () => registry, services: () => ({ secrets: {}, http: {}, artifacts: {}, onRunEvent: () => {} }) });
    const t0 = Date.now();
    await assert.rejects(
      grade({ step: "test/grade-slow", input: { answer: 1, expected: 1, show: null, type: "t" }, principal: "p", maxCostUsd: 0.05, timeoutMs: 50 }),
      /timeout: the grader test\/grade-slow ran past/,
    );
    assert.ok(Date.now() - t0 < 5_000, "stopped, not waited out");
    const ok = await grade({ step: "test/grade-sealed", input: { answer: 1, expected: 1, show: null, type: "t" }, principal: "p", maxCostUsd: 0.05, timeoutMs: 5_000 });
    assert.equal(ok.supports, true);
    assert.deepEqual(seen.at(-1)!.keys, ["secrets"], "http, artifacts and onRunEvent left out");
    await assert.rejects(grade({ step: "test/say", input: { answer: 1, expected: 1, show: null, type: "t" }, principal: "p", maxCostUsd: 0.05, timeoutMs: 5_000 }), /returned no \{ supports, content \}/, "no verdict: it throws");
    const problem = graderProblem(() => registry);
    assert.equal(problem("test/grade-sealed"), undefined);
    assert.match(problem("test/grade-open")!, /is not sealed/);
    assert.match(problem("test/none")!, /no step test\/none here/);
  });

  it("a step that authors a test lists expected in redact: no step on the registry takes it unredacted", async () => {
    const registry = await createRegistry([]);
    for (const [type, def] of Object.entries(registry)) {
      const shape = (def.input as unknown as { shape?: Record<string, unknown> }).shape;
      if (shape && "expected" in shape) assert.ok(def.redact?.includes("expected"), `${type} takes an expected answer: list it in redact (plans/human-steps.md §7.9)`);
    }
  });

  it("STRUT_HOST_CONFIG's tasks sets the grading principal", async () => {
    const file = join(root, "host.json");
    writeFileSync(file, JSON.stringify({ tasks: { principal: "client" } }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }).tasks, { principal: "client" });
    writeFileSync(file, JSON.stringify({ tasks: { principal: "client", rate: 1, newRate: 1 } }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"tasks" must be \{ principal\?: string \}/);
  });
});

// ── an older file (§7.7) ────────────────────────────────────────────────────

/** #655's tables, with #664's pay columns: a version 1 file. */
const SCHEMA_V1 = `
create table task_types (name text primary key, app text not null, answer text not null, lease_seconds integer not null,
  within_hours real not null, enabled integer not null, changed_at integer not null, changed_by text, pay_msat integer, hold_hours real) strict;
create table tasks (seq integer primary key autoincrement, id text not null unique, type text not null, workflow text not null,
  run_id text not null, path text not null, show text not null, files text not null, root text not null check (root in ('run', 'job')),
  job text, status text not null check (status in ('open', 'settled', 'expired', 'cancelled')), created integer not null,
  due integer not null, settled_at integer, answer text, by text, unique (workflow, run_id, path)) strict;
create index tasks_open on tasks(type, seq) where status = 'open';
create table leases (id text primary key, task text not null, worker text not null, type text not null, taken integer not null,
  expires integer not null, status text not null check (status in ('open', 'submitted', 'expired', 'skipped')), closed integer,
  reason text, pay_msat integer, booked_at integer, unique (task, worker)) strict;
create table workers (actor text primary key, status text not null check (status in ('new', 'active', 'suspended', 'banned')),
  first_seen integer not null, changed_at integer not null, changed_by text, note text) strict;
create table grants (actor text not null, type text not null, granted_by text, granted_at integer not null, revoked_at integer,
  revoked_by text, revoked_why text, primary key (actor, type)) strict, without rowid;
`;

describe("an older tasks.db (§7.7)", () => {
  it("#655's schema with #664's columns opens, migrates to version 2 in place and keeps its rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-task-v1-"));
    try {
      const file = tasksPath(dir);
      await mkdir(join(dir, "tasks"), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(file);
      db.exec(SCHEMA_V1);
      db.exec("PRAGMA user_version = 1");
      db.prepare("insert into task_types values (?, 'workers', ?, 600, 48, 1, ?, 'staff', 21000, 24)").run(TYPE, JSON.stringify(MATCH), T0);
      db.prepare(
        `insert into tasks (id, type, workflow, run_id, path, show, files, root, status, created, due, settled_at, answer, by)
         values ('t1', ?, 'pets', 'r1', 'pets/a', '{"i":1}', '["a.jpg"]', 'run', 'settled', ?, ?, ?, '{"same":true}', 'ann')`,
      ).run(TYPE, T0, T0 + 48 * HOUR, T0 + MIN);
      db.prepare(
        `insert into tasks (id, type, workflow, run_id, path, show, files, root, status, created, due)
         values ('t2', ?, 'pets', 'r1', 'pets/b', '{}', '[]', 'run', 'open', ?, ?)`,
      ).run(TYPE, T0, T0 + 48 * HOUR);
      db.prepare("insert into leases values ('l1', 't1', 'ann', ?, ?, ?, 'submitted', ?, null, 21000, ?)").run(TYPE, T0, T0 + 10 * MIN, T0 + MIN, T0 + MIN);
      db.prepare("insert into workers values ('ann', 'active', ?, ?, 'staff', 'a note')").run(T0, T0);
      db.prepare("insert into grants values ('ann', ?, 'staff', ?, null, null, null)").run(TYPE, T0);
      db.close();

      const svc = createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(file), now: () => T0 + HOUR });
      try {
        const [kind] = await svc.capability.types();
        assert.deepEqual([kind!.paySats, kind!.holdHours, kind!.tests], [21, 24, undefined], "the type as it was, tests off");
        const t1 = (await svc.capability.task("t1"))!;
        assert.deepEqual([t1.seq, t1.status, t1.answer, t1.by, t1.files, t1.test], [1, "settled", { same: true }, "ann", ["a.jpg"], undefined]);
        assert.deepEqual([t1.leases[0]!.payMsat, t1.leases[0]!.bookedAt], [21000, T0 + MIN], "the lease's pay and booking kept");
        const ann = (await svc.capability.worker("ann"))!;
        assert.deepEqual([ann.status, ann.note, ann.grants[0]!.type, ann.grants[0]!.qualify], ["active", "a note", TYPE, undefined]);
        const t3 = (await svc.capability.ensure({ type: TYPE, workflow: "pets", runId: "r2", path: "pets/c" })).task;
        assert.equal(t3.seq, 3, "seq goes on from the old rows");
        // Version 2 at work: a test and its instance.
        await svc.capability.setType(TYPE, { app: "workers", answer: MATCH, paySats: 21, holdHours: 24, tests: { qualify: 0, rate: 1, newRate: 1 } }, "staff");
        await svc.tests.create({ type: TYPE, expected: YES });
        const got = (await svc.capability.next("ann")) as WorkerTask;
        assert.equal((await svc.capability.list({ test: true }))[0]!.leases[0]!.id, got.lease);
      } finally {
        await svc.close();
      }
      const after = new DatabaseSync(file);
      try {
        assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
        const cols = (table: string) => (after.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        for (const c of ["tests", "copies"]) assert.ok(cols("task_types").includes(c), `task_types.${c}`);
        for (const c of ["test", "served_to", "copies", "grade", "graded_at", "grade_note"]) assert.ok(cols("tasks").includes(c), `tasks.${c}`);
        assert.ok(cols("leases").includes("answer"), "leases.answer (4b's)");
        assert.ok(cols("grants").includes("qualify"));
        assert.ok(cols("tests").includes("expected"));
        const sql = (after.prepare("select sql from sqlite_master where name = 'tasks'").get() as { sql: string }).sql;
        assert.match(sql, /'disputed'/, "the status CHECK has 4b's disputed");
        assert.match(sql, /'test'/);
        assert.equal((after.prepare("select copies from tasks where id = 't1'").get() as { copies: number }).copies, 1);
        const indexes = (after.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'tasks'").all() as Array<{ name: string }>).map((r) => r.name);
        assert.ok(indexes.includes("tasks_open") && indexes.includes("tasks_ungraded"), "the rebuilt table's indexes made again");
      } finally {
        after.close();
      }
      // Opening it again changes nothing.
      const again = createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(file) });
      try {
        assert.equal((await again.capability.list({ test: false })).length, 3);
      } finally {
        await again.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a file newer than this strut is refused, and a migration that fails leaves the file at version 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-task-v1-"));
    try {
      const file = tasksPath(dir);
      await mkdir(join(dir, "tasks"), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(file);
      db.exec(SCHEMA_V1);
      // A row the new CHECKs refuse cannot be copied: the whole migration rolls back.
      db.exec("drop table tasks");
      db.exec(`create table tasks (seq integer primary key autoincrement, id text not null unique, type text not null, workflow text not null,
        run_id text not null, path text not null, show text not null, files text not null, root text not null, job text, status text not null,
        created integer not null, due integer not null, settled_at integer, answer text, by text, unique (workflow, run_id, path)) strict`);
      db.prepare("insert into tasks (id, type, workflow, run_id, path, show, files, root, status, created, due) values ('x', 't', 'w', 'r', 'p', '{}', '[]', 'elsewhere', 'open', 0, 1)").run();
      db.exec("PRAGMA user_version = 1");
      db.close();
      await assert.rejects(openTaskStores({ dataDir: dir }), /CHECK constraint failed/);
      const after = new DatabaseSync(file);
      try {
        assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1, "still version 1");
        assert.equal((after.prepare("select count(*) as n from sqlite_master where name in ('tests', 'tasks_v2')").get() as { n: number }).n, 0, "nothing half made");
        after.exec("PRAGMA user_version = 3");
      } finally {
        after.close();
      }
      await assert.rejects(openTaskStores({ dataDir: dir }), /schema 3 is newer than this strut's \(2\)/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
