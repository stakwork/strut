import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendPurposeNote, shortOfWorkersRefusal, showsWorkers, withdrawRefusal, workersOutLine, workersPaidSub, type WorkersView } from "./earnings.js";

// The fold both Earnings pages write with. Its worker-pay figures
// (plans/human-steps.md §8.2) are also pinned beside the rest, from the
// strut UI's side, in web/src/earnings.test.ts.

const none: WorkersView = { owedMsat: 0, heldMsat: 0, withdrawableMsat: 0, payees: 0, accepted: { answers: 0, msat: 0, days: [] }, takenBack: { answers: 0, msat: 0 } };

describe("the earnings fold: paid to workers", () => {
  it("a strut that never paid a worker shows none; a payout, paid or on its way, shows it", () => {
    assert.equal(showsWorkers(none), false);
    assert.equal(showsWorkers({ ...none, paidOut: { count: 0, msat: 0, feeMsat: 0, days: [] }, outMsat: 0 }), false);
    assert.equal(showsWorkers({ ...none, paidOut: { count: 2, msat: 9000, feeMsat: 0, days: [] } }), true);
    assert.equal(showsWorkers({ ...none, outMsat: 1000 }), true);
  });

  it("its lines", () => {
    assert.equal(workersPaidSub({ ...none, paidOut: { count: 2, msat: 9000, feeMsat: 4500, days: [] } }), "2 withdrawals · fees 4.5 sats");
    assert.equal(workersOutLine({ ...none, outMsat: 2000 }), "2 sats on its way to workers: reserved, not yet settled.");
    assert.equal(workersOutLine(none), null);
    assert.equal(sendPurposeNote("worker"), " · a worker's payout");
  });

  it("the refusal: the shortfall, and the most that may be asked", () => {
    assert.equal(
      shortOfWorkersRefusal({ afterMsat: 40_000, owedMsat: 100_000, shortMsat: 60_000 }, 500_000),
      "Refused: paying this would leave the wallet 60 sats short of the 100 sats workers are owed for accepted answers. Withdraw at most 440 sats.",
    );
    assert.match(withdrawRefusal({ code: "short_of_workers", error: "short_of_workers: would leave 1 msat" }), /^Refused: would leave 1 msat/);
    assert.match(withdrawRefusal({ code: "balance_unknown", error: "balance_unknown: cannot be read" }), /^Refused: cannot be read\.$/);
  });
});
