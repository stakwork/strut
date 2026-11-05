/**
 * CHANNELS (plans/app-channels.md): live messages between the people on an
 * app — a game's moves, cursors, a lobby that fills as people arrive.
 *
 * A channel is named by an app and shared by every viewer of it: one
 * `LiveFeed` of JSON messages plus the sockets joined to it, in this
 * process. Every version of the app shares its channels (as it shares
 * `app/state` and its jobs); a PREVIEW (`preview-<hex>`) has its own, so
 * the builder's test never joins a live game.
 *
 * A page never connects: its HOST holds one socket per open page and hands
 * it to `connect` (the socket door, `GET /apps/channels`, is the transport;
 * nothing here knows about WebSockets). Code the app runs — a custom step a
 * page called, a workflow it launched — reaches the same channels through
 * `send` and `read`.
 *
 * - STAMPED: strut writes every message's sender — a socket's actor and
 *   the client id strut gave the socket, or the step or workflow that sent
 *   it (`code`) with the actor who set it off. Never what the sender wrote.
 * - STATES AND EVENTS: a message with a `key` replaces that SENDER's last
 *   message with the same key (a position, a referee's board); no sender
 *   can replace another's. A message with no key is an event, never
 *   replaced. When the channel is full, events go first.
 * - PRESENCE from the sockets: a join is `joined` to the others, a leave
 *   (or a clean close) `left` at once, and the leaver's states are dropped.
 *   A socket that dies waits `CHANNEL_REJOIN_MS` for its host to come back
 *   with the same client id before it leaves; one that stops answering
 *   pings is closed.
 * - NOTHING KEPT: no run, no log line, no store. A restart empties every
 *   channel; a channel with nobody in it goes after `CHANNEL_IDLE_MS`.
 */

import { randomBytes } from "node:crypto";
import { isPreviewLabel } from "./apps/files.js";
import { FEED_MAX_WAIT_MS, LiveFeed } from "./live-feed.js";
import { idProblem } from "./session-store.js";

/** One message's `data`, as JSON. A move, not a file. */
export const CHANNEL_MESSAGE_MAX_BYTES = 8 * 1024;
/** Messages a channel keeps: its senders' states and the recent events. */
export const CHANNEL_KEEP = 256;
/** Distinct keys one sender may hold in a channel. */
export const CHANNEL_STATES_PER_SENDER = 16;
/** A key's longest. */
export const CHANNEL_KEY_MAX = 64;
/** Messages a second one sender may send, across the app's channels… */
export const CHANNEL_SEND_RATE = 30;
/** …in bursts of up to this many. */
export const CHANNEL_SEND_BURST = 60;
/** A socket that died keeps its place this long for its host to come back. */
export const CHANNEL_REJOIN_MS = 10_000;
/** A channel with nobody in it and no message is dropped after this. */
export const CHANNEL_IDLE_MS = 10 * 60_000;
/** Live channels one app may have. */
export const CHANNELS_PER_APP = 1_000;
/** Channels one socket may be in at once (a lobby and a game). */
export const CHANNELS_PER_SOCKET = 8;
/** How often a socket is pinged; one that has not answered the last is closed. */
export const CHANNEL_PING_MS = 10_000;
/** How long a step's woken read waits for more before it answers. */
export const CHANNEL_GATHER_MS = 20;
/** How often the timers run: pending leaves, pings, idle channels. */
export const CHANNEL_TICK_MS = 1_000;

/** The app a channel belongs to, as a socket's ticket or a step's `ctx.app` names it. */
export interface ChannelApp {
  name: string;
  version: string;
}

/** Who sent a message — strut's stamp. */
export interface ChannelSender {
  /** The socket's actor (its ticket's), or the actor of the run that sent it. */
  actor?: string;
  /** A page: the id strut gave its socket. */
  client?: string;
  /** A step or workflow: its type or name. */
  code?: string;
}

export interface ChannelMessage {
  from: ChannelSender;
  /** A state: replaces this sender's last message with the same key. */
  key?: string;
  data: unknown;
  /** When strut took it (ms). */
  at: number;
}

export interface ChannelMember {
  actor?: string;
  client: string;
  /** When it joined (ms). */
  since: number;
}

/** A message as a sender hands it in. */
export interface ChannelInput {
  key?: string;
  data: unknown;
}

/** Strut → host, one per socket message. */
export type ChannelFrame =
  | { op: "joined"; channel: string; client: string; cursor: string; members: ChannelMember[]; messages: ChannelMessage[]; reset?: true }
  | { op: "message"; channel: string; cursor: string; message: ChannelMessage }
  | { op: "presence"; channel: string; joined?: ChannelMember; left?: ChannelMember }
  | { op: "error"; channel?: string; error: string };

/** What a channel needs of a socket. */
export interface ChannelTransport {
  /** One frame, as JSON text. */
  send(text: string): void;
  /** A ping the other end answers with a pong (`ChannelConnection.pong`). Without
   *  it, the socket is never closed for not answering. */
  ping?(): void;
  /** Close at once: it stopped answering, or another socket took its place. */
  terminate?(): void;
}

/** One host's socket, as the door hands it over. */
export interface ChannelConnection {
  /** The id strut gave this socket: what its messages are stamped with. */
  readonly client: string;
  /** A frame from the host, parsed: `{ op: "join", channel, since? }`,
   *  `{ op: "leave", channel }`, `{ op: "send", channel, messages }`. */
  receive(frame: unknown): void;
  /** The socket answered a ping. */
  pong(): void;
  /** The socket closed. `clean` (the host closed it: 1000, 1001) leaves
   *  every channel at once; otherwise each waits `CHANNEL_REJOIN_MS` for a
   *  socket that comes back with this client id. */
  close(clean: boolean): void;
}

export interface ChannelRead {
  cursor: string;
  reset?: true;
  more?: true;
  messages: ChannelMessage[];
  members: ChannelMember[];
}

export interface Channels {
  /** A host's socket for one page of `app`. `rejoin`: the client id the
   *  host's last socket had — kept when the same actor comes back within
   *  `CHANNEL_REJOIN_MS` (or while that socket still looks open here, which
   *  it then replaces). */
  connect(app: ChannelApp, opts: { actor?: string; transport: ChannelTransport; rejoin?: string }): ChannelConnection;
  /** A step or workflow sends, stamped `code`. Throws a `ChannelError` naming the limit. */
  send(app: ChannelApp, from: { actor?: string; code: string }, channel: string, messages: ChannelInput[]): { cursor: string };
  /** A step or workflow reads: what came after `since` (everything kept
   *  without one), waiting up to `wait` ms while there is nothing new. */
  read(app: ChannelApp, channel: string, opts?: { since?: string; wait?: number; limit?: number; signal?: AbortSignal }): Promise<ChannelRead>;
  /** Pending leaves, pings and idle channels. Runs every `CHANNEL_TICK_MS` unless `timers: false`. */
  tick(): void;
  /** Stop the timers and let every waiting read answer. */
  close(): void;
}

export interface ChannelsOptions {
  /** Tests move the clock. */
  now?: () => number;
  /** `false`: no interval; the caller runs `tick`. */
  timers?: boolean;
  /** Tests shorten a step's gather. */
  gatherMs?: number;
}

/** A refusal: the message names the limit, for a model and a page alike. */
export class ChannelError extends Error {}

interface Entry {
  /** The sender's key within the channel: whose states this replaces. */
  sender: string;
  message: ChannelMessage;
}

interface Member {
  client: string;
  actor?: string;
  since: number;
  /** The socket in it; none while it waits to come back. */
  conn?: Conn;
  /** When a member whose socket died leaves. */
  leaveAt?: number;
}

interface Channel {
  key: string;
  app: string;
  name: string;
  feed: LiveFeed<Entry>;
  members: Map<string, Member>;
  touchedAt: number;
}

interface Conn {
  client: string;
  actor?: string;
  app: string;
  transport: ChannelTransport;
  channels: Set<Channel>;
  alive: boolean;
  closed: boolean;
}

interface Bucket {
  tokens: number;
  at: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The app's space: every version shares it, a preview has its own. */
export function channelAppKey(app: ChannelApp): string {
  return isPreviewLabel(app.version) ? `${app.name}@${app.version}` : app.name;
}

/** Why a channel name is refused, or null. Names follow the session-id format. */
export function channelNameProblem(name: unknown): string | null {
  const problem = idProblem(name);
  return problem ? `channel name ${problem}` : null;
}

const newClientId = () => randomBytes(9).toString("base64url");

const socketSender = (actor: string | undefined, client: string) => `c:${actor ?? ""}\u0000${client}`;
/** A step or workflow is one sender whoever set it off: its states are the code's. */
const codeSender = (code: string) => `x:${code}`;

export function createChannels(opts: ChannelsOptions = {}): Channels {
  const now = opts.now ?? Date.now;
  const channels = new Map<string, Channel>();
  const perApp = new Map<string, number>();
  /** Live sockets by client id. */
  const clients = new Map<string, Conn>();
  /** Client ids whose socket died, kept for a socket that comes back. */
  const reserved = new Map<string, { actor?: string; app: string; until: number }>();
  const buckets = new Map<string, Bucket>();
  let lastPing = now();
  /** Makes each event's feed key its own: no later message replaces it. */
  let events = 0;

  const member = (m: Member): ChannelMember => ({ ...(m.actor !== undefined ? { actor: m.actor } : {}), client: m.client, since: m.since });
  const membersOf = (ch: Channel) => [...ch.members.values()].map(member);

  const deliver = (conn: Conn, frame: ChannelFrame) => {
    if (conn.closed) return;
    try {
      conn.transport.send(JSON.stringify(frame));
    } catch (err) {
      console.warn(`[channels] ${conn.app}: a send to ${conn.client} failed:`, (err as Error).message);
    }
  };
  /** Every socket in the channel but `except`. */
  const broadcast = (ch: Channel, frame: ChannelFrame, except?: Conn) => {
    for (const m of ch.members.values()) if (m.conn && m.conn !== except) deliver(m.conn, frame);
  };

  const channelOf = (app: string, name: string, create: boolean): Channel | undefined => {
    const key = `${app}\u0000${name}`;
    let ch = channels.get(key);
    if (ch || !create) return ch;
    const count = perApp.get(app) ?? 0;
    if (count >= CHANNELS_PER_APP) throw new ChannelError(`this app already has ${CHANNELS_PER_APP} live channels (CHANNELS_PER_APP): reuse one, or let idle ones go`);
    ch = {
      key,
      app,
      name,
      feed: new LiveFeed<Entry>({
        max: CHANNEL_KEEP,
        keyOf: (e) => (e.message.key !== undefined ? `s:${e.sender}\u0000${e.message.key}` : `e:${++events}`),
        evictable: (e) => e.message.key === undefined,
        gatherMs: opts.gatherMs ?? CHANNEL_GATHER_MS,
      }),
      members: new Map(),
      touchedAt: now(),
    };
    channels.set(key, ch);
    perApp.set(app, count + 1);
    return ch;
  };

  const drop = (ch: Channel) => {
    channels.delete(ch.key);
    const left = (perApp.get(ch.app) ?? 1) - 1;
    if (left > 0) perApp.set(ch.app, left);
    else perApp.delete(ch.app);
    ch.feed.wakeAll();
  };

  /** A member goes: its states with it, and the others hear `left`. */
  const leave = (ch: Channel, m: Member) => {
    ch.members.delete(m.client);
    m.conn?.channels.delete(ch);
    const sender = socketSender(m.actor, m.client);
    ch.feed.remove((e) => e.sender === sender && e.message.key !== undefined);
    ch.touchedAt = now();
    broadcast(ch, { op: "presence", channel: ch.name, left: member(m) });
  };

  /** Spend `n` of a sender's tokens, or refuse. */
  const spend = (app: string, sender: string, n: number) => {
    const key = `${app}\u0000${sender}`;
    const t = now();
    const b = buckets.get(key) ?? { tokens: CHANNEL_SEND_BURST, at: t };
    b.tokens = Math.min(CHANNEL_SEND_BURST, b.tokens + ((t - b.at) / 1000) * CHANNEL_SEND_RATE);
    b.at = t;
    buckets.set(key, b);
    if (b.tokens < n) {
      throw new ChannelError(`too many messages: at most ${CHANNEL_SEND_RATE} a second, in bursts of ${CHANNEL_SEND_BURST} (CHANNEL_SEND_RATE) — send fewer, or make them states (a key) so a newer one replaces the last`);
    }
    b.tokens -= n;
  };

  /** Check every message, then push them all: a batch goes whole or not at all. */
  const push = (ch: Channel, sender: string, from: ChannelSender, inputs: unknown): string => {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new ChannelError("messages: a non-empty list of { key?, data }");
    const held = new Set(ch.feed.readNow().items.filter((e) => e.sender === sender && e.message.key !== undefined).map((e) => e.message.key!));
    const at = now();
    const ready: Entry[] = [];
    for (const input of inputs) {
      if (!isRecord(input)) throw new ChannelError("each message is an object: { key?, data }");
      const { key, data } = input;
      if (key !== undefined && (typeof key !== "string" || !key || key.length > CHANNEL_KEY_MAX)) {
        throw new ChannelError(`a message's key is a non-empty string of at most ${CHANNEL_KEY_MAX} characters`);
      }
      if (data === undefined) throw new ChannelError("a message needs data");
      const text = JSON.stringify(data) as string | undefined;
      if (text === undefined) throw new ChannelError("a message's data must be JSON");
      const bytes = Buffer.byteLength(text);
      if (bytes > CHANNEL_MESSAGE_MAX_BYTES) {
        throw new ChannelError(`a message's data is ${bytes} bytes of JSON, over ${CHANNEL_MESSAGE_MAX_BYTES} (CHANNEL_MESSAGE_MAX_BYTES) — a channel carries moves, not files; put a file in a job (job/upload)`);
      }
      if (typeof key === "string" && !held.has(key)) {
        if (held.size >= CHANNEL_STATES_PER_SENDER) {
          throw new ChannelError(`a sender holds at most ${CHANNEL_STATES_PER_SENDER} states in a channel (CHANNEL_STATES_PER_SENDER) — reuse a key`);
        }
        held.add(key);
      }
      ready.push({ sender, message: { from, ...(typeof key === "string" ? { key } : {}), data: JSON.parse(text) as unknown, at } });
    }
    spend(ch.app, sender, ready.length);
    for (const entry of ready) {
      ch.feed.push(entry);
      broadcast(ch, { op: "message", channel: ch.name, cursor: ch.feed.cursor(), message: entry.message });
    }
    ch.touchedAt = at;
    return ch.feed.cursor();
  };

  /** A socket's channels: leave now (clean) or wait to come back. */
  const closeConn = (conn: Conn, clean: boolean) => {
    if (conn.closed) return;
    conn.closed = true;
    if (clients.get(conn.client) === conn) clients.delete(conn.client);
    const t = now();
    for (const ch of [...conn.channels]) {
      const m = ch.members.get(conn.client);
      if (!m || m.conn !== conn) continue;
      if (clean) {
        leave(ch, m);
      } else {
        m.conn = undefined;
        m.leaveAt = t + CHANNEL_REJOIN_MS;
      }
    }
    conn.channels.clear();
    if (!clean) reserved.set(conn.client, { ...(conn.actor !== undefined ? { actor: conn.actor } : {}), app: conn.app, until: t + CHANNEL_REJOIN_MS });
  };

  const socketDoor = (conn: Conn): ChannelConnection => {
    const refuse = (error: string, channel?: string) => deliver(conn, { op: "error", ...(channel !== undefined ? { channel } : {}), error });

    const join = (name: string, since: unknown) => {
      if (since !== undefined && typeof since !== "string") return refuse("since: a cursor string", name);
      const existing = channelOf(conn.app, name, false);
      if (!(existing && conn.channels.has(existing)) && conn.channels.size >= CHANNELS_PER_SOCKET) {
        return refuse(`a page is in at most ${CHANNELS_PER_SOCKET} channels at once (CHANNELS_PER_SOCKET) — leave one first`, name);
      }
      let ch: Channel;
      try {
        ch = existing ?? channelOf(conn.app, name, true)!;
      } catch (err) {
        if (!(err instanceof ChannelError)) throw err;
        return refuse(err.message, name);
      }
      let m = ch.members.get(conn.client);
      const fresh = !m;
      if (!m) {
        m = { client: conn.client, ...(conn.actor !== undefined ? { actor: conn.actor } : {}), since: now() };
        ch.members.set(conn.client, m);
      }
      m.conn = conn;
      delete m.leaveAt;
      conn.channels.add(ch);
      ch.touchedAt = now();
      const read = ch.feed.readNow({ ...(typeof since === "string" ? { since } : {}) });
      deliver(conn, {
        op: "joined",
        channel: name,
        client: conn.client,
        cursor: read.cursor,
        members: membersOf(ch),
        messages: read.items.map((e) => e.message),
        ...(read.reset ? { reset: true as const } : {}),
      });
      if (fresh) broadcast(ch, { op: "presence", channel: name, joined: member(m) }, conn);
    };

    return {
      client: conn.client,
      receive(frame) {
        if (conn.closed) return;
        if (!isRecord(frame)) return refuse("a frame is a JSON object with an op: join, leave or send");
        const name = frame["channel"];
        const problem = channelNameProblem(name);
        if (problem) return refuse(problem, typeof name === "string" ? name : undefined);
        const channel = name as string;
        switch (frame["op"]) {
          case "join":
            return join(channel, frame["since"]);
          case "leave": {
            const ch = channelOf(conn.app, channel, false);
            const m = ch?.members.get(conn.client);
            if (ch && m?.conn === conn) leave(ch, m);
            return;
          }
          case "send": {
            const ch = channelOf(conn.app, channel, false);
            if (!ch || ch.members.get(conn.client)?.conn !== conn) return refuse("join the channel before sending to it", channel);
            try {
              push(ch, socketSender(conn.actor, conn.client), { ...(conn.actor !== undefined ? { actor: conn.actor } : {}), client: conn.client }, frame["messages"]);
            } catch (err) {
              if (!(err instanceof ChannelError)) throw err;
              refuse(err.message, channel);
            }
            return;
          }
          default:
            return refuse(`unknown op ${JSON.stringify(frame["op"])}: join, leave or send`, channel);
        }
      },
      pong() {
        conn.alive = true;
      },
      close(clean) {
        closeConn(conn, clean);
      },
    };
  };

  const timer = opts.timers === false ? undefined : setInterval(() => api.tick(), CHANNEL_TICK_MS);
  timer?.unref?.();

  const api: Channels = {
    connect(app, { actor, transport, rejoin }) {
      const appKey = channelAppKey(app);
      let client: string | undefined;
      if (rejoin) {
        const live = clients.get(rejoin);
        const kept = reserved.get(rejoin);
        if (live && live.actor === actor && live.app === appKey) {
          // The host saw the drop before strut did: the new socket takes its place.
          closeConn(live, false);
          live.transport.terminate?.();
          client = rejoin;
        } else if (kept && kept.actor === actor && kept.app === appKey && kept.until > now()) {
          client = rejoin;
        }
        if (client) reserved.delete(client);
      }
      const conn: Conn = {
        client: client ?? newClientId(),
        ...(actor !== undefined ? { actor } : {}),
        app: appKey,
        transport,
        channels: new Set(),
        alive: true,
        closed: false,
      };
      clients.set(conn.client, conn);
      return socketDoor(conn);
    },

    send(app, from, name, messages) {
      const problem = channelNameProblem(name);
      if (problem) throw new ChannelError(problem);
      if (!from.code) throw new ChannelError("a step or workflow sends as itself: code is required");
      const ch = channelOf(channelAppKey(app), name, true)!;
      const cursor = push(ch, codeSender(from.code), { ...(from.actor !== undefined ? { actor: from.actor } : {}), code: from.code }, messages);
      return { cursor };
    },

    async read(app, name, o = {}) {
      const problem = channelNameProblem(name);
      if (problem) throw new ChannelError(problem);
      const ch = channelOf(channelAppKey(app), name, true)!;
      ch.touchedAt = now();
      const read = await ch.feed.read({
        ...(o.since !== undefined ? { since: o.since } : {}),
        ...(o.wait !== undefined ? { wait: Math.min(FEED_MAX_WAIT_MS, o.wait) } : {}),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      ch.touchedAt = now();
      return {
        cursor: read.cursor,
        ...(read.reset ? { reset: true as const } : {}),
        ...(read.more ? { more: true as const } : {}),
        messages: read.items.map((e) => e.message),
        members: membersOf(ch),
      };
    },

    tick() {
      const t = now();
      for (const ch of [...channels.values()]) {
        for (const m of [...ch.members.values()]) if (m.leaveAt !== undefined && m.leaveAt <= t) leave(ch, m);
        if (ch.members.size === 0 && t - ch.touchedAt >= CHANNEL_IDLE_MS) drop(ch);
      }
      for (const [client, kept] of reserved) if (kept.until <= t) reserved.delete(client);
      for (const [key, b] of buckets) if (b.tokens + ((t - b.at) / 1000) * CHANNEL_SEND_RATE >= CHANNEL_SEND_BURST) buckets.delete(key);
      if (t - lastPing >= CHANNEL_PING_MS) {
        lastPing = t;
        for (const conn of [...clients.values()]) {
          if (!conn.transport.ping) continue;
          if (!conn.alive) {
            closeConn(conn, false);
            conn.transport.terminate?.();
            continue;
          }
          conn.alive = false;
          try {
            conn.transport.ping();
          } catch {
            // its close comes through the door
          }
        }
      }
    },

    close() {
      if (timer) clearInterval(timer);
      for (const ch of channels.values()) ch.feed.wakeAll();
    },
  };
  return api;
}
