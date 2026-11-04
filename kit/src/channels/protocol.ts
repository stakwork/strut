/** The CHANNELS contract between an app page and its host
 *  (plans/app-channels.md §3): the `strut/channels/*` methods on the MCP
 *  Apps bridge, the frames strut sends over the host's socket (src/channels.ts
 *  is their source; specs/API.md §14.9), and the one fold every page keeps
 *  of a channel. No React, no DOM, no dependency. */

/** What a host puts in `ui/initialize`'s `hostCapabilities.experimental`
 *  when it carries channels. */
export const CHANNELS_CAPABILITY = "strut/channels";
/** Page → host requests. */
export const CHANNEL_JOIN_METHOD = "strut/channels/join";
export const CHANNEL_LEAVE_METHOD = "strut/channels/leave";
export const CHANNEL_SEND_METHOD = "strut/channels/send";
/** Host → page: one of strut's frames as it came, or the host's own `status`. */
export const CHANNEL_FRAME_METHOD = "strut/channels/frame";

export interface ChannelsCapability {
  v: 1;
}

/** The channels a host carries, or undefined: none here. */
export function channelsCapabilityOf(hostCapabilities: unknown): ChannelsCapability | undefined {
  const c = (hostCapabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental?.[CHANNELS_CAPABILITY];
  return typeof c === "object" && c !== null && (c as { v?: unknown }).v === 1 ? (c as ChannelsCapability) : undefined;
}

/** Who sent a message — strut's stamp, never what the sender wrote. */
export interface ChannelSender {
  actor?: string;
  /** A page: the id strut gave its host's socket. */
  client?: string;
  /** A step or workflow of the app: its type or name. */
  code?: string;
}

export interface ChannelMessage {
  from: ChannelSender;
  /** A state: replaces this sender's last message with the same key. */
  key?: string;
  data: unknown;
  at: number;
}

export interface ChannelMember {
  actor?: string;
  client: string;
  since: number;
}

/** A message as a page sends it. */
export interface ChannelInput {
  key?: string;
  data: unknown;
}

/** What the page hears: strut's frames, and the host's `status` when its socket drops. */
export type ChannelFrame =
  | { op: "joined"; channel: string; client: string; cursor: string; members: ChannelMember[]; messages: ChannelMessage[]; reset?: true }
  | { op: "message"; channel: string; cursor: string; message: ChannelMessage }
  | { op: "presence"; channel: string; joined?: ChannelMember; left?: ChannelMember }
  | { op: "error"; channel?: string; error: string }
  | { op: "status"; connected: boolean; error?: string };

/** A StandardSchemaV1 that takes any value: the SDK wants one for a custom method. */
export const CHANNEL_PASS_THROUGH = {
  "~standard": { version: 1 as const, vendor: "strut", validate: (value: unknown) => ({ value }) },
};

/** Whose states a message replaces: a page by its actor and client, code by its name. */
export function senderKey(from: ChannelSender): string {
  return from.code !== undefined ? `x:${from.code}` : `c:${from.actor ?? ""}\u0000${from.client ?? ""}`;
}

/** Events a page keeps of a channel, as strut keeps (`CHANNEL_KEEP`). */
export const CHANNEL_EVENTS_KEPT = 256;

/** One channel as a page sees it. */
export interface ChannelState {
  /** Joined, with the host's socket up. */
  ready: boolean;
  /** This page's id in the channel: what its own messages are stamped with. */
  client?: string;
  members: ChannelMember[];
  /** The newest state of each sender and key, in the order they last changed. */
  states: ChannelMessage[];
  /** The recent events, oldest first. */
  events: ChannelMessage[];
  /** The last refusal strut sent for this channel. */
  error?: string;
}

export const EMPTY_CHANNEL: ChannelState = Object.freeze({ ready: false, members: [], states: [], events: [] }) as ChannelState;

const stateKey = (m: ChannelMessage) => `${senderKey(m.from)}\u0000${m.key}`;

function withMessage(state: ChannelState, m: ChannelMessage): ChannelState {
  if (m.key === undefined) {
    const events = [...state.events, m];
    return { ...state, events: events.length > CHANNEL_EVENTS_KEPT ? events.slice(-CHANNEL_EVENTS_KEPT) : events };
  }
  const key = stateKey(m);
  return { ...state, states: [...state.states.filter((s) => stateKey(s) !== key), m] };
}

/** The channel after `frame`. `fresh`: the page asked to join and this is
 *  the first `joined` since — its messages replace everything; a later
 *  `joined` (the host came back with its cursor) carries only what was
 *  missed, unless strut says `reset`. */
export function applyChannelFrame(state: ChannelState, frame: ChannelFrame, fresh = false): ChannelState {
  switch (frame.op) {
    case "joined": {
      const base: ChannelState = fresh || frame.reset ? { ...EMPTY_CHANNEL } : state;
      let next: ChannelState = { ...base, ready: true, client: frame.client, members: frame.members };
      delete next.error;
      for (const m of frame.messages) next = withMessage(next, m);
      return next;
    }
    case "message":
      return withMessage(state, frame.message);
    case "presence": {
      if (frame.joined) {
        const j = frame.joined;
        return { ...state, members: [...state.members.filter((m) => m.client !== j.client), j] };
      }
      if (frame.left) {
        const gone = senderKey({ ...(frame.left.actor !== undefined ? { actor: frame.left.actor } : {}), client: frame.left.client });
        return {
          ...state,
          members: state.members.filter((m) => m.client !== frame.left!.client),
          states: state.states.filter((s) => senderKey(s.from) !== gone),
        };
      }
      return state;
    }
    case "error":
      return { ...state, error: frame.error };
    case "status":
      return frame.connected ? state : { ...state, ready: false };
  }
}
