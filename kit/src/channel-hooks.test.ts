import { teardownDom, useActEnvironment } from "./test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { bootstrap, type Transport } from "./bootstrap.js";
import { newChannel, useChannel, type UseChannel } from "./channel-hooks.js";
import { CHANNEL_FRAME_METHOD, CHANNELS_CAPABILITY, type ChannelFrame, type ChannelMessage } from "./channels/protocol.js";

after(teardownDom);
useActEnvironment();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await sleep(10); });
  }
}

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** A host on the other end of the bridge that carries (or not) channels:
 *  answers `strut/channels/*` and pushes frames as strut would. */
class ChannelHostTransport implements Transport {
  onmessage?: (message: Msg) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  constructor(readonly carries: boolean) {}
  async start() {}
  async close() { this.onclose?.(); }
  push(frame: ChannelFrame) {
    queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", method: CHANNEL_FRAME_METHOD, params: frame as unknown as Record<string, unknown> }));
  }
  async send(message: Msg) {
    if (message.id === undefined || !message.method) return;
    const reply = (body: { result?: unknown; error?: unknown }) => queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id: message.id, ...body } as Msg));
    if (message.method === "ui/initialize") {
      reply({ result: {
        protocolVersion: (message.params as { protocolVersion: string }).protocolVersion,
        hostInfo: { name: "fake-host", version: "1" },
        hostCapabilities: { openLinks: {}, ...(this.carries ? { experimental: { [CHANNELS_CAPABILITY]: { v: 1 } } } : {}) },
        hostContext: {},
      } });
      return;
    }
    if (message.method.startsWith("strut/channels/")) this.calls.push({ method: message.method, ...(message.params ? { params: message.params } : {}) });
    reply({ result: {} });
    if (message.method === "strut/channels/join") {
      const channel = (message.params as { channel: string }).channel;
      this.push({
        op: "joined", channel, client: "me", cursor: "e.1",
        members: [{ actor: "alice", client: "me", since: 1 }, { actor: "bob", client: "bob-1", since: 1 }],
        messages: [{ from: { actor: "bob", client: "bob-1" }, key: "pos", data: "b1", at: 1 }],
      });
    }
  }
}

async function mount(carries: boolean, opts: Parameters<typeof useChannel>[1] = {}) {
  const host = new ChannelHostTransport(carries);
  let channel: UseChannel | undefined;
  function Probe() {
    channel = useChannel("lobby", opts);
    return null;
  }
  const root = document.createElement("div");
  document.body.appendChild(root);
  const mounted = await bootstrap(Probe, { transport: host, document, root });
  return { host, mounted, root, get: () => channel };
}

describe("useChannel", () => {
  it("joins through the host, folds what it relays, and hands each new message to onMessage with mine", async () => {
    const heard: Array<ChannelMessage & { mine: boolean }> = [];
    const { host, mounted, root, get } = await mount(true, { onMessage: (m) => heard.push(m) });
    await until(() => get()?.ready === true, "joined");
    const c = get()!;
    assert.equal(c.available, true);
    assert.equal(c.client, "me");
    assert.deepEqual(c.members.map((m) => m.actor), ["alice", "bob"]);
    assert.deepEqual(c.states.map((m) => m.data), ["b1"]);
    assert.deepEqual(host.calls, [{ method: "strut/channels/join", params: { channel: "lobby" } }]);
    assert.equal(heard.length, 0, "what a join hands over is state, not news");

    await act(async () => { await c.send({ x: 1 }, { key: "pos" }); });
    assert.deepEqual(host.calls.at(-1), { method: "strut/channels/send", params: { channel: "lobby", messages: [{ data: { x: 1 }, key: "pos" }] } });
    host.push({ op: "message", channel: "lobby", cursor: "e.2", message: { from: { actor: "alice", client: "me" }, key: "pos", data: { x: 1 }, at: 2 } });
    host.push({ op: "message", channel: "lobby", cursor: "e.3", message: { from: { actor: "bob", client: "bob-1" }, data: "hi", at: 3 } });
    await until(() => get()!.events.length === 1, "bob's event");
    assert.deepEqual(get()!.states.map((m) => m.data), ["b1", { x: 1 }]);
    assert.deepEqual(heard.map((m) => [m.data, m.mine]), [[{ x: 1 }, true], ["hi", false]]);

    host.push({ op: "status", connected: false });
    await until(() => get()!.ready === false, "the drop");
    host.push({ op: "error", channel: "lobby", error: "too many messages" });
    await until(() => get()!.error === "too many messages", "the refusal");

    await mounted.unmount();
    assert.deepEqual(host.calls.at(-1), { method: "strut/channels/leave", params: { channel: "lobby" } });
    root.remove();
  });

  it("in a host that carries no channels: unavailable, never ready, send refused", async () => {
    const { host, mounted, root, get } = await mount(false);
    await until(() => get() !== undefined, "rendered");
    const c = get()!;
    assert.equal(c.available, false);
    assert.equal(c.ready, false);
    assert.match(c.error ?? "", /no channels/);
    await assert.rejects(c.send("hi"), /no channels/);
    assert.deepEqual(host.calls, []);
    await mounted.unmount();
    root.remove();
  });

  it("newChannel is 128 random bits a channel name takes", () => {
    const a = newChannel();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, newChannel());
  });
});
