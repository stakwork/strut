import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkedOf, emptyRecord, mergeNeeds, visitorAppLink } from "./public-view.js";
import type { PublicViewNeeds } from "./api.js";

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
