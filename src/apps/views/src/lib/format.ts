// How strut writes a run's numbers — the same as its own UI
// (web/src/components/JobTimeline.tsx, web/src/context-meter.ts).

export function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTime(iso: string | undefined, seconds = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) };
  return today ? d.toLocaleTimeString([], time) : d.toLocaleString([], { month: "short", day: "numeric", ...time });
}

export function fmtTokens(n: number): string {
  const k = Math.round(n / 1000);
  if (k >= 1000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1000) return `${k}k`;
  return String(Math.round(n));
}

/** An actor id as strut's UI shows it: its first `-` segment (web/src/actor.ts). */
export function displayActor(actor: string): string {
  return actor.split("-")[0] || actor;
}

/** A thrown value as one line. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
