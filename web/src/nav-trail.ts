// ── Back trail ─────────────────────────────────────────────────────────────
// Following a link from one place to another (a child run from the run view,
// a subflow's go-to-definition) leaves a trail: where you came from, newest
// last. Each step is also a browser history entry (pushState, the trail in
// its state), so the back button works — and the drill bar shows the trail
// as crumbs plus a Back button, for where there is no back button (embedded
// in Hive's iframe, the desktop app). Picking something from the sidebar is
// a jump, not a step: it starts a fresh trail.

/** A place the trail can lead back to. `run: null` is the workflow's canvas. */
export interface TrailEntry {
  wf: string;
  run: string | null;
  job: string | null;
}

const STATE_KEY = "strutTrail";

/** Never more than this many steps back; the oldest drop off. */
export const MAX_TRAIL = 20;

/** The trail stored in a history entry's state (anything else → empty). */
export function readTrail(state: unknown): TrailEntry[] {
  const raw = (state as Record<string, unknown> | null)?.[STATE_KEY];
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return raw.flatMap((e) => {
    const wf = str((e as TrailEntry | null)?.wf);
    if (!wf) return [];
    return [{ wf, run: str((e as TrailEntry).run), job: str((e as TrailEntry).job) }];
  });
}

/** A history state carrying `trail`, other keys of `state` kept. */
export function withTrail(state: unknown, trail: TrailEntry[]): Record<string, unknown> {
  const base = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  return { ...base, [STATE_KEY]: trail };
}

export function sameSpot(a: TrailEntry, b: TrailEntry): boolean {
  return a.wf === b.wf && a.run === b.run && a.job === b.job;
}

/** Where you are, as a place to come back to — null when there is none. A
 *  job's timeline (a job, no run) has its own crumb, so it isn't one. */
export function hereEntry(wf: string | null, run: string | null, job: string | null): TrailEntry | null {
  if (!wf) return null;
  if (job && !run) return null;
  return { wf, run, job };
}

/** The trail after stepping from `here` to `to`; unchanged when that isn't a
 *  step (nowhere to come back to, or going nowhere). */
export function stepTrail(trail: TrailEntry[], here: TrailEntry | null, to: TrailEntry): TrailEntry[] {
  if (!here || sameSpot(here, to)) return trail;
  return [...trail, here].slice(-MAX_TRAIL);
}

/** A crumb's tooltip: the workflow, and which run of it. */
export function trailTitle(e: TrailEntry): string {
  return e.run ? `Back to ${e.wf} · run ${e.run}` : `Back to ${e.wf}`;
}
