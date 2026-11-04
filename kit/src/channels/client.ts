/** The app's CHANNELS CLIENT (plans/app-channels.md §3, §7): an app page's
 *  side, over the MCP Apps `App` it already runs. It asks its host to join,
 *  leave and send (`strut/channels/*` requests) and folds what the host
 *  relays back (`strut/channels/frame`) into one state per channel, shared
 *  by every component watching it. `useChannel` is over it. No React, no
 *  dependency. */
import {
  CHANNEL_FRAME_METHOD, CHANNEL_JOIN_METHOD, CHANNEL_LEAVE_METHOD, CHANNEL_PASS_THROUGH, CHANNEL_SEND_METHOD, EMPTY_CHANNEL,
  applyChannelFrame, channelsCapabilityOf,
  type ChannelFrame, type ChannelInput, type ChannelState,
} from "./protocol.js";

/** How long a request to the host waits (joining may first open its socket). */
export const CHANNEL_REQUEST_TIMEOUT_MS = 30_000;

export interface ChannelsClient {
  /** The host carries channels. */
  available(): boolean;
  /** A channel's state now. */
  state(channel: string): ChannelState;
  /** Watch a channel: the page joins it with its first watcher and leaves
   *  with its last. `listener` gets the new state, and the frame that made
   *  it. Returns the unwatch. */
  watch(channel: string, listener: (state: ChannelState, frame?: ChannelFrame) => void): () => void;
  /** Send to a channel this page watches. Strut's refusals come back as
   *  the channel's `error`; this rejects only when the host cannot send. */
  send(channel: string, messages: ChannelInput[]): Promise<void>;
}

/** What the client needs of ext-apps' `App`. */
export interface ChannelsBridgeApp {
  getHostCapabilities(): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request(request: { method: string; params?: Record<string, unknown> }, resultSchema: any, options?: { timeout?: number }): Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setNotificationHandler(method: string, schemas: any, handler: (params: any) => void): void;
}

const NO_HOST = "this page's host carries no channels";

interface Entry {
  state: ChannelState;
  listeners: Set<(state: ChannelState, frame?: ChannelFrame) => void>;
  /** Asked to join, and no `joined` yet: the next one replaces everything. */
  fresh: boolean;
}

/** A client over the page's bridge. Construct it BEFORE `app.connect()`, so
 *  no frame is missed; the capability is read once the host has answered. */
export function createBridgeChannels(app: ChannelsBridgeApp): ChannelsClient {
  const entries = new Map<string, Entry>();
  const available = () => !!channelsCapabilityOf(app.getHostCapabilities());
  const ask = (method: string, params: Record<string, unknown>) =>
    app.request({ method, params }, CHANNEL_PASS_THROUGH, { timeout: CHANNEL_REQUEST_TIMEOUT_MS });
  const emit = (entry: Entry, frame?: ChannelFrame) => {
    for (const l of [...entry.listeners]) l(entry.state, frame);
  };
  const apply = (entry: Entry, frame: ChannelFrame) => {
    entry.state = applyChannelFrame(entry.state, frame, entry.fresh);
    if (frame.op === "joined") entry.fresh = false;
    emit(entry, frame);
  };

  app.setNotificationHandler(CHANNEL_FRAME_METHOD, { params: CHANNEL_PASS_THROUGH }, (params: unknown) => {
    const frame = params as ChannelFrame;
    if (!frame || typeof frame !== "object" || typeof frame.op !== "string") return;
    if (frame.op === "status") {
      for (const entry of entries.values()) apply(entry, frame);
      return;
    }
    const channel = (frame as { channel?: unknown }).channel;
    const entry = typeof channel === "string" ? entries.get(channel) : undefined;
    if (entry) apply(entry, frame);
  });

  return {
    available,
    state: (channel) => entries.get(channel)?.state ?? EMPTY_CHANNEL,
    watch(channel, listener) {
      let entry = entries.get(channel);
      if (!entry) {
        entry = { state: EMPTY_CHANNEL, listeners: new Set(), fresh: true };
        entries.set(channel, entry);
      }
      const e = entry;
      e.listeners.add(listener);
      if (e.listeners.size === 1) {
        if (!available()) {
          e.state = { ...EMPTY_CHANNEL, error: NO_HOST };
          emit(e);
        } else {
          e.fresh = true;
          ask(CHANNEL_JOIN_METHOD, { channel }).catch((err: unknown) => {
            if (entries.get(channel) !== e) return;
            e.state = { ...e.state, error: err instanceof Error ? err.message : String(err) };
            emit(e);
          });
        }
      }
      return () => {
        e.listeners.delete(listener);
        if (e.listeners.size > 0 || entries.get(channel) !== e) return;
        entries.delete(channel);
        if (available()) ask(CHANNEL_LEAVE_METHOD, { channel }).catch(() => undefined);
      };
    },
    async send(channel, messages) {
      if (!available()) throw new Error(NO_HOST);
      await ask(CHANNEL_SEND_METHOD, { channel, messages });
    },
  };
}

/** The client of a page whose host carries no channels. */
export const NO_CHANNELS: ChannelsClient = {
  available: () => false,
  state: () => ({ ...EMPTY_CHANNEL, error: NO_HOST }),
  watch: (_channel, listener) => {
    listener({ ...EMPTY_CHANNEL, error: NO_HOST });
    return () => {};
  },
  send: async () => {
    throw new Error(NO_HOST);
  },
};
