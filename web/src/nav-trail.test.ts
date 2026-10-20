import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TRAIL, hereEntry, readTrail, stepTrail, trailTitle, withTrail, type TrailEntry } from "./nav-trail";

const a: TrailEntry = { wf: "parent", run: "r1", job: null };
const b: TrailEntry = { wf: "child", run: "r2", job: null };

test("a trail round-trips through history state, other keys kept", () => {
  const state = withTrail({ other: 1 }, [a, b]);
  assert.equal(state.other, 1);
  assert.deepEqual(readTrail(state), [a, b]);
});

test("readTrail tolerates missing or malformed state", () => {
  assert.deepEqual(readTrail(null), []);
  assert.deepEqual(readTrail({}), []);
  assert.deepEqual(readTrail({ strutTrail: "x" }), []);
  assert.deepEqual(readTrail({ strutTrail: [{ run: "r" }, { wf: "w", run: 3, job: "" }] }), [
    { wf: "w", run: null, job: null },
  ]);
});

test("withTrail starts from a non-object state", () => {
  assert.deepEqual(readTrail(withTrail(null, [a])), [a]);
});

test("hereEntry: a run, a workflow canvas, but not a job's timeline", () => {
  assert.deepEqual(hereEntry("w", "r", null), { wf: "w", run: "r", job: null });
  assert.deepEqual(hereEntry("w", null, null), { wf: "w", run: null, job: null });
  assert.deepEqual(hereEntry("w", "r", "j"), { wf: "w", run: "r", job: "j" });
  assert.equal(hereEntry("w", null, "j"), null);
  assert.equal(hereEntry(null, "r", null), null);
});

test("stepTrail appends where you were, unless it isn't a step", () => {
  assert.deepEqual(stepTrail([], a, b), [a]);
  assert.deepEqual(stepTrail([a], b, { wf: "grandchild", run: "r3", job: null }), [a, b]);
  assert.deepEqual(stepTrail([a], null, b), [a]);
  assert.deepEqual(stepTrail([a], b, { ...b }), [a]);
});

test("stepTrail keeps only the newest steps", () => {
  let trail: TrailEntry[] = [];
  for (let i = 0; i < MAX_TRAIL + 5; i++) trail = stepTrail(trail, { wf: "w", run: `r${i}`, job: null }, b);
  assert.equal(trail.length, MAX_TRAIL);
  assert.equal(trail[0]!.run, "r5");
});

test("trailTitle names the run when there is one", () => {
  assert.equal(trailTitle(a), "Back to parent · run r1");
  assert.equal(trailTitle({ wf: "w", run: null, job: null }), "Back to w");
});
