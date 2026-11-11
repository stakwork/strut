// The store's Run form, its pure parts (./store-run): the price in words,
// the form's fields from a workflow's input block or a step's JSON Schema,
// the values as an input, a publisher's HTTP answers read into the shape the
// visitor's paying loop takes — and that loop driving a plain HTTP launch:
// 402, pay, the same launch under the same key.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, errorOf, httpCallResult, inputOf, loadRuns, newLaunchKey, priceBadge, priceNotes, priceWords, rememberRun, RUNS_KEPT, runFields, runFileUrl, storePurseKey, type LaunchedRun } from "./store-run";
import { callPaying, newPurse, type CallParams, type PaymentRequired } from "./visitor-pay";

describe("the store's Run form (plans/paid-runs.md §10)", () => {
  it("prices in words: free, fixed, metered, both; a badge; the reserve and what recent runs were charged", () => {
    const w = { kind: "workflow" as const, capUsd: null };
    assert.equal(priceWords({ ...w, base: 0, markup: 0 }), "Free");
    assert.equal(priceWords({ ...w, base: 0.5, markup: 0 }), "$0.50 a run");
    assert.equal(priceWords({ ...w, kind: "step", base: 0.02, markup: 0 }), "$0.02 a call");
    assert.equal(priceWords({ ...w, base: 0, markup: 1.5, capUsd: 2 }), "1.5× what a run costs, up to $2.00 of cost");
    assert.equal(priceWords({ ...w, base: 0.1, markup: 2, capUsd: 1 }), "$0.10 + 2× what a run costs, up to $1.00 of cost");
    assert.equal(priceBadge({ base: 0, markup: 0 }), "free");
    assert.equal(priceBadge({ base: 0.5, markup: 0 }), "$0.50");
    assert.equal(priceBadge({ base: 0, markup: 1 }), "metered");
    assert.deepEqual(priceNotes({ kind: "workflow", base: 0.5, markup: 0, reserve: 0.5, recent: { days: 30, runs: 4, average: 0.5 } }), [
      "Needs $0.50 of credit to start; what the run does not use stays yours for later ones here.",
      "4 runs in the last 30 days, $0.50 charged on average.",
    ]);
    assert.deepEqual(priceNotes({ kind: "workflow", base: 0, markup: 0, reserve: 0, recent: { days: 30, runs: 1, average: 0 } }), ["1 run in the last 30 days."]);
    assert.deepEqual(priceNotes({ kind: "step", base: 0, markup: 0, reserve: 0, recent: { days: 30, runs: 0, average: 0 } }), ["No calls in the last 30 days."]);
  });

  it("fields from a workflow's input block, as the Run popover draws it; from a step's JSON Schema", () => {
    assert.deepEqual(runFields({ kind: "workflow", input: { text: { type: "string", description: "What" }, n: { type: "number", default: 2 }, opt: { type: "boolean", required: false } } }), [
      { name: "text", kind: "string", required: true, description: "What" },
      { name: "n", kind: "number", required: false, default: 2 },
      { name: "opt", kind: "boolean", required: false },
    ]);
    assert.deepEqual(
      runFields({
        kind: "step",
        input: {
          type: "object",
          properties: { note: { type: "string" }, count: { type: "integer", default: 1 }, mode: { type: "string", enum: ["a", "b"] }, opts: { type: "object" } },
          required: ["note", "mode", "count"],
        },
      }),
      [
        { name: "note", kind: "string", required: true },
        { name: "count", kind: "number", required: false, default: 1 },
        { name: "mode", kind: "enum", required: true, enumValues: ["a", "b"] },
        { name: "opts", kind: "json", required: false },
      ],
    );
    assert.deepEqual(runFields({ kind: "workflow", input: null }), []);
  });

  it("the values as an input: empty left out, numbers and JSON read, a required one asked for", () => {
    const fields = runFields({ kind: "workflow", input: { text: { type: "string" }, n: { type: "number", default: 2 }, j: { type: "json", required: false } } });
    assert.deepEqual(inputOf(fields, { text: "hi", n: "", j: '{"a":1}' }), { input: { text: "hi", j: { a: 1 } } });
    assert.deepEqual(inputOf(fields, { text: "hi", n: "3" }), { input: { text: "hi", n: 3 } });
    assert.deepEqual(inputOf(fields, { n: 3 }), { error: "text is required" });
    assert.deepEqual(inputOf(fields, { text: "x", j: "{" }), { error: "j is not JSON" });
  });

  it("a publisher's HTTP answers in the paying loop's shape: 2xx its body, 402 payment_required, else an error with its code and wait", () => {
    const ok = httpCallResult(202, { runId: "r1", token: "t" });
    assert.deepEqual(bodyOf(ok), { runId: "r1", token: "t" });
    assert.equal(errorOf(ok), undefined);
    const p = httpCallResult(402, { error: "payment_required", macaroon: "m", invoice: "lnbc1", usd: 0.5, sats: 500, extra: "no" });
    assert.deepEqual(bodyOf(p), { payment_required: { macaroon: "m", invoice: "lnbc1", usd: 0.5, sats: 500 } });
    const busy = httpCallResult(429, { error: "too many public runs in flight" }, "30");
    assert.equal(errorOf(busy), "too many public runs in flight (try again in 30 s)");
    assert.equal(errorOf(httpCallResult(401, { error: "invalid_token: no", code: "invalid_token" })), "invalid_token: no");
    assert.equal(errorOf(httpCallResult(403, { error: "not for this", code: "token_not_for_this" })), "token_not_for_this: not for this");
  });

  it("the paying loop drives a plain HTTP launch: 402, the sheet pays, the SAME launch is sent again with the credential — one key throughout", async () => {
    const purse = newPurse("v".repeat(32));
    const key = newLaunchKey(() => new Uint8Array(12).fill(7));
    assert.equal(key, `store:${"07".repeat(12)}`);
    const sent: Array<{ key: string; credential?: string }> = [];
    const challenge: PaymentRequired = { macaroon: "mac", invoice: "lnbc1", usd: 0.5, sats: 500 };
    const call = async () => {
      sent.push({ key, ...(purse.credential ? { credential: purse.credential } : {}) });
      return purse.credential === "mac:pre" ? httpCallResult(202, { runId: "r1", token: "tok" }) : httpCallResult(402, { error: "payment_required", ...challenge });
    };
    let asked = 0;
    const result = await callPaying({ name: "run_workflow" } as CallParams, {
      call,
      purse,
      launch: { workflow: "priced" },
      pay: async (p, workflow) => {
        asked++;
        assert.equal(workflow, "priced");
        assert.equal(p.macaroon, "mac");
        return "mac:pre";
      },
    });
    assert.deepEqual(bodyOf(result), { runId: "r1", token: "tok" });
    assert.equal(asked, 1);
    assert.deepEqual(sent, [{ key }, { key, credential: "mac:pre" }]);
    assert.equal(purse.credential, "mac:pre", "kept for the next run there");
    // Refused after paying (the server's runs in flight filled meanwhile): the payment is kept as credit.
    const purse2 = newPurse("w".repeat(32));
    const refusedAfter = await callPaying({ name: "run_workflow" } as CallParams, {
      call: async () => (purse2.credential ? httpCallResult(429, { error: "too many public runs in flight" }, "30") : httpCallResult(402, { error: "payment_required", ...challenge })),
      purse: purse2,
      launch: { workflow: "priced" },
      pay: async () => "mac:pre",
    });
    assert.match(errorOf(refusedAfter)!, /your payment is kept as credit on this server/);
    // Cancelled: a plain error, nothing launched.
    const purse3 = newPurse("x".repeat(32));
    const cancelled = await callPaying({ name: "run_workflow" } as CallParams, {
      call: async () => httpCallResult(402, { error: "payment_required", ...challenge }),
      purse: purse3,
      launch: { workflow: "priced" },
      pay: async () => null,
    });
    assert.match(errorOf(cancelled)!, /^payment_cancelled/);
  });

  it("the runs a tab launched there: kept newest first, one per run, at most RUNS_KEPT; storage that is not ours reads as none", () => {
    const r = (runId: string): LaunchedRun => ({ workflow: "w", runId, token: `t${runId}`, at: "2026-11-10T00:00:00Z" });
    let runs: LaunchedRun[] = [];
    for (let i = 0; i < RUNS_KEPT + 3; i++) runs = rememberRun(runs, r(String(i)));
    assert.equal(runs.length, RUNS_KEPT);
    assert.equal(runs[0]!.runId, String(RUNS_KEPT + 2));
    runs = rememberRun(runs, r(String(RUNS_KEPT + 2)));
    assert.equal(runs.filter((x) => x.runId === String(RUNS_KEPT + 2)).length, 1);
    const store = new Map<string, string>([["k", JSON.stringify([r("a"), { nope: 1 }, "x"])], ["bad", "{"]]);
    const storage = { getItem: (k: string) => store.get(k) ?? null };
    assert.deepEqual(loadRuns(storage, "k"), [r("a")]);
    assert.deepEqual(loadRuns(storage, "bad"), []);
    assert.deepEqual(loadRuns(undefined, "k"), []);
  });

  it("a run's file opens on its publisher with the run token; the purse is keyed by the server", () => {
    assert.equal(runFileUrl("https://pub.example/", "/public/workflows/w/runs/1/files/out.txt", "a b"), "https://pub.example/public/workflows/w/runs/1/files/out.txt?t=a%20b");
    assert.equal(runFileUrl("https://pub.example", "https://elsewhere.example/x", "t"), "https://elsewhere.example/x");
    assert.equal(storePurseKey("https://pub.example/"), "strut.store.purse:https://pub.example");
  });
});
