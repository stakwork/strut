/**
 * Home sync between two Ladybug graphs: the box's POST /home/pull answers
 * the memory part of its graph (home/_memory.ts), and home/sync puts it in
 * place of the copy's, keeping what dictation changes meanwhile. The copy
 * reaches the box's routes in process.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { StepContext } from "../../../core.js";
import type { PeersCapability } from "../../../peers.js";
import type { LadybugBackend } from "../../../graph/backend.js";
import { testBackends } from "../../../graph/test-util.js";
import { homeSyncRoutes } from "../../../home-sync.js";
import lexiconStep from "../memory/lexicon.js";
import add from "../dictation/add.js";
import undo from "../dictation/undo.js";
import homeSync from "./sync.js";
import { readState, writeState } from "./_state.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<any> };
const run = (step: Step, cfg: Record<string, unknown>, ctx: unknown): Promise<any> => step.run(step.input.parse(cfg), ctx);
const ctxOf = (services: object) =>
  ({ runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services }) as unknown as StepContext;

describe("home sync: the memory part of the graph (ladybug)", { skip: lb.skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-home-graph-"));
  let box: LadybugBackend, mac: LadybugBackend;
  let boxCtx: StepContext, macCtx: StepContext;
  /** Answers a pull in the box's place, when set. */
  let pullAnswer: unknown;
  /** Runs on the copy while its pull is under way, when set. */
  let duringPull: (() => Promise<unknown>) | undefined;

  before(async () => {
    box = (await lb.open()) as LadybugBackend;
    mac = (await lb.open()) as LadybugBackend;
    const boxServices = { graph: box, dataDir: join(dir, "box") };
    const app = new Hono();
    homeSyncRoutes(app, { services: boxServices, scopeOf: async () => "peer:person" });
    const peers: PeersCapability = {
      list: async () => [],
      self: async () => undefined,
      fetch: async (_id, path, init) => {
        if (path !== "/home/pull") return app.request(path, init as RequestInit);
        if (pullAnswer !== undefined) return Response.json(pullAnswer);
        const res = await app.request(path, init as RequestInit);
        const late = duringPull;
        duringPull = undefined;
        await late?.();
        return res;
      },
    };
    boxCtx = ctxOf(boxServices);
    macCtx = ctxOf({ graph: mac, dataDir: join(dir, "mac"), peers });
  });
  after(async () => {
    await lb.close(box);
    await lb.close(mac);
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await lb.clear(box);
    await lb.clear(mac);
    writeState(macCtx, {});
    pullAnswer = undefined;
    duringPull = undefined;
  });

  const sync = () => run(homeSync, {}, macCtx) as Promise<{ pushed: number; pulled: boolean; hash: string; kept: number; counts?: Record<string, number> }>;
  const lexicon = (ctx: StepContext) => run(lexiconStep, {}, ctx);
  const pairs = async (ctx: StepContext) =>
    (await lexicon(ctx)).entities.flatMap((e: any) => e.heard.map((h: any) => `${h.value}→${h.form ?? e.name}`)).sort();
  const undone = async (ctx: StepContext) => (await lexicon(ctx)).undone.map((u: any) => `${u.value}→${u.form ?? u.entity.name}`).sort();
  const words = async (ctx: StepContext) => (await lexicon(ctx)).entities.map((e: any) => e.name).sort();

  it("puts the box's memory in place of the copy's, then pulls again only when it changed", async () => {
    await run(add, { heard: "stack work", written: "Stakwork" }, boxCtx);
    await run(add, { heard: "ee toy", written: "Itoi", name: "Paul Itoi" }, boxCtx);
    await run(add, { heard: "pee eight", written: "P8", term: true }, boxCtx);

    const first = await sync();
    assert.equal(first.pulled, true);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.equal(readState(macCtx).hash, first.hash);
    assert.deepEqual(await pairs(macCtx), ["ee toy→Itoi", "stack work→Stakwork"]);
    assert.ok((await words(macCtx)).includes("P8"), "the term");
    assert.ok((await words(macCtx)).includes("Paul Itoi"), "the person the name fix is kept on");
    assert.deepEqual(await lexicon(macCtx), await lexicon(boxCtx), "the same memory, ref_ids and all");

    // What the replace wrote here is the box's, not a change here: nothing is pushed back.
    assert.deepEqual(await sync().then((s) => [s.pushed, s.pulled]), [0, false]);

    await run(add, { heard: "lady bug", written: "Ladybug" }, boxCtx);
    const third = await sync();
    assert.equal(third.pulled, true);
    assert.notEqual(third.hash, first.hash);
    assert.deepEqual(await pairs(macCtx), ["ee toy→Itoi", "lady bug→Ladybug", "stack work→Stakwork"]);
  });

  it("a learn on the copy reaches the box, and an undo on the box reaches the copy", async () => {
    await run(add, { heard: "dock her", written: "Docker" }, macCtx);
    assert.equal((await sync()).pushed, 1);
    assert.deepEqual(await pairs(boxCtx), ["dock her→Docker"]);
    assert.deepEqual(await pairs(macCtx), ["dock her→Docker"], "the box's copy of it, in place of this one's");

    const word = (await lexicon(boxCtx)).entities.find((e: any) => e.name === "Docker");
    await run(undo, { undo: [word.ref_id] }, boxCtx);
    assert.equal((await sync()).pulled, true);
    assert.deepEqual(await pairs(macCtx), []);
    assert.deepEqual(await undone(macCtx), ["dock her→Docker"]);
    assert.deepEqual(await sync().then((s) => [s.pushed, s.pulled]), [0, false]);
  });

  it("keeps a learn made on the copy while the pull is under way, and pushes it next", async () => {
    await run(add, { heard: "stack work", written: "Stakwork" }, boxCtx);
    duringPull = () => run(add, { heard: "type script", written: "TypeScript" }, macCtx);
    const first = await sync();
    assert.equal(first.pulled, true);
    assert.equal(first.kept, 1);
    assert.deepEqual(await pairs(macCtx), ["stack work→Stakwork", "type script→TypeScript"]);
    assert.equal(readState(macCtx).pending, undefined, "replayed, so nothing waits");
    assert.equal((await sync()).pushed, 1);
    assert.deepEqual(await pairs(boxCtx), ["stack work→Stakwork", "type script→TypeScript"]);
  });

  it("refuses a pull it cannot load, and records nothing", async () => {
    await run(add, { heard: "dock her", written: "Docker" }, macCtx);
    for (const answer of [{ content_hash: "f".repeat(64), data: "H4sI" }, { content_hash: "f".repeat(64), memory: { format: 99 } }]) {
      pullAnswer = answer;
      await assert.rejects(sync(), /home-sync: .*memory/);
      assert.deepEqual(readState(macCtx), {});
      assert.deepEqual(await pairs(macCtx), ["dock her→Docker"], "the memory here is as it was");
    }
  });
});
