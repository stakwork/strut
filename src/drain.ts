/**
 * DRAIN — the deployment stops starting new work, so whoever runs it can
 * restart it at a quiet moment: an image update, a backup.
 *
 * While a drain is on, every new ROOT run is refused — an HTTP launch, a
 * resume, a schedule's fire (held, like a disabled workflow's), a job an
 * agent starts, a wake turn (it stays queued on disk and runs once the
 * drain lifts or the process restarts), a builder chat's run — and so is a
 * person's chat message. What is already running finishes: a run launched
 * BY a run in flight (`parentRunId`, meta/run-workflow) still starts, a
 * chat turn a settled run wakes still runs. `GET /drain` says when nothing
 * is left (`idle`).
 *
 * In memory, for this process alone: a restart starts undrained, which is
 * what an update or a backup wants. `minutes` lifts it by itself, so a
 * drain whose updater died does not refuse everything forever.
 */

/** The prefix every refusal starts with: what a caller (an updater, an
 *  agent's tool result, the UI) recognizes. */
export const DRAINING = "draining:";

/** What a launch path throws while draining. */
export class DrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrainingError";
  }
}

export interface DrainState {
  /** When the drain was turned on (ISO). */
  since: string;
  /** Why, in words a person reads in every refusal. */
  reason: string;
  /** When it lifts by itself (ISO), if it was given `minutes`. */
  until?: string;
}

export const DRAIN_REASON_MAX = 200;
export const DRAIN_MINUTES_MAX = 24 * 60;
const DEFAULT_REASON = "maintenance";

/** The refusal a caller reads: why, and what to do. */
export function drainMessage(state: DrainState): string {
  return `${DRAINING} this strut is draining for ${state.reason} — it starts nothing new until it restarts or the drain is lifted; try again in a few minutes`;
}

/** `PUT /drain`'s body: `{ reason?, minutes? }`. */
export function parseDrainBody(body: unknown): { reason?: string; minutes?: number } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: { reason?: string; minutes?: number } = {};
  if (b["reason"] !== undefined) {
    const reason = b["reason"];
    if (typeof reason !== "string" || !reason.trim()) return { error: "reason must be a non-empty string" };
    if (reason.length > DRAIN_REASON_MAX) return { error: `reason must be at most ${DRAIN_REASON_MAX} characters` };
    out.reason = reason.trim();
  }
  if (b["minutes"] !== undefined) {
    const minutes = b["minutes"];
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > DRAIN_MINUTES_MAX) {
      return { error: `minutes must be a number above 0 and at most ${DRAIN_MINUTES_MAX}` };
    }
    out.minutes = minutes;
  }
  return out;
}

export interface Drain {
  /** Turn it on, or change a drain that is on (its `since` is kept). */
  set(opts?: { reason?: string; minutes?: number }): DrainState;
  /** Turn it off; true when it was on. */
  lift(): boolean;
  /** The drain in force, if any (one past its `until` is lifted here). */
  current(): DrainState | undefined;
  /** The refusal while draining, else undefined. */
  refusal(): string | undefined;
}

export function createDrain(opts: { now?: () => Date; onLift?: () => void } = {}): Drain {
  const now = opts.now ?? (() => new Date());
  let state: DrainState | undefined;
  const lifted = () => {
    state = undefined;
    try {
      opts.onLift?.();
    } catch (err) {
      console.error("[drain] after lifting:", err);
    }
  };
  const current = () => {
    if (state?.until && Date.parse(state.until) <= now().getTime()) {
      console.log(`[drain] lifted: its ${state.until} deadline passed`);
      lifted();
    }
    return state;
  };
  return {
    set(o = {}) {
      const at = now();
      const prev = current();
      state = {
        since: prev?.since ?? at.toISOString(),
        reason: o.reason ?? prev?.reason ?? DEFAULT_REASON,
        ...(o.minutes !== undefined ? { until: new Date(at.getTime() + o.minutes * 60_000).toISOString() } : {}),
      };
      return state;
    },
    lift() {
      if (!current()) return false;
      lifted();
      return true;
    },
    current,
    refusal() {
      const s = current();
      return s ? drainMessage(s) : undefined;
    },
  };
}
