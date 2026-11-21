import { useId } from "preact/hooks";

/**
 * A tiny chart of counts, oldest first — the store's installs a day and
 * runs a day, as npm draws weekly downloads: a line with a soft fade
 * beneath it, in the accent color (`.sparkline`, components.css). The
 * numbers it stands for are the caller's to show beside it; `label` is what
 * a screen reader hears.
 */
export function Sparkline(props: { values: readonly number[]; label: string }) {
  const fade = `spark-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const W = 120;
  const H = 32;
  const n = props.values.length;
  const max = Math.max(1, ...props.values);
  const x = (i: number) => (n <= 1 ? W : (i / (n - 1)) * W);
  // 2 units clear at the top and the bottom, so the stroke is never cut.
  const y = (v: number) => H - 2 - (v / max) * (H - 4);
  const line = props.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  return (
    <svg class="sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={props.label}>
      <defs>
        <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.35" />
          <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
        </linearGradient>
      </defs>
      {n > 1 && <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${fade})`} />}
      {n > 1 && <path d={line} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />}
    </svg>
  );
}
