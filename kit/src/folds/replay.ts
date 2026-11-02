/**
 * A REPLAY's clock, for any view that plays a run back from its log — a
 * walk's hops, a run graph's calls. Pure: where a viewer starts, how long
 * each beat stays, and what play, pause, a step, a scrub and "back to live"
 * do to the cursor. Nothing is saved while a run is live: a replay days
 * later is the same log read again, at the pace the run kept.
 *
 * The cursor is the number of beats shown (0 … total). It FOLLOWS a run in
 * flight — new beats play in as they arrive, faster the further behind it
 * is — PLAYS a replay at the run's own pace times a speed, or is PAUSED
 * where a person put it.
 */

/** The speeds a viewer picks from. */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

export interface ReplayPace {
  /** The least a beat stays at 1×: readable, however fast the run went. */
  minMs: number;
  /** The most it stays at 1×: an idle stretch (a model thinking) is cut to this. */
  maxMs: number;
  /** No wait is shorter, whatever the speed or the backlog. */
  floorMs: number;
}

export const REPLAY_PACE: ReplayPace = { minMs: 700, maxMs: 4_000, floorMs: 100 };

/**
 * How long one beat stays before the next: the run's own gap between them,
 * held between `minMs` and `maxMs`, divided by the speed. An unknown gap
 * (no times) stays `minMs`.
 */
export function replayDelay(gapMs: number | null | undefined, speed = 1, pace: ReplayPace = REPLAY_PACE): number {
  const gap = typeof gapMs === "number" && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : pace.minMs;
  const held = Math.min(pace.maxMs, Math.max(pace.minMs, gap));
  return Math.max(pace.floorMs, Math.round(held / (speed > 0 ? speed : 1)));
}

/** How much faster a follower plays when `behind` beats have arrived that it has not shown. */
export function replayCatchUp(behind: number): number {
  return behind > 8 ? 6 : behind > 4 ? 3 : behind > 2 ? 2 : 1;
}

/** Epoch ms from a log's `ts` (ISO), or null. */
export function replayTime(ts: string | undefined | null): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

export type ReplayMode = "follow" | "play" | "pause";

export interface ReplayCursor {
  /** Beats shown, 0 … total. */
  at: number;
  mode: ReplayMode;
}

/**
 * Where a viewer starts: on a run in flight, at what it has done so far,
 * following it; on a finished one, at its end — or, with `replay`, at its
 * start, playing.
 */
export function replayStart(total: number, running: boolean, replay = false): ReplayCursor {
  if (running) return { at: total, mode: "follow" };
  return replay && total > 0 ? { at: 0, mode: "play" } : { at: total, mode: "pause" };
}

/**
 * How long until the next beat shows, or null when nothing moves (paused,
 * or at the newest beat). `times` are the beats' epoch ms (null unknown):
 * the wait before beat `at` is the run's gap between it and the one shown.
 */
export function replayWait(c: ReplayCursor, times: ReadonlyArray<number | null>, opts: { speed?: number; pace?: ReplayPace } = {}): number | null {
  const total = times.length;
  if (c.mode === "pause" || c.at >= total) return null;
  const prev = c.at > 0 ? times[c.at - 1] : null;
  const next = times[c.at];
  const gap = prev != null && next != null ? next - prev : null;
  const speed = opts.speed ?? 1;
  return replayDelay(gap, c.mode === "follow" ? speed * replayCatchUp(total - c.at) : speed, opts.pace);
}

/** One beat on. A replay that reaches the end of a run still in flight follows it from there; of a finished one, stops. */
export function replayAdvance(c: ReplayCursor, total: number, running: boolean): ReplayCursor {
  const at = Math.min(total, c.at + 1);
  if (at < total || c.mode !== "play") return { at, mode: c.mode };
  return { at, mode: running ? "follow" : "pause" };
}

/** Play from here — from the start when at the end. */
export function replayPlay(c: ReplayCursor, total: number): ReplayCursor {
  return { at: c.at >= total ? 0 : c.at, mode: "play" };
}

export function replayPause(c: ReplayCursor, total: number): ReplayCursor {
  return { at: Math.min(c.at, total), mode: "pause" };
}

/** Put the cursor somewhere (a scrub, a step): it stays there. */
export function replaySeek(at: number, total: number): ReplayCursor {
  return { at: Math.max(0, Math.min(total, Math.round(at))), mode: "pause" };
}

/** Back to live: everything so far, then follow. */
export function replayLive(total: number): ReplayCursor {
  return { at: total, mode: "follow" };
}

/** Moving: a beat is due, or the run is still producing them while followed. */
export function replayMoving(c: ReplayCursor, total: number, running: boolean): boolean {
  if (c.mode === "pause") return false;
  return c.at < total || (c.mode === "follow" && running);
}
