/**
 * Task groups on a real server: the `/tasks/groups` routes (list filters,
 * detail, an admin's move), full scope only; the `staff/group*` steps that
 * reach them through the staff's door; and the worker's own `task/group-move`
 * and `task/history`, whose identity is the session's, never an input. The
 * lifecycle itself is task-group-lifecycle.test.ts's.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStrut } from "../createStrut.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { inProcessRequest, signInTicket } from "../auth.js";
import { RUN_STEP_FLOW } from "../run-step.js";
import { RunController } from "../run-control.js";
import { inProcessDoor, STAFF_ROUTES } from "../steps/lib/_admin-door.js";
import { STAFF_APP } from "../apps/staff-seed.js";
import { setEnv } from "../test-util/public-door.js";
import type { WorkerTask } from "./tasks.js";
import groupsStep from "../steps/lib/staff/groups.js";
import groupStep from "../steps/lib/staff/group.js";
import groupSetStep from "../steps/lib/staff/group-set.js";
import groupMoveStep from "../steps/lib/task/group-move.js";
import historyStep from "../steps/lib/task/history.js";

const KEY = "groups-key";
const PEER = "groups-peer-key";
const json = { "content-type": "application/json" };
const keyed = { authorization: `Bearer ${KEY}`, ...json };
const T0 = Date.parse("2026-11-13T12:00:00Z");

describe("task groups on a server", () => {
  let dir: string;
  let restoreEnv: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let now: number;
  let n = 0;
  const here = new RunController("r1", "scan").forUnit();

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-group-routes-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_PEER_KEY: PEER, STRUT_SECRET_KEY: undefined });
    now = T0;
    strut = await createStrut({ workspace: new WorkspaceManager(join(dir, "ws")), store: new MemoryRunStore(), webDist: join(dir, "dist"), scheduler: false, autoResume: false, tasks: { now: () => now } });
    const t = strut.tasks.capability;
    await t.setType("page", { app: "scanner", answer: { type: "object", properties: {} }, open: false, groups: { lifecycle: "default" } }, "staff");
    for (const w of ["ann", "bob"]) await t.grant(w, "page", "staff");
  });
  afterEach(async () => {
    await strut.close();
    restoreEnv();
    await rm(dir, { recursive: true, force: true });
  });

  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://strut.test${path}`, init);
  const session = async (role: "admin" | "member") => {
    const { ticket } = signInTicket(`${role}-1`, role)!;
    const traded = await req("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
    return { cookie: traded.headers.get("set-cookie")!.split(";")[0]!, "x-strut-ui": "1", ...json };
  };
  const staffCtx = (actor = "admin-1") => ({
    app: { name: STAFF_APP, version: "v1", firstParty: true, admin: true },
    actor,
    services: { staffAdmin: inProcessDoor((r, a) => Promise.resolve(strut.app.fetch(inProcessRequest(r, a))), STAFF_ROUTES, "staff") },
  });
  const workerCtx = (actor: string, app = "scanner") => ({ app: { name: app, version: "v1" }, actor, workflow: RUN_STEP_FLOW, services: { tasks: strut.tasks.worker } });
  /** A page answered by `worker`, told its group. */
  const page = async (worker: string, group: string) => {
    const t = strut.tasks.capability;
    const task = (await t.ensure({ type: "page", workflow: "scan", runId: "r1", path: `scan/ask#${n++}` })).task;
    const l = (await t.next(worker, { app: "scanner", type: "page" })) as WorkerTask;
    await t.submit(worker, { lease: l.lease, answer: {} });
    await t.reply({ task: task.id, show: {}, group }, { control: here });
    return task.id;
  };
  const post = (path: string, body: unknown, headers: Record<string, string>) => req(path, { method: "POST", headers, body: JSON.stringify(body) });

  it("the routes are an admin's: no key, a peer's key, a member and a worker's page are refused, and nothing moves", async () => {
    await page("ann", "Book");
    const id = ((await (await req("/tasks/groups", { headers: keyed })).json()) as { groups: Array<{ id: string }> }).groups[0]!.id;
    const member = await session("member");
    for (const headers of [json, { authorization: `Bearer ${PEER}`, ...json }, member]) {
      for (const [method, path] of [["GET", "/tasks/groups"], ["GET", `/tasks/groups/${id}`], ["POST", `/tasks/groups/${id}/status`], ["POST", "/tasks/groups/status"]] as const) {
        const res = await req(path, { method, headers, ...(method === "POST" ? { body: JSON.stringify({ to: "submitted", type: "page", group: "Book" }) } : {}) });
        assert.ok(res.status === 401 || res.status === 403, `${method} ${path}: ${res.status}`);
      }
    }
    assert.equal((await strut.tasks.capability.groups!())[0]!.status, "open");
    // A worker's step never reaches the admin routes.
    await assert.rejects(() => groupSetStep.run({ type: "page", group: "Book", to: "submitted" }, workerCtx("ann") as never), /an admin's/);
  });

  it("list filters, detail and an admin's move: reason required, the lifecycle's table, who and why kept", async () => {
    const admin = await session("admin");
    await page("ann", "Book A");
    await page("bob", "Book B");
    const list = async (q = "") => ((await (await req(`/tasks/groups${q}`, { headers: admin })).json()) as { groups: Array<{ id: string; group: string; status: string; owner: string; moves: Array<{ to: string }> }> }).groups;
    assert.deepEqual((await list("?type=page&owner=bob")).map((g) => [g.group, g.status]), [["Book B", "open"]]);
    const a = (await list()).find((g) => g.group === "Book A")!;
    assert.deepEqual(a.moves.map((m) => m.to), ["submitted", "abandoned"]);
    const move = (to: string, reason?: string, extra: object = {}) => post(`/tasks/groups/${a.id}/status`, { to, ...(reason ? { reason } : {}), ...extra }, admin);

    assert.equal((await move("accepted")).status, 409, "open cannot be accepted");
    assert.equal((await (await move("accepted")).json() as { code: string }).code, "bad_move");
    assert.equal((await move("submitted", undefined, { by: "someone" })).status, 400, "who moves it is never an input");
    assert.equal((await move("submitted")).status, 200);
    const noReason = await move("rejected");
    assert.deepEqual([noReason.status, ((await noReason.json()) as { code: string }).code], [400, "reason_required"]);
    const rejected = (await (await move("rejected", "page 2 is cut off")).json()) as { group: { status: string }; event: { actor: string; role: string; reason: string } };
    assert.deepEqual([rejected.group.status, rejected.event.actor, rejected.event.role, rejected.event.reason], ["rejected", "admin-1", "admin", "page 2 is cut off"]);

    const detail = (await (await req(`/tasks/groups/${a.id}`, { headers: admin })).json()) as { events: Array<{ to: string }>; tasks: unknown[]; group: { status: string } };
    assert.deepEqual(detail.events.map((e) => e.to), ["open", "submitted", "rejected"]);
    assert.equal(detail.tasks.length, 1);
    assert.deepEqual((await list("?status=rejected")).map((g) => g.group), ["Book A"]);
    assert.equal((await req("/tasks/groups/grp_nope", { headers: admin })).status, 404);
    assert.equal((await post("/tasks/groups/status", { type: "page", group: "Nope", to: "submitted" }, admin)).status, 404);
    assert.equal((await post("/tasks/groups/status", { type: "page", group: "Book B", to: "submitted" }, admin)).status, 200, "by type and key");
  });

  it("the staff steps reach the routes in the admin's name", async () => {
    await page("ann", "Book");
    const { groups } = (await groupsStep.run({ type: "page", status: "open" }, staffCtx() as never)) as { groups: Array<{ id: string; status: string }> };
    assert.equal(groups.length, 1);
    const set = (await groupSetStep.run({ type: "page", group: "Book", to: "submitted" }, staffCtx("admin-2") as never)) as { event: { actor: string } };
    assert.equal(set.event.actor, "admin-2");
    const one = (await groupStep.run({ id: groups[0]!.id }, staffCtx() as never)) as { events: unknown[]; group: { status: string } };
    assert.deepEqual([one.group.status, one.events.length], ["submitted", 2]);
    await assert.rejects(() => groupSetStep.run({ type: "page", group: "Book", to: "open" }, staffCtx() as never), /bad_move/);
    await assert.rejects(() => groupStep.run({ id: groups[0]!.id }, { app: { name: "scanner", version: "v1" }, services: {} } as never), /an admin's/);
  });

  it("a worker's page reads its groups' status through task/history and moves only its own, as its viewer", async () => {
    await page("ann", "Book");
    const hist = async (actor: string, app = "scanner") => (await historyStep.run({ groups: true }, workerCtx(actor, app) as never)) as { groups: Array<{ status?: string; mine?: boolean }> };
    assert.deepEqual((await hist("ann")).groups.map((g) => [g.status, g.mine]), [["open", true]]);
    const moved = (await groupMoveStep.run({ type: "page", group: "Book", to: "submitted" }, workerCtx("ann") as never)) as { group: { status: string } };
    assert.equal(moved.group.status, "submitted");
    assert.deepEqual((await hist("ann")).groups.map((g) => g.status), ["submitted"], "the app reads the status the platform holds");
    await assert.rejects(() => groupMoveStep.run({ type: "page", group: "Book", to: "reopened" }, workerCtx("bob") as never), /not_owner|only the group's owner/);
    await assert.rejects(() => groupMoveStep.run({ type: "page", group: "Book", to: "accepted" }, workerCtx("ann") as never), /by admin/);
    // A page of a workflow's step, or another app's page, is no worker's call.
    await assert.rejects(() => groupMoveStep.run({ type: "page", group: "Book", to: "reopened" }, { ...workerCtx("ann"), workflow: "wf" } as never), /app page's own call/);
    await assert.rejects(() => groupMoveStep.run({ type: "page", group: "Book", to: "reopened" }, workerCtx("ann", "other") as never), /no such group/);
    // The viewer is the session's: an input naming another owner is not read.
    await assert.rejects(() => groupMoveStep.run({ type: "page", group: "Book", to: "reopened", actor: "ann" } as never, workerCtx("bob") as never), /./);
  });
});
