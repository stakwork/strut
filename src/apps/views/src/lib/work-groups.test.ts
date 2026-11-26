import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupEarnings, splitGroups } from "./work-groups";

describe("work groups", () => {
  it("sums what paid answers earned and what waits, leaving out a taken-back one", () => {
    const items = [
      { earned: { msat: 2000, releases: 0 } },
      { earned: { msat: 5000, releases: 0, takenBack: true as const } },
      { pending: { msat: 3000 } },
      {},
    ];
    assert.deepEqual(groupEarnings(items), { earnedMsat: 2000, pendingMsat: 3000 });
  });
  it("splits groups staff marked done from the rest, keeping order; no status is still going", () => {
    const gs = [{ status: "done" as const, n: 1 }, { n: 2 }, { status: "open" as const, n: 3 }];
    const { active, done } = splitGroups(gs);
    assert.deepEqual([active.map((g) => g.n), done.map((g) => g.n)], [[2, 3], [1]]);
  });
});
