// The TRAIL: one row per hop, the node the walk chose drawn solid on a
// spine that grows downward, and beside it the candidates it considered —
// kept ones outlined, dropped ones faded, ones still being judged
// shimmering. A breadcrumb above reads the path at a glance.
import { useState, type CSSProperties } from "react";
import { Check, ChevronRight, CornerDownRight, Loader2 } from "lucide-react";
import type { WalkBrief, WalkTrail as Trail, WalkTrailCandidate, WalkTrailStep } from "@strut/kit";
import { cn } from "@/lib/utils";
import { nodeColor } from "../../lib/colors";

/** Siblings shown beside a choice before "+N more". */
const SIBLINGS_SHOWN = 8;

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

/** Law › Corporate / M&A › NDA › … — each hop's choice, the nodes of one read at once joined by +; the newest pulses while the walk moves. */
export function WalkBreadcrumb({ steps, moving, selected, onSelect }: Common & { steps: WalkTrailStep[]; moving: boolean }) {
  const groups = steps.map((s) => s.chosen).filter((g) => g.length > 0);
  if (!groups.length) return null;
  return (
    <nav aria-label="The walk's path" className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-sm" data-testid="walk-breadcrumb">
      {groups.map((group, i) => {
        const last = i === groups.length - 1;
        return (
          <span key={`${i}-${group[0]!.ref_id}`} className="sv-walk-in inline-flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />}
            {group.map((n, j) => (
              <span key={n.ref_id} className="inline-flex items-center gap-1">
                {j > 0 && <span className="text-xs text-muted-foreground" aria-hidden>+</span>}
                <button
                  type="button"
                  onClick={() => onSelect(n)}
                  className={cn("rounded-md px-1.5 py-0.5 hover:bg-muted", last ? "font-semibold" : "text-muted-foreground", selected === n.ref_id && "ring-2 ring-ring", last && moving && "sv-walk-current")}
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

export function WalkTrailSteps({ trail, moving, selected, onSelect }: Common & { trail: Trail; moving: boolean }) {
  const steps = trail.steps;
  return (
    <ol className="flex flex-col" data-testid="walk-trail">
      {steps.map((step, i) => (
        <Step key={step.hop} step={step} last={i === steps.length - 1} current={moving && i === steps.length - 1} selected={selected} onSelect={onSelect} />
      ))}
    </ol>
  );
}

function Step({ step, last, current, selected, onSelect }: Common & { step: WalkTrailStep; last: boolean; current: boolean }) {
  const [all, setAll] = useState(false);
  const chosen = step.chosen;
  const rest = ordered(step).filter((c) => c.state !== "chosen");
  const shown = all ? rest : rest.slice(0, SIBLINGS_SHOWN);
  const color = chosen[0] ? nodeColor(chosen[0].node_type) : undefined;
  return (
    <li className="sv-walk-in relative pb-4 pl-8" data-hop={step.hop} data-state={step.pending ? "pending" : chosen.length ? "chosen" : "none"}>
      {!last && <span className="absolute top-4 bottom-0 left-[11px] w-px bg-border" aria-hidden />}
      <span
        className={cn("absolute top-2.5 left-1.5 size-3 rounded-full border-2", step.pending && "sv-walk-considering border-muted-foreground", !chosen.length && !step.pending && "border-muted-foreground/40 bg-background")}
        style={chosen.length ? { backgroundColor: color, borderColor: color } : undefined}
        aria-hidden
      />
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] tracking-wide text-muted-foreground uppercase">
        <span>hop {step.hop + 1}</span>
        <span className="normal-case">{step.from ? <>from <button type="button" className="hover:text-foreground hover:underline" onClick={() => onSelect(step.from!)}>{step.from.name}</button></> : "seeds"}</span>
        {step.candidates.length > 0 && <span>· {step.candidates.length} considered</span>}
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
            const tone = nodeColor(n.node_type);
            return (
              <button
                key={n.ref_id}
                type="button"
                onClick={() => onSelect(n)}
                className={cn("inline-flex max-w-full items-center gap-2 rounded-md border-2 px-2.5 py-1.5 text-left text-sm", current && "sv-walk-current", selected === n.ref_id && "ring-2 ring-ring ring-offset-1 ring-offset-background")}
                style={{ borderColor: tone, backgroundColor: tint(n.node_type, 16), "--sv-walk-color": tint(n.node_type, 55) } as CSSProperties}
                data-testid="walk-chosen"
              >
                <span className="min-w-0 truncate font-medium">{n.name || n.ref_id.slice(0, 8)}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{n.node_type}</span>
                {relevance !== undefined && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relevance.toFixed(2)}</span>}
              </button>
            );
          })
        ) : step.pending ? (
          <span className="sv-walk-considering inline-flex items-center gap-1.5 rounded-md border-2 border-dashed px-2.5 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> choosing…
          </span>
        ) : step.error ? (
          <span className="rounded-md border border-destructive/40 px-2.5 py-1.5 text-sm text-destructive">{step.error}</span>
        ) : (
          step.candidates.length > 0 && <span className="px-1 text-xs text-muted-foreground italic">chose none</span>
        )}
        {shown.map((c) => (
          <Candidate key={c.ref_id} c={c} selected={selected === c.ref_id} onSelect={onSelect} />
        ))}
        {rest.length > shown.length && (
          <button type="button" onClick={() => setAll(true)} className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            +{rest.length - shown.length} more
          </button>
        )}
      </div>
    </li>
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
