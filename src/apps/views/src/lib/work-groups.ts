import type { WorkerHistoryItem, WorkerTaskGroup } from "@strut/kit";

/** What a group's answers earned (paid, still held or not, never a taken-back one) and what waits for an OK. */
export function groupEarnings(items: readonly Pick<WorkerHistoryItem, "earned" | "pending">[]): { earnedMsat: number; pendingMsat: number } {
  let earnedMsat = 0;
  let pendingMsat = 0;
  for (const i of items) {
    if (i.earned && !i.earned.takenBack) earnedMsat += i.earned.msat;
    if (i.pending) pendingMsat += i.pending.msat;
  }
  return { earnedMsat, pendingMsat };
}

/** The groups still being worked on (staff have not marked them done) and the finished ones, each newest first as read. */
export function splitGroups<G extends Pick<WorkerTaskGroup, "status">>(groups: readonly G[]): { active: G[]; done: G[] } {
  return { active: groups.filter((g) => g.status !== "done"), done: groups.filter((g) => g.status === "done") };
}

