/** The channel hooks (plans/app-channels.md §7): live messages between the
 *  people on an app — a game's moves, cursors, a lobby. Over the provider's
 *  channels client: the page's host holds the socket, strut stamps every
 *  sender. A page whose host carries no channels sees `available: false`. */
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useStrutChannels } from "./provider.js";
import { EMPTY_CHANNEL, type ChannelMember, type ChannelMessage, type ChannelState } from "./channels/protocol.js";

export interface UseChannelOptions {
  /** Each message as it arrives (not the ones a join hands over): for a game
   *  loop that should not re-render on every message. `mine` is a message
   *  this page sent. */
  onMessage?: (message: ChannelMessage & { mine: boolean }) => void;
  /** `false`: do not join yet. */
  enabled?: boolean;
}

export interface UseChannel {
  /** The page's host carries channels. */
  available: boolean;
  /** Joined, with the host's socket up. False while it reconnects. */
  ready: boolean;
  /** This page's id in the channel: `from.client` on what it sends. */
  client?: string;
  /** Who has the channel open, as strut sees their sockets. */
  members: ChannelMember[];
  /** The newest state of each sender and key (a position, a board). */
  states: ChannelMessage[];
  /** The recent events, oldest first. */
  events: ChannelMessage[];
  /** The last refusal strut sent, naming its limit. */
  error?: string;
  /** Send an event, or a state with `key` (it replaces this page's last one
   *  of that key). Strut stamps it; every member gets it, this page too. */
  send(data: unknown, opts?: { key?: string }): Promise<void>;
}

/** A channel of this app. Joined while the component is mounted; every
 *  component naming the same channel shares one join and one state. */
export function useChannel(name: string | undefined, opts: UseChannelOptions = {}): UseChannel {
  const channels = useStrutChannels();
  const enabled = opts.enabled !== false && !!name;
  const onMessage = useRef(opts.onMessage);
  onMessage.current = opts.onMessage;

  const subscribe = useCallback(
    (changed: () => void) => {
      if (!enabled) return () => {};
      return channels.watch(name!, (state, frame) => {
        if (frame?.op === "message") onMessage.current?.({ ...frame.message, mine: !!state.client && frame.message.from.client === state.client });
        changed();
      });
    },
    [channels, name, enabled],
  );
  const state: ChannelState = useSyncExternalStore(
    subscribe,
    () => (enabled ? channels.state(name!) : EMPTY_CHANNEL),
    () => EMPTY_CHANNEL,
  );

  const send = useCallback(
    (data: unknown, o?: { key?: string }) => {
      if (!name) return Promise.reject(new Error("useChannel: no channel name"));
      return channels.send(name, [{ data, ...(o?.key !== undefined ? { key: o.key } : {}) }]);
    },
    [channels, name],
  );

  return useMemo(
    () => ({
      available: channels.available(),
      ready: state.ready,
      ...(state.client !== undefined ? { client: state.client } : {}),
      members: state.members,
      states: state.states,
      events: state.events,
      ...(state.error !== undefined ? { error: state.error } : {}),
      send,
    }),
    [channels, state, send],
  );
}

/** A channel name nobody can guess (128 random bits): a private game. Share
 *  it with `appLink(app, { channel })`, and whoever opens the link joins. */
export function newChannel(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
