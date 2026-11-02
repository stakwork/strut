// The TRAIL: one row per hop, the node the walk chose drawn solid on a
// spine that grows downward and, behind "+N considered", the candidates it
// considered — kept ones outlined, dropped ones faded, ones still being
// judged shimmering. Laid out for the whole walk, the hops shown so far
// drawn in place, so a replay never changes its height. A breadcrumb (the
// tree's) reads the path at a glance.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronRight, CornerDownRight, Loader2 } from "lucide-react";
import type { WalkBrief, WalkTrail as Trail, WalkTrailCandidate, WalkTrailStep } from "@strut/kit";
import { cn } from "@/lib/utils";
import { nodeColor } from "../../lib/colors";

/**
 * The keyframes the trail moves by (an app's CSP allows inline styles). No
 * entrance hides what it brings in: a page in a hidden or background frame
 * runs no animation, and one frozen at its first frame must still show
 * every node — so a row slides in, it never fades in from nothing.
 */
export const WALK_CSS = `
@keyframes sv-walk-in { from { transform: translateY(-6px) } to { transform: none } }
@keyframes sv-walk-ring { 0% { box-shadow: 0 0 0 0 var(--sv-walk-color) } 70% { box-shadow: 0 0 0 7px transparent } 100% { box-shadow: 0 0 0 0 transparent } }
@keyframes sv-walk-shimmer { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }
@keyframes sv-walk-ping { 0% { transform: scale(1); opacity: .6 } 100% { transform: scale(2.4); opacity: 0 } }
.sv-walk-in { animation: sv-walk-in .3s ease-out }
.sv-walk-current { animation: sv-walk-ring 1.6s ease-out infinite }
.sv-walk-considering { animation: sv-walk-shimmer 1.4s ease-in-out infinite }
.sv-walk-ping { transform-box: fill-box; transform-origin: center; animation: sv-walk-ping 1.4s ease-out infinite }
@media (prefers-reduced-motion: reduce) { .sv-walk-in, .sv-walk-current, .sv-walk-considering, .sv-walk-ping { animation: none } }
`;

const tint = (type: string, pct: number) => `color-mix(in oklab, ${nodeColor(type)} ${pct}%, transparent)`;

interface Common {
  selected: string | null;
  onSelect: (node: WalkBrief) => void;
}

/**
 * `shown` drawn over `whole` in one grid cell: the cell is as big as the
 * larger of the two, so drawing more or less of the walk never moves what
 * is around it. `whole` is laid out but invisible (no focus, no reader).
 */
function InPlace({ whole, shown }: { whole: ReactNode; shown?: ReactNode }) {
  return (
    <div className="grid">
      <div className="invisible min-w-0" style={{ gridArea: "1 / 1" }} aria-hidden>
        {whole}
      </div>
      {shown && (
        <div className="min-w-0" style={{ gridArea: "1 / 1" }}>
          {shown}
        </div>
      )}
    </div>
  );
}

/** Law › Corporate / M&A › NDA › … — each hop's choice, the nodes of one read at once joined by +; the newest pulses while the walk moves. Laid out for the whole walk (`full`), the hops shown so far drawn in place. */
export function WalkBreadcrumb({ steps, full, moving, selected, onSelect }: Common & { steps: WalkTrailStep[]; full: WalkTrailStep[]; moving: boolean }) {
  if (!full.some((s) => s.chosen.length)) return null;
  return (
    <InPlace
      whole={<Crumbs steps={full} moving={false} selected={null} onSelect={onSelect} />}
      shown={<Crumbs steps={steps} moving={moving} selected={selected} onSelect={onSelect} testId="walk-breadcrumb" />}
    />
  );
}

function Crumbs({ steps, moving, selected, onSelect, testId }: Common & { steps: WalkTrailStep[]; moving: boolean; testId?: string }) {
  const groups = steps.map((s) => s.chosen).filter((g) => g.length > 0);
  return (
    <nav aria-label="The walk's path" className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-sm" data-testid={testId}>
      {groups.map((group, i) => {
        const last = i === groups.length - 1;
        return (
          <span key={`${i}-${group[0]!.ref_id}`} className="inline-flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
            {group.map((n, j) => (
              <span key={n.ref_id} className="inline-flex min-w-0 items-center gap-1">
                {j > 0 && <span className="text-xs text-muted-foreground" aria-hidden>+</span>}
                <button
                  type="button"
                  onClick={() => onSelect(n)}
                  className={cn("min-w-0 truncate rounded-md px-1.5 py-0.5 hover:bg-muted", last ? "font-semibold" : "text-muted-foreground", selected === n.ref_id && "ring-2 ring-ring", last && moving && "sv-walk-current")}
                  style={{ "--sv-walk-color": tint(n.node_type, 55) } as CSSProperties}
                >
                  {n.name || n.ref_id.slice(0, 8)}
                </button>
              </span>
            ))}
          </span>
        );
      })}
    </nav>
  );
}

/** Chosen first, then what was kept, then the rest; the best scored first within each. */
function ordered(step: WalkTrailStep): WalkTrailCandidate[] {
  const rank = { chosen: 0, kept: 1, considering: 2, dropped: 3 } as const;
  return step.candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank[a.c.state] - rank[b.c.state] || (b.c.relevance ?? -1) - (a.c.relevance ?? -1) || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * The trail: a row per hop of the whole walk (`full`), the hops of `trail`
 * (the walk as far as it is shown) drawn in place over it — so a replay
 * reveals rows where they will stay and the trail never changes height.
 */
export function WalkTrailSteps({ trail, full, moving, selected, onSelect }: Common & { trail: Trail; full: Trail; moving: boolean }) {
  const shown = trail.steps;
  return (
    <ol className="flex flex-col" data-testid="walk-trail">
      {full.steps.map((whole, i) => {
        const step = shown[i];
        const last = i === shown.length - 1;
        return (
          <li key={whole.hop} className="grid" data-hop={whole.hop}>
            <StepRow step={whole} last={i === full.steps.length - 1} current={false} selected={null} onSelect={onSelect} whole />
            {step && <StepRow step={step} last={last} current={moving && last} selected={selected} onSelect={onSelect} />}
          </li>
        );
      })}
    </ol>
  );
}

/** A pill's box: every form the choice takes is this tall, so a hop's row is the same height judged or not. */
const PILL = "inline-flex max-w-full items-center gap-2 rounded-md border-2 px-2.5 py-1.5 text-left text-sm";

function StepRow({ step, last, current, selected, onSelect, whole = false }: Common & { step: WalkTrailStep; last: boolean; current: boolean; whole?: boolean }) {
  const [open, setOpen] = useState(false);
  const chosen = step.chosen;
  const rest = ordered(step).filter((c) => c.state !== "chosen");
  const kept = rest.filter((c) => c.state === "kept").length;
  const color = chosen[0] ? nodeColor(chosen[0].node_type) : undefined;
  return (
    <div
      className={cn("relative min-w-0 pb-4 pl-8", whole ? "invisible" : "sv-walk-in")}
      style={{ gridArea: "1 / 1" }}
      {...(whole ? { "aria-hidden": true } : { "data-testid": "walk-step", "data-state": step.pending ? "pending" : chosen.length ? "chosen" : "none" })}
    >
      {!last && <span className="absolute top-4 bottom-0 left-[11px] w-px bg-border" aria-hidden />}
      <span
        className={cn("absolute top-2.5 left-1.5 size-3 rounded-full border-2", step.pending && "sv-walk-considering border-muted-foreground", !chosen.length && !step.pending && "border-muted-foreground/40 bg-background")}
        style={chosen.length ? { backgroundColor: color, borderColor: color } : undefined}
        aria-hidden
      />
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] tracking-wide text-muted-foreground uppercase">
        <span>hop {step.hop + 1}</span>
        <span className="min-w-0 normal-case">
          {step.from ? (
            <>
              from{" "}
              <button type="button" className="hover:text-foreground hover:underline" onClick={() => onSelect(step.from!)}>
                {step.from.name}
              </button>
            </>
          ) : (
            "seeds"
          )}
        </span>
        {step.jump && (
          <span className="inline-flex items-center gap-0.5 normal-case" title="The chosen node was not one of this hop's candidates: an earlier hop's, or read directly.">
            <CornerDownRight className="size-3" aria-hidden /> jumped
          </span>
        )}
        {step.sufficient !== undefined && <span title="The decider's answer to: is what was gathered enough?">· enough? {step.sufficient.toFixed(2)}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chosen.length ? (
          chosen.map((n) => {
            const relevance = step.candidates.find((c) => c.ref_id === n.ref_id)?.relevance;
            return (
              <button
                key={n.ref_id}
                type="button"
                onClick={() => onSelect(n)}
                className={cn(PILL, current && "sv-walk-current", selected === n.ref_id && "ring-2 ring-ring ring-offset-1 ring-offset-background")}
                style={{ borderColor: nodeColor(n.node_type), backgroundColor: tint(n.node_type, 16), "--sv-walk-color": tint(n.node_type, 55) } as CSSProperties}
                {...(whole ? {} : { "data-testid": "walk-chosen" })}
              >
                <span className="min-w-0 truncate font-medium">{n.name || n.ref_id.slice(0, 8)}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{n.node_type}</span>
                {relevance !== undefined && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relevance.toFixed(2)}</span>}
              </button>
            );
          })
        ) : step.pending ? (
          <span className={cn(PILL, "sv-walk-considering border-dashed text-muted-foreground")}>
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> choosing…
          </span>
        ) : step.error ? (
          <span className={cn(PILL, "border-destructive/40 text-destructive")}>{step.error}</span>
        ) : (
          step.candidates.length > 0 && <span className={cn(PILL, "border-transparent px-1 text-muted-foreground italic")}>chose none</span>
        )}
        {rest.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={cn("rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground", step.pending && "sv-walk-considering")}
            title={open ? "Hide the candidates" : "Show every candidate this hop considered"}
            {...(whole ? {} : { "data-testid": "walk-considered" })}
          >
            {open ? "hide" : `+${rest.length} considered${kept ? ` · ${kept} kept` : ""}`}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {rest.map((c) => (
            <Candidate key={c.ref_id} c={c} selected={selected === c.ref_id} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function Candidate({ c, selected, onSelect }: { c: WalkTrailCandidate; selected: boolean; onSelect: (n: WalkBrief) => void }) {
  const title = `${c.node_type}${c.relevance !== undefined ? ` · relevance ${c.relevance.toFixed(2)}` : ""} · ${c.state}${c.merged ? ` · +${c.merged} like it` : ""}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(c)}
      title={title}
      data-state={c.state}
      className={cn(
        "inline-flex max-w-[16rem] items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-opacity",
        c.state === "kept" && "text-foreground",
        c.state === "dropped" && "border-dashed text-muted-foreground opacity-50 hover:opacity-90",
        c.state === "considering" && "sv-walk-considering text-muted-foreground",
        selected && "opacity-100 ring-2 ring-ring",
      )}
      style={c.state === "kept" ? { borderColor: tint(c.node_type, 60) } : undefined}
    >
      {c.state === "kept" && <Check className="size-3 shrink-0" style={{ color: nodeColor(c.node_type) }} aria-hidden />}
      <span className="truncate">{c.name || c.ref_id.slice(0, 8)}</span>
      {c.merged > 0 && <span className="shrink-0 font-mono text-[10px]">+{c.merged}</span>}
    </button>
  );
}
