import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_GRACE_MS, VISIT_HEADER, callPaying, cancelledResult, claimAnswerOf, createClaimKeeper, creditLine, creditSettled, formatSats, keptCreditResult, loadPurse, newPurse, payInTurn, savePurse, formatUsd, invoiceQrText, launchOf, newVisit, paymentRequiredIn,
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
  const purse: VisitorPurse = newPurse("v");
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
    assert.deepEqual(visitorHeaders(newPurse("abc")), { [VISIT_HEADER]: "abc" });
    assert.deepEqual(visitorHeaders({ ...newPurse("abc"), credential: "m:p", spare: ["x:y"] }), { [VISIT_HEADER]: "abc", authorization: "L402 m:p" }, "a spare is not sent");
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
    // Only the door's own refusal: a failure whose text merely mentions the words is not one.
    assert.equal(refusesCredential(err("step_failed: the OAuth server said invalid_token: expired")), false);
    assert.equal(refusesCredential(err("upstream returned invalid_token")), false);
    assert.equal(refusesCredential({ isError: true, structuredContent: { error: "invalid_token: no", code: "invalid_token", status: 401 }, content: [{ type: "text", text: "{}" }] }), true);
    assert.equal(refusesCredential({ isError: true, structuredContent: { error: "step_failed: invalid_token from the API", code: "step_failed", status: 500 }, content: [{ type: "text", text: JSON.stringify({ error: "invalid_token: looks like one" }) }] }), false, "the code says what it is");
  });

  it("a failure that mentions invalid_token keeps the credential and is never sent again; the door's own refusal drops it and asks once more", async () => {
    // A launch whose answer is an error that merely mentions the words.
    const purse: VisitorPurse = { ...newPurse("v"), credential: "good:1" };
    let calls = 0;
    const mentioned = await callPaying(launch(), {
      call: async () => {
        calls++;
        return err("step_failed: the provider said invalid_token");
      },
      purse,
      pay: async () => {
        throw new Error("never asked");
      },
    });
    assert.equal(calls, 1, "never sent again");
    assert.equal(purse.credential, "good:1", "the credential is kept");
    assert.match(JSON.parse(mentioned.content![0]!.text!).error, /step_failed/);
    // The door's own refusal: dropped, and sent once more without it.
    const s = server({ accepts: new Set(), refuses: new Set(["stale:1"]) });
    s.purse.credential = "stale:1";
    let asked = 0;
    await callPaying(launch(), { call: s.call, purse: s.purse, pay: async () => (asked++, null) });
    assert.equal(s.purse.credential, undefined);
    assert.equal(s.seen[0]!.authorization, "L402 stale:1");
    assert.equal(s.seen[1]!.authorization, undefined);
    assert.equal(asked, 1, "then asked to pay");
  });

  it("a call that is not a launch passes through untouched, whatever it answers", async () => {
    const s = server({ accepts: new Set() });
    let asked = 0;
    const out = await callPaying({ name: "step_run", arguments: { type: "run/get", config: { workflow: "w", runId: "1" } } }, { call: s.call, purse: s.purse, pay: async () => (asked++, "x") });
    assert.deepEqual(out.structuredContent, { runs: [] });
    assert.equal(asked, 0);
  });

  it("free: the launch answers at once and nothing is asked", async () => {
    const purse: VisitorPurse = newPurse("v");
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
    assert.equal(asked, 6);
  });

  it("a spare credential — an invoice paid after its sheet closed — is spent before the visitor is asked again", async () => {
    const s = server({ accepts: new Set(["late:pre"]) });
    s.purse.spare.push("late:pre");
    let saves = 0;
    const out = await callPaying(launch(), { call: s.call, purse: s.purse, pay: async () => assert.fail("not asked"), save: () => saves++ });
    assert.deepEqual(out.structuredContent, { runId: "r1" });
    assert.equal(s.purse.credential, "late:pre");
    assert.deepEqual(s.purse.spare, []);
    assert.ok(saves > 0, "the purse is kept for a reload");
  });

  it("paid, then refused (the runs in flight filled, the drain, the day's cap): the page is told its payment is kept", async () => {
    const purse = newPurse("v");
    let n = 0;
    const call = async (): Promise<CallResult> => (n++ === 0 ? ok({ payment_required: challenge(1) }) : err("too many public runs in flight on this strut server (try again in 30 s)"));
    const out = await callPaying(launch(), { call, purse, pay: async () => "mac1:pre" });
    assert.equal(out.isError, true);
    assert.match(out.content![0]!.text!, /too many public runs in flight.*your payment is kept as credit on this server: run it again in a moment/);
    assert.equal(purse.credential, "mac1:pre", "the credit stays for the next try");
    const plain = await callPaying(launch(), { call: async () => err("too many launches"), purse: newPurse("v"), pay: async () => null });
    assert.doesNotMatch(plain.content![0]!.text!, /kept as credit/, "nothing paid in this call: the error as it was");
    assert.match(keptCreditResult({ content: [{ type: "text", text: "plain words" }], isError: true }).content![0]!.text!, /plain words — your payment is kept/);
  });

  it("a settled invoice goes into the purse: the credential with none, the one it carried from replaced, else a spare", () => {
    const purse = newPurse("v");
    purse.pending.push({ macaroon: "a" }, { macaroon: "b", carriesFrom: "a:1" }, { macaroon: "c" });
    creditSettled(purse, { macaroon: "a" }, "a:1");
    assert.equal(purse.credential, "a:1");
    creditSettled(purse, { macaroon: "c" }, "c:3");
    assert.deepEqual([purse.credential, purse.spare], ["a:1", ["c:3"]], "another token's credit is not lost");
    creditSettled(purse, { macaroon: "b", carriesFrom: "a:1" }, "b:2");
    assert.equal(purse.credential, "b:2", "a top-up replaces the token it inherited from");
    assert.deepEqual(purse.pending, []);
    creditSettled(purse, { macaroon: "b" }, "b:2");
    assert.deepEqual(purse.spare, ["c:3"], "the same credential twice is one");
  });

  it("the purse survives a reload in the tab: the visit, the credential, the spares, the invoices still to claim", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const fresh = loadPurse(storage, "k");
    assert.match(fresh.visit, /^[A-Za-z0-9_-]{32}$/);
    fresh.credential = "m:p";
    fresh.spare.push("s:p");
    fresh.pending.push({ macaroon: "x", expires: "2026-11-10T19:00:00Z" });
    savePurse(storage, "k", fresh);
    assert.deepEqual(loadPurse(storage, "k"), fresh);
    store.set("k", JSON.stringify({ visit: "too short" }));
    assert.notEqual(loadPurse(storage, "k").visit, "too short", "not a purse: a new visit");
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    assert.match(loadPurse(throwing, "k").visit, /^[A-Za-z0-9_-]{32}$/, "a storage that throws: a visit in memory");
    savePurse(throwing, "k", fresh);
    assert.match(loadPurse(undefined, "k").visit, /^[A-Za-z0-9_-]{32}$/);
  });

  it("the claim keeper: an invoice is claimed after its sheet is gone, until it settles — into the purse — or ends", async () => {
    let now = Date.parse("2026-11-10T18:50:00Z");
    const states = new Map<string, ClaimAnswer[]>([
      ["paid-late", [{ state: "pending" }, { state: "pending" }, { state: "settled", credential: "paid-late:pre" }]],
      ["never", [{ state: "pending" }]],
      ["gone", [{ state: "expired" }]],
    ]);
    const asked: string[] = [];
    const purse = newPurse("v");
    let saves = 0;
    const keeper = createClaimKeeper({
      purse,
      claim: async (m) => {
        asked.push(m);
        const list = states.get(m)!;
        return list.length > 1 ? list.shift()! : list[0]!;
      },
      save: () => saves++,
      now: () => now,
      intervalMs: 1,
      sleep: async () => {
        now += 60_000;
      },
    });
    const late = keeper.watch({ macaroon: "paid-late", expires: "2026-11-10T19:00:00Z" });
    assert.equal(keeper.watch({ macaroon: "paid-late" }), late, "one watch per invoice");
    assert.deepEqual(purse.pending.map((e) => e.macaroon), ["paid-late"], "kept for a reload while it waits");
    assert.deepEqual(await late, { state: "settled", credential: "paid-late:pre" });
    assert.equal(purse.credential, "paid-late:pre", "a payment made after Cancel is credit");
    assert.deepEqual(purse.pending, []);

    now = Date.parse("2026-11-10T18:50:00Z");
    assert.deepEqual(await keeper.watch({ macaroon: "never", expires: "2026-11-10T18:52:00Z" }), { state: "expired" }, "past its end and a grace, it is let go");
    assert.ok(asked.filter((m) => m === "never").length >= 3, "asked until then");
    assert.ok(CLAIM_GRACE_MS > 0);
    assert.deepEqual(await keeper.watch({ macaroon: "gone" }), { state: "expired" });
    assert.deepEqual(purse.pending, []);
    assert.ok(saves >= 4);

    // After a reload: what was pending is watched again.
    const again = newPurse("v");
    again.pending.push({ macaroon: "reloaded" });
    const keeper2 = createClaimKeeper({ purse: again, claim: async () => ({ state: "settled", credential: "reloaded:pre" }), save: () => {}, sleep: async () => {} });
    keeper2.resume();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(again.credential, "reloaded:pre");
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
