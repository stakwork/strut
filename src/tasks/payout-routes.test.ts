/**
 * Withdraw on a real server (plans/human-steps.md §8.2): the `/tasks/payouts`
 * routes, full scope only, and the `staff/*` steps that reach them through
 * the staff's door; the worker's own withdrawal through the task service —
 * `task/me`'s `payout`, `task/withdraw`, the address from the session alone,
 * any status, two at once — and the books beside the wallet. The pay is
 * written to the ledger directly; the worker's door end to end is
 * worker-door.test.ts's.
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
import { FakePayer, FakeWallet } from "../payments/fake-wallet.js";
import { lightningCapability } from "../payments/lightning.js";
import { WALLET_ENV } from "../payments/settings.js";
import { PayoutError } from "../payments/payouts.js";
import type { EarningsView } from "../payments/earnings.js";
import { inProcessDoor, STAFF_ROUTES } from "../steps/lib/_admin-door.js";
import { STAFF_APP } from "../apps/staff-seed.js";
import { WORKER_ADDRESS } from "../steps/lib/task/_shared.js";
import withdrawStep from "../steps/lib/task/withdraw.js";
import meStep from "../steps/lib/task/me.js";
import payoutsStep from "../steps/lib/staff/payouts.js";
import savePayoutsStep from "../steps/lib/staff/save-payouts.js";
import payoutReadStep from "../steps/lib/staff/payout-read.js";
import payoutResolveStep from "../steps/lib/staff/payout-resolve.js";

const KEY = "payouts-key";
const PEER = "payouts-peer-key";
const json = { "content-type": "application/json" };
const keyed = { authorization: `Bearer ${KEY}`, ...json };
const CLEARED = [...WALLET_ENV, "STRUT_RATE_URL", "STRUT_API_KEY", "STRUT_PEER_KEY", "STRUT_SECRET_KEY"];
const RATE = { usdPerBtc: 100_000, at: new Date().toISOString(), source: "test" };
const T0 = Date.parse("2026-11-13T12:00:00Z");
const HOUR = 3_600_000;
const X = "c".repeat(64);
const ACTOR = `secp:${X}`;
const ADDRESS = `02${X}_03${"d".repeat(64)}_1099511627776`;
const ON = { on: true, minSats: 1_000, workerDaySats: 200_000, serverDaySats: 2_000_000 };

describe("withdraw on a server (plans/human-steps.md §8.2)", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let wallet: FakeWallet;
  let payer: FakePayer;
  let now: number;

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-payouts-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    for (const k of CLEARED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_PEER_KEY"] = PEER;
    now = T0;
    wallet = new FakeWallet({ startMsat: 100_000_000 });
    payer = new FakePayer();
    payer.wallet = wallet;
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      webDist: join(dir, "dist"),
      scheduler: false,
      autoResume: false,
      services: { lightning: lightningCapability(wallet) } as never,
      payments: { rate: async () => RATE, payer },
      tasks: { now: () => now },
    });
    // The wallet's sats were paid in by hand: the books know them.
    await (await strut.ledger()).deposit({ msat: 100_000_000, paymentHash: "seed", at: T0 - HOUR });
  });
  afterEach(async () => {
    await strut.close();
    for (const k of CLEARED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  const req = (path: string, init: RequestInit = {}) => strut.app.request(`http://strut.test${path}`, init);
  const session = async (role: "admin" | "member") => {
    const { ticket } = signInTicket(`${role}-1`, role)!;
    const traded = await req("/auth/session", { method: "POST", headers: { ...json, "x-strut-ui": "1" }, body: JSON.stringify({ ticket }) });
    return { cookie: traded.headers.get("set-cookie")!.split(";")[0]!, "x-strut-ui": "1", ...json };
  };
  /** `msat` earned an hour ago by `worker`, released now. */
  const earned = async (msat: number, worker = ACTOR) => {
    const lease = randomUUID();
    await (await strut.ledger()).pay({ lease, task: `t-${lease}`, worker, type: "pet-match", msat, at: now - HOUR, releases: now });
  };
  const turnOn = async () => {
    const res = await req("/tasks/payouts/settings", { method: "PUT", headers: keyed, body: JSON.stringify(ON) });
    assert.equal(res.status, 200, await res.clone().text());
  };
  /** The staff's door, as the app door hands it to strut/staff in front of an admin. */
  const staffCtx = (actor = "admin-1") => ({
    app: { name: STAFF_APP, version: "v1", firstParty: true, admin: true },
    actor,
    services: { staffAdmin: inProcessDoor((r, a) => Promise.resolve(strut.app.fetch(inProcessRequest(r, a))), STAFF_ROUTES, "staff") },
  });
  /** A worker step's own call on an app door: the worker's calls and, when the session carries one, its address. */
  const workerCtx = (actor: string, address?: string) => ({
    app: { name: "workers", version: "v1" },
    actor,
    workflow: RUN_STEP_FLOW,
    services: { tasks: strut.tasks.worker, ...(address ? { [WORKER_ADDRESS]: address } : {}) },
  });

  it("the routes are full scope only; with no ledger they answer the defaults, off, and make no file", async () => {
    const minted = await req("/peers/tokens", { method: "POST", headers: keyed, body: JSON.stringify({ actor: "tom-1" }) });
    const person = { authorization: `Bearer ${((await minted.json()) as { token: string }).token}`, ...json };
    const member = await session("member");
    const peer = { authorization: `Bearer ${PEER}`, ...json };
    for (const [method, path, body] of [
      ["GET", "/tasks/payouts"],
      ["PUT", "/tasks/payouts/settings", ON],
      ["POST", `/tasks/payouts/${"a".repeat(64)}/read`, {}],
      ["POST", `/tasks/payouts/${"a".repeat(64)}/resolve`, { action: "drop" }],
    ] as const) {
      for (const headers of [json, peer, person, member]) {
        const res = await req(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        assert.ok(res.status === 401 || res.status === 403, `${method} ${path}: ${res.status}`);
      }
    }
    assert.equal((await (await strut.ledger()).payoutSettings()).on, false, "nothing a refused caller sent was saved");
    const list = (await (await req("/tasks/payouts", { headers: await session("admin") })).json()) as Record<string, unknown>;
    assert.deepEqual(list, { settings: { on: false, minSats: 1_000, workerDaySats: 200_000, serverDaySats: 2_000_000 }, today: { day: "2026-11-13", paidMsat: 0, outMsat: 0, count: 0, serverLeftMsat: 2_000_000_000 }, payouts: [] });
  });

  it("settings: saved whole by an admin with who and when; refused when a cap is under the minimum or a field is not one of the four", async () => {
    const admin = await session("admin");
    const put = (body: unknown) => req("/tasks/payouts/settings", { method: "PUT", headers: admin, body: JSON.stringify(body) });
    const ok = await put(ON);
    assert.equal(ok.status, 200);
    const { settings } = (await ok.json()) as { settings: Record<string, unknown> };
    assert.deepEqual(settings, { ...ON, changedBy: "admin-1", changedAt: settings["changedAt"] });
    assert.equal(typeof settings["changedAt"], "number");
    for (const bad of [{ ...ON, minSats: 0 }, { ...ON, workerDaySats: 10 }, { ...ON, on: "yes" }, { ...ON, extra: 1 }, { on: true }]) {
      const res = await put(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(((await res.json()) as { code: string }).code, "bad_request");
    }
    assert.deepEqual((await (await req("/tasks/payouts", { headers: keyed })).json() as { settings: unknown }).settings, settings, "a refused save changed nothing");
    const badState = await req("/tasks/payouts?state=lost", { headers: keyed });
    assert.equal(badState.status, 400);
    assert.equal((await req(`/tasks/payouts/nope/read`, { method: "POST", headers: keyed, body: "{}" })).status, 400);
    assert.equal((await req(`/tasks/payouts/${"a".repeat(64)}/read`, { method: "POST", headers: keyed, body: "{}" })).status, 404);
  });

  it("the staff steps reach the routes through the staff's door, in the admin's name", async () => {
    const saved1 = (await savePayoutsStep.run(ON, staffCtx() as never)) as { settings: { changedBy: string; on: boolean } };
    assert.deepEqual([saved1.settings.on, saved1.settings.changedBy], [true, "admin-1"]);
    await earned(10_000_000);
    payer.outcomes.push("pending");
    const out = await strut.tasks.worker.withdraw!(ACTOR, { address: ADDRESS, msat: 2_000_000 });
    const list = (await payoutsStep.run({ state: "out" }, staffCtx() as never)) as { payouts: Array<{ key: string; worker: string; address: string; stale: boolean }>; today: { outMsat: number } };
    assert.deepEqual(list.payouts.map((p) => [p.key, p.worker, p.address, p.stale]), [[out.key, ACTOR, ADDRESS, false]]);
    assert.equal(list.today.outMsat, 2_000_000);
    const read = (await payoutReadStep.run({ key: out.key }, staffCtx() as never)) as { payout: { state: string }; state: string };
    assert.deepEqual([read.state, read.payout.state], ["pending", "out"]);
    const resolved = (await payoutResolveStep.run({ key: out.key, action: "drop" }, staffCtx("admin-2") as never)) as { action: string; payout: { state: string; by: string } };
    assert.deepEqual([resolved.action, resolved.payout.state, resolved.payout.by], ["drop", "failed", "admin-2"]);
    assert.equal((await strut.tasks.worker.me(ACTOR, { address: ADDRESS })).balance.totalMsat, 10_000_000, "dropped: the worker's again");
    // A refusal is the step's error, its code first; another app gets no door.
    await assert.rejects(() => payoutReadStep.run({ key: out.key }, staffCtx() as never), /^Error: not_pending: /);
    await assert.rejects(() => payoutsStep.run({}, { app: { name: "workers", version: "v1" }, services: {} } as never), /an admin's/);
  });

  it("the worker withdraws through the task service: task/me says it is open and how much; the session's address is paid; the books stay balanced", async () => {
    await earned(10_000_000);
    const closed = await strut.tasks.worker.me(ACTOR, { address: ADDRESS });
    assert.deepEqual(closed.payout, { on: false, why: "off", minMsat: 1_000_000, dayLeftMsat: 200_000_000, maxMsat: 0 });
    await turnOn();
    const open = await strut.tasks.worker.me(ACTOR, { address: ADDRESS });
    assert.equal(open.payout!.on, true);
    assert.ok(open.payout!.maxMsat > 9_900_000 && open.payout!.maxMsat < 10_000_000, "the most whose fee cap still fits");
    assert.deepEqual((await strut.tasks.worker.me(ACTOR)).payout, { on: false, why: "no_address", minMsat: 1_000_000, dayLeftMsat: 200_000_000, maxMsat: 0 });
    // The step: the address from the call's bag, never its input.
    const paid = await withdrawStep.run({ msat: 4_000_000 }, workerCtx(ACTOR, ADDRESS) as never);
    assert.deepEqual([paid.state, paid.msat, paid.feeMsat, paid.maxFeeMsat], ["settled", 4_000_000, 4_000, 20_000]);
    assert.deepEqual(payer.keysends().map((k) => [k.address, k.msat]), [[ADDRESS, 4_000_000]]);
    await assert.rejects(() => withdrawStep.run({ msat: 4_000_000 }, workerCtx(ACTOR) as never), /^PayoutError: no_address: /);
    const me = (await meStep.run({}, workerCtx(ACTOR, ADDRESS) as never)) as { balance: { totalMsat: number }; payout: { on: boolean; dayLeftMsat: number } };
    assert.deepEqual([me.balance.totalMsat, me.payout.on, me.payout.dayLeftMsat], [10_000_000 - 4_004_000, true, 196_000_000]);
    // The books beside the wallet: every send counted, the cover unmoved.
    const view = (await (await req("/earnings?wallet=1", { headers: keyed })).json()) as EarningsView;
    assert.equal(view.wallet!.differenceMsat, 0);
    assert.equal(view.wallet!.coverMsat, 100_000_000 - 10_000_000);
    assert.deepEqual([view.workers!.paidOut.count, view.workers!.paidOut.msat, view.workers!.paidOut.feeMsat, view.workers!.outMsat], [1, 4_000_000, 4_000, 0]);
    assert.equal(view.withdrawn.count, 0);
  });

  it("two calls at once: one is paid, the other meets it on its way or a balance without it", async () => {
    await turnOn();
    await earned(3_000_000);
    const results = await Promise.allSettled([1, 2].map(() => strut.tasks.worker.withdraw!(ACTOR, { address: ADDRESS, msat: 2_000_000 })));
    const paid = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(paid.length, 1);
    assert.ok(refused[0]!.reason instanceof PayoutError && ["payout_out", "over_balance"].includes(refused[0]!.reason.code), String(refused[0]?.reason));
    assert.equal(payer.keysends().length, 1);
  });

  it("a suspended or banned worker may withdraw what passed its hold", async () => {
    await turnOn();
    await earned(10_000_000);
    await strut.tasks.worker.me(ACTOR);
    for (const status of ["suspended", "banned"] as const) {
      await strut.tasks.capability.setWorker(ACTOR, { status }, "admin-1");
      const me = await strut.tasks.worker.me(ACTOR, { address: ADDRESS });
      assert.deepEqual([me.status, me.payout!.on], [status, true]);
      assert.equal((await strut.tasks.worker.withdraw!(ACTOR, { address: ADDRESS, msat: 1_000_000 })).state, "settled", status);
    }
  });

  it("a host's own task store pays nobody: task/withdraw answers not_here, and task/me says so", async () => {
    const w = strut.tasks.worker;
    const host = { next: w.next, submit: w.submit, skip: w.skip, file: w.file, me: async (actor: string) => { const { payout: _p, ...rest } = await w.me(actor); return rest; } };
    const ctx = { ...workerCtx(ACTOR, ADDRESS), services: { tasks: host, [WORKER_ADDRESS]: ADDRESS } };
    await assert.rejects(() => withdrawStep.run({ msat: 1_000_000 }, ctx as never), /^Error: not_here: /);
    const me = (await meStep.run({}, ctx as never)) as { payout: unknown };
    assert.deepEqual(me.payout, { on: false, why: "not_here", minMsat: 1_000_000, dayLeftMsat: 0, maxMsat: 0 });
  });

  it("no step on the shared bag reaches a payout, its settings or the payer", async () => {
    const bag = strut.services as Record<string, unknown>;
    assert.deepEqual(Object.keys(bag["tasks"] as object), ["ensure"]);
    for (const [k, v] of Object.entries(bag)) {
      if (!v || typeof v !== "object") continue;
      for (const name of ["withdraw", "pay", "reservePayout", "saveSettings", "setPayoutSettings", "keysend"]) {
        assert.equal(typeof (v as Record<string, unknown>)[name], "undefined", `${k}.${name}`);
      }
    }
  });

  it("the worker's calls count against their budget, a withdrawal included", async () => {
    await turnOn();
    await earned(10_000_000);
    let refused: unknown;
    for (let i = 0; i < 125 && !refused; i++) {
      await strut.tasks.worker.withdraw!(ACTOR, { msat: 1_000_000 }).catch((e: unknown) => {
        if (!(e instanceof PayoutError)) refused = e;
      });
    }
    assert.match(String(refused), /too_many/);
  });
});
