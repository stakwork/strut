// The moments the changes view compares (plans/concept-history.md §8 item
// 4): what a person types — `now`, `1 day ago`, a date, a commit id, a
// Concept branch's name — as `history/read` takes it: `main`, an ISO time,
// the commit, or the branch (its last commit; plans/concept-evals.md item c).
// Pure.

const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

/** A moment as typed → what `history/read` takes, or null when it reads as
 *  none. `branches`: the history's branches, a name of which is one. */
export function momentOf(text: string, now = Date.now(), branches: readonly string[] = []): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === "now" || t === "main") return "main";
  if (branches.includes(t)) return t;
  const ago = /^(\d+)\s*(minute|hour|day|week)s?\s+ago$/.exec(t);
  if (ago) return new Date(now - Number(ago[1]) * UNIT_MS[ago[2]!]!).toISOString();
  if (/^[0-9a-f]{7,40}$/.test(t)) return t;
  const ms = Date.parse(text.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The view opens on the last day. */
export const DEFAULT_FROM = "1 day ago";
export const DEFAULT_TO = "now";
