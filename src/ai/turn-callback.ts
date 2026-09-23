import type { ChatStore } from "../chat-store.js";
import { postCallback } from "../callback.js";

export { callbackOrigin, parseCallback } from "../callback.js";

/**
 * Turn-end callbacks — how a HOST that dispatched a chat turn (`POST /chat
 * { callback: { url } }`) hears back without holding a connection open. A turn
 * can take seconds or hours, and one dispatch can produce SEVERAL turns: a
 * `run_workflow` that auto-detaches ends its turn with "I'll report back", and
 * the `[run-notification]` / `[verify-notification]` wakes the chat later, on
 * its own. So:
 *
 *   - the callback is stored on the CHAT (`ChatMeta.callback`), not the turn —
 *     machine-triggered turns post to it exactly like the human-triggered one;
 *   - every turn end posts, carrying `settled`: false while anything this
 *     process knows of will (or may) wake the chat again — an `expect()`ed
 *     wake-up outstanding, or the next turn already running (notifications
 *     that queued behind this one). The host shows every turn and acts on
 *     the settled one;
 *   - when the last expected wake-up resolves WITHOUT launching a turn (a
 *     verify pass with nothing to say; a notification that parked at the
 *     auto-turn cap), there is no turn end to carry the news — a `settled`
 *     event follows instead, so a host told `settled: false` always hears
 *     `settled: true`.
 *
 * All of it is in-process, the notifier's crash posture: a restart drops the
 * pending state and the callback with it (the host's fallback is `GET
 * /chat/:id`). Delivery is best-effort with a few retries and never blocks or
 * fails the turn (`postCallback`, src/callback.ts — shared with run
 * callbacks). The URL is the credential (the host signs it), so only its
 * origin is ever logged or returned by a read endpoint.
 */

export interface TurnCallbackPayload {
  /** `turn.end`: a turn finished. `settled`: nothing finished, but the chat
   *  went idle after a `turn.end` that said `settled: false`. */
  event: "turn.end" | "settled";
  chatId: string;
  turn: number;
  status: "done" | "error";
  /** What started the turn: a `POST /chat`, or a run/verify notification. */
  trigger?: "human" | "notification";
  /** The turn's final assistant text (`turn.end` with `status: "done"`). */
  text?: string;
  error?: { message: string };
  /** The turn was stopped (`POST /chat/:id/cancel`): `text` is what streamed
   *  before the stop, not an answer. */
  stopped?: true;
  /** Nothing this process knows of will start another turn. */
  settled: boolean;
  /** The auto-turn cap is reached: notifications append to the transcript but
   *  start no turn until a human message arrives. */
  parked: boolean;
}

export interface TurnCallbacks {
  /** Something will (or may) wake this chat later — a detached run, a verify
   *  pass. Returns an idempotent release; call it AFTER the wake-up was
   *  delivered (or found to be nothing), so a turn it launched is already live. */
  expect(chatId: string): () => void;
  /** A turn finished — post it. Called from `launchChatTurn`'s finally AFTER
   *  the notifier drained its queue: the chat is no longer live (a host may
   *  reply to the callback with its next message at once), unless queued
   *  notifications just launched the next turn — which means not settled. */
  turnEnded(info: {
    chatId: string;
    turn: number;
    status: "done" | "error";
    trigger: "human" | "notification";
    text?: string;
    error?: { message: string };
    stopped?: true;
  }): Promise<void>;
}

/** The final assistant text of a turn's response messages. */
export function finalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p.text === "string")
              .map((p) => p.text)
              .join("")
          : "";
    if (text.trim()) return text;
  }
  return undefined;
}

export function createTurnCallbacks(opts: {
  chatStore: Pick<ChatStore, "getMeta">;
  /** The notifier's view: a turn is running for this chat. */
  isLive: (chatId: string) => boolean;
  maxAutoTurns: number;
  fetch?: typeof fetch;
  /** Delays before each retry of a failed delivery (ms). */
  retryDelaysMs?: number[];
  timeoutMs?: number;
}): TurnCallbacks {
  /** Outstanding `expect()`s per chat. */
  const pending = new Map<string, number>();
  /** Chats whose host was last told `settled: false` → the turn it came from. */
  const unsettled = new Map<string, number>();

  const isSettled = (chatId: string) => !pending.get(chatId) && !opts.isLive(chatId);

  const post = (url: string, payload: TurnCallbackPayload) =>
    postCallback(url, payload, {
      tag: `[chat ${payload.chatId}] callback ${payload.event} turn ${payload.turn}`,
      fetch: opts.fetch,
      retryDelaysMs: opts.retryDelaysMs,
      timeoutMs: opts.timeoutMs,
    });

  /** Posts are chained per chat so the host sees them in order (a `settled`
   *  never overtakes the `turn.end` it follows). Detached: a slow or dead
   *  host never holds up the turn's teardown. */
  const chains = new Map<string, Promise<void>>();
  function enqueue(url: string, payload: TurnCallbackPayload): void {
    const next = (chains.get(payload.chatId) ?? Promise.resolve()).then(() => post(url, payload));
    chains.set(payload.chatId, next);
    void next.finally(() => {
      if (chains.get(payload.chatId) === next) chains.delete(payload.chatId);
    });
  }

  /** The last expected wake-up resolved. If it launched a turn, that turn's
   *  end reports; otherwise the host is still waiting on `settled: false`. */
  async function idleCheck(chatId: string): Promise<void> {
    if (!unsettled.has(chatId)) return;
    const meta = await opts.chatStore.getMeta(chatId);
    // Re-read after the await, with nothing async between check and send.
    const turn = unsettled.get(chatId);
    if (turn === undefined || !isSettled(chatId)) return;
    unsettled.delete(chatId);
    const url = meta?.callback?.url;
    if (!url) return;
    enqueue(url, {
      event: "settled",
      chatId,
      turn,
      status: meta.status === "error" ? "error" : "done",
      settled: true,
      parked: (meta.autoTurns ?? 0) >= opts.maxAutoTurns,
    });
  }

  return {
    expect(chatId) {
      pending.set(chatId, (pending.get(chatId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (pending.get(chatId) ?? 1) - 1;
        if (left > 0) {
          pending.set(chatId, left);
          return;
        }
        pending.delete(chatId);
        idleCheck(chatId).catch((err) => console.error(`[chat ${chatId}] settled callback failed:`, err));
      };
    },

    async turnEnded(info) {
      const meta = await opts.chatStore.getMeta(info.chatId);
      const url = meta?.callback?.url;
      if (!url) return;
      // Nothing async between reading the state and recording what the host
      // was told — a release() racing in sees one or the other, never neither.
      const settled = isSettled(info.chatId);
      if (settled) unsettled.delete(info.chatId);
      else unsettled.set(info.chatId, info.turn);
      enqueue(url, {
        event: "turn.end",
        ...info,
        settled,
        parked: (meta.autoTurns ?? 0) >= opts.maxAutoTurns,
      });
    },
  };
}
