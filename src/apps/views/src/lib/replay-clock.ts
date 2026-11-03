// A replay's position as a time (epoch ms), passed frame by frame from one
// view to another without re-rendering either: a RunGraph sets it as its play
// moves, an AgentTrace scrolls to it. An app makes one per screen
// (`useMemo(createReplayClock, [])`) and hands it to both.

export interface ReplayClock {
  /** The replay's time, or null on the whole run. */
  get(): number | null;
  set(at: number | null): void;
  /** Called at every set; returns the unsubscribe. */
  listen(fn: (at: number | null) => void): () => void;
}

export function createReplayClock(): ReplayClock {
  let now: number | null = null;
  const listeners = new Set<(at: number | null) => void>();
  return {
    get: () => now,
    set(at) {
      if (at === now) return;
      now = at;
      for (const fn of listeners) fn(at);
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
