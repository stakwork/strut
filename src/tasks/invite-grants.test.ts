/**
 * An invite gives the work (plans/human-steps.md §5.8): the token an
 * invite's link opens the worker app with gives the worker who opens it the
 * app's INVITE-ONLY task types, in one step — one worker per invite, while
 * the daemon still has it. Over both stores; the token's signing is auth.ts's
 * (auth.test.ts), stood in for here by `read`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTasks, memoryTaskStores, openTaskStores, tasksPath, TaskError, type TasksService, type WorkerTask } from "./tasks.js";
import { memoryTestFiles } from "./test-files.js";

const T0 = Date.parse("2026-11-17T12:00:00Z");
const MATCH = { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] };

/** A stand-in token: `tok:<code>:<app>`. */
const token = (code: string, app = "workers") => `tok:${code}:${app}`;

for (const impl of ["SQLite", "memory"] as const) {
  describe(`an invite gives the work: ${impl}`, () => {
    let dir: string;
    let svc: TasksService;
    /** The invites the daemon still has. */
    let live: Set<string>;
    let asked: string[];
    const tasks = () => svc.capability;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "strut-invite-grants-"));
      live = new Set(["c1", "c2", "c3"]);
      asked = [];
      svc = createTasks({
        open: impl === "SQLite" ? () => openTaskStores({ dataDir: dir }) : async () => memoryTaskStores(),
        ...(impl === "SQLite" ? { exists: () => existsSync(tasksPath(dir)) } : {}),
        now: () => T0,
        random: () => 0.999,
        testFiles: memoryTestFiles(),
        invite: {
          read: (t) => {
            const m = /^tok:([^:]+):(.+)$/.exec(t);
            return m ? { code: m[1]!, app: m[2]! } : undefined;
          },
          live: async (code) => (asked.push(code), live.has(code)),
        },
      });
      // Two invite-only types the worker app draws, one open, one another app's.
      await tasks().setType("calls", { app: "workers", answer: MATCH, open: false, paySats: 5 }, "staff");
      await tasks().setType("visits", { app: "workers", answer: MATCH, open: false }, "staff");
      await tasks().setType("photos", { app: "workers", answer: MATCH }, "staff");
      await tasks().setType("elsewhere", { app: "other", answer: MATCH, open: false }, "staff");
    });
    afterEach(async () => {
      await svc.close();
      await rm(dir, { recursive: true, force: true });
    });

    const held = async (actor: string) =>
      ((await tasks().worker(actor))?.grants ?? [])
        .filter((g) => g.revokedAt === undefined)
        .map((g) => `${g.type}:${g.by}`)
        .sort();

    it("the worker who opens the app with it is given its invite-only types at once, by invite:<code>, and is active", async () => {
      const me = await tasks().me("ann", { app: "workers", invite: token("c1") });
      assert.equal(me.status, "active");
      assert.deepEqual(me.types.map((t) => t.name).sort(), ["calls", "photos", "visits"], "the invite's two, and the open one they may enter");
      assert.deepEqual(await held("ann"), ["calls:invite:c1", "visits:invite:c1"], "never another app's, and the open one is entered on a first ask, as before");
      assert.equal(svc.isActiveWorker("ann"), true);
      // A task of one is theirs to take straight away.
      await tasks().ensure({ type: "calls", workflow: "w", runId: "r1", path: "w/ask#1" });
      const got = (await tasks().next("ann", { app: "workers", invite: token("c1") })) as WorkerTask;
      assert.equal(got.type, "calls");
      // Asked again with it: nothing more to give, and the daemon not asked again.
      const before = asked.length;
      await tasks().me("ann", { app: "workers", invite: token("c1") });
      assert.equal(asked.length, before);
    });

    it("task/next takes it too: a worker whose page first asks for a task is given the work and gets one", async () => {
      await tasks().ensure({ type: "visits", workflow: "w", runId: "r2", path: "w/ask#2" });
      const got = (await tasks().next("bo", { app: "workers", invite: token("c2") })) as WorkerTask;
      assert.equal(got.type, "visits");
      assert.deepEqual(await held("bo"), ["calls:invite:c2", "photos:open", "visits:invite:c2"]);
    });

    it("one worker per invite: a second who opens the same link is given nothing", async () => {
      await tasks().me("ann", { app: "workers", invite: token("c1") });
      const cy = await tasks().me("cy", { app: "workers", invite: token("c1") });
      assert.equal(cy.status, "new");
      assert.deepEqual(await held("cy"), []);
      // Even once staff revoke ann's: the invite stays used.
      await tasks().revoke("ann", "calls", { by: "staff" });
      await tasks().revoke("ann", "visits", { by: "staff" });
      await tasks().me("cy", { app: "workers", invite: token("c1") });
      assert.deepEqual(await held("cy"), []);
      // Two first asks at once: only one is given it.
      const [a, b] = await Promise.all([tasks().me("di", { app: "workers", invite: token("c3") }), tasks().me("ed", { app: "workers", invite: token("c3") })]);
      assert.deepEqual([a.status, b.status].sort(), ["active", "new"]);
    });

    it("gives nothing once the daemon no longer has the invite (cancelled, failed), nor when it cannot say", async () => {
      live.delete("c1");
      assert.equal((await tasks().me("ann", { app: "workers", invite: token("c1") })).status, "new");
      assert.deepEqual(await held("ann"), []);
      // Without its token, an invite-only type stays staff's to grant.
      await assert.rejects(tasks().next("ann", { app: "workers", type: "calls" }), (e: unknown) => e instanceof TaskError && e.code === "not_active");
    });

    it("a token that is not strut's, or opens another app, is ignored: the ask goes on as without one", async () => {
      assert.equal((await tasks().me("ann", { app: "workers", invite: "forged" })).status, "new");
      assert.equal((await tasks().me("ann", { app: "workers", invite: token("c1", "other") })).status, "new");
      assert.deepEqual(await held("ann"), []);
      assert.deepEqual(asked, [], "the daemon is never asked about a token that does not hold");
    });

    it("never to a suspended or banned worker, and never a grant staff revoked", async () => {
      await tasks().setWorker("ann", { status: "banned" }, "staff");
      await tasks().me("ann", { app: "workers", invite: token("c1") });
      assert.deepEqual(await held("ann"), []);
      // Revoked from a worker who had it: an invite gives it again no more than "open" does.
      await tasks().grant("bo", "calls", "staff");
      await tasks().revoke("bo", "calls", { by: "staff", why: "careless" });
      await tasks().me("bo", { app: "workers", invite: token("c2") });
      assert.deepEqual(await held("bo"), ["visits:invite:c2"]);
    });
  });
}
