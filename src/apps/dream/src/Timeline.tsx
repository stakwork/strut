// A cause over time: when it was corrected, when it was followed, and when
// memory was changed for it, on one real time axis. Three ways to draw one
// cause, and one way to draw every cause on a shared axis. Reads only
// `cause.said`, `cause.fixes` and `cause.children` (lib/model.ts).
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Cause, Model } from "./lib/model";

export type TimelineKind = "dots" | "total" | "bars";
type Ev = { t: number; kind: "corrected" | "followed" | "changed"; text: string; runId?: string };

const HOUR = 3_600_000, DAY = 24 * HOUR;
const fmtDay = (t: number) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmt = (t: number) => `${fmtDay(t)}, ${fmtTime(t)}`;

/** Everything that happened to a cause, oldest first. A group's is its claims' together. */
export function eventsOf(cause: Cause): Ev[] {
  const leaves = cause.children.length ? cause.children : [cause];
  const said: Ev[] = leaves.flatMap((k) =>
    k.said.map((e): Ev => ({ t: Date.parse(e.at), kind: e.outcome === "followed" ? "followed" : "corrected", text: `“${e.excerpt}”`, ...(e.dream ? { runId: e.dream } : {}) })),
  );
  const changed: Ev[] = cause.fixes.map((f) => ({ t: Date.parse(f.run.startedAt), kind: "changed", text: [...f.change.added, ...(f.change.description?.is ? [f.change.description.is] : [])].join(" ") || f.change.name, runId: f.run.runId }));
  return [...said, ...changed].filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
}

/** The span to draw: from the first thing to now (the newest dream), with a little room either side. */
function domainOf(events: Ev[], now: number): [number, number] {
  const lo = Math.min(now, ...events.map((e) => e.t)), hi = Math.max(now, ...events.map((e) => e.t));
  const pad = Math.max((hi - lo) * 0.04, 20 * 60_000);
  return [lo - pad, hi + pad];
}

/** A few round moments to label the axis with: midnights over days, else whole hours. */
function ticksOf([lo, hi]: [number, number]): Array<{ t: number; label: string }> {
  const span = hi - lo;
  const byDay = span > 1.5 * DAY;
  const step = byDay ? Math.max(1, Math.ceil(span / DAY / 6)) * DAY : Math.max(1, Math.ceil(span / HOUR / 6)) * HOUR;
  const first = new Date(lo);
  if (byDay) first.setHours(24, 0, 0, 0); else first.setMinutes(60, 0, 0);
  const out: Array<{ t: number; label: string }> = [];
  for (let t = first.getTime(); t < hi; t += step) out.push({ t, label: byDay ? fmtDay(t) : fmtTime(t) });
  return out;
}

const pct = (t: number, [lo, hi]: [number, number]) => ((t - lo) / (hi - lo)) * 100;

function Axis({ domain }: { domain: [number, number] }) {
  return (
    <div className="relative h-5 border-t text-[11px] tabular-nums text-muted-foreground">
      {ticksOf(domain).map((k) => (
        <span key={k.t} className="absolute top-1 -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(k.t, domain)}%` }}>{k.label}</span>
      ))}
    </div>
  );
}

/** The stretches after memory was changed, tinted: where corrections should stop. */
function After({ events, domain }: { events: Ev[]; domain: [number, number] }) {
  const first = events.find((e) => e.kind === "changed");
  if (!first) return null;
  return <div className="absolute inset-y-0 right-0 bg-foreground/[0.06]" style={{ left: `${pct(first.t, domain)}%` }} />;
}

function ChangeLines({ events, domain, onRun }: { events: Ev[]; domain: [number, number]; onRun?: (id: string) => void }) {
  return (
    <>
      {events.filter((e) => e.kind === "changed").map((e, i) => (
        <button key={i} type="button" title={`Memory changed · ${fmt(e.t)}\n${e.text}`} onClick={() => e.runId && onRun?.(e.runId)} className="absolute inset-y-0 w-3 -translate-x-1/2" style={{ left: `${pct(e.t, domain)}%` }}>
          <span className="absolute inset-y-0 left-1/2 w-px bg-foreground" />
          <span className="absolute left-1/2 top-0 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-foreground" />
        </button>
      ))}
    </>
  );
}

const DOT = "absolute size-2.5 -translate-x-1/2 rounded-full border border-foreground transition-transform duration-100 hover:scale-125";

/** Option A. Every remark a dot at the moment it was said: solid when corrected, hollow when followed. */
function Dots({ events, domain, onRun }: { events: Ev[]; domain: [number, number]; onRun?: (id: string) => void }) {
  // Dots that would sit on each other stack upwards.
  const levels: number[] = [];
  const placed = events.filter((e) => e.kind !== "changed").map((e) => {
    const x = pct(e.t, domain);
    let level = levels.findIndex((last) => x - last >= 1.8);
    if (level < 0) level = levels.length;
    levels[level] = x;
    return { e, x, level };
  });
  const rows = Math.min(Math.max(levels.length, 1), 8);
  return (
    <div className="relative" style={{ height: `${16 + rows * 13}px` }}>
      <After events={events} domain={domain} />
      <ChangeLines events={events} domain={domain} onRun={onRun} />
      {placed.map(({ e, x, level }, i) => (
        <button
          key={i} type="button" title={`${e.kind === "followed" ? "Followed" : "Corrected"} · ${fmt(e.t)}\n${e.text}`} onClick={() => e.runId && onRun?.(e.runId)}
          className={cn(DOT, e.kind === "followed" ? "bg-background" : "bg-foreground")} style={{ left: `${x}%`, bottom: `${3 + Math.min(level, 7) * 13}px` }}
        />
      ))}
    </div>
  );
}

/** Option B. Corrections added up: a line that climbs with each one and runs flat once it stops. */
function Total({ events, domain, onRun }: { events: Ev[]; domain: [number, number]; onRun?: (id: string) => void }) {
  const said = events.filter((e) => e.kind === "corrected");
  const total = Math.max(1, said.length);
  const H = 84;
  const y = (n: number) => H - 6 - (n / total) * (H - 18);
  let d = `M0,${y(0)}`;
  said.forEach((e, i) => { const x = pct(e.t, domain); d += ` L${x},${y(i)} L${x},${y(i + 1)}`; });
  d += ` L100,${y(said.length)}`;
  return (
    <div className="relative" style={{ height: `${H}px` }}>
      <After events={events} domain={domain} />
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
        <path d={d} fill="none" className="stroke-foreground" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
      </svg>
      <ChangeLines events={events} domain={domain} onRun={onRun} />
      {said.map((e, i) => (
        <button key={i} type="button" title={`Corrected · ${fmt(e.t)}\n${e.text}`} onClick={() => e.runId && onRun?.(e.runId)} className={cn(DOT, "size-2 -translate-y-1/2 bg-foreground")} style={{ left: `${pct(e.t, domain)}%`, top: `${y(i + 1)}px` }} />
      ))}
      {events.filter((e) => e.kind === "followed").map((e, i) => (
        <button key={`f${i}`} type="button" title={`Followed · ${fmt(e.t)}\n${e.text}`} onClick={() => e.runId && onRun?.(e.runId)} className={cn(DOT, "-translate-y-1/2 bg-background")} style={{ left: `${pct(e.t, domain)}%`, top: `${y(said.filter((s) => s.t <= e.t).length)}px` }} />
      ))}
      <span className="absolute right-0 -translate-y-full pr-1 text-xs font-medium tabular-nums" style={{ top: `${y(said.length) - 2}px` }}>{said.length}×</span>
    </div>
  );
}

/** Option C. Corrections per day (per hour over a short span) as bars; a followed remark is a hollow block on top. */
function Bars({ events, domain, onRun }: { events: Ev[]; domain: [number, number]; onRun?: (id: string) => void }) {
  const span = domain[1] - domain[0];
  const size = span > 60 * DAY ? 7 * DAY : span > 1.5 * DAY ? DAY : HOUR;
  const start = (t: number) => { const d = new Date(t); if (size >= DAY) d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0); return d.getTime(); };
  const buckets = new Map<number, { corrected: Ev[]; followed: Ev[] }>();
  for (const e of events) {
    if (e.kind === "changed") continue;
    const b = buckets.get(start(e.t)) ?? { corrected: [], followed: [] };
    b[e.kind].push(e);
    buckets.set(start(e.t), b);
  }
  const max = Math.max(1, ...[...buckets.values()].map((b) => b.corrected.length + b.followed.length));
  const H = 84, unit = Math.min(14, (H - 8) / max);
  const width = Math.max(0.8, (size / span) * 100 * 0.8);
  const label = (t: number) => (size >= DAY ? fmtDay(t) : `${fmtDay(t)}, ${fmtTime(t)}`);
  return (
    <div className="relative" style={{ height: `${H}px` }}>
      <After events={events} domain={domain} />
      <ChangeLines events={events} domain={domain} onRun={onRun} />
      {[...buckets.entries()].map(([t, b]) => (
        <button
          key={t} type="button" onClick={() => { const id = (b.corrected[0] ?? b.followed[0])?.runId; if (id) onRun?.(id); }}
          title={`${label(t)} · corrected ${b.corrected.length}×${b.followed.length ? ` · followed ${b.followed.length}×` : ""}\n${[...b.corrected, ...b.followed].map((e) => e.text).join("\n")}`}
          className="absolute bottom-0 flex -translate-x-1/2 flex-col-reverse gap-px hover:opacity-80" style={{ left: `${pct(t + size / 2, domain)}%`, width: `${width}%`, minWidth: "6px", maxWidth: "28px" }}
        >
          {b.corrected.length > 0 && <span className="w-full rounded-[2px] bg-foreground" style={{ height: `${b.corrected.length * unit}px` }} />}
          {b.followed.length > 0 && <span className="w-full rounded-[2px] border border-foreground bg-background" style={{ height: `${b.followed.length * unit}px` }} />}
        </button>
      ))}
    </div>
  );
}

const Key = ({ children }: { children: ReactNode }) => <span className="inline-flex items-center gap-1.5">{children}</span>;

/** One cause over time, drawn one of three ways. */
export function CauseTimeline({ cause, model, kind, onRun }: { cause: Cause; model: Model; kind: TimelineKind; onRun?: (id: string) => void }) {
  const events = eventsOf(cause);
  const now = Date.parse(model.runs[0]?.startedAt ?? "") || Date.now();
  const domain = domainOf(events, now);
  const changed = events.some((e) => e.kind === "changed");
  const followed = events.some((e) => e.kind === "followed");
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border px-3 pb-1 pt-4">
        {kind === "dots" ? <Dots events={events} domain={domain} onRun={onRun} /> : kind === "total" ? <Total events={events} domain={domain} onRun={onRun} /> : <Bars events={events} domain={domain} onRun={onRun} />}
        <Axis domain={domain} />
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Key><span className={cn("bg-foreground", kind === "bars" ? "h-2.5 w-2 rounded-[2px]" : "size-2.5 rounded-full")} /> Corrected</Key>
        {followed && <Key><span className={cn("border border-foreground", kind === "bars" ? "h-2.5 w-2 rounded-[2px]" : "size-2.5 rounded-full")} /> Followed</Key>}
        {changed && <Key><span className="h-3 w-px bg-foreground" /> Memory changed</Key>}
      </p>
    </div>
  );
}

/** Every cause on one shared axis, most corrected first: where corrections cluster, and which ones stopped after a change. */
export function Lanes({ model, selected, onPick }: { model: Model; selected: string | null; onPick: (id: string) => void }) {
  const rows = model.causes.map((c) => ({ cause: c, events: eventsOf(c) }));
  const now = Date.parse(model.runs[0]?.startedAt ?? "") || Date.now();
  const domain = domainOf(rows.flatMap((r) => r.events), now);
  return (
    <div className="flex flex-col p-4">
      {rows.map(({ cause, events }) => {
        const levels: number[] = [];
        return (
          <button key={cause.claim.id} type="button" onClick={() => onPick(cause.claim.id)} className={cn("grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] items-center gap-x-4 border-b py-1.5 text-left hover:bg-muted/60", selected === cause.claim.id && "bg-muted")}>
            <span className="flex min-w-0 items-baseline gap-2 pl-1">
              <span className="w-7 shrink-0 text-right text-sm font-medium tabular-nums">{cause.claim.corrected}×</span>
              <span className="truncate text-sm">{cause.claim.title || cause.claim.text}</span>
            </span>
            <span className="relative block h-7">
              <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
              {events.filter((e) => e.kind === "changed").map((e, i) => (
                <span key={`c${i}`} title={`Memory changed · ${fmt(e.t)}\n${e.text}`} className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: `${pct(e.t, domain)}%` }} />
              ))}
              {events.filter((e) => e.kind !== "changed").map((e, i) => {
                const x = pct(e.t, domain);
                let level = levels.findIndex((last) => x - last >= 1.2);
                if (level < 0) level = levels.length;
                levels[level] = x;
                return <span key={i} title={`${e.kind === "followed" ? "Followed" : "Corrected"} · ${fmt(e.t)}\n${e.text}`} className={cn("absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground", e.kind === "followed" ? "bg-background" : "bg-foreground")} style={{ left: `${x}%`, top: `${[50, 22, 78][Math.min(level, 2)]}%` }} />;
              })}
            </span>
          </button>
        );
      })}
      <div className="grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)] gap-x-4">
        <span />
        <div className="-mt-px"><Axis domain={domain} /></div>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 text-xs text-muted-foreground">
        <Key><span className="size-2 rounded-full bg-foreground" /> Corrected</Key>
        <Key><span className="size-2 rounded-full border border-foreground" /> Followed</Key>
        <Key><span className="h-3 w-0.5 bg-foreground" /> Memory changed</Key>
      </p>
    </div>
  );
}
