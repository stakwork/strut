import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type TaskErrorCode, type TasksService, type WorkerTask } from "./tasks.js";
import { DEFAULT_LIFECYCLE, groupRuleOf, keyFromAnswer, moveProblem, movesFor } from "./task-groups.js";
import { RunController } from "../run-control.js";

/**
 * Task groups' lifecycle: a type that manages its groups gives each key a
 * row (status, owner, history), moved by its owner and by an admin as the
 * lifecycle says. One suite over the SQLite file and the memory twin, through
 * the service; the routes' are in group-routes.test.ts.
 */

const T0 = Date.parse("2026-11-19T20:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const NONE = { type: "object", properties: { title: { type: "string" }, author: { type: "string" } } };
const refused = (code: TaskErrorCode, re?: RegExp) => (e: unknown) => e instanceof TaskError && e.code === code && (!re || re.test(e.message));
const MANAGED = { lifecycle: "default" } as const;

describe("the default lifecycle (pure)", () => {
  const rule = groupRuleOf(MANAGED)!;
  /** The book ledger's status table, written out: the oracle every pair is read against. */
  const ORACLE: Record<string, Record<string, { by: Array<"owner" | "admin">; reason?: true }>> = {
    open: { submitted: { by: ["owner", "admin"] }, abandoned: { by: ["admin"], reason: true } },
    reopened: { submitted: { by: ["owner", "admin"] }, abandoned: { by: ["admin"], reason: true } },
    submitted: { accepted: { by: ["admin"] }, rejected: { by: ["admin"], reason: true }, reopened: { by: ["owner", "admin"] }, abandoned: { by: ["admin"], reason: true } },
    rejected: { submitted: { by: ["owner", "admin"] }, reopened: { by: ["owner", "admin"] }, abandoned: { by: ["admin"], reason: true } },
    accepted: { reopened: { by: ["admin"] } },
    abandoned: { reopened: { by: ["admin"] } },
  };

  it("every from, to and role gives what the table says", () => {
    for (const from of DEFAULT_LIFECYCLE.statuses) {
      for (const to of DEFAULT_LIFECYCLE.statuses) {
        for (const role of ["owner", "admin"] as const) {
          const want = ORACLE[from]?.[to];
          const got = moveProblem(rule, from, to, role, "because");
          assert.equal(got === undefined, !!want && want.by.includes(role), `${from} -> ${to} by ${role}`);
          if (want?.reason) assert.equal(moveProblem(rule, from, to, role, "  ")?.code ?? "ok", want.by.includes(role) ? "reason_required" : "bad_move", `${from} -> ${to} needs a reason`);
        }
      }
    }
    assert.deepEqual(movesFor(rule, "submitted", "owner").map((m) => m.to), ["reopened"]);
    assert.deepEqual(movesFor(rule, "submitted", "admin").map((m) => [m.to, m.reason]), [["accepted", false], ["rejected", true], ["reopened", false], ["abandoned", true]]);
  });

  it("a type's own lifecycle and options are checked when it is saved", () => {
    assert.equal(groupRuleOf(null), undefined);
    assert.throws(() => groupRuleOf({ nope: 1 }), /not nope/);
    assert.throws(() => groupRuleOf({ lifecycle: { statuses: ["a"], initial: "b", moves: [] } }), /initial/);
    assert.throws(() => groupRuleOf({ lifecycle: { statuses: ["a", "b"], initial: "a", moves: [{ from: "a", to: "c", by: ["admin"] }] } }), /between its statuses/);
    assert.throws(() => groupRuleOf({ lifecycle: { statuses: ["a", "b"], initial: "a", moves: [{ from: "a", to: "b", by: ["staff"] }] } }), /by is a list/);
    assert.throws(() => groupRuleOf({ onEnter: { nowhere: { review: "ok" } } }), /not a status/);
    assert.throws(() => groupRuleOf({ idleHours: 0 }), /idleHours/);
    assert.throws(() => groupRuleOf({ keyFrom: "no fields" }), /keyFrom/);
    assert.deepEqual(groupRuleOf({ lifecycle: "default", onEnter: { accepted: { review: "ok" } }, idleHours: 5 }), { lifecycle: "default", idleHours: 5, onEnter: { accepted: { review: "ok" } } });
  });

  it("keyFrom reads the answer's fields, trimmed, and gives none when one is missing", () => {
    assert.equal(keyFromAnswer("{title}|{author}", { title: "  Wild   Game ", author: "Adrienne" }, 200), "Wild Game|Adrienne");
    assert.equal(keyFromAnswer("{book.title}", { book: { title: "X" } }, 200), "X");
    assert.equal(keyFromAnswer("{title}|{author}", { title: "Wild Game" }, 200), undefined);
    assert.equal(keyFromAnswer("{title}", { title: "x".repeat(300) }, 200), undefined);
  });
});

for (const impl of ["SQLite", "memory"] as const) {
  describe(`managed groups: ${impl}`, () => {
    let dir: string;
    let clock: number;
    let svc: TasksService;
    const tasks = () => svc.capability;
    const make = () =>
      createTasks({
        ...(impl === "SQLite" ? { open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)) } : { open: async () => memoryTaskStores() }),
        now: () => clock,
        principal: "client",
      });
    const here = new RunController("r1", "scan").forUnit();
    let n = 0;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-group-lifecycle-"));
      clock = T0;
      svc = make();
      await tasks().setType("page", { app: "scanner", answer: NONE, open: false, groups: { ...MANAGED } }, "staff");
      await tasks().setType("plain", { app: "scanner", answer: NONE, open: false }, "staff");
      for (const w of ["ann", "bob"]) for (const t of ["page", "plain"]) await tasks().grant(w, t, "staff");
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    /** One task asked by run r1, answered by `worker`, then told its group (or none). */
    const page = async (worker: string, group: string | undefined, o: { type?: string; answer?: unknown } = {}) => {
      const type = o.type ?? "page";
      const t = (await tasks().ensure({ type, workflow: "scan", runId: "r1", path: `scan/ask#${n++}` })).task;
      const l = (await tasks().next(worker, { app: "scanner", type })) as WorkerTask;
      clock += MIN;
      await tasks().submit(worker, { lease: l.lease, answer: o.answer ?? {} });
      if (group !== undefined) await tasks().reply({ task: t.id, show: { n }, group }, { control: here });
      else if (o.answer) await tasks().reply({ task: t.id, show: { n } }, { control: here });
      return t.id;
    };
    const rowOf = async (key: string) => (await tasks().groups!({ type: "page" })).find((g) => g.group === key)!;
    const adminMove = (key: string, to: string, reason?: string) => svc.groupSet({ type: "page", group: key, to, ...(reason ? { reason } : {}), by: "ada" });

    it("the first page makes the group, owned by whoever sent it; later pages and other workers change nothing", async () => {
      await page("ann", "Wild Game");
      clock += MIN;
      await page("bob", "Wild Game");
      const g = await rowOf("Wild Game");
      assert.deepEqual([g.status, g.owner, g.tasks, g.virtual, g.id?.startsWith("grp_")], ["open", "ann", 2, undefined, true]);
      const d = (await svc.groupDetail(g.id!))!;
      assert.deepEqual(d.events.map((e) => [e.from, e.to, e.role, e.source]), [[undefined, "open", "system", "api"]]);
      assert.equal(d.tasks.length, 2);
      // A type that manages none makes no row.
      await page("ann", "Wild Game", { type: "plain" });
      assert.equal((await tasks().groups!({ type: "plain" }))[0]!.status, undefined);
    });

    it("an owner submits and reopens their own group; everything else is an admin's", async () => {
      await page("ann", "Book");
      const move = (actor: string, to: string, reason?: string) => svc.worker.groupMove!(actor, { type: "page", group: "Book", to, ...(reason ? { reason } : {}), app: "scanner" });
      assert.equal((await move("ann", "submitted")).group.status, "submitted");
      await assert.rejects(move("bob", "reopened"), refused("not_owner"));
      await assert.rejects(move("ann", "accepted"), refused("bad_move", /by admin/));
      await assert.rejects(move("ann", "abandoned", "x"), refused("bad_move"));
      assert.equal((await move("ann", "reopened")).group.status, "reopened");
      await move("ann", "submitted");
      // The admin's: reason where required, and no move the table lacks.
      await assert.rejects(adminMove("Book", "rejected"), refused("reason_required"));
      await assert.rejects(adminMove("Book", "open"), refused("bad_move", /cannot become/));
      const r = await adminMove("Book", "rejected", "page 3 is cut off");
      assert.deepEqual([r.group.status, r.event.reason, r.event.role, r.event.actor], ["rejected", "page 3 is cut off", "admin", "ada"]);
      await move("ann", "reopened");
      await move("ann", "submitted");
      await adminMove("Book", "accepted");
      // An accepted group is reopened by an admin, never its owner.
      await assert.rejects(move("ann", "reopened"), refused("bad_move"));
      assert.equal((await adminMove("Book", "reopened")).group.status, "reopened");
      const g = await rowOf("Book");
      assert.deepEqual((await svc.groupDetail(g.id!))!.events.map((e) => [e.to, e.role, e.actor]), [
        ["open", "system", "ann"],
        ["submitted", "owner", "ann"],
        ["reopened", "owner", "ann"],
        ["submitted", "owner", "ann"],
        ["rejected", "admin", "ada"],
        ["reopened", "owner", "ann"],
        ["submitted", "owner", "ann"],
        ["accepted", "admin", "ada"],
        ["reopened", "admin", "ada"],
      ]);
    });

    it("the worker's read of their groups says status and whether they own it, and no other worker's", async () => {
      await page("ann", "Book");
      await page("bob", "Book");
      const mine = (await tasks().history("ann", { app: "scanner", groups: true })).groups![0]!;
      const theirs = (await tasks().history("bob", { app: "scanner", groups: true })).groups![0]!;
      assert.deepEqual([mine.status, mine.mine, theirs.status, theirs.mine], ["open", true, "open", false]);
      assert.equal("owner" in mine || "moves" in mine || "workers" in mine, false, "no who and no staff's moves");
      await assert.rejects(svc.worker.groupMove!("ann", { type: "page", group: "Nope", to: "submitted", app: "scanner" }), refused("unknown_group"));
      await assert.rejects(svc.worker.groupMove!("ann", { type: "page", group: "Book", to: "submitted", app: "other" }), refused("unknown_group"), "another app's type");
      await assert.rejects(svc.worker.groupMove!("ann", { type: "plain", group: "Book", to: "submitted", app: "scanner" }), refused("unknown_group"), "a type that manages none");
    });

    it("a finished group takes no new page; reopening takes it again; a group with no row is never refused", async () => {
      await page("ann", "Book");
      await adminMove("Book", "submitted");
      const late = (await tasks().ensure({ type: "page", workflow: "scan", runId: "r1", path: "late" })).task;
      const l = (await tasks().next("ann", { app: "scanner", type: "page" })) as WorkerTask;
      await tasks().submit("ann", { lease: l.lease, answer: {} });
      await assert.rejects(tasks().reply({ task: late.id, group: "Book", show: {} }, { control: here }), refused("group_closed", /submitted/));
      assert.equal((await tasks().task(late.id))!.group, undefined);
      await adminMove("Book", "reopened");
      await tasks().reply({ task: late.id, group: "Book", show: {} }, { control: here });
      assert.equal((await tasks().task(late.id))!.group, "Book");
      // A page already in the group may be told again while it is closed.
      await adminMove("Book", "submitted");
      await tasks().reply({ task: late.id, group: "Book", show: { again: true } }, { control: here });
      // Legacy: a group named before the type managed groups has no row: open to new pages, read as open.
      await tasks().setType("page", { app: "scanner", answer: NONE, open: false }, "staff");
      await page("bob", "Old book");
      await tasks().setType("page", { app: "scanner", answer: NONE, open: false, groups: { ...MANAGED } }, "staff");
      const old = await rowOf("Old book");
      assert.deepEqual([old.virtual, old.status, old.id], [true, "open", undefined]);
      await page("bob", "Old book");
      assert.equal((await rowOf("Old book")).virtual, true, "a new page of an old group makes no row");
      // The first admin move makes its row, owned by its first answerer.
      const moved = await adminMove("Old book", "submitted");
      assert.deepEqual([moved.group.status, moved.group.owner, moved.group.virtual], ["submitted", "bob", undefined]);
      await assert.rejects(adminMove("No such", "submitted"), refused("unknown_group"));
    });

    it("keyFrom names the group from the answer when the run names none; the run's own name wins", async () => {
      await tasks().setType("page", { app: "scanner", answer: NONE, open: false, groups: { lifecycle: "default", keyFrom: "{title}|{author}" } }, "staff");
      const a = await page("ann", undefined, { answer: { title: "Wild Game", author: "Adrienne" } });
      assert.equal((await tasks().task(a))!.group, "Wild Game|Adrienne");
      await page("ann", undefined, { answer: { title: "No author" } });
      assert.equal((await tasks().groups!({ type: "page" })).length, 1, "a missing field names nothing");
      const c = await page("ann", "Named by the run", { answer: { title: "Wild Game", author: "Adrienne" } });
      assert.equal((await tasks().task(c))!.group, "Named by the run");
    });

    it("onEnter approves the group's answers when it enters a status; without it pay is untouched", async () => {
      await page("ann", "Book");
      await page("ann", "Book");
      assert.equal((await adminMove("Book", "submitted")).reviewed, undefined);
      await adminMove("Book", "accepted");
      assert.equal((await rowOf("Book")).unreviewed, 2, "accepting a group approves no answer by itself");
      await adminMove("Book", "reopened");
      await tasks().setType("page", { app: "scanner", answer: NONE, open: false, groups: { lifecycle: "default", onEnter: { accepted: { review: "ok" } } } }, "staff");
      await adminMove("Book", "submitted");
      const out = await adminMove("Book", "accepted");
      assert.equal(out.reviewed, 2);
      assert.deepEqual([out.group.ok, out.group.unreviewed], [2, 0]);
    });

    it("idle: an open group with no new task for the idle hours is hinted, a closed one never", async () => {
      await tasks().setType("page", { app: "scanner", answer: NONE, open: false, groups: { lifecycle: "default", idleHours: 24 } }, "staff");
      await page("ann", "Quiet");
      await page("ann", "Done");
      await adminMove("Done", "submitted");
      assert.deepEqual((await tasks().groups!({ type: "page", idle: true })).map((g) => g.group), []);
      clock += 25 * HOUR;
      assert.deepEqual((await tasks().groups!({ type: "page", idle: true })).map((g) => g.group), ["Quiet"]);
      assert.deepEqual((await tasks().groups!({ type: "page", status: "submitted" })).map((g) => g.group), ["Done"]);
      assert.deepEqual((await tasks().groups!({ type: "page", owner: "bob" })).map((g) => g.group), []);
      assert.equal((await rowOf("Quiet")).idle, true);
    });

    it("saving a type checks its groups, and refuses to drop a status a group is in", async () => {
      await assert.rejects(tasks().setType("page", { app: "scanner", answer: NONE, groups: { lifecycle: { statuses: [] } } }, "staff"), refused("bad_request", /statuses/));
      await page("ann", "Book");
      const own = { statuses: ["draft", "done"], initial: "draft", moves: [{ from: "draft", to: "done", by: ["owner", "admin"] }], closed: ["done"] };
      await assert.rejects(tasks().setType("page", { app: "scanner", answer: NONE, groups: { lifecycle: own } }, "staff"), refused("in_use", /is open/));
      // Once the group is moved to a status the new lifecycle keeps, the save goes through.
      const keeps = { ...own, statuses: ["open", "draft", "done"], moves: [{ from: "open", to: "done", by: ["admin"] }] };
      await tasks().setType("page", { app: "scanner", answer: NONE, groups: { lifecycle: keeps } }, "staff");
      await svc.groupSet({ type: "page", group: "Book", to: "done", by: "ada" });
      await tasks().setType("page", { app: "scanner", answer: NONE, groups: null }, "staff");
      assert.equal((await tasks().types()).find((t) => t.name === "page")!.groups, undefined, "null turns it off; the rows stay");
    });
  });
}

describe("an older task file", () => {
  it("opens with its types and groups intact, gains the group tables, and keeps no group until asked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-group-migrate-"));
    try {
      let svc = createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)), now: () => T0, principal: "client" });
      await svc.capability.setType("page", { app: "scanner", answer: NONE, open: false }, "staff");
      await svc.capability.grant("ann", "page", "staff");
      const t = (await svc.capability.ensure({ type: "page", workflow: "scan", runId: "r1", path: "a" })).task;
      const l = (await svc.capability.next("ann", { app: "scanner", type: "page" })) as WorkerTask;
      await svc.capability.submit("ann", { lease: l.lease, answer: {} });
      await svc.capability.reply({ task: t.id, group: "Old", show: {} }, { control: new RunController("r1", "scan").forUnit() });
      await svc.close();
      // Back to what a release before groups wrote: no group tables, no column.
      const raw = new DatabaseSync(tasksPath(dir));
      raw.exec("drop table task_group_events; drop table task_groups; alter table task_types drop column groups_rule;");
      raw.close();
      svc = createTasks({ open: () => openTaskStores({ dataDir: dir }), exists: () => existsSync(tasksPath(dir)), now: () => T0, principal: "client" });
      assert.deepEqual((await svc.capability.groups!()).map((g) => [g.group, g.status]), [["Old", undefined]], "an unmanaged group lists as it did");
      await svc.capability.setType("page", { app: "scanner", answer: NONE, open: false, groups: { lifecycle: "default" } }, "staff");
      const g = (await svc.capability.groups!())[0]!;
      assert.deepEqual([g.virtual, g.status], [true, "open"]);
      const moved = await svc.groupSet({ type: "page", group: "Old", to: "submitted", by: "ada" });
      assert.equal(moved.group.owner, "ann");
      await svc.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
