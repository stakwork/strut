import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createChannels, channelNameProblem, type ChannelFrame, type Channels, type ChannelTransport } from "./channels.js";
import { defineStep, type AppRef, type Flow, type StepRegistry } from "./core.js";
import { runWorkflow } from "./runner.js";
import { runStep } from "./run-step.js";
import { MemoryRunStore } from "./store.js";
import { createRegistry } from "./steps/registry.js";
import { grantRefusal } from "./apps/tools.js";
import { manifestSchema } from "./apps/manifest.js";

// The channel/* steps (plans/app-channels.md §5): code an app runs — a step
// its page called, a workflow it launched — sends and reads in process,
// stamped as itself; a page never calls them.

class Sock implements ChannelTransport {
  frames: ChannelFrame[] = [];
  send(text: string) {
    this.frames.push(JSON.parse(text) as ChannelFrame);
  }
  messages() {
    return this.frames.flatMap((f) => (f.op === "message" ? [f.message] : []));
  }
}

const chess: AppRef = { name: "chess", version: "v1" };

/** A referee the page calls: checks nothing here, sends the board as its state. */
const gameMove = defineStep({
  type: "game/move",
  description: "a referee",
  input: z.object({ board: z.any() }),
  output: z.any(),
  async run(cfg, ctx) {
    return ctx.registry!["channel/send"]!.run({ channel: "g1", key: "board", data: cfg.board }, ctx);
  },
});

let registry: StepRegistry;
let channels: Channels;
let services: Record<string, unknown>;
let watcher: Sock;

beforeEach(async () => {
  registry ??= await createRegistry([gameMove]);
  channels = createChannels({ timers: false, gatherMs: 5 });
  services = { channels };
  watcher = new Sock();
  channels.connect(chess, { actor: "carol", transport: watcher }).receive({ op: "join", channel: "g1" });
});

const flow = (name: string, steps: Flow["steps"]): Flow => ({ name, input: z.any(), steps });
const run = (f: Flow, opts: { app?: AppRef; actor?: string } = {}) =>
  runWorkflow(f, {}, registry, { services, store: new MemoryRunStore(), ...(opts.app ? { app: opts.app } : {}), ...(opts.actor ? { actor: opts.actor } : {}) });

describe("the channel steps", () => {
  it("a step the page called sends as itself: its board is its own, whichever player set it off", async () => {
    for (const [actor, board] of [["alice", 1], ["bob", 2]] as const) {
      const res = await runStep("game/move", registry, services, { config: { board }, app: chess, actor }, { store: new MemoryRunStore() });
      assert.equal(res.status, "success", res.error?.message);
    }
    assert.deepEqual(
      watcher.messages().map((m) => [m.from, m.key, m.data]),
      [[{ actor: "alice", code: "game/move" }, "board", 1], [{ actor: "bob", code: "game/move" }, "board", 2]],
    );
    const read = await channels.read(chess, "g1");
    assert.deepEqual(read.messages.map((m) => m.data), [2], "one board: the referee's latest");
  });

  it("a workflow the app launched sends as the workflow, and its read waits for the next message", async () => {
    const res = await run(flow("referee", [{ id: "announce", type: "channel/send", config: { channel: "g1", data: { winner: "alice" } } }]), { app: chess, actor: "bob" });
    assert.equal(res.status, "success", res.error?.message);
    assert.deepEqual(watcher.messages().at(-1)?.from, { actor: "bob", code: "referee" });

    const { cursor } = await channels.read(chess, "g1");
    const waiting = run(flow("ai-player", [{ id: "look", type: "channel/read", config: { channel: "g1", since: cursor, wait: 5_000 } }]), { app: chess });
    await new Promise((r) => setTimeout(r, 20));
    channels.send(chess, { code: "game/move" }, "g1", [{ data: "e4" }]);
    const read = await waiting;
    assert.equal(read.status, "success", read.error?.message);
    const out = read.output as { messages: Array<{ data: unknown }>; members: Array<{ actor?: string }> };
    assert.deepEqual(out.messages.map((m) => m.data), ["e4"]);
    assert.deepEqual(out.members.map((m) => m.actor), ["carol"]);
  });

  it("channel/derive: the same scope the same name, another scope or app another, a name the channel format takes", async () => {
    const derive = async (scope: string, app = chess) => {
      const res = await run(flow("gate", [{ id: "d", type: "channel/derive", config: { scope } }]), { app });
      assert.equal(res.status, "success", res.error?.message);
      return (res.output as { channel: string }).channel;
    };
    const a = await derive("game-7:1");
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(channelNameProblem(a), null);
    assert.equal(await derive("game-7:1"), a);
    assert.notEqual(await derive("game-7:2"), a, "a new epoch, a new room");
    assert.notEqual(await derive("game-7:1", { name: "go", version: "v1" }), a);
  });

  it("without an app every channel step refuses: a channel is an app's", async () => {
    for (const [type, config] of [
      ["channel/send", { channel: "g1", data: 1 }],
      ["channel/read", { channel: "g1" }],
      ["channel/derive", { scope: "x" }],
    ] as const) {
      const res = await run(flow("loose", [{ id: "s", type, config }]));
      assert.equal(res.status, "error", type);
      assert.match(res.error?.message ?? "", /a channel is an app's/, type);
    }
    assert.equal(watcher.messages().length, 0);
  });

  it("a page never calls them, whatever its grants say", () => {
    const manifest = manifestSchema.parse({ title: "Chess", grants: { steps: ["channel/*", "game/move"] } });
    for (const type of ["channel/send", "channel/read", "channel/derive"]) {
      assert.match(grantRefusal(type, {}, manifest, registry) ?? "", /not a thing a page does/, type);
    }
    assert.equal(grantRefusal("game/move", {}, manifest, registry), null, "the referee it grants, the page calls");
  });
});
