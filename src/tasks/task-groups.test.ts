import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type TaskErrorCode, type TasksService, type WorkerTask } from "./tasks.js";
import { MemoryLedgerStore } from "../payments/ledger-memory.js";
import { RunController } from "../run-control.js";

/**
 * Groups of tasks: a run names the deliverable its task is part of with
 * `task/reply`'s `group` (a book its pages); staff read a group's tasks and
 * counts and mark its unreviewed answers at once; a worker reads their own
 * groups and every answer of one, each with staff's verdict and why — what
 * to fix. Staff mark a group done or open again. One suite over the SQLite
 * file and the memory twin, through the service; the routes and steps are
 * in src/apps/workers.test.ts.
 */

const T0 = Date.parse("2026-11-19T20:00:00Z");
const MIN = 60_000;
const NONE = { type: "object", properties: {} };

const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));

for (const impl of ["SQLite", "memory"] as const) {
  describe(`groups of tasks: ${impl}`, () => {
    let dir: string;
    let clock: number;
    let svc: TasksService;
    let ledger: MemoryLedgerStore;
    const tasks = () => svc.capability;
    const make = () =>
      createTasks({
        ...(impl === "SQLite" ? { open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)) } : { open: async () => memoryTaskStores() }),
        now: () => clock,
        ledger: async () => ledger,
        ledgerIfAny: async () => ledger,
        principal: "client",
      });
    /** What the run's step carries: the store reads the run off it. */
    const here = new RunController("r1", "scan").forUnit();

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-task-groups-"));
      clock = T0;
      ledger = new MemoryLedgerStore();
      svc = make();
      // Paid, with a hold: a rejection takes the page's pay back.
      await tasks().setType("page", { app: "scanner", answer: NONE, open: false, paySats: 4, holdHours: 72 }, "staff");
      await tasks().setType("label", { app: "scanner", answer: NONE, open: false }, "staff");
      for (const w of ["ann", "bob"]) for (const t of ["page", "label"]) await tasks().grant(w, t, "staff");
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    let n = 0;
    /** One task of `type` asked by run r1, answered by `worker`, then told its group. */
    const page = async (worker: string, group: string | undefined, type = "page") => {
      const t = (await tasks().ensure({ type, workflow: "scan", runId: "r1", path: `scan/ask#${n++}` })).task;
      const l = (await tasks().next(worker, { app: "scanner", type })) as WorkerTask;
      clock += MIN;
      await tasks().submit(worker, { lease: l.lease, answer: {} });
      if (group !== undefined) await tasks().reply({ task: t.id, show: { page: n }, group }, { control: here });
      return { task: t.id, lease: l.lease };
    };

    it("a run names its task's group with its reply; a group alone keeps what was told, a reply alone keeps the group", async () => {
      const p = await page("ann", undefined);
      await tasks().reply({ task: p.task, show: { note: "cover" } }, { control: here });
      await tasks().reply({ task: p.task, group: "  Taliesin · John  " }, { control: here });
      let t = (await tasks().task(p.task))!;
      assert.deepEqual([t.group, t.reply?.show], ["Taliesin · John", { note: "cover" }], "trimmed; the reply as it was");
      await tasks().reply({ task: p.task, show: { note: "again" } }, { control: here });
      t = (await tasks().task(p.task))!;
      assert.deepEqual([t.group, t.reply?.show], ["Taliesin · John", { note: "again" }], "the group stays");
      for (const bad of ["", "   ", "a\nb", "x".repeat(201)]) {
        await assert.rejects(tasks().reply({ task: p.task, group: bad }, { control: here }), refused("bad_request", /group is a name/), JSON.stringify(bad));
      }
      await assert.rejects(tasks().reply({ task: p.task }, { control: here }), refused("bad_request", /show, files, a group or a verdict/));
      // Only the run that asked, as for any reply.
      await assert.rejects(tasks().reply({ task: p.task, group: "other" }, { control: new RunController("r2", "scan").forUnit() }), refused("unknown_task"));
      assert.equal((await tasks().task(p.task))!.group, "Taliesin · John");
    });

    it("staff read the groups — newest first, by type — and a group's tasks; one call marks its unreviewed answers", async () => {
      const a1 = await page("ann", "Taliesin");
      const a2 = await page("ann", "Taliesin");
      const a3 = await page("ann", "Taliesin");
      await page("bob", "Wild Game");
      await page("ann", "Wild Game", "label");
      await page("bob", undefined);

      const groups = await tasks().groups!();
      assert.deepEqual(
        groups.map((g) => [g.type, g.group, g.tasks, g.answers, g.unreviewed, g.workers]),
        [
          ["label", "Wild Game", 1, 1, 1, ["ann"]],
          ["page", "Wild Game", 1, 1, 1, ["bob"]],
          ["page", "Taliesin", 3, 3, 3, ["ann"]],
        ],
        "one row a type and group, the newest task's first; a task with no group in none",
      );
      const tal = groups[2]!;
      assert.deepEqual([tal.first, tal.last], [T0, T0 + 3 * MIN], "made when its first task was; last answered when its newest was");
      assert.deepEqual((await tasks().groups!({ type: "page" })).map((g) => g.group), ["Wild Game", "Taliesin"]);
      assert.deepEqual((await tasks().list({ group: "Taliesin" })).map((t) => t.id), [a3.task, a2.task, a1.task], "a group's tasks, newest first");
      assert.deepEqual((await tasks().list({ group: "Wild Game", type: "label" })).length, 1);

      // A page rejected first; then the rest marked ok at once — the rejection stays.
      await svc.review({ task: a2.task, verdict: "rejected", why: "blurry", by: "ada" });
      await assert.rejects(svc.reviewGroup({ group: "Taliesin", verdict: "rejected" }), refused("bad_request", /says why/));
      await assert.rejects(svc.reviewGroup({ group: " ", verdict: "ok" }), refused("bad_request", /group is a name/));
      assert.deepEqual(await svc.reviewGroup({ group: "Taliesin", type: "page", verdict: "ok", by: "ada" }), { reviewed: 2, more: false });
      assert.deepEqual(await svc.reviewGroup({ group: "Taliesin", verdict: "ok", by: "ada" }), { reviewed: 0, more: false }, "nothing left to mark");
      const after = (await tasks().groups!({ type: "page" })).find((g) => g.group === "Taliesin")!;
      assert.deepEqual([after.ok, after.rejected, after.unreviewed], [2, 1, 0]);
      const verdicts = (await tasks().list({ group: "Taliesin" })).map((t) => [t.id, t.leases[0]!.review?.verdict, t.leases[0]!.review?.by]);
      assert.deepEqual(verdicts, [
        [a3.task, "ok", "ada"],
        [a2.task, "rejected", "ada"],
        [a1.task, "ok", "ada"],
      ]);
      // The other type's group of the same name is untouched by a typed call.
      assert.equal((await tasks().groups!({ type: "label" }))[0]!.unreviewed, 1);
      // The rejected page's pay was taken back, inside its hold.
      assert.equal((await ledger.payOf(a2.lease))?.takenBack !== undefined, true);
      assert.equal((await ledger.payOf(a1.lease))?.takenBack, undefined);
    });

    it("a worker reads their groups and every answer of one, with staff's verdict and why; never another's", async () => {
      const a1 = await page("ann", "Taliesin");
      const a2 = await page("ann", "Taliesin");
      await page("bob", "Taliesin");
      await page("ann", "Wild Game");
      await svc.review({ task: a1.task, verdict: "rejected", why: "the page is cut off", by: "ada" });
      await svc.review({ task: a2.task, verdict: "ok", by: "ada" });

      const h = await tasks().history("ann", { app: "scanner", groups: true });
      assert.deepEqual(
        h.groups!.map((g) => [g.group, g.tasks, g.answers, g.ok, g.rejected, g.unreviewed, "workers" in g]),
        [
          ["Wild Game", 1, 1, 0, 0, 1, false],
          ["Taliesin", 2, 2, 1, 1, 0, false],
        ],
        "their own answers alone, and never who else answered",
      );
      const byLease = new Map(h.items.map((i) => [i.lease, i]));
      assert.deepEqual(byLease.get(a1.lease)!.review, { verdict: "rejected", why: "the page is cut off", at: T0 + 4 * MIN });
      assert.deepEqual([byLease.get(a1.lease)!.group, byLease.get(a2.lease)!.review?.verdict], ["Taliesin", "ok"]);
      assert.equal("by" in byLease.get(a1.lease)!.review!, false, "never who gave it");
      assert.equal((await tasks().history("ann", { app: "scanner" })).groups, undefined, "groups only when asked");

      const one = await tasks().history("ann", { app: "scanner", group: "Taliesin" });
      assert.deepEqual(one.items.map((i) => i.lease), [a2.lease, a1.lease], "their answers in it, newest first; bob's not");
      assert.deepEqual((await tasks().history("bob", { app: "scanner", group: "Wild Game" })).items, []);
      assert.deepEqual((await tasks().history("ann", { app: "other", groups: true })).groups, [], "another app's types are not this app's");
    });

    it("staff mark a group done or open again, the newest change with who, when and why; the list filters by it", async () => {
      await page("ann", "Taliesin");
      await page("ann", "Wild Game");
      await page("ann", "Wild Game", "label");
      const of = async (group: string, type = "page") => (await tasks().groups!({ type, group }))[0]!;
      assert.deepEqual([(await of("Taliesin")).status, "statusAt" in (await of("Taliesin"))], ["open", false], "open until set");

      clock += MIN;
      const done = await svc.setGroupStatus({ type: "page", group: " Taliesin ", status: "done", why: " all pages in ", by: "ada" });
      assert.deepEqual([done.group, done.tasks, done.status, done.statusAt, done.statusBy, done.why], ["Taliesin", 1, "done", T0 + 4 * MIN, "ada", "all pages in"]);
      assert.deepEqual(await of("Taliesin"), done, "the list reads it so");
      assert.equal((await of("Wild Game", "label")).status, "open");
      assert.deepEqual((await tasks().groups!({ status: "done", limit: 1 })).map((g) => g.group), ["Taliesin"], "filtered before the page: the oldest group, at a limit of 1");
      assert.deepEqual((await tasks().groups!({ status: "open" })).map((g) => [g.type, g.group]), [["label", "Wild Game"], ["page", "Wild Game"]]);

      clock += MIN;
      const open = await svc.setGroupStatus({ type: "page", group: "Taliesin", status: "open", by: "bea" });
      assert.deepEqual([open.status, open.statusAt, open.statusBy, "why" in open], ["open", T0 + 5 * MIN, "bea", false], "the newest change's why, not an earlier one's");
      assert.deepEqual(await tasks().groups!({ status: "done" }), []);

      await assert.rejects(svc.setGroupStatus({ type: "page", group: "Taliesin", status: "closed" as never }), refused("bad_request", /status is open or done/));
      await assert.rejects(svc.setGroupStatus({ type: "page", group: "Nope", status: "done" }), refused("unknown_group"));
      await assert.rejects(svc.setGroupStatus({ type: "label", group: "Taliesin", status: "done" }), refused("unknown_group"), "a group is of one type");
      await assert.rejects(svc.setGroupStatus({ type: "page", group: " ", status: "done" }), refused("bad_request", /group is a name/));
      await assert.rejects(tasks().groups!({ status: "closed" as never }), refused("bad_request", /status is open or done/));
    });

    it("a worker's groups carry the status staff set and why, never who set it", async () => {
      await page("ann", "Taliesin");
      await svc.setGroupStatus({ type: "page", group: "Taliesin", status: "done", why: "all pages in", by: "ada" });
      const g = (await tasks().history("ann", { app: "scanner", groups: true })).groups![0]!;
      assert.deepEqual([g.status, g.statusAt, g.why, "statusBy" in g, "workers" in g], ["done", T0 + MIN, "all pages in", false, false]);
    });

    it("a group's answers past the newest 50 are all read", async () => {
      const first = await page("ann", "Long book");
      for (let i = 0; i < 54; i++) await page("ann", "Long book");
      await page("ann", "Other");
      assert.equal((await tasks().history("ann", { app: "scanner" })).items.length, 50, "the dashboard's newest 50");
      const all = await tasks().history("ann", { app: "scanner", group: "Long book" });
      assert.equal(all.items.length, 55);
      assert.equal(all.items.at(-1)!.lease, first.lease);
    });
  });
}

describe("groups of tasks: a tasks.db from before a group's status", () => {
  it("opens with every group open, gains the table and keeps every change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-task-groups-old-"));
    try {
      const make = () => createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)), now: () => T0 });
      let svc = make();
      await svc.capability.setType("page", { app: "scanner", answer: NONE, open: false }, "staff");
      await svc.capability.grant("ann", "page", "staff");
      const t = (await svc.capability.ensure({ type: "page", workflow: "scan", runId: "r1", path: "scan/ask" })).task;
      const l = (await svc.capability.next("ann", { app: "scanner", type: "page" })) as WorkerTask;
      await svc.capability.submit("ann", { lease: l.lease, answer: {} });
      await svc.capability.reply({ task: t.id, group: "Taliesin" }, { control: new RunController("r1", "scan").forUnit() });
      await svc.close();
      // As a strut before this one left it: no `task_group_status` table.
      const db = new DatabaseSync(tasksPath(dir));
      db.exec("drop index task_group_status_key; drop table task_group_status");
      db.close();
      svc = make();
      assert.deepEqual((await svc.capability.groups!()).map((g) => [g.group, g.status]), [["Taliesin", "open"]]);
      await svc.setGroupStatus({ type: "page", group: "Taliesin", status: "done", why: "all in", by: "ada" });
      await svc.setGroupStatus({ type: "page", group: "Taliesin", status: "open", by: "bea" });
      await svc.close();
      const again = new DatabaseSync(tasksPath(dir));
      const rows = again.prepare("select type, group_key, status, why, by, at from task_group_status order by rowid").all().map((r) => ({ ...r }));
      again.close();
      assert.deepEqual(rows, [
        { type: "page", group_key: "Taliesin", status: "done", why: "all in", by: "ada", at: T0 },
        { type: "page", group_key: "Taliesin", status: "open", why: null, by: "bea", at: T0 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
