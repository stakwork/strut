/**
 * A walk's REPLAY frames: its hop events (./source.ts) as beats, in the
 * walk's own order and at its own times — a hop is two, its candidates
 * listed, then its choice — and the trail at any beat. Rebuilt from the run
 * log alone, so a walk opened days later plays exactly as it did live. The
 * clock that moves through the beats is the kit's (../replay.ts).
 */

import { replayTime } from "../replay.js";
import type { WalkHopEvent } from "./source.js";
import { foldWalkTrail, type WalkTrail } from "./trail.js";

export type WalkBeatKind = "candidates" | "choice" | "error";

export interface WalkBeat {
  /** Its index among the walk's hop events: the beats shown are `hops.slice(0, index + 1)`. */
  index: number;
  hop: number;
  kind: WalkBeatKind;
  /** Epoch ms, from the event's `ts`; null when the log has none. */
  at: number | null;
  /** What happened, as a person reads it: `NDA: 3 candidates`, `chose NDA drafting rules`. */
  label: string;
}

export function walkBeats(hops: readonly WalkHopEvent[]): WalkBeat[] {
  return hops.map((e, index) => {
    const at = replayTime(e.ts);
    if (e.type === "step.start") {
      const n = e.input?.candidates?.filter((c) => !c.merged_into).length ?? 0;
      const from = e.input?.expanded?.name ?? "seeds";
      return { index, hop: e.iteration, kind: "candidates", at, label: `${from}: ${n === 1 ? "1 candidate" : `${n} candidates`}` };
    }
    if (e.type === "step.error") return { index, hop: e.iteration, kind: "error", at, label: `failed: ${e.error?.message ?? "the hop failed"}` };
    const next = e.output?.next;
    return { index, hop: e.iteration, kind: "choice", at, label: next ? `chose ${next.name || next.ref_id}` : "chose none" };
  });
}

export interface WalkFrame {
  /** The trail with `at` beats shown. */
  trail: WalkTrail;
  /** The beat shown last; null before the first. */
  beat: WalkBeat | null;
  /** Hops begun so far, of `hops` in the walk. */
  hop: number;
  hops: number;
}

/** The walk as it stood after `at` beats. */
export function walkFrame(hops: readonly WalkHopEvent[], at: number, beats: readonly WalkBeat[] = walkBeats(hops)): WalkFrame {
  const n = Math.max(0, Math.min(at, hops.length));
  const trail = foldWalkTrail(hops.slice(0, n));
  return { trail, beat: n > 0 ? beats[n - 1]! : null, hop: trail.steps.length, hops: new Set(hops.map((h) => h.iteration)).size };
}

/**
 * One HOP on or back from `at`: the next (or previous) place a hop's choice
 * has just shown — or the start, or the newest beat. A step never stops
 * between a hop's candidates and its choice; playing does.
 */
export function walkHopStop(beats: readonly WalkBeat[], at: number, delta: 1 | -1): number {
  const settled = (k: number) => k === 0 || k === beats.length || beats[k - 1]!.kind !== "candidates";
  if (delta > 0) {
    for (let k = Math.max(0, at) + 1; k <= beats.length; k++) if (settled(k)) return k;
    return beats.length;
  }
  for (let k = Math.min(beats.length, at) - 1; k >= 0; k--) if (settled(k)) return k;
  return 0;
}
