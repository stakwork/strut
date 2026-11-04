import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_IDLE_MS,
  CHANNEL_KEEP,
  CHANNEL_PING_MS,
  CHANNEL_REJOIN_MS,
  CHANNEL_SEND_BURST,
  CHANNEL_STATES_PER_SENDER,
  CHANNELS_PER_APP,
  CHANNELS_PER_SOCKET,
  ChannelError,
  createChannels,
  type ChannelApp,
  type ChannelFrame,
  type ChannelMessage,
  type Channels,
  type ChannelTransport,
} from "./channels.js";

/** A host's socket: records what strut sends it. */
class Sock implements ChannelTransport {
  frames: ChannelFrame[] = [];
  pings = 0;
  terminated = false;
  send(text: string) {
    this.frames.push(JSON.parse(text) as ChannelFrame);
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
  }
  take(): ChannelFrame[] {
    const f = this.frames;
    this.frames = [];
    return f;
  }
  last<Op extends ChannelFrame["op"]>(op: Op): Extract<ChannelFrame, { op: Op }> {
    const f = [...this.frames].reverse().find((x) => x.op === op);
    assert.ok(f, `no ${op} frame in ${JSON.stringify(this.frames)}`);
    return f as Extract<ChannelFrame, { op: Op }>;
  }
}

const chess: ChannelApp = { name: "chess", version: "v1" };
const data = (messages: ChannelMessage[]) => messages.map((m) => m.data);

let t: number;
let channels: Channels;

beforeEach(() => {
  t = 1_000_000;
  channels = createChannels({ now: () => t, timers: false, gatherMs: 5 });
});

/** A socket of `actor` on `app`, joined to `channel`. */
function joined(actor: string | undefined, channel = "lobby", app = chess) {
  const sock = new Sock();
  const conn = channels.connect(app, { ...(actor !== undefined ? { actor } : {}), transport: sock });
  conn.receive({ op: "join", channel });
  return { conn, sock };
}

describe("channels (plans/app-channels.md)", () => {
  it("a message reaches every socket in the channel, the sender's own included, stamped by strut", () => {
    const a = joined("alice");
    const first = a.sock.last("joined");
    assert.equal(first.client, a.conn.client);
    assert.deepEqual(first.members, [{ actor: "alice", client: a.conn.client, since: t }]);
    assert.deepEqual(first.messages, []);

    const b = joined("bob");
    assert.notEqual(b.conn.client, a.conn.client);
    assert.deepEqual(b.sock.last("joined").members.map((m) => m.actor), ["alice", "bob"]);
    assert.deepEqual(a.sock.last("presence"), { op: "presence", channel: "lobby", joined: { actor: "bob", client: b.conn.client, since: t } });

    a.sock.take();
    b.sock.take();
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ data: { move: "e4" }, from: { actor: "mallory" }, at: 1 }] });
    const sent: ChannelMessage = { from: { actor: "alice", client: a.conn.client }, data: { move: "e4" }, at: t };
    for (const s of [a.sock, b.sock]) {
      const frames = s.take();
      assert.equal(frames.length, 1);
      assert.equal(frames[0]!.op, "message");
      assert.deepEqual((frames[0] as Extract<ChannelFrame, { op: "message" }>).message, sent, "what the page wrote as from and at is not the stamp");
    }
  });

  it("a key replaces only its sender's own state; an event is never replaced", () => {
    const a = joined("alice");
    const b = joined("bob");
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ key: "pos", data: "a1" }] });
    b.conn.receive({ op: "send", channel: "lobby", messages: [{ key: "pos", data: "b1" }] });
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ key: "pos", data: "a2" }, { data: "hi" }, { data: "hi" }] });
    const c = joined("carol");
    assert.deepEqual(data(c.sock.last("joined").messages), ["b1", "a2", "hi", "hi"]);
  });

  it("a leave drops the leaver's states, keeps its events, and the others hear left at once; so does a clean close", () => {
    const a = joined("alice");
    const b = joined("bob");
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ key: "pos", data: "a1" }, { data: "gg" }] });
    b.sock.take();
    a.conn.receive({ op: "leave", channel: "lobby" });
    assert.deepEqual(b.sock.take(), [{ op: "presence", channel: "lobby", left: { actor: "alice", client: a.conn.client, since: t } }]);
    assert.deepEqual(data(joined("carol").sock.last("joined").messages), ["gg"]);

    b.sock.take();
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ data: "after" }] });
    assert.equal(a.sock.last("error").error, "join the channel before sending to it");

    const c = joined("dave");
    b.sock.take();
    c.conn.close(true);
    assert.equal(b.sock.last("presence").left?.actor, "dave");
  });

  it("a socket that dies keeps its place for CHANNEL_REJOIN_MS: its host coming back with the client id is no leave", () => {
    const a = joined("alice");
    const b = joined("bob");
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ key: "pos", data: "a1" }] });
    b.sock.take();
    a.conn.close(false);
    t += CHANNEL_REJOIN_MS - 1;
    channels.tick();
    assert.deepEqual(b.sock.take(), [], "no left inside the window");

    const other = channels.connect(chess, { actor: "mallory", transport: new Sock(), rejoin: a.conn.client });
    assert.notEqual(other.client, a.conn.client, "another actor never takes the id");

    const s2 = new Sock();
    const a2 = channels.connect(chess, { actor: "alice", transport: s2, rejoin: a.conn.client });
    assert.equal(a2.client, a.conn.client);
    a2.receive({ op: "join", channel: "lobby" });
    assert.deepEqual(data(s2.last("joined").messages), ["a1"], "its state is still there");
    assert.deepEqual(b.sock.take(), [], "no joined either: it never left");

    a2.close(false);
    t += CHANNEL_REJOIN_MS;
    channels.tick();
    assert.equal(b.sock.last("presence").left?.client, a.conn.client);
    assert.deepEqual(data(joined("carol").sock.last("joined").messages), [], "its state went with it");
    assert.notEqual(channels.connect(chess, { actor: "alice", transport: new Sock(), rejoin: a.conn.client }).client, a.conn.client, "past the window the id is gone");
  });

  it("a host that reconnects before strut saw the drop takes the old socket's place", () => {
    const a = joined("alice");
    const b = joined("bob");
    b.sock.take();
    const s2 = new Sock();
    const a2 = channels.connect(chess, { actor: "alice", transport: s2, rejoin: a.conn.client });
    assert.equal(a2.client, a.conn.client);
    assert.equal(a.sock.terminated, true);
    a2.receive({ op: "join", channel: "lobby" });
    assert.deepEqual(b.sock.take(), []);
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ data: "stale" }] });
    assert.deepEqual(b.sock.take(), [], "the replaced socket sends nothing");
  });

  it("a reconnect with its cursor gets what it missed; past what the channel keeps, reset with every state", () => {
    const a = joined("alice");
    const b = joined("bob");
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ key: "ready", data: true }] });
    const cursor = a.sock.last("message").cursor;
    a.conn.close(false);
    b.conn.receive({ op: "send", channel: "lobby", messages: [{ data: 1 }, { data: 2 }, { data: 3 }] });
    const s2 = new Sock();
    const a2 = channels.connect(chess, { actor: "alice", transport: s2, rejoin: a.conn.client });
    a2.receive({ op: "join", channel: "lobby", since: cursor });
    const back = s2.last("joined");
    assert.equal(back.reset, undefined);
    assert.deepEqual(data(back.messages), [1, 2, 3]);

    for (let i = 0; i < 5; i++) {
      channels.send(chess, { code: "game/tick" }, "lobby", Array.from({ length: CHANNEL_SEND_BURST }, (_, n) => ({ data: i * 100 + n })));
      t += 10_000;
    }
    const s3 = new Sock();
    const late = channels.connect(chess, { actor: "carol", transport: s3 });
    late.receive({ op: "join", channel: "lobby", since: cursor });
    const snap = s3.last("joined");
    assert.equal(snap.reset, true);
    assert.equal(snap.messages.length, CHANNEL_KEEP);
    assert.deepEqual(snap.messages[0], { from: { actor: "alice", client: a.conn.client }, key: "ready", data: true, at: 1_000_000 }, "a burst of events never pushes out a state");
    assert.equal(snap.messages.at(-1)!.data, 459);
  });

  it("refusals name their limit, change nothing, and leave the socket open", () => {
    const a = joined("alice");
    const b = joined("bob");
    b.sock.take();
    const err = () => a.sock.last("error").error;

    a.conn.receive({ op: "send", channel: "lobby", messages: [{ data: "x".repeat(9000) }] });
    assert.match(err(), /CHANNEL_MESSAGE_MAX_BYTES/);
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ data: 1 }, { key: "", data: 2 }] });
    assert.match(err(), /key/);
    a.conn.receive({ op: "send", channel: "lobby", messages: Array.from({ length: CHANNEL_SEND_BURST + 1 }, (_, n) => ({ data: n })) });
    assert.match(err(), /CHANNEL_SEND_RATE/);
    a.conn.receive({ op: "send", channel: "lobby", messages: Array.from({ length: CHANNEL_STATES_PER_SENDER + 1 }, (_, n) => ({ key: `k${n}`, data: n })) });
    assert.match(err(), /CHANNEL_STATES_PER_SENDER/);
    a.conn.receive({ op: "send", channel: "lobby", messages: [] });
    assert.match(err(), /non-empty list/);
    assert.deepEqual(b.sock.take(), [], "a refused batch sends none of its messages");

    a.conn.receive({ op: "join", channel: "../etc" });
    assert.match(err(), /channel name/);
    a.conn.receive({ op: "dance", channel: "lobby" });
    assert.match(err(), /unknown op/);
    a.conn.receive("hello");
    assert.match(err(), /JSON object/);
    for (let i = 1; i < CHANNELS_PER_SOCKET; i++) a.conn.receive({ op: "join", channel: `room-${i}` });
    a.conn.receive({ op: "join", channel: "one-too-many" });
    assert.match(err(), /CHANNELS_PER_SOCKET/);

    a.conn.receive({ op: "send", channel: "lobby", messages: [{ data: "still here" }] });
    assert.equal(b.sock.last("message").message.data, "still here");
  });

  it("an app has at most CHANNELS_PER_APP live channels, and an idle one makes room", () => {
    for (let i = 0; i < CHANNELS_PER_APP; i++) channels.send(chess, { code: `bot-${i}` }, `c-${i}`, [{ data: i }]);
    assert.throws(() => channels.send(chess, { code: "bot" }, "one-more", [{ data: 0 }]), (e: unknown) => e instanceof ChannelError && /CHANNELS_PER_APP/.test(e.message));
    const s = new Sock();
    channels.connect(chess, { transport: s }).receive({ op: "join", channel: "one-more" });
    assert.match(s.last("error").error, /CHANNELS_PER_APP/);
    channels.send({ name: "go", version: "v1" }, { code: "bot" }, "one-more", [{ data: 0 }]); // another app's count is its own

    t += CHANNEL_IDLE_MS;
    channels.tick();
    assert.doesNotThrow(() => channels.send(chess, { code: "bot" }, "one-more", [{ data: 0 }]));
  });

  it("a channel nobody is in goes after CHANNEL_IDLE_MS; one with a member stays", async () => {
    const { cursor } = channels.send(chess, { code: "bot" }, "old", [{ data: 1 }]);
    joined("alice", "kept");
    t += CHANNEL_IDLE_MS;
    channels.tick();
    const read = await channels.read(chess, "old", { since: cursor });
    assert.equal(read.reset, true, "a new feed: the old cursor is past its end");
    assert.deepEqual(read.messages, []);
    assert.deepEqual((await channels.read(chess, "kept")).members.map((m) => m.actor), ["alice"]);
  });

  it("an app's channels are its own: every version shares them, a preview has its own, another app never sees them", () => {
    const v1 = joined("alice");
    const v2 = joined("bob", "lobby", { name: "chess", version: "v2" });
    const preview = joined("builder", "lobby", { name: "chess", version: "preview-0123456789ab" });
    const go = joined("carol", "lobby", { name: "go", version: "v1" });
    assert.deepEqual(v2.sock.last("joined").members.map((m) => m.actor), ["alice", "bob"]);
    assert.deepEqual(preview.sock.last("joined").members.map((m) => m.actor), ["builder"]);
    assert.deepEqual(go.sock.last("joined").members.map((m) => m.actor), ["carol"]);
    preview.sock.take();
    go.sock.take();
    v1.conn.receive({ op: "send", channel: "lobby", messages: [{ data: "hello" }] });
    assert.equal(v2.sock.last("message").message.data, "hello");
    assert.deepEqual(preview.sock.take(), []);
    assert.deepEqual(go.sock.take(), []);
  });

  it("a step or workflow sends as itself: whoever set it off, its states are the code's", async () => {
    const a = joined("alice", "g1");
    channels.send(chess, { actor: "alice", code: "game/move" }, "g1", [{ key: "board", data: 1 }]);
    assert.deepEqual(a.sock.last("message").message, { from: { actor: "alice", code: "game/move" }, key: "board", data: 1, at: t });
    channels.send(chess, { actor: "bob", code: "game/move" }, "g1", [{ key: "board", data: 2 }]);
    a.conn.receive({ op: "send", channel: "g1", messages: [{ key: "board", data: "forged" }] });
    const read = await channels.read(chess, "g1");
    assert.deepEqual(
      read.messages.map((m) => [m.from.code ?? m.from.client, m.data]),
      [["game/move", 2], [a.conn.client, "forged"]],
      "the page's own board is its own state; it never replaces the code's",
    );
    assert.throws(() => channels.send(chess, { code: "" }, "g1", [{ data: 1 }]), /code is required/);
    assert.throws(() => channels.send(chess, { code: "x" }, "no good", [{ data: 1 }]), /channel name/);
  });

  it("a step's read waits for the next message and says who is in the channel", async () => {
    const a = joined("alice", "g1");
    const { cursor } = await channels.read(chess, "g1");
    const waiting = channels.read(chess, "g1", { since: cursor, wait: 5_000 });
    a.conn.receive({ op: "send", channel: "g1", messages: [{ data: "your move" }] });
    const read = await waiting;
    assert.deepEqual(data(read.messages), ["your move"]);
    assert.deepEqual(read.members.map((m) => m.actor), ["alice"]);
  });

  it("a socket that stops answering pings is closed and keeps its place; one that answers stays", () => {
    const a = joined("alice");
    const b = joined("bob");
    b.sock.take();
    t += CHANNEL_PING_MS;
    channels.tick();
    assert.equal(a.sock.pings, 1);
    assert.equal(b.sock.pings, 1);
    b.conn.pong();
    t += CHANNEL_PING_MS;
    channels.tick();
    assert.equal(a.sock.terminated, true, "no pong since the last ping");
    assert.equal(b.sock.terminated, false);
    assert.deepEqual(b.sock.take(), [], "it waits CHANNEL_REJOIN_MS to come back");
    t += CHANNEL_REJOIN_MS;
    channels.tick();
    assert.equal(b.sock.last("presence").left?.actor, "alice");
  });

  it("a socket with no actor is stamped by its client id alone", () => {
    const a = joined(undefined);
    a.conn.receive({ op: "send", channel: "lobby", messages: [{ data: 1 }] });
    assert.deepEqual(a.sock.last("message").message.from, { client: a.conn.client });
    assert.deepEqual(a.sock.last("joined").members, [{ client: a.conn.client, since: t }]);
  });
});
