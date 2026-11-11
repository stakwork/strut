import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VISIT_HEADER, callPaying, cancelledResult, claimAnswerOf, creditLine, formatSats, payInTurn, formatUsd, invoiceQrText, launchOf, newVisit, paymentRequiredIn,
  refusesCredential, secondsLeft, visitorHeaders, waitForClaim, type CallParams, type CallResult, type ClaimAnswer, type PaymentRequired, type VisitorPurse,
} from "./visitor-pay";

const launch = (workflow = "priced"): CallParams => ({ name: "step_run", arguments: { type: "run/launch", config: { workflow, input: { text: "x" } }, app: "app:shop@v1.t" } });
const ok = (output: unknown): CallResult => ({ content: [{ type: "text", text: JSON.stringify(output) }], ...(output && typeof output === "object" ? { structuredContent: output } : {}) });
const err = (error: string): CallResult => ({ content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true });
const challenge = (n: number): PaymentRequired => ({ macaroon: `mac${n}`, invoice: `lnbc${n}`, usd: 0.5, sats: 500, description: "priced: credit for one run" });

/** A server that asks for credit until the purse holds one it knows. */
function server(o: { accepts: Set<string>; refuses?: Set<string> }) {
  const seen: Array<{ params: CallParams; authorization?: string }> = [];
  let n = 0;
  const purse: VisitorPurse = { visit: "v" };
  const call = async (params: CallParams): Promise<CallResult> => {
    const auth = visitorHeaders(purse)["authorization"];
    seen.push({ params, ...(auth ? { authorization: auth } : {}) });
    if (!launchOf(params)) return ok({ runs: [] });
    const cred = purse.credential;
    if (cred && o.refuses?.has(cred)) return err("invalid_token: this server's ledger does not know the token");
    if (cred && o.accepts.has(cred)) return ok({ runId: "r1" });
    return ok({ payment_required: challenge(++n) });
  };
  return { seen, purse, call };
}

describe("a visitor's page, paid for by its host (plans/paid-runs.md §10)", () => {
  it("a visit is 32 base64url characters, the server's own shape", () => {
    const v = newVisit();
    assert.match(v, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(v, newVisit());
    assert.equal(newVisit((b) => b.fill(255)), "_".repeat(32));
  });

  it("every request names the visit, and the credential once one is held — never anything else", () => {
    assert.deepEqual(visitorHeaders({ visit: "abc" }), { [VISIT_HEADER]: "abc" });
    assert.deepEqual(visitorHeaders({ visit: "abc", credential: "m:p" }), { [VISIT_HEADER]: "abc", authorization: "L402 m:p" });
  });

  it("reads a launch call and its payment_required answer, from structuredContent or the text", () => {
    assert.deepEqual(launchOf(launch("w")), { workflow: "w" });
    assert.equal(launchOf({ name: "step_run", arguments: { type: "run/get", config: { workflow: "w" } } }), undefined);
    assert.equal(launchOf({ name: "other", arguments: { type: "run/launch" } }), undefined);
    const p = challenge(1);
    assert.deepEqual(paymentRequiredIn(ok({ payment_required: p })), p);
    assert.deepEqual(paymentRequiredIn({ content: [{ type: "text", text: JSON.stringify({ payment_required: p }) }] }), p);
    assert.equal(paymentRequiredIn(ok({ runId: "r" })), undefined);
    assert.equal(paymentRequiredIn(ok({ payment_required: { usd: 1 } })), undefined, "no invoice, nothing to pay");
    assert.equal(paymentRequiredIn(err("payment_required")), undefined);
    assert.equal(refusesCredential(err("invalid_token: nope")), true);
    assert.equal(refusesCredential(err("too many launches")), false);
    assert.equal(refusesCredential(ok({ runId: "r" })), false);
  });

  it("a call that is not a launch passes through untouched, whatever it answers", async () => {
    const s = server({ accepts: new Set() });
    let asked = 0;
    const out = await callPaying({ name: "step_run", arguments: { type: "run/get", config: { workflow: "w", runId: "1" } } }, { call: s.call, purse: s.purse, pay: async () => (asked++, "x") });
    assert.deepEqual(out.structuredContent, { runs: [] });
    assert.equal(asked, 0);
  });

  it("free: the launch answers at once and nothing is asked", async () => {
    const purse: VisitorPurse = { visit: "v" };
    let asked = 0;
    const out = await callPaying(launch(), { call: async () => ok({ runId: "r9" }), purse, pay: async () => (asked++, null) });
    assert.deepEqual(out.structuredContent, { runId: "r9" });
    assert.equal(asked, 0);
    assert.equal(purse.credential, undefined);
  });

  it("priced: shown to the visitor, paid, and the SAME call sent again with the credential; the page gets the launch", async () => {
    const s = server({ accepts: new Set(["mac1:pre1"]) });
    const shown: Array<[PaymentRequired, string]> = [];
    const out = await callPaying(launch("priced"), {
      call: s.call,
      purse: s.purse,
      pay: async (p, workflow) => {
        shown.push([p, workflow]);
        return `${p.macaroon}:pre1`;
      },
    });
    assert.deepEqual(out.structuredContent, { runId: "r1" }, "the page sees a launch that took a moment longer");
    assert.deepEqual(shown.map(([p, w]) => [p.macaroon, w]), [["mac1", "priced"]]);
    assert.deepEqual(s.seen.map((x) => x.authorization), [undefined, "L402 mac1:pre1"]);
    assert.deepEqual(s.seen[1]!.params, launch("priced"), "the page's own call, unchanged — no credential in its arguments");
    assert.ok(!JSON.stringify(out).includes("pre1"), "no credential in what the page gets");
    assert.equal(s.purse.credential, "mac1:pre1", "kept for the next launch");

    // The next launch reuses it: nothing asked.
    const again = await callPaying(launch("priced"), { call: s.call, purse: s.purse, pay: async () => assert.fail("not asked again") });
    assert.deepEqual(again.structuredContent, { runId: "r1" });
  });

  it("cancelled: the page's call answers a plain error and nothing is kept", async () => {
    const s = server({ accepts: new Set() });
    const out = await callPaying(launch("priced"), { call: s.call, purse: s.purse, pay: async () => null });
    assert.equal(out.isError, true);
    assert.match(out.content![0]!.text!, /payment_cancelled: the run of priced was not paid for/);
    assert.deepEqual(out, cancelledResult("priced"));
    assert.equal(s.purse.credential, undefined);
  });

  it("an expired invoice asked again: a new challenge, then paid", async () => {
    const s = server({ accepts: new Set(["mac2:pre2"]) });
    const answers = ["again" as const, "mac2:pre2"];
    const out = await callPaying(launch(), { call: s.call, purse: s.purse, pay: async () => answers.shift()! });
    assert.deepEqual(out.structuredContent, { runId: "r1" });
    assert.equal(s.seen.length, 3);
  });

  it("run short: the next 402 is paid the same way and its credential REPLACES the old one (it carried the remainder)", async () => {
    const s = server({ accepts: new Set(["mac1:new"]) });
    s.purse.credential = "old:pre";
    const out = await callPaying(launch(), { call: s.call, purse: s.purse, pay: async (p) => `${p.macaroon}:new` });
    assert.deepEqual(out.structuredContent, { runId: "r1" });
    assert.equal(s.purse.credential, "mac1:new");
    assert.deepEqual(s.seen.map((x) => x.authorization), ["L402 old:pre", "L402 mac1:new"]);
  });

  it("a credential the server refuses is dropped and the call made again without it", async () => {
    const s = server({ accepts: new Set(["mac1:good"]), refuses: new Set(["bad:pre"]) });
    s.purse.credential = "bad:pre";
    const out = await callPaying(launch(), { call: s.call, purse: s.purse, pay: async (p) => `${p.macaroon}:good` });
    assert.deepEqual(out.structuredContent, { runId: "r1" });
    assert.deepEqual(s.seen.map((x) => x.authorization), ["L402 bad:pre", undefined, "L402 mac1:good"]);
  });

  it("two priced launches at once: one sheet, and the second is sent again with what the first bought", async () => {
    const s = server({ accepts: new Set(["mac1:paid"]) });
    const inTurn = payInTurn(s.purse);
    let sheets = 0;
    let release!: () => void;
    const shown = new Promise<void>((r) => (release = r));
    const payer = async (p: PaymentRequired) => {
      sheets++;
      await shown;
      return `${p.macaroon}:paid`;
    };
    const both = Promise.all([
      callPaying(launch("priced"), { call: s.call, purse: s.purse, pay: (p, w) => inTurn(payer, p, w) }),
      callPaying(launch("priced"), { call: s.call, purse: s.purse, pay: (p, w) => inTurn(payer, p, w) }),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [a, b] = await both;
    assert.deepEqual([a.structuredContent, b.structuredContent], [{ runId: "r1" }, { runId: "r1" }]);
    assert.equal(sheets, 1, "the visitor is asked once");
  });

  it("gives up after a few rounds rather than asking forever", async () => {
    const s = server({ accepts: new Set() });
    let asked = 0;
    const out = await callPaying(launch(), { call: s.call, purse: s.purse, pay: async (p) => (asked++, `${p.macaroon}:never`) });
    assert.ok(paymentRequiredIn(out));
    assert.equal(asked, 4);
  });

  it("claim: asks until settled, waits longer when told to, and stops when aborted", async () => {
    const answers: ClaimAnswer[] = [{ state: "pending" }, { error: "too many claims", retryAfter: 30 }, { state: "settled", credential: "m:p" }];
    const waits: number[] = [];
    const got = await waitForClaim(async () => answers.shift()!, { signal: new AbortController().signal, intervalMs: 10, sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(got, { state: "settled", credential: "m:p" });
    assert.deepEqual(waits, [10, 30_000]);
    assert.deepEqual(await waitForClaim(async () => ({ state: "expired" }), { signal: new AbortController().signal, sleep: async () => {} }), { state: "expired" });
    const abort = new AbortController();
    let calls = 0;
    const stopped = await waitForClaim(
      async () => {
        if (++calls === 2) abort.abort();
        return { state: "pending" };
      },
      { signal: abort.signal, sleep: async () => {} },
    );
    assert.equal(stopped, null);
    assert.equal(calls, 2);
    let thrown = 0;
    const after = await waitForClaim(async () => (thrown++ ? { state: "settled", credential: "x:y" } : Promise.reject(new Error("offline"))), { signal: new AbortController().signal, sleep: async () => {} });
    assert.deepEqual(after, { state: "settled", credential: "x:y" }, "a dropped request is asked again");
  });

  it("the claim route's answers read", () => {
    assert.deepEqual(claimAnswerOf(200, { state: "pending" }, null), { state: "pending" });
    assert.deepEqual(claimAnswerOf(200, { state: "settled", preimage: "p", credential: "m:p" }, null), { state: "settled", credential: "m:p" });
    assert.deepEqual(claimAnswerOf(429, { error: "too many claims" }, "30"), { error: "too many claims", retryAfter: 30 });
    assert.deepEqual(claimAnswerOf(503, null, null), { error: "claim answered 503" });
  });

  it("what the sheet shows: dollars, sats, the QR text, the time left", () => {
    assert.equal(formatUsd(0.5), "$0.50");
    assert.equal(formatUsd(12), "$12.00");
    assert.equal(formatUsd(0.0025), "$0.0025");
    assert.equal(formatUsd(1234.5), "$1,234.50");
    assert.equal(formatUsd(97250, { whole: true }), "$97,250");
    assert.match(creditLine({}), /stays as credit for later runs/);
    assert.match(creditLine({ reason: "short", remaining_usd: 0.12 }), /^Your credit has \$0\.12 left; this tops it up/);
    assert.match(creditLine({ reason: "short", remaining_usd: 0 }), /^Your credit here is spent; this buys more/);
    assert.equal(formatSats(10250), "10,250 sats");
    assert.equal(invoiceQrText("lnbc10u1pabc"), "LIGHTNING:LNBC10U1PABC");
    assert.equal(secondsLeft("2026-11-10T19:00:08Z", Date.parse("2026-11-10T18:59:00Z")), 68);
    assert.equal(secondsLeft("2026-11-10T19:00:08Z", Date.parse("2026-11-10T19:10:00Z")), 0);
    assert.equal(secondsLeft(undefined), undefined);
  });
});
