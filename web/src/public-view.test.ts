import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { boxesOf, checkedOf, emptyRecord, mergeNeeds, needsTick, removeRow, reserveUsd, rowsOf, runHints, setBox, setPrice, setResults, usd, visitorAppLink } from "./public-view.js";
import type { PublicRunInfo, PublicViewNeeds } from "./api.js";

const needs: PublicViewNeeds = {
  app: { name: "bench", version: "v3", title: "Bench" },
  workflows: [
    { name: "score-wf", runs: true, checked: true, note: "" },
    { name: "gone", runs: true, checked: false, note: "not a workflow on this strut server" },
  ],
  steps: [{ name: "bench/_shared-user", checked: true, note: "" }],
  reads: [
    { name: "bench/read", checked: true, note: "" },
    { name: "sheets/get-values", checked: false, note: "" },
  ],
  concepts: [
    { name: "Law", pages: 27, from: ["score-wf"], checked: true, note: "" },
    { name: "Nowhere", pages: 0, from: ["score-wf"], checked: false, missing: true, note: "" },
  ],
  perRun: [],
};

describe("the Public view tab's cascade", () => {
  it("starts from what the server pre-checked, runs with their workflow", () => {
    assert.deepEqual([...checkedOf(needs)].sort(), ["concept:Law", "read:bench/read", "runs:score-wf", "step:bench/_shared-user", "workflow:score-wf"]);
  });

  it("merges the checked lines: the app with its ticked reads, each workflow once, runs only when ticked", () => {
    const checked = checkedOf(needs);
    checked.add("read:sheets/get-values");
    const rec = mergeNeeds({ ...emptyRecord(), workflows: [{ name: "score-wf" }] }, needs, checked);
    assert.deepEqual(rec, {
      concepts: ["Law"],
      workflows: [{ name: "score-wf", runs: true }],
      steps: ["bench/_shared-user"],
      types: [],
      apps: [{ name: "bench", reads: ["bench/read", "sheets/get-values"] }],
      runnable: [],
    });
    checked.delete("runs:score-wf");
    assert.deepEqual(mergeNeeds(emptyRecord(), needs, checked).workflows, [{ name: "score-wf" }]);
  });

  it("a workflow added alone, with nothing else ticked, is its definition", () => {
    const wf: PublicViewNeeds = { workflow: "solo", workflows: [{ name: "solo", runs: false, checked: true, note: "" }], steps: [], reads: [], concepts: [], perRun: [] };
    assert.deepEqual(mergeNeeds(emptyRecord(), wf, checkedOf(wf)).workflows, [{ name: "solo" }]);
  });

  it("a visitor's link is the page alone, under the same mount", () => {
    assert.equal(visitorAppLink("acme/bench", "https://swarm.example:3355/lab/?wf=x#y"), "https://swarm.example:3355/lab/?app=acme%2Fbench&solo=1&public=1");
  });
});

describe("a workflow or step row's three boxes", () => {
  const wf = { kind: "workflow" as const, name: "cve/scan" };
  const step = { kind: "step" as const, name: "cve/lookup" };
  const info = (o: Partial<PublicRunInfo> = {}): PublicRunInfo => ({
    kind: "workflow",
    name: "cve/scan",
    can: { spends: false, acts: false, code: false },
    costs: { days: 30, runs: 0, measured: 0, average: 0, highest: 0 },
    input: true,
    wallet: true,
    gateway: true,
    ...o,
  });

  it("rows: the ones already drawn keep their order; the record's others follow", () => {
    const rec = { ...emptyRecord(), workflows: [{ name: "a" }], steps: ["s"], runnable: [{ kind: "workflow" as const, name: "b" }, { kind: "workflow" as const, name: "a" }] };
    assert.deepEqual(rowsOf(rec), [{ kind: "workflow", name: "a" }, { kind: "step", name: "s" }, { kind: "workflow", name: "b" }]);
    // A row unticked everywhere stays where it was drawn.
    assert.deepEqual(rowsOf(emptyRecord(), [{ kind: "workflow", name: "z" }]), [{ kind: "workflow", name: "z" }]);
  });

  it("each box is its own list; runs come with the definition; running is independent", () => {
    let rec = setBox(emptyRecord(), wf, "run", true);
    assert.deepEqual(boxesOf(rec, wf), { definition: false, runs: false, run: true });
    assert.deepEqual(rec.workflows, []);
    rec = setBox(rec, wf, "runs", true);
    assert.deepEqual(boxesOf(rec, wf), { definition: true, runs: true, run: true });
    rec = setBox(rec, wf, "runs", false);
    assert.deepEqual(rec.workflows, [{ name: "cve/scan" }]);
    rec = setBox(setBox(rec, wf, "runs", true), wf, "definition", false);
    assert.deepEqual(boxesOf(rec, wf), { definition: false, runs: false, run: true });
    rec = setBox(rec, step, "definition", true);
    assert.deepEqual(rec.steps, ["cve/lookup"]);
    assert.deepEqual(removeRow(setBox(rec, step, "run", true), step), { ...rec, steps: [] });
  });

  it("the price: typed numbers in, empty ones out; turning running off drops it", () => {
    let rec = setBox(emptyRecord(), wf, "run", true);
    rec = setPrice(rec, wf, "markup", "1.5");
    rec = setPrice(rec, wf, "capUsd", "5");
    rec = setPrice(rec, wf, "base", "");
    rec = setResults(rec, wf, "run");
    assert.deepEqual(rec.runnable, [{ kind: "workflow", name: "cve/scan", markup: 1.5, capUsd: 5, results: "run" }]);
    assert.deepEqual(setResults(rec, wf, "output").runnable[0], { kind: "workflow", name: "cve/scan", markup: 1.5, capUsd: 5 });
    assert.deepEqual(setPrice(rec, wf, "capUsd", "").runnable[0], { kind: "workflow", name: "cve/scan", markup: 1.5, results: "run" });
    assert.deepEqual(setBox(setBox(rec, wf, "run", false), wf, "run", true).runnable, [{ kind: "workflow", name: "cve/scan" }]);
  });

  it("the reserve is base + markup × the per-run cap, to the micro-dollar", () => {
    assert.equal(reserveUsd({ ...wf }), 0);
    assert.equal(reserveUsd({ ...wf, markup: 1.5, capUsd: 5 }), 7.5);
    assert.equal(reserveUsd({ ...wf, base: 0.1, markup: 1.2, capUsd: 5 }), 6.1);
    assert.equal(usd(7.5), "$7.50");
    assert.equal(usd(0.0042), "$0.0042");
  });

  it("says what the save will refuse, before it", () => {
    assert.deepEqual(runHints({ ...wf }, info()), []);
    assert.match(runHints({ ...wf }, info({ input: false })).join(" "), /no input: block/);
    assert.match(runHints({ ...wf, markup: 2 }, info()).join(" "), /needs a per-run cap/);
    assert.match(runHints({ ...wf, base: 1 }, info({ wallet: false })).join(" "), /set a wallet/);
    const spends = info({ can: { spends: true, acts: false, code: false } });
    assert.match(runHints({ ...wf, dailyCapUsd: 5 }, spends).join(" "), /no owner/);
    assert.deepEqual(runHints({ ...wf, dailyCapUsd: 5 }, { ...spends, owner: "tom-1" }), []);
    assert.match(runHints({ ...wf }, { ...spends, principal: "public-runs" }).join(" "), /set a daily cap/);
    assert.deepEqual(runHints({ ...wf, base: 1 }, { ...spends, owner: "tom-1" }), [], "a priced item needs no daily cap");
  });

  it("something that acts or runs code needs a tick when it is newly runnable", () => {
    const acts = info({ can: { spends: false, acts: true, code: false } });
    assert.equal(needsTick(wf, acts, emptyRecord()), true);
    assert.equal(needsTick(wf, info({ can: { spends: false, acts: false, code: true } }), emptyRecord()), true);
    assert.equal(needsTick(wf, info(), emptyRecord()), false);
    assert.equal(needsTick(wf, undefined, emptyRecord()), false);
    assert.equal(needsTick(wf, acts, { ...emptyRecord(), runnable: [{ ...wf }] }), false, "already runnable when the tab opened");
  });
});
