// strut/views' RunGraph at the scale of a workspace graph: the gallery's
// large run (about 3,000 nodes) read the way the component reads it, and the
// layout it is drawn from — folded, so it stays the size of a picture.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { distinctNodeRefs, lineageParents, projectWithLaunches, runGraphHops, runGraphLinks } from "@strut/kit/folds";
import { layoutRunGraph } from "../../kit/src/folds/run-graph/layout.js";
import { createFixtureClient } from "./views/src/fixtures/client.js";
import { LARGE_RUN_EVENTS, LARGE_RUN_HIGHLIGHTS, LARGE_RUN_ID, LARGE_RUN_WORKFLOW } from "./views/src/fixtures/run-large.js";
import { RunGraphReader } from "./views/src/components/run-graph/reader.js";
import { NAME_CHARS, clipName } from "./views/src/lib/format.js";

describe("strut/views — RunGraph at scale", () => {
  it("reads the large run whole — about 3,000 nodes and their lineage — and lays it out folded, a few thousand pixels at most", async () => {
    const client = createFixtureClient({ latencyMs: 0 });
    const events = await client.run<unknown[]>("run/events", { workflow: LARGE_RUN_WORKFLOW, runId: LARGE_RUN_ID });
    assert.deepEqual(events, LARGE_RUN_EVENTS);
    const { calls } = projectWithLaunches(events);
    const refs = distinctNodeRefs(calls);
    assert.ok(refs.length > 2900, `${refs.length} nodes touched`);

    const reader = new RunGraphReader(client);
    await reader.read(refs);
    const s = reader.snapshot();
    assert.equal(s.truncated, false, "every node read");
    assert.equal(s.nodes.length, refs.length);
    assert.ok(s.nodes.some((n) => n.name.length > 120), "names past 120 characters");
    assert.equal(clipName(s.nodes.find((n) => n.name.length > 120)!.name).length, NAME_CHARS);

    const parents = lineageParents(s.edges);
    assert.equal(parents.size, 2904 + 12, "every document under its area, every area under Law");
    const typeOf = new Map(s.nodes.map((n) => [n.ref_id, n.node_type]));
    const links = runGraphLinks(s.edges, runGraphHops(calls));
    const layout = layoutRunGraph(calls, s.nodes.map((n) => n.ref_id), links, parents, new Map(), 1.6, { cap: 8, typeOf, arc: 36 });
    assert.ok(layout.width < 3500 && layout.height < 2000, `${Math.round(layout.width)} × ${Math.round(layout.height)} px`);
    assert.ok(layout.places.size < 250, `${layout.places.size} drawn`);
    assert.ok(layout.clusters.size > 0);
    const folded = [...layout.clusters.values()].reduce((n, c) => n + c.members.length, 0);
    assert.ok(folded > 2000, `${folded} folded into ${layout.clusters.size} "+N" nodes`);
    // A highlight is a set of ref_ids; it names nodes the layout drew or folded — it moves nothing.
    const drawnOrFolded = new Set([...[...layout.places.values()].map((p) => p.id), ...[...layout.clusters.values()].flatMap((c) => c.members.map((m) => m.id))]);
    assert.ok(LARGE_RUN_HIGHLIGHTS.walk.every((r) => drawnOrFolded.has(r)));
    assert.ok(LARGE_RUN_HIGHLIGHTS.products.every((r) => drawnOrFolded.has(r)));
  });
});
