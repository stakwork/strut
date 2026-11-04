import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_EVENTS_KEPT, CHANNEL_FRAME_METHOD, CHANNEL_JOIN_METHOD, CHANNEL_LEAVE_METHOD, CHANNEL_SEND_METHOD, CHANNELS_CAPABILITY, EMPTY_CHANNEL,
  applyChannelFrame, channelsCapabilityOf,
  type ChannelFrame, type ChannelMessage, type ChannelState,
} from "./protocol.js";
import { createBridgeChannels, type ChannelsBridgeApp } from "./client.js";
import { relayChannels, type ChannelRelayBridge, type ChannelSocketLike } from "./relay.js";

const msg = (from: ChannelMessage["from"], data: unknown, key?: string): ChannelMessage => ({ from, ...(key ? { key } : {}), data, at: 1 });
const alice = { actor: "alice", client: "ca" };
const bob = { actor: "bob", client: "cb" };
const joined = (messages: ChannelMessage[], extra: Partial<Extract<ChannelFrame, { op: "joined" }>> = {}): ChannelFrame => ({
  op: "joined", channel: "lobby", client: "ca", cursor: "e.1", members: [{ actor: "alice", client: "ca", since: 1 }], messages, ...extra,
});
const fold = (frames: ChannelFrame[], fresh = true): ChannelState =>
  frames.reduce((s, f, i) => applyChannelFrame(s, f, fresh && i === 0), EMPTY_CHANNEL);

describe("the channel fold", () => {
  it("a fresh join replaces everything; a later one (the host back with its cursor) adds what was missed; reset replaces again", () => {
    const first = fold([joined([msg(alice, "a1", "pos"), msg(bob, "hi")])]);
    assert.equal(first.ready, true);
    assert.equal(first.client, "ca");
    assert.deepEqual(first.states.map((m) => m.data), ["a1"]);
    assert.deepEqual(first.events.map((m) => m.data), ["hi"]);

    const back = applyChannelFrame(applyChannelFrame(first, { op: "status", connected: false }), joined([msg(bob, "again")]));
    assert.equal(back.ready, true);
    assert.deepEqual(back.events.map((m) => m.data), ["hi", "again"], "only what was missed, added");
    assert.deepEqual(back.states.map((m) => m.data), ["a1"]);

    const reset = applyChannelFrame(back, joined([msg(bob, "b1", "pos")], { reset: true }));
    assert.deepEqual(reset.states.map((m) => m.data), ["b1"]);
    assert.deepEqual(reset.events, []);
  });

  it("a key replaces only its sender's state; a leave drops the leaver's states and keeps its events", () => {
    let s = fold([joined([])]);
    for (const f of [
      { op: "message", channel: "lobby", cursor: "e.2", message: msg(alice, "a1", "pos") },
      { op: "message", channel: "lobby", cursor: "e.3", message: msg(bob, "b1", "pos") },
      { op: "message", channel: "lobby", cursor: "e.4", message: msg(alice, "a2", "pos") },
      { op: "message", channel: "lobby", cursor: "e.5", message: msg({ code: "game/move", actor: "bob" }, 1, "board") },
      { op: "message", channel: "lobby", cursor: "e.6", message: msg({ code: "game/move", actor: "alice" }, 2, "board") },
      { op: "message", channel: "lobby", cursor: "e.7", message: msg(bob, "gg") },
      { op: "presence", channel: "lobby", joined: { actor: "bob", client: "cb", since: 2 } },
    ] as ChannelFrame[]) s = applyChannelFrame(s, f);
    assert.deepEqual(s.states.map((m) => m.data), ["b1", "a2", 2]);
    assert.deepEqual(s.members.map((m) => m.client), ["ca", "cb"]);
    s = applyChannelFrame(s, { op: "presence", channel: "lobby", left: { actor: "bob", client: "cb", since: 2 } });
    assert.deepEqual(s.states.map((m) => m.data), ["a2", 2]);
    assert.deepEqual(s.events.map((m) => m.data), ["gg"]);
    assert.deepEqual(s.members.map((m) => m.client), ["ca"]);
  });

  it("keeps the newest events, as many as strut does; an error is kept; a drop is not ready", () => {
    let s = fold([joined([])]);
    for (let i = 0; i < CHANNEL_EVENTS_KEPT + 5; i++) s = applyChannelFrame(s, { op: "message", channel: "lobby", cursor: `e.${i}`, message: msg(alice, i) });
    assert.equal(s.events.length, CHANNEL_EVENTS_KEPT);
    assert.equal(s.events[0]!.data, 5);
    s = applyChannelFrame(s, { op: "error", channel: "lobby", error: "too many messages" });
    assert.equal(s.error, "too many messages");
    assert.equal(applyChannelFrame(s, { op: "status", connected: false }).ready, false);
    assert.equal(applyChannelFrame(s, joined([])).error, undefined, "a join clears it");
  });

  it("reads the capability only when the host put it there", () => {
    assert.deepEqual(channelsCapabilityOf({ experimental: { [CHANNELS_CAPABILITY]: { v: 1 } } }), { v: 1 });
    assert.equal(channelsCapabilityOf({ experimental: { [CHANNELS_CAPABILITY]: true } }), undefined);
    assert.equal(channelsCapabilityOf({}), undefined);
    assert.equal(channelsCapabilityOf(undefined), undefined);
  });
});

/** The page's `App`, as the client sees it. */
function fakeApp(capable = true) {
  const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let push: (frame: unknown) => void = () => {};
  const app: ChannelsBridgeApp = {
    getHostCapabilities: () => (capable ? { experimental: { [CHANNELS_CAPABILITY]: { v: 1 } } } : {}),
    async request(request) {
      requests.push(request);
      return {};
    },
    setNotificationHandler(method, _schemas, handler) {
      if (method === CHANNEL_FRAME_METHOD) push = handler;
    },
  };
  return { app, requests, push: (frame: unknown) => push(frame) };
}

describe("the page's channels client", () => {
  it("joins with the first watcher, shares the state, and leaves with the last", async () => {
    const { app, requests, push } = fakeApp();
    const channels = createBridgeChannels(app);
    const seen: ChannelState[] = [];
    const stopA = channels.watch("lobby", (s) => seen.push(s));
    const stopB = channels.watch("lobby", () => undefined);
    await Promise.resolve();
    assert.deepEqual(requests, [{ method: CHANNEL_JOIN_METHOD, params: { channel: "lobby" } }]);
    push(joined([msg(alice, "a1", "pos")]));
    push({ op: "message", channel: "elsewhere", cursor: "e.9", message: msg(bob, "not ours") });
    assert.deepEqual(channels.state("lobby").states.map((m) => m.data), ["a1"]);
    assert.equal(seen.at(-1)?.ready, true);
    push({ op: "status", connected: false });
    assert.equal(channels.state("lobby").ready, false);
    await channels.send("lobby", [{ data: "hi" }]);
    assert.deepEqual(requests.at(-1), { method: CHANNEL_SEND_METHOD, params: { channel: "lobby", messages: [{ data: "hi" }] } });
    stopA();
    assert.equal(requests.length, 2, "one watcher left: still in");
    stopB();
    await Promise.resolve();
    assert.deepEqual(requests.at(-1), { method: CHANNEL_LEAVE_METHOD, params: { channel: "lobby" } });
    assert.equal(channels.state("lobby"), EMPTY_CHANNEL);
  });

  it("in a host with no channels: no request, the reason as the error, send refused", async () => {
    const { app, requests } = fakeApp(false);
    const channels = createBridgeChannels(app);
    let state: ChannelState | undefined;
    channels.watch("lobby", (s) => (state = s));
    assert.equal(channels.available(), false);
    assert.match(state!.error!, /no channels/);
    await assert.rejects(channels.send("lobby", [{ data: 1 }]), /no channels/);
    assert.deepEqual(requests, []);
  });
});

/** A socket the relay opens, driven by hand. */
class FakeSocket implements ChannelSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith?: number;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  opened() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(f: ChannelFrame) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  dropped() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

/** A bridge the relay registers on: calls a method as the page would, keeps what it sends the page. */
function fakeBridge() {
  const handlers = new Map<string, (params: unknown) => unknown>();
  const toPage: unknown[] = [];
  const bridge: ChannelRelayBridge = {
    setRequestHandler(method, _schemas, handler) {
      handlers.set(method, handler);
    },
    async notification(n) {
      toPage.push(n.params);
    },
  };
  return { bridge, toPage, call: (method: string, params: Record<string, unknown>) => Promise.resolve(handlers.get(method)!(params)) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the host's relay", () => {
  it("opens one socket on the first join, joins on open, relays every frame, and queues a send until it can go", async () => {
    const { bridge, toPage, call } = fakeBridge();
    const sockets: FakeSocket[] = [];
    const opened: Array<string | undefined> = [];
    const relay = relayChannels({ bridge, open: async (client) => (opened.push(client), sockets[sockets.push(new FakeSocket()) - 1]!), retryMs: [5] });

    await assert.rejects(call(CHANNEL_SEND_METHOD, { channel: "lobby", messages: [] }), /join the channel/);
    await call(CHANNEL_JOIN_METHOD, { channel: "lobby" });
    await call(CHANNEL_SEND_METHOD, { channel: "lobby", messages: [{ data: "early" }] });
    assert.deepEqual(opened, [undefined]);
    const s = sockets[0]!;
    s.opened();
    assert.deepEqual(s.sent, [{ op: "join", channel: "lobby" }, { op: "send", channel: "lobby", messages: [{ data: "early" }] }]);
    s.frame(joined([]));
    s.frame({ op: "message", channel: "lobby", cursor: "e.2", message: msg(alice, "early") });
    await tick();
    assert.deepEqual(toPage.map((f) => (f as ChannelFrame).op), ["joined", "message"], "as strut sent them");

    await call(CHANNEL_JOIN_METHOD, { channel: "game" });
    assert.deepEqual(s.sent.at(-1), { op: "join", channel: "game" }, "an open socket: straight on");
    await call(CHANNEL_LEAVE_METHOD, { channel: "game" });
    assert.deepEqual(s.sent.at(-1), { op: "leave", channel: "game" });
    relay.close();
    assert.equal(s.closedWith, 1000, "the frame went away: a clean close");
  });

  it("a drop tells the page, and the socket comes back with its client id and each channel's cursor", async () => {
    const { bridge, toPage, call } = fakeBridge();
    const sockets: FakeSocket[] = [];
    const opened: Array<string | undefined> = [];
    const relay = relayChannels({ bridge, open: async (client) => (opened.push(client), sockets[sockets.push(new FakeSocket()) - 1]!), retryMs: [5] });
    await call(CHANNEL_JOIN_METHOD, { channel: "lobby" });
    sockets[0]!.opened();
    sockets[0]!.frame(joined([], { client: "c-123", cursor: "e.4" }));
    sockets[0]!.frame({ op: "message", channel: "lobby", cursor: "e.7", message: msg(bob, "x") });
    sockets[0]!.dropped();
    await tick();
    assert.deepEqual(toPage.at(-1), { op: "status", connected: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(opened, [undefined, "c-123"]);
    sockets[1]!.opened();
    assert.deepEqual(sockets[1]!.sent, [{ op: "join", channel: "lobby", since: "e.7" }]);
    relay.close();
  });

  it("a ticket it cannot get is a status with the reason, and it tries again", async () => {
    const { bridge, toPage, call } = fakeBridge();
    let tries = 0;
    const relay = relayChannels({
      bridge,
      open: async () => {
        tries++;
        if (tries === 1) throw new Error("403 forbidden");
        return new FakeSocket();
      },
      retryMs: [5],
    });
    await call(CHANNEL_JOIN_METHOD, { channel: "lobby" });
    await tick();
    assert.deepEqual(toPage.at(-1), { op: "status", connected: false, error: "403 forbidden" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tries, 2);
    relay.close();
  });
});
