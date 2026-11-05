/**
 * Home sync on two hosts whose memory is the graph (`memory: "graph"`): the
 * box's POST /home/pull answers dictation's changes since the copy's last
 * pull (home/_graph-pull.ts), and home/sync replays them on the copy.
 * Two Ladybug graphs; the copy reaches the box's routes in process.
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
import { GRAPH_PULL } from "./_graph-pull.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<any> };
const run = (step: Step, cfg: Record<string, unknown>, ctx: unknown): Promise<any> => step.run(step.input.parse(cfg), ctx);
const ctxOf = (services: object) =>
  ({ runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services }) as unknown as StepContext;

describe("home sync with both memories on the graph (ladybug)", { skip: lb.skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-home-graph-"));
  let box: LadybugBackend, mac: LadybugBackend;
  let boxCtx: StepContext, macCtx: StepContext;
  /** Answers a pull in the box's place, when set. */
  let pullAnswer: unknown;

  before(async () => {
    box = (await lb.open()) as LadybugBackend;
    mac = (await lb.open()) as LadybugBackend;
    const boxServices = { graph: box, memory: "graph", dataDir: join(dir, "box") };
    const app = new Hono();
    homeSyncRoutes(app, { services: boxServices, scopeOf: async () => "peer:person" });
    const peers: PeersCapability = {
      list: async () => [],
      self: async () => undefined,
      fetch: async (_id, path, init) =>
        path === "/home/pull" && pullAnswer !== undefined ? Response.json(pullAnswer) : app.request(path, init as RequestInit),
    };
    boxCtx = ctxOf(boxServices);
    macCtx = ctxOf({ graph: mac, memory: "graph", dataDir: join(dir, "mac"), peers });
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
  });

  const sync = () => run(homeSync, {}, macCtx) as Promise<{ pushed: number; pulled: boolean; hash: string; kept: number }>;
  const lexicon = (ctx: StepContext) => run(lexiconStep, {}, ctx);
  const pairs = async (ctx: StepContext) =>
    (await lexicon(ctx)).entities.flatMap((e: any) => e.heard.map((h: any) => `${h.value}→${h.form ?? e.name}`)).sort();
  const undone = async (ctx: StepContext) => (await lexicon(ctx)).undone.map((u: any) => `${u.value}→${u.form ?? u.entity.name}`).sort();
  const words = async (ctx: StepContext) => (await lexicon(ctx)).entities.map((e: any) => e.name).sort();

  it("pulls the box's vocabulary onto the copy's graph, then only what changed since", async () => {
    await run(add, { heard: "stack work", written: "Stakwork" }, boxCtx);
    await run(add, { heard: "ee toy", written: "Itoi", name: "Paul Itoi" }, boxCtx);
    await run(add, { heard: "pee eight", written: "P8", term: true }, boxCtx);

    const first = await sync();
    assert.equal(first.pulled, true);
    assert.ok(first.hash.startsWith(GRAPH_PULL), first.hash);
    assert.equal(readState(macCtx).hash, first.hash);
    assert.deepEqual(await pairs(macCtx), ["ee toy→Itoi", "stack work→Stakwork"]);
    assert.ok((await words(macCtx)).includes("P8"), "the term");
    assert.ok((await words(macCtx)).includes("Paul Itoi"), "the person the name fix is kept on");

    // What the pull wrote here is pushed back once, and the box knows it all.
    const second = await sync();
    assert.equal(second.pushed, 3);
    assert.equal(second.pulled, false);
    assert.deepEqual(await pairs(boxCtx), ["ee toy→Itoi", "stack work→Stakwork"]);
    assert.deepEqual(await sync().then((s) => [s.pushed, s.pulled]), [0, false]);

    await run(add, { heard: "lady bug", written: "Ladybug" }, boxCtx);
    const third = await sync();
    assert.equal(third.pulled, true);
    assert.notEqual(third.hash, second.hash);
    assert.deepEqual(await pairs(macCtx), ["ee toy→Itoi", "lady bug→Ladybug", "stack work→Stakwork"]);
  });

  it("a learn on the copy reaches the box, and an undo on the box reaches the copy by its pair", async () => {
    await run(add, { heard: "dock her", written: "Docker" }, macCtx);
    assert.equal((await sync()).pushed, 1);
    assert.deepEqual(await pairs(boxCtx), ["dock her→Docker"]);
    await sync();

    const word = (await lexicon(boxCtx)).entities.find((e: any) => e.name === "Docker");
    await run(undo, { undo: [word.ref_id] }, boxCtx);
    assert.equal((await sync()).pulled, true);
    assert.deepEqual(await pairs(macCtx), []);
    assert.deepEqual(await undone(macCtx), ["dock her→Docker"]);
    // The undo replayed here is pushed back once, already undone there; then nothing moves.
    assert.deepEqual(await sync().then((s) => [s.pushed, s.pulled]), [1, false]);
    assert.deepEqual(await sync().then((s) => [s.pushed, s.pulled]), [0, false]);
    assert.deepEqual(await undone(boxCtx), ["dock her→Docker"]);
  });

  it("a hash that is no graph cursor (an old memory's) pulls the whole vocabulary again", async () => {
    await run(add, { heard: "stack work", written: "Stakwork" }, boxCtx);
    await sync();
    writeState(macCtx, { ...readState(macCtx), hash: "0".repeat(64) });
    const again = await sync();
    assert.equal(again.pulled, true);
    assert.deepEqual(await pairs(macCtx), ["stack work→Stakwork"], "known: nothing new written");
  });

  it("refuses a whole-memory pull, which a graph memory does not load, and records nothing", async () => {
    pullAnswer = { content_hash: "f".repeat(64), data: "H4sI" };
    await assert.rejects(sync(), /home-sync: .*graph/);
    assert.deepEqual(readState(macCtx), {});
    pullAnswer = { content_hash: `${GRAPH_PULL}x` };
    await assert.rejects(sync(), /home-sync: /);
    assert.deepEqual(readState(macCtx), {});
  });
});
