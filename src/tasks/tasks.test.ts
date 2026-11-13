import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  createTasks,
  memoryTaskStores,
  openTaskStores,
  tasksPath,
  TaskError,
  type TaskErrorCode,
  type TasksService,
  type TaskSettled,
  type WorkerTask,
} from "./tasks.js";
import { createStrut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, workflowOf, type StepContext } from "../core.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import type { StrutCapabilities } from "../capabilities.js";

/**
 * The task store's spec (plans/human-steps.md §4, §13's 2a rows), as tests:
 * one suite, run over the SQLite file and the memory twin through the
 * service, which holds the rules that need both sides. An implementation
 * that needs a different assertion here changed the contract.
 */

const T0 = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const BOX = { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 };
const MATCH = { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] };

interface Impl {
  name: string;
  make(dir: string, now: () => number): TasksService;
  /** The same data in a new service: what a restart does. */
  reopen?(dir: string, now: () => number): TasksService;
}

const sqlite = (dir: string, now: () => number) =>
  createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)), now });

const impls: Impl[] = [
  { name: "SQLite", make: sqlite, reopen: sqlite },
  { name: "memory", make: (_dir, now) => createTasks({ open: async () => memoryTaskStores(), now }) },
];

const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) =>
  e instanceof TaskError && e.code === code && (!re || re.test(e.message));

for (const impl of impls) {
  describe(`the task store: ${impl.name}`, () => {
    let dir: string;
    let clock: number;
    let svc: TasksService;
    let heard: TaskSettled[];
    const now = () => clock;
    const tasks = () => svc.capability;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-tasks-"));
      clock = T0;
      svc = impl.make(dir, now);
      heard = [];
      svc.onSettle((s) => heard.push(...s));
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    /** A type, its workers granted, and `n` tasks of one run. */
    const setup = async (o: { n?: number; workers?: string[]; type?: string; answer?: unknown; leaseSeconds?: number; withinHours?: number; app?: string } = {}) => {
      const type = o.type ?? "pet-match";
      await tasks().setType(type, { app: o.app ?? "workers", answer: o.answer ?? BOX, leaseSeconds: o.leaseSeconds ?? 600, withinHours: o.withinHours ?? 48 }, "staff");
      for (const w of o.workers ?? ["ann", "bob"]) await tasks().grant(w, type, "staff");
      const made = [];
      for (let i = 0; i < (o.n ?? 1); i++) {
        made.push((await tasks().ensure({ type, workflow: "pets", runId: "r1", path: `pets/each#${i}/review`, show: { i }, files: [`found-${i}.jpg`] })).task);
        clock += 1;
      }
      return made;
    };
    const take = async (actor: string, o?: { type?: string; app?: string }) => {
      const got = await tasks().next(actor, o);
      assert.ok(!("none" in got), `${actor} got no task`);
      return got as WorkerTask;
    };

    // ── task types ────────────────────────────────────────────────────

    it("a type whose answer schema uses a keyword strut does not check is refused when saved", async () => {
      await assert.rejects(tasks().setType("t", { app: "a", answer: { type: "string", pattern: "^x" } }), refused("bad_schema", /"pattern" is not a keyword strut checks/));
      await assert.rejects(tasks().setType("t", { app: "a", answer: { type: "object", additionalProperties: false } }), refused("bad_schema"));
      await assert.rejects(tasks().setType("Bad Name", { app: "a", answer: BOX }), refused("bad_request"));
      await assert.rejects(tasks().setType("t", { app: "a", answer: BOX, leaseSeconds: 0 }), refused("bad_request"));
      assert.deepEqual(await tasks().types(), []);
      const t = await tasks().setType("acme/pet-match", { app: "workers", answer: BOX }, "staff");
      assert.deepEqual(
        { ...t, changedAt: 0 },
        { name: "acme/pet-match", app: "workers", answer: BOX, leaseSeconds: 600, withinHours: 72, enabled: true, changedAt: 0, changedBy: "staff" },
        "the defaults are §4.2's",
      );
      assert.deepEqual((await tasks().types()).map((x) => x.name), ["acme/pet-match"]);
    });

    // ── rule 1: one task per key ──────────────────────────────────────

    it("one task per workflow, run and step path, whatever happens to its type since", async () => {
      await tasks().setType("pet-match", { app: "workers", answer: BOX });
      const key = { type: "pet-match", workflow: "pets", runId: "r1", path: "pets/review" };
      const first = await tasks().ensure({ ...key, show: { a: 1 }, files: ["x.jpg", "x.jpg", "y/z.jpg"] });
      assert.equal(first.created, true);
      assert.match(first.task.id, /^[0-9a-f]{32}$/);
      assert.deepEqual(first.task.files, ["x.jpg", "y/z.jpg"], "each file once");
      assert.equal(first.task.root, "run");
      assert.equal(first.task.status, "open");
      assert.equal(first.task.due, T0 + 72 * HOUR);
      await tasks().setType("pet-match", { app: "workers", answer: BOX, enabled: false });
      const again = await tasks().ensure({ ...key, show: { a: 2 } });
      assert.equal(again.created, false);
      assert.equal(again.task.id, first.task.id);
      assert.deepEqual(again.task.show, { a: 1 }, "the task as it was made");
      await assert.rejects(tasks().ensure({ ...key, path: "pets/other" }), refused("type_disabled"), "a new task needs the type enabled");
      await assert.rejects(tasks().ensure({ ...key, type: "nope", path: "pets/other" }), refused("unknown_type"));
      await tasks().setType("pet-match", { app: "workers", answer: BOX });
      const other = await tasks().ensure({ ...key, runId: "r2" });
      assert.equal(other.created, true, "another run is another key");
      assert.notEqual(other.task.id, first.task.id);
    });

    it("ensure checks what a task holds: show at most 256 KB, at most 200 files, paths under the run's files", async () => {
      await tasks().setType("t", { app: "a", answer: BOX });
      const base = { type: "t", workflow: "w", runId: "r", path: "w/s" };
      await assert.rejects(tasks().ensure({ ...base, show: "x".repeat(256 * 1024) }), refused("bad_request", /show is/));
      await assert.rejects(tasks().ensure({ ...base, files: Array.from({ length: 201 }, (_, i) => `f${i}`) }), refused("bad_request", /at most 200/));
      for (const bad of ["/etc/passwd", "../x", "a//b", "a/./b", ""]) {
        await assert.rejects(tasks().ensure({ ...base, files: [bad] }), refused("bad_request"), bad);
      }
      const job = await tasks().ensure({ ...base, job: "j1", withinHours: 0.5, files: ["page-12.png"] });
      assert.equal(job.task.root, "job");
      assert.equal(job.task.job, "j1");
      assert.equal(job.task.due, T0 + 30 * MIN);
    });

    // ── workers ───────────────────────────────────────────────────────

    it("a worker is new on their first call, active at the first grant, and stays active when the last is revoked", async () => {
      await tasks().setType("t", { app: "a", answer: BOX });
      assert.deepEqual(await tasks().me("ann"), { actor: "ann", status: "new", types: [] });
      await assert.rejects(tasks().next("ann"), refused("not_active", /no task types yet/));
      await tasks().grant("ann", "t", "staff");
      assert.deepEqual(await tasks().me("ann"), { actor: "ann", status: "active", types: [{ name: "t", app: "a" }] });
      await tasks().revoke("ann", "t", { by: "staff", why: "quality" });
      const w = (await tasks().workers()).find((x) => x.actor === "ann")!;
      assert.equal(w.status, "active");
      assert.deepEqual(w.grants.map((g) => ({ type: g.type, by: g.by, revokedBy: g.revokedBy, why: g.why })), [{ type: "t", by: "staff", revokedBy: "staff", why: "quality" }]);
      assert.deepEqual(await tasks().next("ann"), { none: true }, "nothing to take");
      await tasks().grant("ann", "t");
      assert.equal((await tasks().me("ann")).types.length, 1, "granted again");
      await assert.rejects(tasks().grant("ann", "nope"), refused("unknown_type"));
      await assert.rejects(tasks().revoke("zed", "t"), refused("unknown_worker"));
      await assert.rejects(tasks().me(""), refused("bad_request"));
    });

    // ── rule 2: next ──────────────────────────────────────────────────

    it("two workers never hold one task, even asking at once", async () => {
      const [t] = await setup({ workers: ["w1", "w2", "w3", "w4", "w5", "w6"] });
      const got = await Promise.all(["w1", "w2", "w3", "w4", "w5", "w6"].map((w) => tasks().next(w)));
      const leased = got.filter((g) => !("none" in g)) as WorkerTask[];
      assert.equal(leased.length, 1);
      assert.match(leased[0].lease, /^[0-9a-f]{32}$/, "128 random bits");
      assert.deepEqual(
        { type: leased[0].type, show: leased[0].show, files: leased[0].files, expires: leased[0].expires },
        { type: "pet-match", show: { i: 0 }, files: ["found-0.jpg"], expires: T0 + 1 + 600_000 },
      );
      const view = (await tasks().task(t.id))!;
      assert.equal(view.leases.length, 1);
      assert.equal(view.leases[0].status, "open");
    });

    it("a worker holds one lease at a time: asking again returns it, oldest task first", async () => {
      await setup({ n: 3 });
      const a = await take("ann");
      assert.deepEqual(a.show, { i: 0 }, "oldest first");
      const again = await take("ann");
      assert.equal(again.lease, a.lease);
      const b = await take("bob");
      assert.deepEqual(b.show, { i: 1 });
    });

    it("next narrows by type and by app, and refuses a type the worker does not hold or another app draws", async () => {
      await tasks().setType("pets", { app: "pets-app", answer: BOX });
      await tasks().setType("ballots", { app: "ballot-app", answer: MATCH });
      await tasks().grant("ann", "pets");
      await tasks().grant("ann", "ballots");
      await tasks().ensure({ type: "pets", workflow: "w", runId: "r", path: "w/p", show: "pet" });
      await tasks().ensure({ type: "ballots", workflow: "w", runId: "r", path: "w/b", show: "ballot" });
      assert.deepEqual((await tasks().me("ann", { app: "ballot-app" })).types, [{ name: "ballots", app: "ballot-app" }]);
      await assert.rejects(tasks().next("ann", { type: "pets", app: "ballot-app" }), refused("wrong_app"));
      await assert.rejects(tasks().next("bob", { type: "pets" }), refused("not_active"));
      await tasks().grant("bob", "ballots");
      await assert.rejects(tasks().next("bob", { type: "pets" }), refused("not_granted"));
      const b = await take("ann", { app: "ballot-app" });
      assert.equal(b.show, "ballot");
      await assert.rejects(tasks().next("ann", { app: "pets-app" }), refused("lease_held", /type ballots/), "one lease at a time, of any app");
      assert.equal((await take("ann", { app: "ballot-app" })).lease, b.lease);
    });

    it("a disabled type hands out nothing", async () => {
      await setup();
      await tasks().setType("pet-match", { app: "workers", answer: BOX, enabled: false });
      assert.deepEqual(await tasks().next("ann"), { none: true });
      assert.deepEqual((await tasks().me("ann")).types, []);
    });

    // ── rules 3, 4, 7: submit ─────────────────────────────────────────

    it("one answer per lease; the answer settles the task and is heard", async () => {
      const [t] = await setup();
      const l = await take("ann");
      clock += 5 * MIN;
      assert.deepEqual(await tasks().submit("ann", { lease: l.lease, answer: [1, 2, 3, 4] }), { ok: true });
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: [5, 6, 7, 8] }), refused("lease_closed", /already answered/));
      const view = (await tasks().task(t.id))!;
      assert.equal(view.status, "settled");
      assert.deepEqual(view.answer, [1, 2, 3, 4]);
      assert.equal(view.by, "ann");
      assert.equal(view.settledAt, clock);
      assert.equal(view.leases[0].status, "submitted");
      assert.deepEqual(heard, [{ id: t.id, type: "pet-match", workflow: "pets", runId: "r1", path: "pets/each#0/review", status: "settled" }]);
      assert.equal(await svc.settled(t.id), true);
      assert.deepEqual(await tasks().next("bob"), { none: true }, "a settled task is nobody's");
    });

    it("only the lease's own worker reaches the task through it", async () => {
      await setup();
      const l = await take("ann");
      await assert.rejects(tasks().submit("bob", { lease: l.lease, answer: [1, 2, 3, 4] }), refused("no_lease"));
      await assert.rejects(tasks().skip("bob", { lease: l.lease }), refused("no_lease"));
      await assert.rejects(tasks().submit("ann", { lease: "f".repeat(32), answer: [1, 2, 3, 4] }), refused("no_lease"));
      assert.deepEqual(heard, []);
    });

    it("an answer that does not fit the type's schema is refused, and the task waits for one that does", async () => {
      const [t] = await setup({ answer: MATCH });
      const l = await take("ann");
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: { same: "yes" } }), refused("bad_answer", /answer\.same: expected a boolean/));
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: { same: true, extra: 1 } }), refused("bad_answer", /"extra" is not a field/));
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: {} }), refused("bad_answer", /"same" is required/));
      assert.equal((await tasks().task(t.id))!.status, "open");
      assert.deepEqual(await tasks().submit("ann", { lease: l.lease, answer: { same: false } }), { ok: true });
    });

    // ── leases run out ────────────────────────────────────────────────

    it("an expired lease takes no answer, and its task goes to someone else — never back to the same worker", async () => {
      const [t] = await setup();
      const l = await take("ann");
      clock += 600_000 + 1;
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: [1, 2, 3, 4] }), refused("lease_expired"));
      assert.deepEqual(await tasks().next("ann"), { none: true }, "not handed back to ann");
      const b = await take("bob");
      assert.notEqual(b.lease, l.lease);
      const swept = await svc.sweep();
      assert.equal(swept.leases, 1);
      assert.deepEqual(swept.expired, []);
      const view = (await tasks().task(t.id))!;
      assert.deepEqual(view.leases.map((x) => [x.worker, x.status]), [["ann", "expired"], ["bob", "open"]]);
    });

    it("the sweep reopens a task whose lease expired", async () => {
      const [t] = await setup({ workers: ["ann", "bob"], leaseSeconds: 60 });
      await take("ann");
      clock += 2 * MIN;
      assert.equal((await svc.sweep()).leases, 1);
      assert.equal((await tasks().task(t.id))!.status, "open");
      assert.equal((await tasks().list({ status: "open" })).length, 1);
      await take("bob");
    });

    it("a task past its withinHours is settled as expired by the sweep, and heard", async () => {
      const [t, u] = await setup({ n: 2, withinHours: 1, leaseSeconds: 7200 });
      const l = await take("ann");
      clock = T0 + HOUR + 5;
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: [1, 2, 3, 4] }), refused("task_closed", /past its time/));
      assert.deepEqual(await tasks().next("bob"), { none: true }, "past due: handed to nobody, swept or not");
      const swept = await svc.sweep();
      assert.deepEqual(swept.expired.map((x) => [x.id, x.status]), [[t.id, "expired"], [u.id, "expired"]]);
      assert.deepEqual(heard.map((x) => x.status), ["expired", "expired"]);
      const view = (await tasks().task(t.id))!;
      assert.equal(view.status, "expired");
      assert.equal(view.leases[0].status, "expired");
      assert.equal(await svc.settled(t.id), true);
      assert.deepEqual((await svc.sweep()).expired, [], "once");
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: [1, 2, 3, 4] }), refused("task_closed", /expired/));
    });

    // ── skip ──────────────────────────────────────────────────────────

    it("skip frees the task for someone else, never for the worker who skipped", async () => {
      const [t] = await setup();
      const l = await take("ann");
      assert.deepEqual(await tasks().skip("ann", { lease: l.lease, reason: "blurry" }), { ok: true });
      await assert.rejects(tasks().skip("ann", { lease: l.lease }), refused("lease_closed", /skipped/));
      assert.deepEqual(await tasks().next("ann"), { none: true });
      await take("bob");
      const view = (await tasks().task(t.id))!;
      assert.equal(view.status, "open");
      assert.deepEqual(view.leases.map((x) => [x.worker, x.status, x.reason]), [["ann", "skipped", "blurry"], ["bob", "open", undefined]]);
    });

    // ── rule 6, §4.6: status read on every call ───────────────────────

    it("suspending a worker expires their open lease at once, and the task reopens; lifting it lets them work again", async () => {
      const [t] = await setup();
      const l = await take("ann");
      await tasks().setWorker("ann", { status: "suspended", note: "check quality" }, "staff");
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: [1, 2, 3, 4] }), refused("not_active", /suspended/));
      await assert.rejects(tasks().next("ann"), refused("not_active"));
      assert.deepEqual(await tasks().me("ann"), { actor: "ann", status: "suspended", types: [{ name: "pet-match", app: "workers" }] }, "me still answers");
      const view = (await tasks().task(t.id))!;
      assert.equal(view.leases[0].status, "expired");
      assert.equal(view.leases[0].reason, "worker suspended");
      await take("bob");
      const w = await tasks().setWorker("ann", { status: "active" }, "staff");
      assert.equal(w.note, "check quality", "a status change keeps the note");
      assert.equal(w.changedBy, "staff");
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: [1, 2, 3, 4] }), refused("lease_expired"), "the old lease stays dead");
    });

    it("banning does the same; revoking a grant expires a lease of that type", async () => {
      await setup({ n: 2 });
      const a = await take("ann");
      await tasks().setWorker("ann", { status: "banned" });
      assert.equal((await tasks().workers({ status: "banned" })).map((w) => w.actor).join(), "ann");
      const b = await take("bob");
      assert.deepEqual(b.show, { i: 0 }, "ann's task first");
      await tasks().revoke("bob", "pet-match", { why: "left" });
      await assert.rejects(tasks().submit("bob", { lease: b.lease, answer: [1, 2, 3, 4] }), refused("not_granted"));
      const leases = (await tasks().list()).flatMap((t) => t.leases);
      assert.deepEqual(
        [a.lease, b.lease].map((id) => leases.find((l) => l.id === id)!).map((l) => [l.worker, l.status, l.reason]),
        [["ann", "expired", "worker banned"], ["bob", "expired", "grant revoked"]],
      );
    });

    // ── cancel: what a cancelled run's source does ────────────────────

    it("cancelling a run cancels its open tasks, closes their leases, and is heard", async () => {
      const [t, u] = await setup({ n: 2 });
      await tasks().ensure({ type: "pet-match", workflow: "pets", runId: "r2", path: "pets/review" });
      const l = await take("ann");
      const out = await svc.cancelRun("pets", "r1");
      assert.deepEqual(out.map((x) => [x.id, x.status]), [[t.id, "cancelled"], [u.id, "cancelled"]]);
      assert.deepEqual(heard.map((x) => x.status), ["cancelled", "cancelled"]);
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: [1, 2, 3, 4] }), refused("task_closed", /cancelled/));
      assert.equal(await svc.settled(t.id), true);
      assert.deepEqual(await svc.cancelRun("pets", "r1"), [], "once");
      assert.equal((await tasks().list({ runId: "r2" }))[0].status, "open", "another run's task is left");
      const [r2] = await tasks().list({ runId: "r2" });
      assert.deepEqual((await svc.cancel(r2.id)).map((x) => x.status), ["cancelled"]);
      assert.equal(await svc.settled("not-a-task"), true, "a task not on file will never settle");
    });

    it("lists tasks newest first, by type, status and run, a page at a time", async () => {
      const made = await setup({ n: 5 });
      const all = await tasks().list();
      assert.deepEqual(all.map((t) => t.id), made.map((t) => t.id).reverse());
      const page = await tasks().list({ limit: 2 });
      const next = await tasks().list({ limit: 2, before: page[1].seq });
      assert.deepEqual([...page, ...next].map((t) => t.id), all.slice(0, 4).map((t) => t.id));
      assert.equal((await tasks().list({ type: "other" })).length, 0);
      assert.equal((await tasks().list({ workflow: "pets", runId: "r1", status: "open" })).length, 5);
    });

    if (impl.reopen) {
      it("survives a restart: tasks, leases, workers and types are on file", async () => {
        const [t] = await setup();
        const l = await take("ann");
        await svc.close();
        svc = impl.reopen!(dir, now);
        assert.deepEqual((await svc.capability.task(t.id))!.leases.map((x) => x.id), [l.lease]);
        assert.equal((await take("ann")).lease, l.lease);
        assert.deepEqual(await svc.capability.submit("ann", { lease: l.lease, answer: [0, 0, 1, 1] }), { ok: true });
        assert.equal((await svc.capability.workers()).length, 2);
      });

      it("makes no file until something is asked of it; the folder is the owner's alone", async () => {
        const file = tasksPath(dir);
        svc.start();
        assert.deepEqual(await tasks().types(), []);
        assert.deepEqual(await tasks().workers(), []);
        assert.deepEqual(await tasks().list(), []);
        assert.equal(await svc.settled("x"), true);
        assert.deepEqual(await svc.cancelRun("w", "r"), []);
        assert.equal(existsSync(file), false, "reads and the timer made no file");
        await tasks().me("ann");
        assert.equal(existsSync(file), true);
        assert.equal(statSync(join(dir, "tasks")).mode & 0o777, 0o700);
        svc.stop();
      });
    }
  });
}

describe("the task store in a strut", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-tasks-strut-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ask = defineStep({
    type: "test/ask",
    input: z.object({ type: z.string() }),
    output: z.object({ id: z.string(), created: z.boolean() }),
    async run(cfg, ctx?: StepContext<StrutCapabilities>) {
      const tasks = ctx!.services.tasks!;
      assert.ok(Object.isFrozen(tasks), "the capability is frozen");
      const { task, created } = await tasks.ensure({ type: cfg.type, workflow: workflowOf(ctx!), runId: ctx!.runId, path: ctx!.path, show: { hi: 1 } });
      return { id: task.id, created };
    },
  });

  it("is ctx.services.tasks, and makes <dataDir>/tasks/tasks.db only once used", async () => {
    const ws = join(dir, "ws");
    const strut = await createStrut({ workspace: new WorkspaceManager(ws), serveUi: false, scheduler: false, autoResume: false, registry: await createRegistry([ask]) });
    try {
      await strut.workspace.createWorkflow("ask", "name: ask\nsteps:\n  - id: review\n    type: test/ask\n    config:\n      type: pet-match\n");
      const file = tasksPath(ws);
      assert.equal(existsSync(file), false, "no file at boot");
      await strut.tasks.capability.setType("pet-match", { app: "workers", answer: BOX });
      assert.equal(existsSync(file), true);
      const result = await strut.run("ask", {});
      assert.equal(result.status, "success", JSON.stringify(result));
      const out = result.output as { id: string; created: boolean };
      assert.equal(out.created, true);
      const t = (await strut.tasks.capability.task(out.id))!;
      assert.deepEqual([t.workflow, t.runId, t.path, t.show], ["ask", result.runId, "ask/review", { hi: 1 }]);
    } finally {
      await strut.close();
    }
  });

  it("lives in memory where the run store does", async () => {
    const strut = await createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), store: new MemoryRunStore(), serveUi: false, scheduler: false, registry: await createRegistry([ask]) });
    try {
      await strut.tasks.capability.setType("t", { app: "a", answer: BOX });
      assert.equal(existsSync(tasksPath(join(dir, "ws"))), false);
      assert.deepEqual((await strut.tasks.capability.types()).map((t) => t.name), ["t"]);
    } finally {
      await strut.close();
    }
  });
});
