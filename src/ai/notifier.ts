import type { ChatStore, StoredMessage } from "../chat-store.js";
import { truncateToolMessages } from "../chat-store.js";

/**
 * Run-completion notifications for the AI-builder chat — the "wake" half of
 * the dispatch-mode `run_workflow` tool (see `plans/dispatch-run-notifications.md`).
 *
 * When a detached run settles, `deliver` wakes the chat by appending a
 * user-role `[run-notification]` message and launching a new turn via the
 * SAME `launchChatTurn` path a human message uses. If a turn is live in this
 * process, notifications queue and are drained into ONE wake-up turn when it
 * ends (two runs finishing close together → one turn that sees both).
 *
 * Liveness is an in-process set (mirroring `createStrut`'s `activeRuns`), NOT
 * `meta.status` — a crashed process leaves `status: "live"` stale, and
 * pending notifications die with the process anyway (same crash posture as
 * detached runs; no durable delivery).
 *
 * Runaway guard: `ChatMeta.autoTurns` counts consecutive notification-
 * triggered turns since the last human message (`POST /chat` resets it).
 * At the cap the notification is still appended to the transcript (the next
 * human turn sees it) but NO turn is launched — an autonomous loop parks
 * instead of running unbounded.
 *
 * A person's answer to the builder's question (an elicitation,
 * plans/elicitation.md) takes the same door with `human: true`: it queues
 * behind a live turn like a notification — so a form never sees a 409 —
 * but it resets `autoTurns` (a parked chat wakes) and launches as `human`.
 */

export const NOTIFICATION_PREFIX = "[run-notification]";

export interface RunNotificationInfo {
  workflow: string;
  runId: string;
  status: "success" | "error" | "cancelled";
  durationMs?: number;
  output?: unknown;
  error?: { message: string };
}

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Render a settled run into the slim notification message text. The agent
 *  has `get_run` for full detail, so output is truncated hard. */
export function formatRunNotification(
  info: RunNotificationInfo,
  maxOutputChars = 2000,
): string {
  const dur = info.durationMs != null ? ` in ${formatDuration(info.durationMs)}` : "";
  const lines = [
    `${NOTIFICATION_PREFIX} Workflow "${info.workflow}" run ${info.runId} finished: ${info.status}${dur}.`,
  ];
  if (info.error?.message) {
    lines.push(`Error: ${info.error.message}`);
  }
  if (info.status === "success" && info.output !== undefined) {
    let json: string;
    try {
      json = JSON.stringify(info.output);
    } catch {
      json = String(info.output);
    }
    if (json.length > maxOutputChars) {
      lines.push(
        `Output (truncated, ${json.length} chars total):`,
        json.slice(0, maxOutputChars),
      );
    } else {
      lines.push(`Output: ${json}`);
    }
  }
  lines.push(`Full details: get_run("${info.workflow}", "${info.runId}").`);
  return lines.join("\n");
}

// ── Notifier ───────────────────────────────────────────────────────────────

export interface ChatNotifier {
  /** A turn is live in this process (idempotent). Called at turn launch. */
  turnStarted(chatId: string): void;
  /** The turn finished — drain any notifications queued during it into one
   *  wake-up turn. Called from `launchChatTurn`'s finally. */
  turnEnded(chatId: string): Promise<void>;
  /** Deliver one message: queue if a turn is live, else wake now.
   *  `human: true` = a person answered (an elicitation): `autoTurns` resets
   *  and the turn launches as `human`. Returns the launched turn, `queued`
   *  when it waits on the live one, or neither when the chat parked. */
  deliver(chatId: string, text: string, opts?: { human?: boolean }): Promise<{ turn?: number; queued?: true }>;
  /** Is a turn for this chat running in THIS process? The authoritative
   *  liveness check — `meta.status === "live"` on disk can be stale after a
   *  crash/restart (see `createStrut`'s `reconcileStaleChat`). */
  isLive(chatId: string): boolean;
}

export function createChatNotifier(opts: {
  chatStore: ChatStore;
  /** Max consecutive notification-triggered turns since the last human
   *  message before the chat parks (notifications append, turns stop). */
  maxAutoTurns: number;
  /** Launch an agent turn — `createStrut` passes `launchChatTurn`. Receives
   *  the truncated model-message copy, exactly like a human-triggered turn,
   *  and the trigger: `human` when a person's answer is among the messages. */
  startTurn: (chatId: string, turn: number, modelMessages: StoredMessage[], trigger: "human" | "notification") => void;
}): ChatNotifier {
  type Queued = { text: string; human: boolean };
  const live = new Set<string>();
  const queues = new Map<string, Queued[]>();

  /** Append the messages and launch the turn; the launched turn, or
   *  undefined when nothing launched (chat gone, or parked at the cap). */
  async function launch(chatId: string, items: Queued[]): Promise<number | undefined> {
    // Claim liveness synchronously so a deliver() racing in during the awaits
    // below queues instead of double-launching.
    live.add(chatId);
    try {
      const meta = await opts.chatStore.getMeta(chatId);
      if (!meta) {
        live.delete(chatId); // chat was deleted — drop silently
        return undefined;
      }
      const msgs: StoredMessage[] = items.map((i) => ({ role: "user", content: i.text }));
      // Always record the notification in the transcript, even when parked —
      // the next human-triggered turn replays it to the model.
      await opts.chatStore.appendMessages(chatId, msgs);

      // A person's answer among the messages makes this a human turn: the
      // runaway counter resets and the cap does not apply.
      const human = items.some((i) => i.human);
      const autoTurns = meta.autoTurns ?? 0;
      if (!human && autoTurns >= opts.maxAutoTurns) {
        console.warn(
          `[chat ${chatId}] auto-turn cap (${opts.maxAutoTurns}) reached — notification appended, turn NOT launched; waiting for a human message.`,
        );
        live.delete(chatId);
        return undefined;
      }

      const turn = meta.currentTurn + 1;
      await opts.chatStore.setMeta(chatId, {
        status: "live",
        currentTurn: turn,
        autoTurns: human ? 0 : autoTurns + 1,
      });
      const prior = await opts.chatStore.loadMessages(chatId);
      // startTurn (launchChatTurn) re-claims liveness idempotently and calls
      // turnEnded when the turn finishes, which drains anything queued since.
      opts.startTurn(chatId, turn, truncateToolMessages(prior), human ? "human" : "notification");
      return turn;
    } catch (err) {
      live.delete(chatId);
      console.error(`[chat ${chatId}] failed to launch notification turn:`, err);
      return undefined;
    }
  }

  return {
    isLive(chatId) {
      return live.has(chatId);
    },

    turnStarted(chatId) {
      live.add(chatId);
    },

    async turnEnded(chatId) {
      live.delete(chatId);
      const q = queues.get(chatId);
      if (q && q.length > 0) {
        queues.delete(chatId);
        await launch(chatId, q);
      }
    },

    async deliver(chatId, text, o) {
      const item: Queued = { text, human: !!o?.human };
      if (live.has(chatId)) {
        const q = queues.get(chatId) ?? [];
        q.push(item);
        queues.set(chatId, q);
        return { queued: true };
      }
      const turn = await launch(chatId, [item]);
      return turn === undefined ? {} : { turn };
    },
  };
}
