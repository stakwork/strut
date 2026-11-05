import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createDrain, drainMessage, parseDrainBody, DRAINING, DRAIN_MINUTES_MAX } from "./drain.js";
import { createStrut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import { defineStep } from "./core.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";

describe("createDrain", () => {
  it("is off until set; set keeps its first `since`; lift says whether it was on", () => {
    let t = Date.parse("2026-11-05T10:00:00Z");
    let lifts = 0;
    const drain = createDrain({ now: () => new Date(t), onLift: () => lifts++ });
    assert.equal(drain.current(), undefined);
    assert.equal(drain.refusal(), undefined);
    assert.equal(drain.lift(), false);
    assert.equal(lifts, 0, "lifting a drain that is off runs nothing");

    const first = drain.set();
    assert.deepEqual(first, { since: "2026-11-05T10:00:00.000Z", reason: "maintenance" });
    assert.equal(drain.refusal(), drainMessage(first));
    assert.ok(drain.refusal()!.startsWith(DRAINING));
    assert.match(drain.refusal()!, /draining for maintenance/);

    t += 60_000;
    const second = drain.set({ reason: "an image update", minutes: 30 });
    assert.equal(second.since, first.since, "a drain that is on keeps when it began");
    assert.equal(second.reason, "an image update");
    assert.equal(second.until, "2026-11-05T10:31:00.000Z");

    assert.equal(drain.lift(), true);
    assert.equal(lifts, 1);
    assert.equal(drain.current(), undefined);
  });

  it("lifts by itself at its deadline, and says so to whoever asks next", () => {
    let t = Date.parse("2026-11-05T10:00:00Z");
    let lifts = 0;
    const drain = createDrain({ now: () => new Date(t), onLift: () => lifts++ });
    drain.set({ minutes: 5 });
    t += 4 * 60_000;
    assert.ok(drain.refusal());
    t += 60_000;
    assert.equal(drain.refusal(), undefined, "at the deadline it is off");
    assert.equal(lifts, 1);
    assert.equal(drain.current(), undefined);
    assert.equal(lifts, 1, "lifted once");
  });

  it("an onLift that throws does not keep the drain on", () => {
    const drain = createDrain({ onLift: () => { throw new Error("boom"); } });
    drain.set();
    assert.equal(drain.lift(), true);
    assert.equal(drain.current(), undefined);
  });
});

describe("parseDrainBody", () => {
  it("takes a reason and minutes, both optional", () => {
    assert.deepEqual(parseDrainBody(undefined), {});
    assert.deepEqual(parseDrainBody({}), {});
    assert.deepEqual(parseDrainBody({ reason: "  a backup  ", minutes: 15 }), { reason: "a backup", minutes: 15 });
  });
  it("refuses what it cannot use", () => {
    assert.ok("error" in parseDrainBody({ reason: "" }));
    assert.ok("error" in parseDrainBody({ reason: 7 }));
    assert.ok("error" in parseDrainBody({ reason: "x".repeat(201) }));
    assert.ok("error" in parseDrainBody({ minutes: 0 }));
    assert.ok("error" in parseDrainBody({ minutes: -1 }));
    assert.ok("error" in parseDrainBody({ minutes: "5" }));
    assert.ok("error" in parseDrainBody({ minutes: DRAIN_MINUTES_MAX + 1 }));
  });
});

describe("draining a strut", () => {
  const KEY = "drain-key";
  let tempDir: string;
  let savedKey: string | undefined;
  beforeEach(async () => {
    savedKey = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    tempDir = join(tmpdir(), `strut-drain-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });
  afterEach(async () => {
    released = true; // a failed test never leaves a run waiting
    if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = savedKey;
    await rm(tempDir, { recursive: true, force: true });
  });

  /** A step that waits until the test lets it go — a run in flight —
   *  checking in between, as a long step does, so a pause can park it. */
  let released = true;
  const hold = () => {
    released = false;
  };
  const release = () => {
    released = true;
  };
  const wait = defineStep({
    type: "wait-for-test",
    input: z.object({}),
    output: z.any(),
    async run(_cfg, ctx) {
      while (!released) {
        await ctx.control?.checkpoint();
        await new Promise((r) => setTimeout(r, 5));
      }
      return { done: true };
    },
  });
  const ping = defineStep({ type: "ping", input: z.object({}), output: z.any(), async run() { return { pong: true }; } });
  const look = defineStep({ type: "look", effect: "read", input: z.object({}), output: z.any(), async run() { return { seen: true }; } });

  const boot = async (o: { chat?: boolean } = {}) => {
    const store = new MemoryRunStore();
    const strut = await createStrut({
      workspace: new WorkspaceManager(tempDir),
      registry: await createRegistry([wait, ping, look]),
      store,
      serveUi: false,
      enableChat: o.chat === true,
      scheduler: false,
      stt: false,
      job: false,
      orchestrator: false,
      builder: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
    });
    await strut.workspace.publishWorkflow("slow", "v1", { steps: [{ id: "w", type: "wait-for-test", config: {} }] });
    await strut.workspace.publishWorkflow("wf", "v1", { steps: [{ id: "p", type: "ping", config: {} }] });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await strut.app.request(path, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, headers: res.headers, json: (await res.json().catch(() => null)) as any };
    };
    const finished = async (wf: string, runId: string) => {
      for (let i = 0; i < 300; i++) {
        const s = await store.getRunSummary(wf, runId);
        if (s) return s;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`run ${runId} never finished`);
    };
    return { strut, call, finished };
  };

  it("refuses every new run, lets what runs finish, and says when nothing is left", async () => {
    const { strut, call, finished } = await boot();
    // One run of each kind that finished before the drain, to resume later.
    const before = (await call("POST", "/workflows/wf/run", { input: {} })).json.runId as string;
    await finished("wf", before);
    const draft = { name: "Nightly", trigger: { every: "day", at: ["09:00"], tz: "UTC" } };
    const auto = await call("POST", "/workflows/wf/automations", draft);
    assert.equal(auto.status, 201, JSON.stringify(auto.json));

    hold();
    const slow = (await call("POST", "/workflows/slow/run", { input: {} })).json.runId as string;

    const off = await call("GET", "/drain");
    assert.equal(off.status, 200);
    assert.equal(off.json.draining, false);
    assert.equal(off.json.idle, false);
    assert.deepEqual(off.json.active, { runs: 1, chats: 0 });

    assert.equal((await call("PUT", "/drain", { minutes: 0 })).status, 400);
    const on = await call("PUT", "/drain", { reason: "an image update", minutes: 30 });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.draining, true);
    assert.equal(on.json.reason, "an image update");
    assert.ok(on.json.until);
    assert.equal(on.json.idle, false);
    assert.deepEqual(on.json.runs, [{ workflow: "slow", runId: slow, state: "running" }]);

    // /health says so, with the key.
    const health = await call("GET", "/health");
    assert.equal(health.json.drain.reason, "an image update");
    assert.equal(health.json.drain.idle, false);

    // HTTP launches: 503, with when to ask again.
    for (const path of ["/workflows/wf/run", "/workflows/wf/v1/run"]) {
      const r = await call("POST", path, { input: {} });
      assert.equal(r.status, 503, path);
      assert.ok(r.json.error.startsWith(DRAINING), r.json.error);
      assert.match(r.json.error, /an image update/);
      assert.equal(r.headers.get("retry-after"), "60");
    }
    // A durable resume starts a run again.
    const resumed = await call("POST", `/workflows/wf/runs/${before}/resume`, { from: "wf/p" });
    assert.equal(resumed.status, 503);
    // A step: one that only reads still answers; anything else is refused.
    assert.equal((await call("POST", "/steps/ping/run", { config: {} })).status, 503);
    const read = await call("POST", "/steps/look/run", { config: {} });
    assert.equal(read.status, 200, JSON.stringify(read.json));
    // Run now: held, and nothing recorded as a failure.
    const fired = await call("POST", `/workflows/wf/automations/${auto.json.automation.id}/fire`);
    assert.equal(fired.status, 503);
    assert.ok(fired.json.error.startsWith(DRAINING));
    const listed = (await call("GET", "/automations?workflow=wf")).json;
    assert.equal(JSON.stringify(listed).includes("lastFireError"), false, JSON.stringify(listed));

    // In process: a new top-level run is refused, by every door …
    await assert.rejects(strut.run("wf", {}), (err: Error) => err.message.startsWith(DRAINING));
    const authoring = (strut.services as { authoring: { runWorkflow: (name: string, input: unknown) => Promise<{ error?: string }> } }).authoring;
    assert.ok((await authoring.runWorkflow("wf", {})).error?.startsWith(DRAINING));
    // … while a run launched BY the run in flight is that run's work and starts.
    const child = await strut.run("wf", {}, { parentRunId: slow });
    assert.equal(child.status, "success");

    // The run in flight finishes; then nothing is left.
    release();
    assert.equal((await finished("slow", slow)).status, "success");
    const idle = await call("GET", "/drain");
    assert.equal(idle.json.idle, true);
    assert.deepEqual(idle.json.active, { runs: 0, chats: 0 });
    assert.deepEqual(idle.json.runs, []);

    // Lifted: launches go through again.
    const lifted = await call("DELETE", "/drain");
    assert.equal(lifted.status, 200);
    assert.equal(lifted.json.draining, false);
    assert.equal((await call("GET", "/health")).json.drain, undefined);
    const after = await call("POST", "/workflows/wf/run", { input: {} });
    assert.equal(after.status, 202);
    assert.equal((await finished("wf", after.json.runId)).status, "success");
  });

  it("a paused run is not waited on", async () => {
    const { call, finished } = await boot();
    hold();
    const slow = (await call("POST", "/workflows/slow/run", { input: {} })).json.runId as string;
    assert.equal((await call("POST", `/workflows/slow/runs/${slow}/pause`)).status, 202);
    // Parked at its next check-in.
    for (let i = 0; i < 100 && (await call("GET", "/drain")).json.active.runs; i++) await new Promise((r) => setTimeout(r, 10));
    await call("PUT", "/drain", {});
    const view = (await call("GET", "/drain")).json;
    assert.equal(view.idle, true, JSON.stringify(view));
    assert.deepEqual(view.active, { runs: 0, chats: 0 });
    // Unpausing it is its own work going on: let through while draining.
    assert.equal((await call("POST", `/workflows/slow/runs/${slow}/resume`)).status, 202);
    release();
    assert.equal((await finished("slow", slow)).status, "success");
  });

  it("a drain past its deadline lifts by itself", async () => {
    const { call } = await boot();
    await call("PUT", "/drain", { minutes: 0.0002 }); // 12 ms
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await call("GET", "/drain")).json.draining, false);
    assert.equal((await call("POST", "/workflows/wf/run", { input: {} })).status, 202);
  });

  it("a person's chat message waits, and no chat is made", async () => {
    const { call } = await boot({ chat: true });
    await call("PUT", "/drain", { reason: "a backup" });
    const sent = await call("POST", "/chat", { message: "build me a workflow" });
    assert.equal(sent.status, 503, JSON.stringify(sent.json));
    assert.match(sent.json.error, /draining for a backup/);
    assert.equal(sent.headers.get("retry-after"), "60");
    assert.deepEqual((await call("GET", "/chats")).json, []);
  });
});
