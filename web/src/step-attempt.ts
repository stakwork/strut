// A run's log is append-only, and a resume (or "Re-run from here") continues
// the same log: a step that failed and was run again has BOTH attempts at its
// path, oldest first — `step.start`, `step.error`, then `step.start`,
// `step.end`. What a step's status and its flyout show is its latest attempt.

export interface StepEvent {
  type: string;
  path: string;
}

/** The events at `path` from its latest attempt on. An attempt begins at a
 *  `step.start` (a retry's included) or a `step.skipped`, which the runner
 *  emits alone; a journal replay (`step.replayed`) keeps the attempt it
 *  replays. Every event at the path when none begins one. */
export function latestAttempt<E extends StepEvent>(events: readonly E[], path: string): E[] {
  const at = events.filter((e) => e.path === path);
  for (let i = at.length - 1; i >= 0; i--) {
    const t = at[i]!.type;
    if (t === "step.start" || t === "step.skipped") return at.slice(i);
  }
  return at;
}
