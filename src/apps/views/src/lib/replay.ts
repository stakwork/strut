// A replay's cursor as React state, moved by the kit's clock (`replayWait`,
// `replayAdvance`): live and replay are one cursor in two modes. A view
// gives it the beats' times and whether the run is still producing them.
import { useCallback, useEffect, useState } from "react";
import { replayAdvance, replayLive, replayMoving, replayPause, replayPlay, replaySeek, replayStart, replayWait, type ReplayCursor } from "@strut/kit";

export interface Replay {
  /** Beats shown, 0 … total. */
  at: number;
  total: number;
  /** A beat is due, or a run in flight is being followed. */
  moving: boolean;
  /** Playing a replay, or following: what the play/pause button shows. */
  playing: boolean;
  /** At the newest beat of a run in flight, taking each new one as it comes. */
  following: boolean;
  speed: number;
  setSpeed: (speed: number) => void;
  play: () => void;
  pause: () => void;
  seek: (at: number) => void;
  /** Back to the newest beat, following. */
  live: () => void;
}

/**
 * `key` names what is replayed (another starts over); `times` are its
 * beats' epoch ms, in order (null unknown) — they grow while `running`.
 * Joined in flight, it shows what has happened and follows; opened
 * finished, it shows the end — or, with `replay`, plays from the start.
 */
export function useReplay(key: string | undefined, times: ReadonlyArray<number | null>, running: boolean, opts: { replay?: boolean; speed?: number } = {}): Replay {
  const total = times.length;
  const [state, setState] = useState<{ key: string | undefined; cursor: ReplayCursor }>(() => ({ key, cursor: replayStart(total, running, opts.replay) }));
  let cursor = state.cursor;
  if (state.key !== key) {
    cursor = replayStart(total, running, opts.replay);
    setState({ key, cursor });
  }
  const [speed, setSpeed] = useState(opts.speed ?? 1);
  const at = Math.min(cursor.at, total);

  const wait = replayWait({ at, mode: cursor.mode }, times, { speed });
  useEffect(() => {
    if (wait === null) return;
    const t = setTimeout(() => setState((s) => (s.key === key ? { key, cursor: replayAdvance({ ...s.cursor, at: Math.min(s.cursor.at, total) }, total, running) } : s)), wait);
    return () => clearTimeout(t);
  }, [wait, at, total, running, key]);

  const set = useCallback((f: (c: ReplayCursor) => ReplayCursor) => setState((s) => ({ key: s.key, cursor: f(s.cursor) })), []);
  return {
    at,
    total,
    moving: replayMoving({ at, mode: cursor.mode }, total, running),
    playing: cursor.mode === "play" || (cursor.mode === "follow" && (running || at < total)),
    following: cursor.mode === "follow" && running,
    speed,
    setSpeed,
    play: useCallback(() => set((c) => replayPlay(c, total)), [set, total]),
    pause: useCallback(() => set((c) => replayPause(c, total)), [set, total]),
    seek: useCallback((n: number) => set(() => replaySeek(n, total)), [set, total]),
    live: useCallback(() => set(() => replayLive(total)), [set, total]),
  };
}
