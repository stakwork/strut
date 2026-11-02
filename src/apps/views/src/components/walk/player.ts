// The walk's PLAYER: a cursor over its hop events (each one a beat — a
// hop's candidates listed, then its choice), advanced on a timer so a walk
// that runs faster than a person reads, or a poll that brings five hops at
// once, plays at a readable pace. Never skips a beat: the further behind it
// is, the shorter each wait, down to a floor.
import { useCallback, useEffect, useState } from "react";

/** A beat's pace when the player is caught up, ms. */
export const WALK_PACE_MS = 800;
const FLOOR_MS = 120;

/** How long to wait before the next beat, `behind` beats from the newest. */
export function beatDelay(behind: number, paceMs = WALK_PACE_MS): number {
  const d = behind > 8 ? paceMs / 6 : behind > 4 ? paceMs / 3 : behind > 2 ? paceMs / 2 : paceMs;
  return Math.max(FLOOR_MS, Math.round(d));
}

export interface WalkPlayer {
  /** Beats shown: the hop events folded so far. */
  at: number;
  /** Still moving toward the newest beat. */
  playing: boolean;
  seek: (at: number) => void;
  play: () => void;
  pause: () => void;
}

/**
 * `key` names the walk (a new one starts over); `total` is how many beats
 * the log holds now. A walk first seen RUNNING plays from its start and
 * follows; one first seen finished is shown whole, ready to replay.
 */
export function useWalkPlayer(key: string | undefined, total: number, running: boolean, paceMs = WALK_PACE_MS): WalkPlayer {
  const [pos, setPos] = useState<{ key: string | undefined; at: number; paused: boolean }>(() => ({ key, at: running ? 0 : total, paused: false }));
  let current = pos;
  if (pos.key !== key) {
    current = { key, at: running ? 0 : total, paused: false };
    setPos(current);
  }
  const at = Math.min(current.at, total);
  const playing = !current.paused && at < total;
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPos((p) => (p.key === key ? { ...p, at: Math.min(p.at, total) + 1 } : p)), beatDelay(total - at, paceMs));
    return () => clearTimeout(t);
  }, [playing, at, total, key, paceMs]);

  const seek = useCallback((n: number) => setPos((p) => ({ ...p, at: Math.max(0, Math.min(n, total)), paused: true })), [total]);
  const play = useCallback(() => setPos((p) => ({ ...p, at: Math.min(p.at, total) >= total ? 0 : p.at, paused: false })), [total]);
  const pause = useCallback(() => setPos((p) => ({ ...p, at: Math.min(p.at, total), paused: true })), [total]);
  return { at, playing, seek, play, pause };
}
