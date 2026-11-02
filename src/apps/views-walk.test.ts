// strut/views' WalkView: what it draws of the gallery's two walks of the law
// Concept tree — a graph/walk step's hops and an agent's own graph calls —
// and its live replay, read the way useRunEvents reads a run in flight.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findWalks, foldWalkTrail, latestWalk, replayStart, toolResultsByCall, walkFrame, type WalkLogEvent } from "@strut/kit/folds";
import { createFixtureClient } from "./views/src/fixtures/client.js";
import { AGENT_WALK_EVENTS, AGENT_WALK_PATH, AGENT_WALK_RUN_ID, WALK_EVENTS, WALK_JOIN_RUN_ID, WALK_LIVE_RUN_ID, WALK_RUN_ID, WALK_WORKFLOW } from "./views/src/fixtures/walk.js";
import { BIG_WALK_EVENTS, BIG_WALK_RUN_ID, bigWalkNode } from "./views/src/fixtures/walk-large.js";
import { NAME_CHARS, clipName } from "./views/src/lib/format.js";

const TRAIL = ["Law", "Corporate / M&A", "NDA", "NDA drafting rules", "Deviation matrix (Google Sheet)"];
/** The agent read the drafting rules and the playbook in one call: both chosen at NDA. */
const AGENT_TRAIL = ["Law", "Corporate / M&A", "NDA", "NDA drafting rules", "Negotiation playbook", "Deviation matrix (Google Sheet)"];
const names = (l: Array<{ name: string }>) => l.map((n) => n.name);

describe("strut/views — WalkView", () => {
  it("the gallery's client serves each walk run's own log", async () => {
    const client = createFixtureClient();
    const read = (runId: string) => client.run<WalkLogEvent[]>("run/events", { workflow: WALK_WORKFLOW, runId });
    assert.deepEqual(await read(WALK_RUN_ID), WALK_EVENTS);
    assert.deepEqual(await read(AGENT_WALK_RUN_ID), AGENT_WALK_EVENTS);
  });

  it("the graph/walk step: the trail down the tree, the dropped siblings beside each choice", () => {
    const w = latestWalk(findWalks(WALK_EVENTS as WalkLogEvent[]))!;
    assert.deepEqual([w.kind, w.label, w.status, w.stopped], ["walk", "gather", "done", "sufficient"]);
    const t = foldWalkTrail(w.hops);
    assert.deepEqual(names(t.path), TRAIL);
    assert.deepEqual(
      t.steps.map((s) => s.candidates.filter((c) => c.state === "dropped").length),
      [0, 4, 3, 1, 2],
    );
    assert.deepEqual(t.steps[4]!.candidates.map((c) => [c.name, c.state]), [
      ["Deviation matrix (Google Sheet)", "chosen"],
      ["Clause library", "kept"],
      ["Redline conventions", "dropped"],
      ["Governing-law table", "dropped"],
    ]);
  });

  it("the agent's own calls: the same tree, the rules and the playbook read at once one hop; the sheet writes are not walk steps", async () => {
    const walks = findWalks(AGENT_WALK_EVENTS as WalkLogEvent[]);
    assert.deepEqual(walks.map((w) => [w.kind, w.path]), [["agent", AGENT_WALK_PATH]]);
    const t = foldWalkTrail(walks[0]!.hops);
    assert.deepEqual(names(t.path), AGENT_TRAIL);
    assert.equal(t.steps.length, 5);
    assert.deepEqual([t.steps[3]!.from?.name, names(t.steps[3]!.chosen)], ["NDA", ["NDA drafting rules", "Negotiation playbook"]]);
    assert.equal(t.steps[4]!.from?.name, "NDA drafting rules", "going on from one of them is no new hop");
    assert.deepEqual(t.steps[1]!.candidates.map((c) => c.state).sort(), ["chosen", "dropped", "dropped", "dropped", "dropped"]);
    // The transcript the view reads once the agent ended answers for every call.
    const client = createFixtureClient();
    const transcript = await client.run<{ messages: unknown[] }>("run/transcript", { workflow: WALK_WORKFLOW, runId: AGENT_WALK_RUN_ID, path: AGENT_WALK_PATH });
    const results = toolResultsByCall(transcript.messages);
    assert.equal(results.size, 8);
    assert.deepEqual(names(foldWalkTrail(findWalks(AGENT_WALK_EVENTS as WalkLogEvent[], { results })[0]!.hops).path), AGENT_TRAIL);
  });

  it("the live replay, read as useRunEvents reads it (`skip`): running, a hop pending, then done", async () => {
    const client = createFixtureClient();
    const log: WalkLogEvent[] = [];
    const seen: string[] = [];
    let pending = false;
    while (!log.some((e) => e.type === "run.end")) {
      log.push(...(await client.run<WalkLogEvent[]>("run/events", { workflow: WALK_WORKFLOW, runId: WALK_LIVE_RUN_ID, ...(log.length ? { skip: log.length } : {}) })));
      const w = findWalks(log)[0];
      if (!w) continue;
      seen.push(w.status);
      pending ||= foldWalkTrail(w.hops).steps.at(-1)?.pending === true;
    }
    assert.equal(seen[0], "running");
    assert.equal(seen.at(-1), "done");
    assert.ok(pending, "a read landed between a hop's candidates and its choice");
    assert.deepEqual(log, WALK_EVENTS);
  });

  it("joined mid-walk: the hops so far at once, following; scrubbing back reads the same log", async () => {
    const client = createFixtureClient();
    const first = await client.run<WalkLogEvent[]>("run/events", { workflow: WALK_WORKFLOW, runId: WALK_JOIN_RUN_ID });
    const w = findWalks(first)[0]!;
    assert.equal(w.status, "running");
    const start = replayStart(w.hops.length, true);
    assert.deepEqual(start, { at: 6, mode: "follow" }, "three hops shown at once");
    assert.deepEqual(names(walkFrame(w.hops, start.at).trail.path), TRAIL.slice(0, 3));
    assert.deepEqual(names(walkFrame(w.hops, 2).trail.path), ["Law"], "a step back");
  });

  it("the large walk: 9 hops over about 2,000 candidates, some names past 120 characters, each node there to open", async () => {
    const client = createFixtureClient();
    const log = await client.run<WalkLogEvent[]>("run/events", { workflow: WALK_WORKFLOW, runId: BIG_WALK_RUN_ID });
    assert.deepEqual(log, BIG_WALK_EVENTS);
    const w = findWalks(log)[0]!;
    const t = foldWalkTrail(w.hops);
    assert.equal(t.steps.length, 9);
    assert.equal(t.considered, 9 * 222);
    assert.equal(t.path.length, 9);
    const names = t.steps.flatMap((s) => s.candidates.map((c) => c.name));
    assert.ok(names.some((n) => n.length > 120), "names past 120 characters");
    assert.ok(t.path.some((n) => n.name.length > 120), "one on the path");
    const long = names.find((n) => n.length > 120)!;
    assert.equal(clipName(long).length, NAME_CHARS);
    assert.ok(clipName(long).endsWith("…"));
    assert.equal(clipName("NDA"), "NDA");
    assert.equal(bigWalkNode(t.path[4]!.ref_id)?.name, t.path[4]!.name);
  });
});
