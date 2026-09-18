import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Ledger } from "../ledger.js";
import type { VerifyResult } from "../verify.js";
import { STILL_VERIFYING, createVerifyWaker } from "./verify-waker.js";

const LEDGER: Ledger = { "clip/compute-times": [{ id: "c1", text: "end is after start", status: "refuted", assertedOnly: false, unverified: 0, checks: [{ id: "k1", name: "bounds", lastVerify: { ran: true } }] }] };
const result = (over: Partial<VerifyResult> = {}): VerifyResult => ({ key: "clipper", runId: "r1", subjects: [{ kind: "step", type: "clip/compute-times" }], checks: [], evidence: 1, slots: 0, costUsd: 0, ...over });

function setup(opts: { passMs?: number; graceMs?: number; ledger?: Ledger; pass?: VerifyResult } = {}) {
  const delivered: Array<[string, string]> = [];
  let calls = 0;
  const waker = createVerifyWaker({
    graceMs: opts.graceMs ?? 200,
    deliver: async (chatId, text) => void delivered.push([chatId, text]),
    verifier: {
      verifyRun: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, opts.passMs ?? 5));
        return opts.pass ?? result();
      },
      ledger: async () => opts.ledger ?? LEDGER,
    },
  });
  return { waker, delivered, calls: () => calls };
}

describe("verify waker", () => {
  it("a settled pass wakes the chat that launched the run — once, with the ledger", async () => {
    const { waker, delivered } = setup();
    waker.watch("r1", "chat-A");
    await waker.settled(result());
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]![0], "chat-A");
    assert.match(delivered[0]![1], /^\[verify-notification\] Run r1 of "clipper".*1 REFUTED/);
    await waker.settled(result());
    assert.equal(delivered.length, 1, "the watch is consumed");
  });

  it("nobody watching (an API / UI launch), a no-op pass, or an empty contract → no wake-up", async () => {
    const quiet = setup();
    await quiet.waker.settled(result());
    assert.deepEqual(quiet.delivered, []);

    for (const pass of [result({ skipped: "verify-origin" }), result({ subjects: [] })]) {
      const s = setup();
      s.waker.watch("r1", "chat-A");
      await s.waker.settled(pass);
      assert.deepEqual(s.delivered, []);
      assert.equal(await s.waker.ledgerLinesFor("clipper", "r1"), "", "and the watch was released, not leaked");
    }
    const empty = setup({ ledger: {} });
    empty.waker.watch("r1", "chat-A");
    await empty.waker.settled(result());
    assert.deepEqual(empty.delivered, []);
  });

  it("a run-notification carries the ledger when the pass settles inside the grace window — and then no verify-notification follows", async () => {
    const { waker, delivered } = setup({ passMs: 10, graceMs: 500 });
    waker.watch("r1", "chat-A");
    const lines = await waker.ledgerLinesFor("clipper", "r1");
    assert.match(lines, /^\nVerified against its claims — clip\/compute-times: 1 REFUTED\.\nclaims: \{/);
    await waker.settled(result()); // the detached pass's own hook fires too
    assert.deepEqual(delivered, [], "exactly ONE of the two carries the ledger");
  });

  it("a slow pass: the run-notification says verification is still running, and the verify-notification follows", async () => {
    const { waker, delivered } = setup({ passMs: 120, graceMs: 20 });
    waker.watch("r1", "chat-A");
    assert.equal(await waker.ledgerLinesFor("clipper", "r1"), `\n${STILL_VERIFYING}`);
    await waker.settled(result());
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]![1], /^\[verify-notification\]/);
  });

  it("if the detached pass's hook wins the race, the run-notification adds nothing (no duplicate ledger)", async () => {
    const { waker, delivered } = setup({ passMs: 40, graceMs: 500 });
    waker.watch("r1", "chat-A");
    const lines = waker.ledgerLinesFor("clipper", "r1");
    await waker.settled(result()); // settles while ledgerLinesFor is still awaiting the pass
    assert.equal(await lines, "");
    assert.equal(delivered.length, 1);
  });

  it("an unwatched run adds nothing to its run-notification and starts no pass; a failing pass never breaks the notification", async () => {
    const { waker, calls } = setup();
    assert.equal(await waker.ledgerLinesFor("clipper", "r1"), "");
    assert.equal(calls(), 0);
    const broken = createVerifyWaker({ deliver: async () => {}, verifier: { verifyRun: async () => Promise.reject(new Error("bolt down")), ledger: async () => LEDGER } });
    broken.watch("r1", "chat-A");
    assert.equal(await broken.ledgerLinesFor("clipper", "r1"), "");
  });
});
