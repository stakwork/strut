/**
 * A walk's hop events (./source.ts) → the TRAIL a view draws: one step per
 * hop, the node it chose and, beside it, every candidate it considered —
 * kept, dropped, or still being judged. Pure: a player re-folds a prefix of
 * the hops to play the walk back, so a step reads the same live and after.
 *
 *  - A hop's `step.start` opens a step: its candidates `considering`, the
 *    node it expanded to find them as `from` (none for the seeds).
 *  - Its `step.end` settles it: the candidate it chose next is `chosen`,
 *    the rest `kept` or `dropped` by the verdicts. A `next` that is not
 *    among the hop's candidates came from an earlier hop (graph/walk's
 *    frontier) or was read directly (an agent): a `jump`.
 *  - Evidence folded into an earlier candidate (`merged_into`) is counted
 *    on it, never drawn twice.
 */

import type { WalkBrief, WalkHopEvent, WalkVia } from "./source.js";

export type WalkCandidateState = "chosen" | "kept" | "dropped" | "considering";

export interface WalkTrailCandidate extends WalkBrief {
  state: WalkCandidateState;
  relevance?: number;
  via?: WalkVia;
  /** Evidence like it folded into it (same claim, same verdict, other runs). */
  merged: number;
}

export interface WalkTrailStep {
  hop: number;
  /** The node expanded to find the candidates; null for the seeds. */
  from: WalkBrief | null;
  /** Every node considered at this choice, in the order the hop listed them. */
  candidates: WalkTrailCandidate[];
  /** The node chosen to go on from; null while judging, or when it chose none. */
  chosen: WalkBrief | null;
  /** The chosen node is not one of this hop's candidates (an earlier hop's, or read directly). */
  jump: boolean;
  /** Its candidates are listed, its verdicts not yet in. */
  pending: boolean;
  /** graph/walk's "is it enough?" after this hop, 0–1. */
  sufficient?: number;
  error?: string;
  /** When the hop started (the log's `ts`). */
  at?: string;
}

export interface WalkTrail {
  steps: WalkTrailStep[];
  /** The chosen nodes in order — the trail itself: Law › M&A › NDA › … */
  path: WalkBrief[];
  /** Candidates kept anywhere (the bundle a graph/walk hands on), the chosen ones included. */
  kept: number;
  /** Candidates considered anywhere. */
  considered: number;
  /** A decider scored the candidates (graph/walk); an agent's own choices carry no score. */
  scored: boolean;
}

/** Fold hop events, in order, into the trail. */
export function foldWalkTrail(hops: readonly WalkHopEvent[]): WalkTrail {
  const steps: WalkTrailStep[] = [];
  const byHop = new Map<number, WalkTrailStep>();
  const where = new Map<string, WalkTrailCandidate>();
  for (const e of hops) {
    if (e.type === "step.start" && e.input) {
      const step: WalkTrailStep = {
        hop: e.iteration,
        from: e.input.expanded ? brief(e.input.expanded) : null,
        candidates: [],
        chosen: null,
        jump: false,
        pending: true,
        ...(e.ts ? { at: e.ts } : {}),
      };
      for (const c of e.input.candidates ?? []) {
        if (c.merged_into) {
          const group = where.get(c.merged_into);
          if (group) group.merged++;
          continue;
        }
        if (step.candidates.some((x) => x.ref_id === c.ref_id)) continue;
        const cand: WalkTrailCandidate = { ...brief(c), state: "considering", merged: 0, ...(c.via ? { via: c.via } : {}) };
        step.candidates.push(cand);
        if (!where.has(c.ref_id)) where.set(c.ref_id, cand);
      }
      steps.push(step);
      byHop.set(e.iteration, step);
      continue;
    }
    const step = byHop.get(e.iteration);
    if (!step) continue;
    if (e.type === "step.end" && e.output) {
      const verdicts = new Map((e.output.verdicts ?? []).map((v) => [v.ref_id, v]));
      const next = e.output.next;
      for (const c of step.candidates) {
        const v = verdicts.get(c.ref_id);
        if (v?.relevance !== undefined) c.relevance = v.relevance;
        c.state = next && c.ref_id === next.ref_id ? "chosen" : v?.kept ? "kept" : "dropped";
      }
      step.chosen = next ? brief(next) : null;
      step.jump = !!next && !step.candidates.some((c) => c.ref_id === next.ref_id);
      step.pending = false;
      if (typeof e.output.sufficient === "number") step.sufficient = e.output.sufficient;
    } else if (e.type === "step.error") {
      step.pending = false;
      step.error = e.error?.message ?? "the hop failed";
      for (const c of step.candidates) if (c.state === "considering") c.state = "dropped";
    }
  }
  let kept = 0;
  let considered = 0;
  let scored = false;
  for (const s of steps) {
    considered += s.candidates.length;
    kept += s.candidates.filter((c) => c.state === "kept" || c.state === "chosen").length;
    scored ||= s.candidates.some((c) => c.relevance !== undefined);
  }
  return { steps, path: steps.flatMap((s) => (s.chosen ? [s.chosen] : [])), kept, considered, scored };
}

function brief(n: WalkBrief): WalkBrief {
  return { ref_id: n.ref_id, node_type: n.node_type, name: n.name };
}

/** One line for a walk's state: `4 hops · 6 kept · walking…`, `5 hops · 7 kept · stopped: sufficient`;
 *  an agent's, which keeps nothing by score, `5 hops · 17 considered`. `scored` says which before any verdict is in. */
export function walkTrailSummary(trail: WalkTrail, opts: { live?: boolean; replaying?: boolean; stopped?: string; error?: string; scored?: boolean } = {}): string {
  const hop = trail.steps.length;
  const count = (opts.scored ?? trail.scored) ? `${trail.kept} kept` : `${trail.considered} considered`;
  const tail = opts.error ? `error: ${opts.error}` : opts.live ? "walking…" : opts.replaying ? "replaying…" : opts.stopped ? `stopped: ${opts.stopped}` : "";
  return `${hop === 1 ? "1 hop" : `${hop} hops`} · ${count}${tail ? ` · ${tail}` : ""}`;
}
