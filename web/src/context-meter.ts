// ── The builder's context meter ─────────────────────────────────────────────
//
// The chat header's "351k / 1M": how full the model's context window is, as
// of the last model call (`ChatMeta.context`, `step.finish` events).

/** A token count, short: 950 · 12k · 351k · 1M · 1.05M. */
export function formatTokens(n: number): string {
  const k = Math.round(n / 1000);
  if (k >= 1000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1000) return `${k}k`;
  return String(Math.round(n));
}

/** At or past this share of the window, the meter warns. */
export const CONTEXT_WARN_AT = 0.8;

/** The meter's text and whether it warns. */
export function contextMeter(c: { used: number; limit: number }): { text: string; warn: boolean } {
  return { text: `${formatTokens(c.used)} / ${formatTokens(c.limit)}`, warn: c.limit > 0 && c.used / c.limit >= CONTEXT_WARN_AT };
}
