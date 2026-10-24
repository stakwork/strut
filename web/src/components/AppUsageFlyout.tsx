import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { formatBytes } from "../attachments";
import { errorMessage } from "../helpers";
import { CloseIcon } from "../icons";
import { FlyoutResizer } from "./FlyoutResizer";

// ── App usage (src/apps/monitor.ts) ────────────────────────────────────────
//
// What an app's pages cost the server: every `step_run` counted where it
// ran, over the last day (kept on disk, so a restart keeps it). The warnings first — the live
// version's lit, an earlier version's dim — each with what to do and, for an
// app that lives here, a way to hand it to the builder; then the calls per
// minute over the last hour and the last day by step type. Refreshed while
// open.

const KIND: Record<api.AppWarning["kind"], string> = {
  fanout: "One call per item",
  repeat: "Polling too fast",
  volume: "Too many calls",
  bytes: "Too much data",
  failing: "Failing in a loop",
};

const REFRESH_MS = 10_000;

export function since(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 60 / 24)}d ago`;
}

const n = (v: number) => v.toLocaleString();
const avgMs = (t: api.AppUsageTotals) => {
  const avg = t.ms / Math.max(1, t.calls);
  return t.calls && avg < 1 ? "<1 ms" : `${Math.round(avg)} ms`;
};
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function AppUsageFlyout(props: {
  app: { name: string; title: string; version: string; peer?: string };
  onClose: () => void;
  /** Hand a warning to the builder chat (an app that lives here). */
  onFix?: (warning: api.AppWarning) => void;
}) {
  const { app } = props;
  const [usage, setUsage] = useState<api.AppUsage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setUsage(null);
    setError("");
    const load = () =>
      api.getAppUsage(app.name, app.peer).then(
        (u) => { if (live) { setUsage(u); setError(""); } },
        (e) => { if (live) setError(errorMessage(e)); },
      );
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [app.name, app.peer]);

  const current = usage?.warnings.filter((w) => w.version === app.version) ?? [];
  const earlier = usage?.warnings.filter((w) => w.version !== app.version) ?? [];

  return (
    <div class="flyout">
      <FlyoutResizer />
      <div class="flyout-header">
        <div>
          <div class="flyout-title">Usage · {app.title}</div>
          <div class="flyout-meta-row" style="gap:12px;font-size:11px;color:var(--text-muted);">
            <span>{app.peer ? `counted on @${app.peer}` : "counted on this server"}</span>
            {usage?.since && <span title={usage.since}>since {since(usage.since)}</span>}
            {usage?.lastCallAt && <span>last call {since(usage.lastCallAt)}</span>}
          </div>
        </div>
        <button class="btn btn-icon" onClick={props.onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      <div class="flyout-body usage">
        {error && <div class="flyout-json tone-error">{error}</div>}
        {!usage && !error && <div class="empty">Loading…</div>}
        {usage && (
          <>
            {current.length === 0 && (
              <div class="usage-ok">No warnings on {app.version} — its pages ask the server for what they show, and no more.</div>
            )}
            {current.map((w) => (
              <WarningCard key={`${w.kind}:${w.type ?? ""}:${w.window}`} warning={w} {...(props.onFix ? { onFix: props.onFix } : {})} />
            ))}

            <div class="flyout-section-title">Calls</div>
            <div class="step-stats">
              <Stat label="last hour" value={n(usage.hour.calls)} />
              <Stat label="last 24 h" value={n(usage.day.calls)} />
              <Stat label="failed, 24 h" value={n(usage.day.errors)} tone={usage.day.errors ? "error" : undefined} />
              <Stat label="data, 24 h" value={formatBytes(usage.day.bytes)} />
            </div>
            <MinuteBars minutes={usage.minutes} />

            <div class="flyout-section-title">By step, last 24 h</div>
            {usage.types.length === 0
              ? <div class="empty-sidebar">No calls yet.</div>
              : (
                <table class="usage-types">
                  <thead>
                    <tr><th>Step</th><th>Calls</th><th>Failed</th><th>Avg</th><th>Data</th></tr>
                  </thead>
                  <tbody>
                    {usage.types.map((t) => (
                      <tr key={t.type}>
                        <td class="usage-type">{t.type}</td>
                        <td>{n(t.calls)}</td>
                        <td class={t.errors ? "is-error" : ""}>{n(t.errors)}</td>
                        <td>{avgMs(t)}</td>
                        <td>{formatBytes(t.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

            {earlier.length > 0 && (
              <>
                <div class="flyout-section-title">Earlier versions</div>
                {earlier.map((w) => <WarningCard key={`${w.version}:${w.kind}:${w.type ?? ""}:${w.window}`} warning={w} earlier />)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; tone?: "error" | undefined }) {
  return (
    <div class="step-stat">
      <span class={`step-stat-num${props.tone ? ` is-${props.tone}` : ""}`}>{props.value}</span>
      <span class="step-stat-label">{props.label}</span>
    </div>
  );
}

function WarningCard(props: { warning: api.AppWarning; earlier?: boolean; onFix?: (w: api.AppWarning) => void }) {
  const w = props.warning;
  return (
    <div class={`usage-warning${props.earlier ? " is-earlier" : ""}`}>
      <div class="usage-warning-head">
        <span class="usage-dot" aria-hidden="true" />
        <span class="usage-warning-kind">{KIND[w.kind]}</span>
        <span class="badge">{w.version}</span>
        <span class="usage-warning-when" title={`first ${w.firstAt}, last ${w.lastAt}`}>
          {w.times > 1 ? `${w.times}× · ` : ""}last {since(w.lastAt)}
        </span>
      </div>
      <div class="usage-warning-message">{w.message}</div>
      <div class="usage-warning-fix">{w.fix}</div>
      {w.example && <code class="usage-warning-example" title="The last such call's config">{w.example}</code>}
      {props.onFix && !props.earlier && (
        <button class="btn btn-sm" onClick={() => props.onFix!(w)}>Ask the builder to fix it</button>
      )}
    </div>
  );
}

/** Calls per minute over the last hour: one bar a minute, a readout on hover. */
function MinuteBars(props: { minutes: api.AppUsage["minutes"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300;
  const H = 56;
  const slot = W / props.minutes.length;
  const max = Math.max(1, ...props.minutes.map((m) => m.calls));
  const shown = hover !== null ? props.minutes[hover] : undefined;
  return (
    <div class="usage-bars">
      <div class="usage-bars-readout">
        {shown
          ? `${hhmm(shown.at)} · ${n(shown.calls)} call${shown.calls === 1 ? "" : "s"}${shown.errors ? ` · ${n(shown.errors)} failed` : ""} · ${formatBytes(shown.bytes)}`
          : `per minute, last hour · peak ${n(max === 1 && !props.minutes.some((m) => m.calls) ? 0 : max)}`}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Calls per minute over the last hour" onMouseLeave={() => setHover(null)}>
        <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} class="usage-bars-axis" />
        {props.minutes.map((m, i) => {
          const h = m.calls ? Math.max(2, (m.calls / max) * (H - 4)) : 0;
          return (
            <g key={m.at} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y="0" width={slot} height={H} class="usage-bars-hit" />
              {h > 0 && <rect x={i * slot + 1} y={H - h} width={Math.max(1, slot - 2)} height={h} rx="1.5" class={`usage-bars-bar${hover === i ? " is-hover" : ""}`} />}
            </g>
          );
        })}
      </svg>
      <div class="usage-bars-scale"><span>{props.minutes[0] ? hhmm(props.minutes[0].at) : ""}</span><span>now</span></div>
    </div>
  );
}
