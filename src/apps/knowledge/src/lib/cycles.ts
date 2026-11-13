// What the dream did, afterwards — pure, no React (tested in
// src/apps/knowledge.test.ts). A CYCLE is one dream that read something
// (`knowledge/cycles`, an admin's read): when it ran, the tree it tends,
// whether a person reviewed its changes, and its LESSONS (what a person said,
// the claim it wrote, the change it made). What it changed is the history's:
// the commits carrying its run (`history/read log { run }`), drawn as one
// diff from the commit before the first to the last.
import type { HistoryCommit } from "strut/views";

/** The step the cycles are read through. */
export const CYCLES_STEP = "knowledge/cycles";

/** One lesson as the dream answered it. */
export interface DreamLesson {
  session: string;
  turn: number;
  said: string;
  concept: string;
  claim: string;
  claim_id?: string;
  recorded?: boolean;
  change?: string;
}

/** One dream that read something, as `knowledge/cycles` answers it. */
export interface DreamCycle {
  run: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  tree: string;
  source?: string;
  review: boolean;
  turns: number;
  more?: true;
  lessons: DreamLesson[];
  stuck: string[];
  error?: string;
}

/** The cycles about one Concept, newest first: a lesson's claim is on it, or the cycle's run changed its page (the
 *  `runs` of the page's own history). */
export function cyclesFor(cycles: readonly DreamCycle[], name: string, changedBy: ReadonlySet<string> = new Set()): DreamCycle[] {
  return cycles.filter((c) => changedBy.has(c.run) || c.lessons.some((l) => l.concept === name));
}

/** The runs named on a page's commits: the ones that changed it. */
export function runsOf(commits: readonly Pick<HistoryCommit, "runs">[]): Set<string> {
  return new Set(commits.flatMap((c) => c.runs));
}

/** What one cycle changed, as two moments to diff: from the commit before the first that carries its run (`before`,
 *  the next older commit on the pages) to the last. `commits` are the run's, newest first. Null when none carries
 *  it: nothing in the tree changed under that run. With no commit before (the history's first), the second before
 *  the first one's time. */
export function cycleSpan(commits: readonly Pick<HistoryCommit, "id" | "time">[], before?: Pick<HistoryCommit, "id"> | null): { from: string; to: string } | null {
  const newest = commits[0];
  const oldest = commits[commits.length - 1];
  if (!newest || !oldest) return null;
  return { from: before?.id ?? new Date(Date.parse(oldest.time) - 1000).toISOString(), to: newest.id };
}

/** "2 lessons · 14 turns read"; a dream that failed before it answered, "it did not finish". */
export function cycleWords(c: Pick<DreamCycle, "status" | "lessons" | "turns" | "more">): string {
  if (c.status !== "success" && !c.lessons.length && !c.turns) return "it did not finish";
  const lessons = c.lessons.length ? `${c.lessons.length} lesson${c.lessons.length === 1 ? "" : "s"}` : "nothing learned";
  return `${lessons} · ${c.turns} turn${c.turns === 1 ? "" : "s"} read${c.more ? ", more waiting" : ""}`;
}

/** Why the cycles are not shown, as one line, from the step's refusal; null when the viewer is simply not an admin
 *  (they see nothing of it, as with the dream's proposals). */
export function cyclesUnavailable(message: string): string | null {
  if (/is an admin's/.test(message)) return null;
  if (/may not read/.test(message)) return "What the dream learned isn't shown here: this page may not read where the tree is kept.";
  if (/claims layer/.test(message)) return "This server keeps no claims, so there is no dream.";
  return `Couldn't read what the dream learned: ${message}`;
}
