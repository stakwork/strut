import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTasks, memoryTaskStores, openTaskStores, OPEN_GRANT_BY, tasksPath, TaskError, type TaskErrorCode, type TasksService, type WorkerTask } from "./tasks.js";
import { memoryTestFiles } from "./test-files.js";
import { openPayProblem } from "./task-tests.js";

/**
 * Open task types (plans/human-steps.md ruling 9): any signed-in worker who
 * is not suspended or banned takes an open type's tasks with no grant from
 * staff — their first ask records one, by `open`, through #671's grant, so
 * qualifying, standing and the automatic revoke work as they did. An
 * invite-only type still needs a staff grant. A paid open type needs its K
 * ready tests when saved, and takes no newcomer while it is short of them.
 * One suite over the SQLite file and the memory twin; the visitor's door
 * end to end is in worker-door.test.ts.
 */

const T0 = Date.parse("2026-11-13T12:00:00Z");
const MATCH = { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] };
const YES = { same: true };
const NO = { same: false };
/** Qualify on 2, decided at 2, half to pass: a short rule a test can walk. */
const RULE = { qualify: 2, window: 4, minGraded: 2, threshold: 0.5 };

const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

describe("openPayProblem: a paid open type qualifies every newcomer", () => {
  it("an unpaid or invite-only type needs nothing; a paid open one its tests on, K at least 1 and K ready", () => {
    assert.equal(openPayProblem({ name: "t", open: true }, 0), undefined, "unpaid: no tests needed");
    assert.equal(openPayProblem({ name: "t", open: false, paySats: 5 }, 0), undefined, "invite-only: staff grant each worker");
    assert.match(openPayProblem({ name: "t", open: true, paySats: 5 }, 0)!, /turn its tests on \(qualify 10 by default\)/);
    assert.match(openPayProblem({ name: "t", open: true, paySats: 5, tests: { qualify: 0 } }, 9)!, /qualify nobody \(qualify 0\)/);
    assert.match(openPayProblem({ name: "t", open: true, paySats: 5, tests: { qualify: 10 } }, 7)!, /needs 10 ready tests and has 7, 3 short; save it invite-only \(open: false\) or unpaid/);
    assert.equal(openPayProblem({ name: "t", open: true, paySats: 5, tests: { qualify: 10 } }, 10), undefined);
  });
});

for (const impl of ["SQLite", "memory"] as const) {
  describe(`open task types: ${impl}`, () => {
    let dir: string;
    let svc: TasksService;
    let clock = T0;
    const tasks = () => svc.capability;
    const tests = () => svc.tests;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-open-types-"));
      clock = T0;
      svc = createTasks({
        open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
        ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
        now: () => clock,
        // No test is drawn in place of a real task: only qualifying serves them.
        random: () => 0.999,
        testFiles: memoryTestFiles(),
      });
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    let n = 0;
    /** A real task of `type`. */
    const real = async (type: string) => (await tasks().ensure({ type, workflow: "w", runId: "r1", path: `w/ask#${n++}` })).task;
    /** `count` ready tests of `type`, expecting yes. */
    const ready = async (type: string, count: number) => {
      const out = [];
      for (let i = 0; i < count; i++) out.push(await tests().create({ type, show: { i }, expected: YES }, "staff"));
      return out;
    };
    const take = async (actor: string, o: { type?: string; app?: string } = {}) => {
      const got = await tasks().next(actor, o);
      assert.ok(!("none" in got), `${actor} got nothing`);
      return got as WorkerTask;
    };
    /** The task behind a lease, as staff read it. */
    const behind = async (lease: string) => (await tasks().list({ limit: 1000 })).find((t) => t.leases.some((l) => l.id === lease))!;
    const grantOf = async (actor: string, type: string) => (await tasks().worker(actor))?.grants.find((g) => g.type === type);
    /** Answers `count` tests of the worker's with `answer`, then waits for their grades. */
    const answerTests = async (actor: string, count: number, answer: unknown) => {
      for (let i = 0; i < count; i++) {
        const got = await take(actor);
        assert.notEqual((await behind(got.lease)).test, undefined, `${actor}'s ask ${i + 1} is a test`);
        await tasks().submit(actor, { lease: got.lease, answer });
      }
      await svc.grading();
    };

    it("a new signed-in worker takes an open type's tasks with no grant; the first ask records one, by open, and makes them active", async () => {
      const saved = await tasks().setType("pets", { app: "workers", answer: MATCH }, "staff");
      assert.equal(saved.open, true, "open unless staff say otherwise");
      await tasks().setType("elsewhere", { app: "other", answer: MATCH }, "staff");
      // Seen, not yet in: told what they may take, nothing recorded.
      assert.deepEqual((await tasks().me("ann", { app: "workers" })).types, [{ name: "pets", app: "workers", payMsat: 0, qualifying: false }]);
      assert.deepEqual([(await tasks().worker("ann"))!.status, (await tasks().worker("ann"))!.grants], ["new", []]);
      assert.equal(svc.isActiveWorker("ann"), false);

      const t = await real("pets");
      const got = await take("ann", { app: "workers" });
      assert.equal(got.type, "pets");
      const w = (await tasks().worker("ann"))!;
      assert.equal(w.status, "active");
      assert.deepEqual(
        w.grants.map((g) => [g.type, g.by, g.at, g.qualify]),
        [["pets", OPEN_GRANT_BY, T0, 0]],
        "an unpaid type with no tests: no qualifying, and another app's open type untouched",
      );
      assert.equal(svc.isActiveWorker("ann"), true, "counted as a worker from now on");
      assert.deepEqual(await tasks().submit("ann", { lease: got.lease, answer: YES }), { ok: true });
      const done = (await tasks().task(t.id))!;
      assert.deepEqual([done.status, done.by, done.answer], ["settled", "ann", YES]);
      // By name too, and in the stats as any grant.
      await real("pets");
      assert.equal((await take("bob", { type: "pets", app: "workers" })).type, "pets");
      assert.equal((await grantOf("bob", "pets"))!.by, OPEN_GRANT_BY);
      assert.equal((await tasks().stats({ type: "pets" })).types[0]!.granted, 2);
    });

    it("with K ready tests they qualify first; failing qualifying revokes, and the revoke sticks until staff grant it again", async () => {
      // Paid: saved invite-only, its tests made, then opened.
      await tasks().setType("pets", { app: "workers", answer: MATCH, open: false, paySats: 5, tests: RULE }, "staff");
      await ready("pets", 3);
      await tasks().setType("pets", { app: "workers", answer: MATCH, open: true, paySats: 5, tests: RULE }, "staff");
      await real("pets");
      assert.deepEqual((await tasks().me("ann", { app: "workers" })).types, [{ name: "pets", app: "workers", payMsat: 5000, qualifying: true }], "told they qualify first, with no score");

      // Ann passes: tests only, then nothing until graded, then the real task.
      const first = await take("ann", { app: "workers" });
      assert.notEqual((await behind(first.lease)).test, undefined, "a test, though a real task waits");
      assert.deepEqual([(await grantOf("ann", "pets"))!.by, (await grantOf("ann", "pets"))!.qualify], [OPEN_GRANT_BY, 2], "the grant records the type's K at the time");
      await tasks().submit("ann", { lease: first.lease, answer: YES });
      await answerTests("ann", 1, YES);
      assert.deepEqual((await tasks().me("ann", { app: "workers" })).types.map((t) => t.qualifying), [false]);
      assert.equal((await behind((await take("ann")).lease)).test, undefined, "qualified: the real task");

      // Bob fails: qualifying's own revoke, by standing.
      await answerTests("bob", 2, NO);
      const lost = (await grantOf("bob", "pets"))!;
      assert.deepEqual([lost.by, lost.revokedBy, lost.why], [OPEN_GRANT_BY, "standing", "qualifying: passed 0 of 2 tests of pets, under 50%"]);
      // "Open" never grants it again: by name refused, with no type nothing, and not offered.
      await assert.rejects(tasks().next("bob", { type: "pets", app: "workers" }), refused("not_granted", /your grant of task type pets was revoked \(qualifying: .*\); only staff can grant it again/));
      assert.deepEqual(await tasks().next("bob", { app: "workers" }), { none: true });
      assert.deepEqual((await tasks().me("bob", { app: "workers" })).types, []);
      assert.ok((await grantOf("bob", "pets"))!.revokedAt !== undefined, "still revoked after asking");
      // A staff revoke of an open grant sticks the same way.
      await tasks().revoke("ann", "pets", { by: "staff", why: "careless" });
      await assert.rejects(tasks().next("ann", { type: "pets" }), refused("not_granted", /revoked \(careless\)/));
      // Staff grant it again: live, qualifying again (§7.5) — its window starts empty.
      clock += 60_000;
      const again = await tasks().grant("bob", "pets", "staff");
      assert.deepEqual(again.grants.map((g) => [g.type, g.by, g.revokedAt, g.qualify]), [["pets", "staff", undefined, 2]]);
      assert.notEqual((await behind((await take("bob")).lease)).test, undefined, "qualifying again");
    });

    it("a suspended or banned worker is refused, and an open type records them no grant", async () => {
      await tasks().setType("pets", { app: "workers", answer: MATCH }, "staff");
      await real("pets");
      for (const status of ["suspended", "banned"] as const) {
        const actor = `eve-${status}`;
        await tasks().setWorker(actor, { status }, "staff");
        await assert.rejects(tasks().next(actor, { app: "workers" }), refused("not_active", new RegExp(`you are ${status}`)));
        await assert.rejects(tasks().next(actor, { type: "pets", app: "workers" }), refused("not_active"));
        assert.deepEqual((await tasks().worker(actor))!.grants, [], "nothing recorded");
        assert.deepEqual((await tasks().me(actor, { app: "workers" })).types, [], "nothing offered");
      }
      // One who was in: suspended, their lease let go and their asks refused.
      const got = await take("ann", { app: "workers" });
      await tasks().setWorker("ann", { status: "suspended" }, "staff");
      await assert.rejects(tasks().submit("ann", { lease: got.lease, answer: YES }), refused("not_active"));
      await assert.rejects(tasks().next("ann", { app: "workers" }), refused("not_active", /you are suspended/));
      assert.equal((await take("bob", { app: "workers" })).type, "pets", "the task is free for someone else");
    });

    it("an invite-only type still needs a grant", async () => {
      const saved = await tasks().setType("ballots", { app: "workers", answer: MATCH, open: false }, "staff");
      assert.equal(saved.open, false);
      await tasks().setType("pets", { app: "workers", answer: MATCH }, "staff");
      await real("ballots");
      // A new worker, with only an invite-only type around: as built.
      await assert.rejects(tasks().next("cat", { type: "ballots", app: "workers" }), refused("not_active", /you have no task types yet; an admin decides/));
      // One in by an open type: the invite-only one is still not theirs.
      assert.deepEqual(await tasks().next("ann", { app: "workers" }), { none: true }, "pets has nothing; ballots is not hers");
      assert.deepEqual((await tasks().worker("ann"))!.grants.map((g) => g.type), ["pets"]);
      assert.deepEqual((await tasks().me("ann", { app: "workers" })).types.map((t) => t.name), ["pets"]);
      await assert.rejects(tasks().next("ann", { type: "ballots", app: "workers" }), refused("not_granted", /it is invite-only, and staff grant it/));
      await tasks().grant("ann", "ballots", "staff");
      assert.equal((await take("ann", { app: "workers" })).type, "ballots");
    });

    it("a paid open type with fewer than K ready tests is refused when saved; short of them later, it takes no newcomer until they are back", async () => {
      const base = { app: "workers", answer: MATCH, paySats: 5 };
      await assert.rejects(tasks().setType("pets", base, "staff"), refused("needs_tests", /turn its tests on/));
      await assert.rejects(tasks().setType("pets", { ...base, tests: { ...RULE, qualify: 0 } }, "staff"), refused("needs_tests", /qualify 0/));
      await assert.rejects(tasks().setType("pets", { ...base, tests: RULE }, "staff"), refused("needs_tests", /needs 2 ready tests and has 0, 2 short/));
      assert.deepEqual(await tasks().types(), [], "nothing saved");
      assert.equal((await tasks().setType("free", { app: "workers", answer: MATCH, tests: RULE }, "staff")).open, true, "unpaid: open with no tests");
      await tasks().setType("pets", { ...base, open: false, tests: RULE }, "staff");
      const [t1] = await ready("pets", 2);
      assert.equal((await tasks().setType("pets", { ...base, tests: RULE }, "staff")).open, true, "open once K are ready");
      assert.equal((await tasks().stats({ type: "pets" })).types[0]!.readyTests, 2);
      // A raise of K past the ready tests is a save like any other.
      await assert.rejects(tasks().setType("pets", { ...base, tests: { ...RULE, qualify: 3 } }, "staff"), refused("needs_tests", /needs 3 ready tests and has 2, 1 short/));

      // Ann gets in while it has them.
      await answerTests("ann", 2, YES);
      // One retired: a newcomer finds it invite-only, and is told why.
      await tests().retire(t1!.id, "staff");
      await real("pets");
      assert.deepEqual((await tasks().me("bob", { app: "workers" })).types.map((t) => t.name), ["free"], "not offered");
      await assert.rejects(tasks().next("bob", { type: "pets", app: "workers" }), refused("not_active", /task type pets takes new workers while it has 2 ready tests to qualify them on, and has 1 now: ask again later/));
      assert.deepEqual(await tasks().next("bob", { app: "workers" }), { none: true }, "in by the unpaid open type, which has nothing");
      await assert.rejects(tasks().next("bob", { type: "pets", app: "workers" }), refused("not_granted", /has 1 now: ask again later/));
      assert.equal(await grantOf("bob", "pets"), undefined);
      // Ann, already in, keeps working.
      assert.equal((await behind((await take("ann", { app: "workers" })).lease)).test, undefined);
      // Its tests back: the newcomer enters, qualifying.
      await ready("pets", 1);
      const bob = await take("bob", { type: "pets", app: "workers" });
      assert.notEqual((await behind(bob.lease)).test, undefined);
      assert.deepEqual([(await grantOf("bob", "pets"))!.by, (await grantOf("bob", "pets"))!.qualify], [OPEN_GRANT_BY, 2]);
    });

    it("task/me and task/next with no type cover the calling app's open types beside the granted ones", async () => {
      await tasks().setType("a", { app: "workers", answer: MATCH }, "staff");
      await tasks().setType("b", { app: "workers", answer: MATCH, open: false }, "staff");
      await tasks().setType("c", { app: "other", answer: MATCH }, "staff");
      await tasks().setType("off", { app: "workers", answer: MATCH, enabled: false }, "staff");
      await tasks().grant("ann", "b", "staff");
      assert.deepEqual(
        (await tasks().me("ann", { app: "workers" })).types.map((t) => t.name),
        ["b", "a"],
        "granted, then open: never another app's, never one turned off",
      );
      assert.deepEqual((await tasks().me("ann", { app: "other" })).types.map((t) => t.name), ["c"]);
      await real("b");
      await real("a");
      const first = await take("ann", { app: "workers" });
      assert.equal(first.type, "b", "oldest first, across the granted and the open");
      assert.deepEqual((await tasks().worker("ann"))!.grants.map((g) => [g.type, g.by]), [["a", OPEN_GRANT_BY], ["b", "staff"]], "the app's open types entered; another app's not");
      await tasks().submit("ann", { lease: first.lease, answer: YES });
      assert.equal((await take("ann", { app: "workers" })).type, "a");
    });

    it("a new worker's held next waits on the open types it entered, and wakes when a task of one is made", async () => {
      await tasks().setType("pets", { app: "workers", answer: MATCH }, "staff");
      const held = tasks().next("dan", { app: "workers", wait: 5 });
      for (let i = 0; i < 50 && !(await tasks().worker("dan"))?.grants.length; i++) await new Promise((r) => setTimeout(r, 5));
      const t0 = Date.now();
      await real("pets");
      const got = (await held) as WorkerTask;
      assert.equal(got.type, "pets");
      assert.ok(Date.now() - t0 < 4000, "woken by the task, not the wait's end");
    });
  });
}
