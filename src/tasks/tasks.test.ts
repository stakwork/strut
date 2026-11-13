import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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
  type TaskStores,
  type WorkerTask,
} from "./tasks.js";
import { ledgerPath, openLedger, type LedgerStore } from "../payments/ledger.js";
import { MemoryLedgerStore } from "../payments/ledger-memory.js";
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
/** A worker's balance with nothing earned (§8.1). */
const NOTHING = { totalMsat: 0, heldMsat: 0, withdrawableMsat: 0 };

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
      await tasks().setType(type, { app: o.app ?? "workers", answer: o.answer ?? BOX, leaseSeconds: o.leaseSeconds ?? 600, withinHours: o.withinHours ?? 48, open: false }, "staff");
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
        { name: "acme/pet-match", app: "workers", answer: BOX, leaseSeconds: 600, withinHours: 72, enabled: true, open: true, holdHours: 72, changedAt: 0, changedBy: "staff" },
        "the defaults are §4.2's, unpaid with §8.1's hold, open (ruling 9)",
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
      await tasks().setType("t", { app: "a", answer: BOX, open: false });
      assert.deepEqual(await tasks().me("ann"), { actor: "ann", status: "new", types: [], balance: NOTHING });
      await assert.rejects(tasks().next("ann"), refused("not_active", /no task types yet/));
      await tasks().grant("ann", "t", "staff");
      assert.deepEqual(await tasks().me("ann"), { actor: "ann", status: "active", types: [{ name: "t", app: "a", payMsat: 0, qualifying: false }], balance: NOTHING });
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
      await tasks().setType("pets", { app: "pets-app", answer: BOX, open: false });
      await tasks().setType("ballots", { app: "ballot-app", answer: MATCH, open: false });
      await tasks().grant("ann", "pets");
      await tasks().grant("ann", "ballots");
      await tasks().ensure({ type: "pets", workflow: "w", runId: "r", path: "w/p", show: "pet" });
      await tasks().ensure({ type: "ballots", workflow: "w", runId: "r", path: "w/b", show: "ballot" });
      assert.deepEqual((await tasks().me("ann", { app: "ballot-app" })).types, [{ name: "ballots", app: "ballot-app", payMsat: 0, qualifying: false }]);
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
      assert.deepEqual(await tasks().me("ann"), { actor: "ann", status: "suspended", types: [{ name: "pet-match", app: "workers", payMsat: 0, qualifying: false }], balance: NOTHING }, "me still answers");
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

    // ── the worker's door (§5, item 3) ────────────────────────────────

    it("next hands out the type's answer schema with the task", async () => {
      await setup({ answer: MATCH });
      assert.deepEqual((await take("ann")).answer, MATCH);
    });

    it("next { wait } holds until a task the worker may take is made; with none it answers none when the wait runs out", async () => {
      await setup({ n: 0 });
      const started = Date.now();
      assert.deepEqual(await tasks().next("bob", { wait: 0.1 }), { none: true });
      assert.ok(Date.now() - started >= 90, "held for the wait");
      const held = tasks().next("ann", { wait: 5 });
      await new Promise((r) => setTimeout(r, 20));
      const [t] = await setup({ n: 1, workers: [] });
      const got = (await held) as WorkerTask;
      assert.equal(got.type, "pet-match");
      assert.equal((await tasks().task(t.id))!.leases[0].worker, "ann");
      await assert.rejects(tasks().next("ann", { wait: 26 }), refused("bad_request", /wait/));
    });

    it("a task made wakes one waiter; a waiter that cannot take it hands the wake on", async () => {
      await setup({ n: 1, workers: ["carol", "dan", "ann"] });
      const c = await take("carol");
      await tasks().skip("carol", { lease: c.lease });
      const d = await take("dan");
      // carol waits first, but never gets the task she skipped; ann waits next.
      const carol = tasks().next("carol", { wait: 0.4 });
      await new Promise((r) => setTimeout(r, 10));
      const ann = tasks().next("ann", { wait: 5 });
      await new Promise((r) => setTimeout(r, 10));
      const t0 = Date.now();
      await tasks().skip("dan", { lease: d.lease });
      const got = (await ann) as WorkerTask;
      assert.deepEqual(got.show, { i: 0 });
      assert.ok(Date.now() - t0 < 300, "handed on at once, not at carol's timeout");
      assert.deepEqual(await carol, { none: true });
    });

    it("a grant wakes the worker's own held wait", async () => {
      await setup({ n: 0, workers: ["ann"] });
      await tasks().setType("other-type", { app: "workers", answer: MATCH });
      await tasks().ensure({ type: "other-type", workflow: "w", runId: "r9", path: "w/ask", show: { o: 1 } });
      const held = tasks().next("ann", { wait: 5, app: "workers" });
      await new Promise((r) => setTimeout(r, 20));
      const t0 = Date.now();
      await tasks().grant("ann", "other-type");
      const got = (await held) as WorkerTask;
      assert.equal(got.type, "other-type");
      assert.ok(Date.now() - t0 < 300);
    });

    it("next with no type gives the oldest task of any type the worker holds in the calling app, never another app's", async () => {
      await setup({ n: 0, workers: ["ann"] });
      await tasks().setType("elsewhere", { app: "other-app", answer: MATCH });
      await tasks().setType("second", { app: "workers", answer: MATCH });
      await tasks().grant("ann", "elsewhere");
      await tasks().grant("ann", "second");
      const ask = (type: string, path: string) => tasks().ensure({ type, workflow: "w", runId: "r1", path, show: { path } });
      await ask("elsewhere", "w/a");
      clock += 1;
      await ask("second", "w/b");
      clock += 1;
      await ask("pet-match", "w/c");
      const first = await take("ann", { app: "workers" });
      assert.equal(first.type, "second", "the oldest of the app's types");
      await tasks().submit("ann", { lease: first.lease, answer: { same: true } });
      assert.equal((await take("ann", { app: "workers" })).type, "pet-match");
      await assert.rejects(tasks().next("ann", { app: "workers", type: "elsewhere" }), refused("wrong_app"));
    });

    it("submit, skip and file refuse a lease of a type another app draws", async () => {
      await setup({ answer: MATCH, app: "workers" });
      const l = await take("ann", { app: "workers" });
      await assert.rejects(tasks().submit("ann", { lease: l.lease, answer: { same: true }, app: "other-app" }), refused("wrong_app"));
      await assert.rejects(tasks().skip("ann", { lease: l.lease, app: "other-app" }), refused("wrong_app"));
      await assert.rejects(tasks().file("ann", { lease: l.lease, path: "found-0.jpg", app: "other-app" }), refused("wrong_app"));
      assert.deepEqual(await tasks().submit("ann", { lease: l.lease, answer: { same: true }, app: "workers" }), { ok: true });
    });

    it("the store's limit: 120 calls a minute per worker, a held wait counted once", async () => {
      await setup({ n: 0, workers: ["ann"] });
      for (let i = 0; i < 118; i++) await tasks().me("ann");
      const held = tasks().next("ann", { wait: 0.3 }); // call 119
      await new Promise((r) => setTimeout(r, 20));
      // Woken twice: attempts, not calls.
      await tasks().setType("pet-match", { app: "workers", answer: BOX });
      await tasks().setType("pet-match", { app: "workers", answer: BOX });
      assert.deepEqual(await held, { none: true });
      await tasks().me("ann"); // 120
      await assert.rejects(tasks().me("ann"), refused("too_many", /120 task calls a minute/));
      await tasks().me("bob");
      clock += MIN;
      await tasks().me("ann");
    });

    it("deleting a type: refused while a task of it is open; then gone, its grants revoked", async () => {
      const [t] = await setup({ answer: MATCH });
      await assert.rejects(tasks().deleteType("pet-match"), refused("in_use", /open tasks/));
      await assert.rejects(tasks().deleteType("nope"), refused("unknown_type"));
      const l = await take("ann");
      await tasks().submit("ann", { lease: l.lease, answer: { same: false } });
      assert.deepEqual(await tasks().deleteType("pet-match", "staff"), { name: "pet-match", revoked: 2 });
      assert.deepEqual(await tasks().types(), []);
      assert.deepEqual((await tasks().me("ann")).types, []);
      const grant = (await tasks().workers()).find((w) => w.actor === "ann")!.grants[0];
      assert.deepEqual([grant.revokedBy, grant.why], ["staff", "task type deleted"]);
      assert.equal((await tasks().task(t.id))!.type, "pet-match", "its tasks keep its name");
      // Made again, it starts with no workers.
      await tasks().setType("pet-match", { app: "workers", answer: MATCH });
      assert.deepEqual((await tasks().me("ann")).types, []);
    });

    it("knows from memory who is an active worker: a grant, a suspension and a lift", async () => {
      assert.equal(svc.isActiveWorker("ann"), false);
      await tasks().me("ann");
      assert.equal(svc.isActiveWorker("ann"), false, "new");
      await setup({ n: 0, workers: ["ann"] });
      assert.equal(svc.isActiveWorker("ann"), true);
      await tasks().setWorker("ann", { status: "suspended" });
      assert.equal(svc.isActiveWorker("ann"), false);
      await tasks().setWorker("ann", { status: "active" });
      assert.equal(svc.isActiveWorker("ann"), true);
      if (impl.reopen) {
        await svc.close();
        svc = impl.reopen(dir, now);
        assert.equal(svc.isActiveWorker("ann"), false, "nothing known before the store opens");
        await tasks().types();
        assert.equal(svc.isActiveWorker("ann"), true, "loaded when it opens");
      }
    });

    it("a suspension answers a held wait at once", async () => {
      await setup({ n: 0, workers: ["ann"] });
      const held = tasks().next("ann", { wait: 5 });
      await new Promise((r) => setTimeout(r, 20));
      const t0 = Date.now();
      await tasks().setWorker("ann", { status: "suspended" });
      await assert.rejects(held, refused("not_active", /suspended/));
      assert.ok(Date.now() - t0 < 300);
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

// ── earnings (plans/human-steps.md §8.1) ──────────────────────────────────

const RATE = 100_000; // dollars per bitcoin: 1,000 msat (a sat) is $0.001

interface EarningsImpl {
  name: string;
  stores(dir: string): Promise<TaskStores>;
  exists?(dir: string): boolean;
  ledger(dir: string): Promise<LedgerStore>;
  /** Whether the ledger made a file. */
  ledgerFile?(dir: string): boolean;
}

const earningsImpls: EarningsImpl[] = [
  {
    name: "SQLite",
    stores: (dir) => openTaskStores({ dataDir: dir }),
    exists: (dir) => existsSync(tasksPath(dir)),
    ledger: (dir) => openLedger({ dataDir: dir }),
    ledgerFile: (dir) => existsSync(ledgerPath(dir)),
  },
  { name: "memory", stores: async () => memoryTaskStores(), ledger: async () => new MemoryLedgerStore() },
];

for (const impl of earningsImpls) {
  describe(`earnings: ${impl.name}`, () => {
    let dir: string;
    let clock: number;
    let svc: TasksService;
    let heard: TaskSettled[];
    let ledgerOpen: Promise<LedgerStore> | undefined;
    /** While above 0, the ledger's `pay` throws (and counts down). */
    let failPay: number;
    const now = () => clock;
    const tasks = () => svc.capability;
    const ledger = async (): Promise<LedgerStore> => {
      ledgerOpen ??= impl.ledger(dir);
      const l = await ledgerOpen;
      return new Proxy(l, {
        get(target, key) {
          if (key === "pay" && failPay > 0) {
            return async () => {
              failPay--;
              throw new Error("the disk is full");
            };
          }
          const v = Reflect.get(target, key, target) as unknown;
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };
    const make = () =>
      createTasks({
        open: () => impl.stores(dir),
        ...(impl.exists ? { exists: () => impl.exists!(dir) } : {}),
        ledger,
        ledgerIfAny: async () => (ledgerOpen || impl.ledgerFile?.(dir) ? ledger() : null),
        usdPerBtc: async () => RATE,
        now,
      });

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-task-pay-"));
      clock = T0;
      failPay = 0;
      ledgerOpen = undefined;
      svc = make();
      heard = [];
      svc.onSettle((s) => heard.push(...s));
    });
    afterEach(async () => {
      await svc.close();
      await (await ledgerOpen?.catch(() => undefined))?.close();
      await rm(dir, { recursive: true, force: true });
    });

    /** A paid type, its workers, and one task of one run per path. */
    const paid = async (o: { paySats?: number; holdHours?: number; workers?: string[]; paths?: string[] } = {}) => {
      await tasks().setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: o.paySats ?? 21, ...(o.holdHours === undefined ? {} : { holdHours: o.holdHours }) }, "staff");
      for (const w of o.workers ?? ["ann", "bob"]) await tasks().grant(w, "pet-match", "staff");
      const made = [];
      for (const path of o.paths ?? ["pets/review"]) made.push((await tasks().ensure({ type: "pet-match", workflow: "pets", runId: "r1", path })).task);
      return made;
    };
    const take = async (actor: string) => {
      const got = await tasks().next(actor);
      assert.ok(!("none" in got), `${actor} got no task`);
      return got as WorkerTask;
    };

    it("a type's pay and hold: sats to the msat, at most 1,000,000; a hold from 1 to 720 hours, 72 by default", async () => {
      const bad = async (input: Record<string, unknown>) => assert.rejects(tasks().setType("t", { app: "a", answer: MATCH, ...input }), refused("bad_request"));
      await bad({ paySats: -1 });
      await bad({ paySats: 1_000_001 });
      assert.equal((await tasks().setType("t", { app: "a", answer: MATCH, open: false, paySats: 1_000_000 })).paySats, 1_000_000, "the cap itself");
      await bad({ paySats: 1.0005 });
      await bad({ paySats: "21" });
      await bad({ holdHours: 0 });
      await bad({ holdHours: 0.5 });
      await bad({ holdHours: 721 });
      const t = await tasks().setType("t", { app: "a", answer: MATCH, open: false, paySats: 1.234, holdHours: 24 });
      assert.deepEqual([t.paySats, t.holdHours], [1.234, 24]);
      assert.deepEqual([(await tasks().types())[0]!.paySats, (await tasks().types())[0]!.holdHours], [1.234, 24], "as saved");
      const unpaid = await tasks().setType("t", { app: "a", answer: MATCH, paySats: 0 });
      assert.deepEqual([unpaid.paySats, unpaid.holdHours], [undefined, 72], "a PUT: what is left out is the default");
      assert.equal(ledgerOpen, undefined, "saving a type opens no ledger");
    });

    it("next stamps the type's pay on the lease and hands it out; a change of pay after the take leaves the lease's", async () => {
      const [a, b] = await paid({ paySats: 21, paths: ["pets/a", "pets/b"] });
      const ann = await take("ann");
      assert.equal(ann.payMsat, 21_000);
      await tasks().setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 50 }, "staff");
      const bob = await take("bob");
      assert.equal(bob.payMsat, 50_000, "the next lease gets the new pay");
      assert.equal((await take("ann")).payMsat, 21_000, "the lease in hand keeps its own");
      assert.equal((await tasks().task(a!.id))!.leases[0]!.payMsat, 21_000);
      assert.equal((await tasks().task(b!.id))!.leases[0]!.payMsat, 50_000);
      assert.deepEqual((await tasks().me("ann")).types, [{ name: "pet-match", app: "workers", payMsat: 50_000, qualifying: false }], "what the type pays now");
      await tasks().submit("ann", { lease: ann.lease, answer: { same: true } });
      assert.equal((await svc.capability.me("ann")).balance.totalMsat, 21_000, "earns what its lease was stamped with");
    });

    it("a lease taken before the type was paid earns nothing", async () => {
      await tasks().setType("pet-match", { app: "workers", answer: MATCH }, "staff");
      await tasks().grant("ann", "pet-match");
      await tasks().ensure({ type: "pet-match", workflow: "pets", runId: "r1", path: "pets/review" });
      const l = await take("ann");
      assert.equal(l.payMsat, 0);
      await tasks().setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 21 }, "staff");
      await tasks().submit("ann", { lease: l.lease, answer: { same: true } });
      assert.equal(ledgerOpen, undefined, "nothing was booked");
      assert.equal((await svc.sweep()).booked, 0);
    });

    it("a paid answer books once, with the type's hold; an unpaid one books nothing and makes no ledger file", async () => {
      // Unpaid first: nothing reaches the ledger.
      await tasks().setType("free", { app: "workers", answer: MATCH }, "staff");
      await tasks().grant("ann", "free");
      await tasks().ensure({ type: "free", workflow: "pets", runId: "r0", path: "pets/free" });
      const f = await take("ann");
      await tasks().submit("ann", { lease: f.lease, answer: { same: true } });
      assert.equal(ledgerOpen, undefined, "the ledger was never opened");
      if (impl.ledgerFile) assert.equal(impl.ledgerFile(dir), false, "no ledger file");
      assert.deepEqual((await tasks().me("ann")).balance, NOTHING);
      if (impl.ledgerFile) assert.equal(impl.ledgerFile(dir), false, "a balance read makes none either");

      const [t] = await paid({ paySats: 21, holdHours: 24 });
      const l = await take("ann");
      clock += 5 * MIN;
      const answeredAt = clock;
      assert.deepEqual(await tasks().submit("ann", { lease: l.lease, answer: { same: true } }), { ok: true });
      const view = (await tasks().task(t!.id))!;
      assert.equal(view.leases[0]!.bookedAt, answeredAt);
      assert.deepEqual(view.leases[0]!.earning, { msat: 21_000, at: answeredAt, releases: answeredAt + 24 * HOUR });
      const earning = (await (await ledger()).payOf(l.lease))!;
      assert.deepEqual([earning.task, earning.worker, earning.type, earning.workflow, earning.runId, earning.path], [t!.id, "ann", "pet-match", "pets", "r1", "pets/review"]);
      // The hold as the type had it when booked: a later change reaches only later earnings.
      await tasks().setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 21, holdHours: 720 }, "staff");
      assert.equal((await svc.sweep()).booked, 0, "nothing left to book");
      assert.equal((await (await ledger()).payOf(l.lease))!.releases, answeredAt + 24 * HOUR);
      assert.deepEqual((await tasks().me("ann")).balance, { totalMsat: 21_000, heldMsat: 21_000, withdrawableMsat: 0, nextReleaseAt: answeredAt + 24 * HOUR }, "counted once");
      if (impl.ledgerFile) assert.equal(impl.ledgerFile(dir), true, "the first paid answer made the ledger");
    });

    it("a ledger that throws inside submit: the answer is accepted and heard, and the next sweep books it, once", async () => {
      const [t] = await paid();
      const l = await take("ann");
      failPay = 1;
      assert.deepEqual(await tasks().submit("ann", { lease: l.lease, answer: { same: false } }), { ok: true }, "never the worker's");
      assert.deepEqual(heard.map((h) => [h.id, h.status]), [[t!.id, "settled"]], "the run is woken");
      assert.equal(await (await ledger()).payOf(l.lease), undefined, "not booked");
      assert.equal((await tasks().task(t!.id))!.leases[0]!.bookedAt, undefined);
      assert.deepEqual((await tasks().me("ann")).balance, NOTHING);
      assert.equal((await svc.sweep()).booked, 1);
      assert.equal((await svc.sweep()).booked, 0, "once");
      assert.equal((await (await ledger()).payOf(l.lease))!.msat, 21_000);
      assert.equal((await tasks().me("ann")).balance.totalMsat, 21_000);
    });

    it("me answers held, withdrawable and total as the clock passes the hold", async () => {
      await paid({ paySats: 10, holdHours: 1, paths: ["pets/a", "pets/b"] });
      const a = await take("ann");
      await tasks().submit("ann", { lease: a.lease, answer: { same: true } });
      const first = clock;
      clock += 30 * MIN;
      const b = await take("ann");
      await tasks().submit("ann", { lease: b.lease, answer: { same: true } });
      const second = clock;
      assert.deepEqual((await tasks().me("ann")).balance, { totalMsat: 20_000, heldMsat: 20_000, withdrawableMsat: 0, nextReleaseAt: first + HOUR });
      clock = first + HOUR - 1;
      assert.equal((await tasks().me("ann")).balance.heldMsat, 20_000, "held one millisecond before");
      clock = first + HOUR;
      assert.deepEqual((await tasks().me("ann")).balance, { totalMsat: 20_000, heldMsat: 10_000, withdrawableMsat: 10_000, nextReleaseAt: second + HOUR });
      clock = second + HOUR;
      assert.deepEqual((await tasks().me("ann")).balance, { totalMsat: 20_000, heldMsat: 0, withdrawableMsat: 20_000 });
      // A worker's status touches no earning.
      await tasks().setWorker("ann", { status: "banned" }, "staff");
      assert.equal((await tasks().me("ann")).balance.totalMsat, 20_000);
      // Staff read every worker's balance in one read.
      const workers = await tasks().workers();
      assert.deepEqual(Object.fromEntries(workers.map((w) => [w.actor, w.balance.totalMsat])), { ann: 20_000, bob: 0 });
    });

    it("takeBack: inside the hold the earning goes; past it, it is the worker's; again changes nothing", async () => {
      const [a, b, c] = await paid({ paySats: 21, holdHours: 2, paths: ["pets/a", "pets/b", "pets/c"] });
      const la = await take("ann");
      await tasks().submit("ann", { lease: la.lease, answer: { same: true } });
      const lb = await take("bob");
      await tasks().submit("bob", { lease: lb.lease, answer: { same: true } });
      clock += HOUR;
      const taken = await svc.takeBack({ task: a!.id, why: "the wrong dog", by: "admin-1" });
      assert.deepEqual(taken, [{ lease: la.lease, worker: "ann", result: "taken", earning: { msat: 21_000, at: T0, releases: T0 + 2 * HOUR, takenBack: clock, takenBackWhy: "the wrong dog", takenBackBy: "admin-1" } }]);
      assert.deepEqual((await tasks().me("ann")).balance, NOTHING);
      assert.deepEqual((await tasks().task(a!.id))!.leases[0]!.earning?.takenBackWhy, "the wrong dog", "staff see it on the task");
      const again = await svc.takeBack({ task: a!.id, why: "twice", by: "admin-2" });
      assert.deepEqual([again[0]!.result, again[0]!.earning?.takenBackBy], ["taken", "admin-1"], "the first stands");
      assert.deepEqual(await svc.takeBack({ task: b!.id, worker: "ann", why: "not hers" }), [], "only that worker's answers");
      clock = T0 + 2 * HOUR;
      const late = await svc.takeBack({ task: b!.id, why: "too late" });
      assert.deepEqual([late[0]!.worker, late[0]!.result], ["bob", "released"]);
      assert.equal((await tasks().me("bob")).balance.withdrawableMsat, 21_000);
      assert.deepEqual(await svc.takeBack({ task: c!.id, why: "nobody answered" }), [], "no answer, nothing earned");
      await assert.rejects(svc.takeBack({ task: "nope", why: "x" }), refused("unknown_task"));
      await assert.rejects(svc.takeBack({ task: a!.id, why: "  " }), refused("bad_request"));
    });

    it("takeBack books an answer not yet booked first, so it never loses a race with the sweep", async () => {
      const [t] = await paid();
      const l = await take("ann");
      failPay = 1;
      await tasks().submit("ann", { lease: l.lease, answer: { same: true } });
      assert.equal(await (await ledger()).payOf(l.lease), undefined);
      const out = await svc.takeBack({ task: t!.id, why: "a bad answer" });
      assert.equal(out[0]!.result, "taken");
      assert.equal((await (await ledger()).payOf(l.lease))!.takenBackWhy, "a bad answer");
      assert.notEqual((await tasks().task(t!.id))!.leases[0]!.bookedAt, undefined);
      assert.equal((await svc.sweep()).booked, 0, "the sweep finds nothing left");
      assert.deepEqual((await tasks().me("ann")).balance, NOTHING);
    });

    it("an unpaid answer has nothing to take back", async () => {
      await tasks().setType("free", { app: "workers", answer: MATCH }, "staff");
      await tasks().grant("ann", "free");
      const { task } = await tasks().ensure({ type: "free", workflow: "w", runId: "r", path: "w/free" });
      const l = await take("ann");
      await tasks().submit("ann", { lease: l.lease, answer: { same: true } });
      assert.deepEqual(await svc.takeBack({ task: task.id, why: "x" }), [{ lease: l.lease, worker: "ann", result: "none" }]);
    });

    it("ensure answers a settled task with its pay: the lease's stamp and the dollars at the rate now", async () => {
      const [t] = await paid({ paySats: 21 });
      const key = { type: "pet-match", workflow: "pets", runId: "r1", path: "pets/review" };
      assert.equal((await tasks().ensure(key)).pay, undefined, "open: nothing earned yet");
      const l = await take("ann");
      await tasks().submit("ann", { lease: l.lease, answer: { same: true } });
      const got = await tasks().ensure(key);
      assert.equal(got.task.id, t!.id);
      assert.deepEqual(got.pay, { msat: 21_000, usd: 0.021 });
    });

    if (impl.exists) {
      it("a tasks.db made by #655's schema opens, gains the columns and keeps its rows", async () => {
        await svc.close();
        const file = tasksPath(dir);
        await mkdir(join(dir, "tasks"), { recursive: true });
        const db = new DatabaseSync(file);
        db.exec(SCHEMA_655);
        db.exec("PRAGMA user_version = 1");
        db.prepare("insert into task_types values ('pet-match', 'workers', ?, 600, 48, 1, ?, 'staff')").run(JSON.stringify(MATCH), T0);
        db.prepare(
          `insert into tasks (id, type, workflow, run_id, path, show, files, root, status, created, due)
           values ('t1', 'pet-match', 'pets', 'r1', 'pets/review', '{}', '[]', 'run', 'open', ?, ?)`,
        ).run(T0, T0 + 48 * HOUR);
        db.prepare("insert into leases (id, task, worker, type, taken, expires, status) values ('l1', 't1', 'ann', 'pet-match', ?, ?, 'open')").run(T0, T0 + 10 * MIN);
        db.close();

        svc = make();
        const types = await tasks().types();
        assert.deepEqual([types[0]!.name, types[0]!.paySats, types[0]!.holdHours, types[0]!.open], ["pet-match", undefined, 72, true], "an old type is unpaid, with the default hold, and open (ruling 9)");
        const view = (await tasks().task("t1"))!;
        assert.deepEqual([view.status, view.leases[0]!.id, view.leases[0]!.payMsat], ["open", "l1", undefined], "its rows kept; the old lease earns nothing");
        await svc.close();
        const after = new DatabaseSync(file);
        try {
          const cols = (table: string) => (after.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
          for (const c of ["pay_msat", "hold_hours", "invite_only"]) assert.ok(cols("task_types").includes(c), c);
          for (const c of ["pay_msat", "booked_at"]) assert.ok(cols("leases").includes(c), c);
          assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2, "brought to schema 2 (plans/human-steps.md §7.7)");
        } finally {
          after.close();
        }
        svc = make();
        await tasks().setType("pet-match", { app: "workers", answer: MATCH, open: false, paySats: 5 }, "staff");
        assert.equal((await tasks().types())[0]!.paySats, 5, "and takes pay now");
      });
    }
  });
}

/** The task side's tables as #655 made them, before pay (§8.1). */
const SCHEMA_655 = `
create table task_types (name text primary key, app text not null, answer text not null, lease_seconds integer not null,
  within_hours real not null, enabled integer not null, changed_at integer not null, changed_by text) strict;
create table tasks (seq integer primary key autoincrement, id text not null unique, type text not null, workflow text not null,
  run_id text not null, path text not null, show text not null, files text not null, root text not null check (root in ('run', 'job')),
  job text, status text not null check (status in ('open', 'settled', 'expired', 'cancelled')), created integer not null,
  due integer not null, settled_at integer, answer text, by text, unique (workflow, run_id, path)) strict;
create table leases (id text primary key, task text not null, worker text not null, type text not null, taken integer not null,
  expires integer not null, status text not null check (status in ('open', 'submitted', 'expired', 'skipped')), closed integer,
  reason text, unique (task, worker)) strict;
`;

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
      assert.deepEqual(Object.keys(tasks), ["ensure"], "the human step's call alone (§9.2)");
      const { task, created } = await tasks.ensure({ type: cfg.type, workflow: workflowOf(ctx!), runId: ctx!.runId, path: ctx!.path, show: { hi: 1 } });
      return { id: task.id, created };
    },
  });

  it("is ctx.services.tasks (ensure alone), and makes <dataDir>/tasks/tasks.db only once used", async () => {
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

describe("task/file's read (§5.5): only a path on the task's list, through the worker's own live lease", () => {
  it("reads through the deps for a listed path; refuses one off the list whether or not it exists, and another worker's lease", async () => {
    const read: string[] = [];
    const svc = createTasks({
      open: async () => memoryTaskStores(),
      file: async (t, path) => {
        read.push(`${t.runId}:${path}`);
        return path === "gone.jpg" ? null : { path, mediaType: "image/jpeg", bytes: 3, base64: "AAAA" };
      },
    });
    const tasks = svc.capability;
    try {
      await tasks.setType("pet-match", { app: "workers", answer: MATCH });
      await tasks.grant("ann", "pet-match");
      await tasks.grant("bob", "pet-match");
      await tasks.ensure({ type: "pet-match", workflow: "w", runId: "r1", path: "w/review", files: ["found.jpg", "gone.jpg"] });
      const l = (await tasks.next("ann")) as WorkerTask;
      assert.deepEqual(l.files, ["found.jpg", "gone.jpg"]);
      assert.deepEqual(await tasks.file("ann", { lease: l.lease, path: "found.jpg", app: "workers" }), { path: "found.jpg", mediaType: "image/jpeg", bytes: 3, base64: "AAAA" });
      await assert.rejects(tasks.file("ann", { lease: l.lease, path: "secret.txt" }), refused("not_listed"));
      await assert.rejects(tasks.file("ann", { lease: l.lease, path: "../found.jpg" }), refused("not_listed"));
      await assert.rejects(tasks.file("ann", { lease: l.lease, path: "gone.jpg" }), refused("no_file", /no longer there/));
      await assert.rejects(tasks.file("bob", { lease: l.lease, path: "found.jpg" }), refused("no_lease"));
      await tasks.submit("ann", { lease: l.lease, answer: { same: true } });
      await assert.rejects(tasks.file("ann", { lease: l.lease, path: "found.jpg" }), refused("lease_closed"));
      assert.deepEqual(read, ["r1:found.jpg", "r1:gone.jpg"], "nothing off the list, nothing past the lease, was read");
    } finally {
      await svc.close();
    }
  });
});
