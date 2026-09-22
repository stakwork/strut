/**
 * The policy layer + tick loop (plans/automations.md §4–§6), over the real
 * file workspace + an in-memory run store, with an injected clock and manual
 * ticks — no timers.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Flow, RunSummary } from "./core.js";
import { MemoryRunStore } from "./store.js";
import { FileWorkspaceStore } from "./workspace.js";
import { createAutomations, type Automations } from "./scheduler.js";
import { buildTools } from "./ai/tools.js";
import { z } from "zod";

const WF = "digest";
const steps = [{ id: "a", type: "log", config: { message: "{{ input.since_id || 'none' }}" } }];
const daily = { every: "day", at: ["09:00"], tz: "UTC" };

interface Launch {
  workflow: string;
  input: Record<string, unknown>;
  automation: { id: string };
  runId: string;
}

describe("automations: policy layer + scheduler", () => {
  let dir: string;
  let ws: FileWorkspaceStore;
  let store: MemoryRunStore;
  let now: Date;
  let launches: Launch[];
  let inFlight: Set<string>;
  let autos: Automations;

  /** Settle a launched run the way the runner would. */
  const settle = async (l: Launch, status: RunSummary["status"], output?: unknown) => {
    inFlight.delete(l.runId);
    await store.finalize(l.workflow, l.runId, {
      runId: l.runId,
      workflow: l.workflow,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      durationMs: 1,
      status,
      input: l.input,
      ...(output !== undefined ? { output } : {}),
      automation: l.automation,
    });
  };

  const make = () =>
    createAutomations({
      workspace: ws,
      store,
      now: () => now,
      isInFlight: (_wf, runId) => inFlight.has(runId),
      launch: (flow: Flow, input, automation) => {
        // Run ids sort by start time, like generateRunId's.
        const runId = `${now.getTime()}-${launches.length}`;
        launches.push({ workflow: flow.name, input, automation, runId });
        inFlight.add(runId);
        void store.append(flow.name, runId, { ts: now.toISOString(), runId, path: flow.name, type: "run.start", input, origin: "schedule", automation });
        return runId;
      },
    });

  beforeEach(async () => {
    dir = join(tmpdir(), `strut-autos-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    ws = new FileWorkspaceStore(dir);
    await ws.publishWorkflow(WF, "v1", { steps });
    store = new MemoryRunStore();
    now = new Date("2026-09-20T08:00:00Z");
    launches = [];
    inFlight = new Set();
    autos = make();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const created = async (draft: Record<string, unknown>, workflow = WF) => {
    const r = await autos.create(workflow, draft);
    assert.ok("ok" in r, JSON.stringify(r));
    return r;
  };

  it("create: validates, stores on the workflow's metadata, and returns summary + next fires", async () => {
    const r = await created({ name: "Morning", trigger: daily, input: { since_id: "{{ last.output.newest_id }}" } });
    assert.match(r.automation.id, /^a-[0-9a-f]{8}$/);
    assert.equal(r.automation.summary, "Every day at 9:00 AM (UTC)");
    assert.deepEqual(r.next.slice(0, 2), ["2026-09-20T09:00:00.000Z", "2026-09-21T09:00:00.000Z"]);
    assert.equal(r.next.length, 5);
    const meta = await ws.getWorkflowMetadata(WF);
    assert.deepEqual(meta?.automations, [{ id: r.automation.id, name: "Morning", enabled: true, trigger: { type: "schedule", ...daily }, input: { since_id: "{{ last.output.newest_id }}" } }]);
    assert.equal(meta?.active, "v1", "no workflow version is published");
  });

  it("create/update refuse bad drafts with a message naming the problem", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: "x", trigger: { every: "month", day: 29, at: ["09:00"] } }, /trigger/],
      [{ name: "x", trigger: { every: "day", at: ["09:00"], tz: "Nowhere/Land" } }, /IANA/],
      [{ name: "x", trigger: daily, input: { url: "{{ input.url }}" } }, /reads "input"/],
      [{ trigger: daily }, /name/],
    ];
    for (const [draft, want] of cases) {
      const r = await autos.create(WF, draft);
      assert.ok("error" in r && want.test(r.error), JSON.stringify(r));
    }
    assert.match(((await autos.create("nope", { name: "x", trigger: daily })) as { error: string }).error, /not found/);
    assert.deepEqual(await autos.list(WF), [], "nothing was stored");
  });

  it("update keeps the id, patches only what is given, and keeps an interval's anchor", async () => {
    const r = await created({ name: "Poll", trigger: { every: "interval", minutes: 30, tz: "UTC" } });
    const anchor = (r.automation.trigger as { anchor: string }).anchor;
    assert.equal(anchor, "2026-09-20T08:00:00.000Z");
    now = new Date("2026-09-20T08:10:00Z");
    const u = await autos.update(WF, r.automation.id, { name: "Poll faster", trigger: { every: "interval", minutes: 15, tz: "UTC" } });
    assert.ok("ok" in u);
    assert.equal(u.automation.id, r.automation.id);
    assert.equal(u.automation.name, "Poll faster");
    assert.equal((u.automation.trigger as { anchor: string }).anchor, anchor, "the rhythm is not restarted by an edit");
    assert.equal(u.automation.nextRunAt, "2026-09-20T08:15:00.000Z");
    assert.match(((await autos.update(WF, "a-missing", { name: "y" })) as { error: string }).error, /not found/);
  });

  it("preview writes nothing", async () => {
    const p = autos.preview({ every: "week", on: ["mon"], at: ["09:00"], tz: "UTC" });
    assert.ok("ok" in p);
    assert.equal(p.summary, "Mon at 9:00 AM (UTC)");
    assert.equal(p.next[0], "2026-09-21T09:00:00.000Z");
    assert.ok("error" in autos.preview({ every: "cron", expr: "* * * * *" }));
  });

  it("tick fires what is due — once — stamped, and never an instant already past at boot", async () => {
    await created({ name: "Morning", trigger: daily });
    await autos.tick(); // 08:00 — not due
    assert.equal(launches.length, 0);
    now = new Date("2026-09-20T09:00:05Z");
    await autos.tick();
    await autos.tick();
    assert.equal(launches.length, 1, "advanced before launching: a second tick does not re-fire");
    assert.equal(launches[0]!.workflow, WF);
    assert.equal((await autos.list(WF))[0]!.nextRunAt, "2026-09-21T09:00:00.000Z");

    // A fresh process at 09:30 computes from NOW: the 09:00 fire it never
    // saw is skipped, not replayed.
    await settle(launches[0]!, "success");
    launches.length = 0;
    now = new Date("2026-09-20T09:30:00Z");
    autos = make();
    await autos.tick();
    assert.equal(launches.length, 0);
  });

  it("a fire due between boot and the first tick is late, not lost", async () => {
    await created({ name: "Morning", trigger: daily });
    now = new Date("2026-09-20T08:59:50Z");
    autos = make(); // boots 10 s before the fire; its first tick lands after it
    now = new Date("2026-09-20T09:00:05Z");
    await autos.tick();
    assert.equal(launches.length, 1);
    assert.equal(launches[0]!.input && (await autos.list(WF))[0]!.nextRunAt, "2026-09-21T09:00:00.000Z");
  });

  it("a paused automation never fires; resuming schedules it from now", async () => {
    const r = await created({ name: "Morning", trigger: daily, enabled: false });
    assert.equal(r.automation.nextRunAt, null);
    now = new Date("2026-09-20T09:00:05Z");
    await autos.tick();
    assert.equal(launches.length, 0);
    const u = await autos.update(WF, r.automation.id, { enabled: true });
    assert.ok("ok" in u);
    assert.equal(u.automation.nextRunAt, "2026-09-21T09:00:00.000Z");
  });

  it("an edit to ANOTHER automation does not swallow a fire that is already due", async () => {
    await created({ name: "Morning", trigger: daily });
    const other = await created({ name: "Evening", trigger: { every: "day", at: ["18:00"], tz: "UTC" } });
    await autos.tick(); // load entries at 08:00
    now = new Date("2026-09-20T09:00:05Z");
    await autos.update(WF, other.automation.id, { name: "Evening digest" }); // before the tick
    await autos.tick();
    assert.deepEqual(launches.map((l) => l.workflow), [WF]);
  });

  it("dynamic inputs: `last` is the last SUCCESS; a failure does not advance the cursor", async () => {
    const r = await created({ name: "Poll", trigger: { every: "interval", minutes: 60, anchor: "2026-09-20T09:00:00Z", tz: "UTC" }, input: { since_id: "{{ last.output.newest_id }}", day: "{{ today }}" } });
    const fireAt = async (iso: string) => {
      now = new Date(iso);
      await autos.tick();
      return launches[launches.length - 1]!;
    };
    const first = await fireAt("2026-09-20T09:00:01Z");
    assert.deepEqual(first.input, { day: "2026-09-20" }, "first fire: undefined cursor key dropped");
    await settle(first, "success", { newest_id: "100" });

    const second = await fireAt("2026-09-20T10:00:01Z");
    assert.deepEqual(second.input, { since_id: "100", day: "2026-09-20" });
    await settle(second, "error");

    const third = await fireAt("2026-09-20T11:00:01Z");
    assert.equal(third.input["since_id"], "100", "the failed run did not move the cursor");
    await settle(third, "success", { newest_id: "250" });

    // A manual run of the same workflow carries no stamp and is ignored.
    await store.finalize(WF, "9999999999999-manual", { runId: "9999999999999-manual", workflow: WF, startedAt: "s", finishedAt: "f", durationMs: 1, status: "success", input: {}, output: { newest_id: "MANUAL" } });
    const fourth = await fireAt("2026-09-20T12:00:01Z");
    assert.equal(fourth.input["since_id"], "250");

    const [view] = await autos.list(WF);
    assert.equal(view!.id, r.automation.id);
    assert.deepEqual([view!.lastRun?.runId, view!.lastRun?.status, view!.running], [fourth.runId, "running", true]);
  });

  it("two automations on one workflow keep separate cursors", async () => {
    const a = await created({ name: "A", trigger: daily, input: { account: "a", since_id: "{{ last.output.newest_id }}" } });
    const b = await created({ name: "B", trigger: daily, input: { account: "b", since_id: "{{ last.output.newest_id }}" } });
    now = new Date("2026-09-20T09:00:01Z");
    await autos.tick();
    assert.equal(launches.length, 2);
    await settle(launches.find((l) => l.automation.id === a.automation.id)!, "success", { newest_id: "A1" });
    await settle(launches.find((l) => l.automation.id === b.automation.id)!, "success", { newest_id: "B1" });
    now = new Date("2026-09-21T09:00:01Z");
    await autos.tick();
    assert.deepEqual(
      launches.slice(2).map((l) => [l.input["account"], l.input["since_id"]]).sort(),
      [["a", "A1"], ["b", "B1"]],
    );
  });

  it("the one overlap rule: a fire is skipped while the previous run is in flight — even across a restart", async () => {
    const r = await created({ name: "Poll", trigger: { every: "interval", minutes: 60, anchor: "2026-09-20T09:00:00Z", tz: "UTC" } });
    now = new Date("2026-09-20T09:00:01Z");
    await autos.tick();
    assert.equal(launches.length, 1);

    autos = make(); // a restart: the rule reads the run store, not memory
    now = new Date("2026-09-20T09:30:00Z");
    await autos.tick(); // loads entries
    now = new Date("2026-09-20T10:00:01Z");
    await autos.tick();
    assert.equal(launches.length, 1, "skipped");
    const manual = await autos.fire(WF, r.automation.id);
    assert.ok("error" in manual && /in flight/.test(manual.error), "Run now obeys the same rule");

    await settle(launches[0]!, "success");
    now = new Date("2026-09-20T11:00:01Z");
    await autos.tick();
    assert.equal(launches.length, 2, "fires again once the run settles");
  });

  it("Run now fires off-schedule without moving the schedule, even when paused", async () => {
    const r = await created({ name: "Morning", trigger: daily, input: { at: "{{ now }}" }, enabled: false });
    now = new Date("2026-09-20T08:20:00Z");
    const fired = await autos.fire(WF, r.automation.id);
    assert.ok("ok" in fired);
    assert.deepEqual(launches[0]!.input, { at: "2026-09-20T08:20:00.000Z" });
    assert.match(((await autos.fire(WF, "a-missing")) as { error: string }).error, /not found/);
  });

  it("an input that cannot resolve launches nothing and surfaces lastFireError", async () => {
    const r = await created({ name: "Bad", trigger: daily, input: { x: "{{ last.output.a.b }}" } });
    now = new Date("2026-09-20T09:00:01Z");
    await autos.tick();
    assert.equal(launches.length, 0);
    const [view] = await autos.list(WF);
    assert.match(view!.lastFireError ?? "", /Cannot access property/);
    const fixed = await autos.update(WF, r.automation.id, { input: {} });
    assert.ok("ok" in fixed);
    assert.equal(fixed.automation.lastFireError, undefined, "an edit clears it");
  });

  it("a `once` fires once and then has no next run", async () => {
    await created({ name: "Launch", trigger: { every: "once", at: "2026-09-20T09:00", tz: "UTC" } });
    now = new Date("2026-09-20T09:00:01Z");
    await autos.tick();
    now = new Date("2026-09-21T09:00:01Z");
    await autos.tick();
    assert.equal(launches.length, 1);
    assert.equal((await autos.list(WF))[0]!.nextRunAt, null);
  });

  it("remove deletes the record and its schedule; list() spans workflows", async () => {
    await ws.publishWorkflow("other", "v1", { steps });
    const a = await created({ name: "A", trigger: daily });
    await created({ name: "B", trigger: daily }, "other");
    assert.deepEqual((await autos.list()).map((v) => [v.workflow, v.name]).sort(), [[WF, "A"], ["other", "B"]]);
    await autos.tick();
    assert.deepEqual(await autos.remove(WF, a.automation.id), { ok: true, id: a.automation.id });
    assert.ok("error" in (await autos.remove(WF, a.automation.id)));
    assert.equal((await ws.getWorkflowMetadata(WF))?.automations, undefined);
    now = new Date("2026-09-20T09:00:01Z");
    await autos.tick();
    assert.deepEqual(launches.map((l) => l.workflow), ["other"]);
  });

  it("chat tools: offered only when wired; set_automation creates, edits and pauses through the same policy layer", async () => {
    const base = { workspace: ws, registry: {} as any, store, getRegistry: async () => ({}) as any };
    assert.equal("set_automation" in buildTools(base), false);
    const tools = buildTools({ ...base, automations: autos }) as any;

    // What the MODEL sees must convert: a discriminated union with refinements.
    const schema = z.toJSONSchema(tools.set_automation.inputSchema, { io: "input" }) as any;
    assert.ok(schema.properties.trigger, "the trigger grammar is in the tool's input schema");

    const made = await tools.set_automation.execute({ workflow: WF, name: "Morning", trigger: { every: "week", on: ["mon"], at: ["09:00"], tz: "UTC" }, input: { since: "{{ last.startedAt }}" } });
    assert.equal(made.ok, true);
    assert.equal(made.automation.summary, "Mon at 9:00 AM (UTC)");
    assert.equal(made.next[0], "2026-09-21T09:00:00.000Z");

    const paused = await tools.set_automation.execute({ workflow: WF, id: made.automation.id, enabled: false });
    assert.deepEqual([paused.automation.enabled, paused.automation.name, paused.automation.nextRunAt], [false, "Morning", null]);
    assert.match((await tools.set_automation.execute({ workflow: WF, trigger: daily })).error, /name/, "creating needs a name");
    assert.match((await tools.set_automation.execute({ workflow: WF, name: "x", trigger: daily, input: { u: "{{ input.u }}" } })).error, /reads "input"/);

    assert.deepEqual((await tools.list_automations.execute({})).automations.map((a: any) => a.id), [made.automation.id]);
    assert.deepEqual(await tools.delete_automation.execute({ workflow: WF, id: made.automation.id }), { ok: true, id: made.automation.id });
    assert.deepEqual((await tools.list_automations.execute({ workflow: WF })).automations, []);
    assert.equal((await ws.getWorkflowMetadata(WF))?.active, "v1", "no version was ever published");
  });

  it("start() is unref'd and idempotent; stop() ends it", () => {
    autos.start();
    autos.start();
    autos.stop();
    autos.stop();
  });
});
