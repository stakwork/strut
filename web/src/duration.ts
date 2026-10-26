// ── Durations, short ────────────────────────────────────────────────────────
//
// How long a run, a step or a turn took, as a run row, the events panel and
// the run overview show it.

/** A duration in ms, short: 340ms · 2.3s · 14s · 4.5m · 14m · 2.3h. One
 *  decimal under 10 of the unit, none from there. */
export function fmtDuration(ms: number): string {
  if (ms < 999.5) return `${Math.round(ms)}ms`;
  if (ms < 59_500) return short(ms / 1000, "s");
  if (ms < 3_570_000) return short(ms / 60_000, "m");
  return short(ms / 3_600_000, "h");
}

function short(n: number, unit: string): string {
  return `${n < 9.95 ? Number(n.toFixed(1)) : Math.round(n)}${unit}`;
}
