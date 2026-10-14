import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkOutcomes, lastVerifyLabel, ledgerSignature, locatorTarget, newestTurn, shownOutcome, verifySummary } from "./claims-view";
import type { LedgerClaim } from "./api";

const claim = (over: Partial<LedgerClaim> = {}): LedgerClaim => ({
  id: "c1",
  text: "the settings page renders",
  status: "supported",
  assertedOnly: false,
  unverified: 0,
  checks: [],
  ...over,
});

describe("lastVerifyLabel", () => {
  it("says what each outcome means, superseded and planned in words", () => {
    assert.equal(lastVerifyLabel({ ran: true }).text, "ran");
    assert.equal(lastVerifyLabel({ ran: true }).tone, "ok");
    assert.equal(lastVerifyLabel({ planned: "e1" }).text, "waiting on a person");
    assert.equal(lastVerifyLabel({ skipped: "superseded" }).text, "superseded");
    assert.match(lastVerifyLabel({ skipped: "superseded" }).title!, /no longer the newest/);
    assert.equal(lastVerifyLabel({ pending: true }).text, "pending");
    assert.equal(lastVerifyLabel({ skipped: "budget" }).text, "over budget");
    assert.equal(lastVerifyLabel({ skipped: "policy" }).text, "not due");
  });

  it("keeps the reason a check could not run", () => {
    const l = lastVerifyLabel({ skipped: "cannot-launch", reason: "net::ERR_CONNECTION_REFUSED" });
    assert.equal(l.text, "couldn't run");
    assert.equal(l.tone, "bad");
    assert.match(l.title!, /ERR_CONNECTION_REFUSED/);
  });
});

describe("checkOutcomes", () => {
  it("maps each check that has an outcome by its id", () => {
    const out = checkOutcomes([
      claim({ checks: [{ id: "k1", name: "shot", lastVerify: { ran: true } }, { id: "k2", name: "eyes", external: true }] }),
      claim({ id: "c2", checks: [{ id: "k3", name: "api", lastVerify: { skipped: "superseded" } }] }),
    ]);
    assert.deepEqual(out, { k1: { ran: true }, k3: { skipped: "superseded" } });
    assert.deepEqual(checkOutcomes(undefined), {});
  });
});

describe("shownOutcome", () => {
  it("drops a waiting-on-a-person once the slot is answered, keeps everything else", () => {
    assert.deepEqual(shownOutcome({ planned: "e1" }, true), { planned: "e1" });
    assert.equal(shownOutcome({ planned: "e1" }, false), undefined);
    assert.deepEqual(shownOutcome({ ran: true }, false), { ran: true });
    assert.equal(shownOutcome(undefined, true), undefined);
  });
});

describe("verifySummary", () => {
  it("names the turn and counts what the checks did", () => {
    const line = verifySummary({
      runId: "1792018615451",
      costUsd: 0,
      checks: [
        { path: "job:j-1#0", claimId: "c1", checkId: "k1", lastVerify: { ran: true } },
        { path: "job:j-1#0", claimId: "c2", checkId: "k2", lastVerify: { ran: true } },
        { path: "job:j-1#0", claimId: "c2", checkId: "k3", lastVerify: { skipped: "cannot-launch", reason: "refused" } },
        { path: "job:j-1#0", claimId: "c3", checkId: "k4", lastVerify: { planned: "e9" } },
      ],
    });
    assert.equal(line, "Verified turn 1792018615451: 2 ran, 1 couldn't run, 1 waiting on a person.");
  });

  it("says when there was nothing to run, and when there is no turn", () => {
    assert.equal(verifySummary({ runId: "17", costUsd: 0, checks: [] }), "Verified turn 17: no claim has a check to run.");
    assert.equal(verifySummary({ runId: "", skipped: "unknown-run", costUsd: 0, checks: [] }), "Nothing to verify: the job has no turn yet.");
  });

  it("adds what paid checks cost", () => {
    assert.match(verifySummary({ runId: "17", costUsd: 0.0123, checks: [{ path: "p", claimId: "c", checkId: "k", lastVerify: { ran: true } }] }), / · \$0\.0123\.$/);
  });
});

describe("locatorTarget", () => {
  it("opens a job's screenshot in place, an image", () => {
    assert.deepEqual(locatorTarget({ url: "/jobs/j-1/files/shots/001.png", file: "shots/001.png" }), {
      kind: "file",
      path: "/jobs/j-1/files/shots/001.png",
      image: true,
    });
  });

  it("builds the job's file route from a bare file", () => {
    assert.deepEqual(locatorTarget({ file: "shots/a b.png" }, "j/1"), { kind: "file", path: "/jobs/j%2F1/files/shots/a%20b.png", image: true });
    assert.equal(locatorTarget({ file: "shots/a.png" }), null, "no job, no route");
    assert.equal(locatorTarget({ file: "../secrets.json" }, "j-1"), null);
    assert.equal(locatorTarget({ file: "/etc/passwd" }, "j-1"), null);
  });

  it("links an endpoint, and leaves anything else alone", () => {
    assert.deepEqual(locatorTarget({ url: "https://pod.example/api/settings" }), { kind: "url", url: "https://pod.example/api/settings" });
    assert.equal(locatorTarget({ url: "javascript:alert(1)" }), null);
    assert.equal(locatorTarget(undefined), null);
  });

  it("a served file that is not an image still opens, without a thumbnail", () => {
    assert.deepEqual(locatorTarget({ url: "/artifacts/17/report.md" }), { kind: "file", path: "/artifacts/17/report.md", image: false });
  });
});

describe("newestTurn", () => {
  it("is the newest top-level run — a child run is not a turn", () => {
    assert.equal(newestTurn([{ runId: "3", parentRunId: "2" }, { runId: "2" }, { runId: "1" }]), "2");
    assert.equal(newestTurn([]), undefined);
  });
});

describe("ledgerSignature", () => {
  it("moves when a status, a turn or a verdict moves", () => {
    const a = ledgerSignature([claim({ latest: { about: "1", observed_at: 10 } })]);
    assert.notEqual(a, ledgerSignature([claim({ status: "stale", latest: { about: "1", observed_at: 10 } })]));
    assert.notEqual(a, ledgerSignature([claim({ latest: { about: "2", observed_at: 10 } })]));
    assert.notEqual(a, ledgerSignature([claim({ latest: { about: "1", observed_at: 11 } })]));
    assert.equal(a, ledgerSignature([claim({ latest: { about: "1", observed_at: 10 } })]));
    assert.equal(ledgerSignature(undefined), "");
  });
});
