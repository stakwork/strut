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
import { placeLabels, type LabelBox, type LabelInput, type LabelRequest } from "./views/src/components/run-graph/labels.js";

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

describe("strut/views — RunGraph's names", () => {
  const FONT = 11;
  const R = 12;
  const cell: LabelBox = { x0: 0, y0: 0, x1: 400, y1: 300 };
  const run = (requests: LabelRequest[], nodes: Array<{ key: string; x: number; y: number }> = requests, extra: Partial<LabelInput> = {}) =>
    placeLabels({
      requests,
      nodes,
      bounds: new Map([["c", cell]]),
      radius: R,
      font: FONT,
      pad: 2,
      width: (t) => t.length * 6,
      foldText: (n) => [`+${n} highlighted`, `+${n}`],
      ...extra,
    });
  const req = (key: string, x: number, y: number, rank = 3, more: Partial<LabelRequest> = {}): LabelRequest => ({ key, cell: "c", x, y, text: `Finding ${key}: a long name`, rank, fold: `Finding ${key}`, ...more });
  // Each placed name's box, as placeLabels sizes it (width 6 a character, ascent 0.95, descent 0.3 of the font).
  const boxOf = (r: LabelRequest, at: { dx: number; dy: number; anchor: string }): LabelBox => {
    const w = r.text.length * 6;
    const left = at.anchor === "middle" ? at.dx - w / 2 : at.anchor === "start" ? at.dx : at.dx - w;
    return { x0: r.x + left, y0: r.y + at.dy - 0.95 * FONT, x1: r.x + left + w, y1: r.y + at.dy + 0.3 * FONT };
  };
  const overlap = (a: LabelBox, b: LabelBox) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  it("two names that would cover each other: the second goes where it covers neither name nor node", () => {
    const a = req("a", 150, 100);
    const b = req("b", 170, 104);
    const { placed, folded } = run([a, b]);
    assert.equal(placed.size, 2);
    assert.deepEqual(folded, []);
    const [ba, bb] = [boxOf(a, placed.get("a")!), boxOf(b, placed.get("b")!)];
    assert.ok(!overlap(ba, bb), "the names do not overlap");
    for (const n of [a, b]) {
      const circle = { x0: n.x - R, y0: n.y - R, x1: n.x + R, y1: n.y + R };
      assert.ok(!overlap(ba, circle) && !overlap(bb, circle), "no name covers a node");
    }
  });

  it("a node by its cell's right edge: the name leans left and stays inside", () => {
    const r = req("r", 380, 150);
    const at = run([r]).placed.get("r")!;
    assert.equal(at.anchor, "end");
    const box = boxOf(r, at);
    assert.ok(box.x1 <= cell.x1 && box.x0 >= cell.x0, `inside the cell: ${JSON.stringify(box)}`);
  });

  it("a tight cluster: as many named as fit, the rest one \"+N highlighted\" listing them; a name nothing asked to list is left out", () => {
    // A ring of eight highlighted nodes in a cell too small for their names, and one more that is not highlighted.
    const small: LabelBox = { x0: 0, y0: 0, x1: 240, y1: 220 };
    const ring = Array.from({ length: 8 }, (_, i) => req(String(i), 120 + 40 * Math.cos((i * Math.PI) / 4), 110 + 40 * Math.sin((i * Math.PI) / 4)));
    const plain = req("p", 120, 110, 1, { fold: undefined });
    const { placed, folded } = run([...ring, plain], [...ring, plain], { bounds: new Map([["c", small]]) });
    assert.ok(placed.size >= 1 && placed.size < 8, `${placed.size} named`);
    assert.equal(folded.length, 1);
    const named = ring.filter((r) => placed.has(r.key)).length;
    assert.equal(folded[0]!.text, `+${8 - named} highlighted`);
    assert.deepEqual(new Set(folded[0]!.names), new Set(ring.filter((r) => !placed.has(r.key)).map((r) => r.fold)));
    assert.equal(placed.has("p"), false);
  });

  it("a group packed in among other nodes in a narrow lane: its \"+N\" goes below them, inside the lane", () => {
    const lane: LabelBox = { x0: 0, y0: 0, x1: 140, y1: 400 };
    const center = req("law", 70, 80);
    const ring = Array.from({ length: 10 }, (_, i) => ({ key: `n${i}`, x: 70 + 30 * Math.cos((i * Math.PI) / 5), y: 80 + 30 * Math.sin((i * Math.PI) / 5) }));
    const lit = req("lit", ring[2]!.x, ring[2]!.y);
    const { placed, folded } = run([center, lit], [...ring, center], { bounds: new Map([["c", lane]]) });
    assert.equal(placed.size, 0);
    assert.equal(folded.length, 1);
    const f = folded[0]!;
    const w = f.text.length * 6;
    const box = { x0: f.x + f.dx - w / 2, x1: f.x + f.dx + w / 2, y: f.y + f.dy };
    assert.ok(box.x0 >= lane.x0 && box.x1 <= lane.x1, "inside the lane");
    assert.ok(box.y - 0.95 * FONT > Math.max(...ring.map((n) => n.y)) + R, "below the ring");
    assert.deepEqual(new Set(f.names), new Set(["Finding law", "Finding lit"]));
  });

  it("a cell too narrow for a name: a shorter cut of it, else a plain \"+N\" listing it", () => {
    const narrow: LabelBox = { x0: 0, y0: 0, x1: 70, y1: 300 };
    const r = req("m", 35, 100, 3, { text: "Finding m: a long name", variants: ["Finding…"] });
    const short = run([r], [r], { bounds: new Map([["c", narrow]]) });
    assert.equal(short.placed.get("m")?.text, "Finding…");
    const tiny: LabelBox = { x0: 15, y0: 0, x1: 55, y1: 300 };
    const one = run([req("a", 35, 100), req("b", 35, 160)], undefined, { bounds: new Map([["c", tiny]]) });
    assert.equal(one.placed.size, 0);
    assert.deepEqual(one.folded.map((f) => [f.text, f.names.length]), [["+2", 2]]);
  });

  it("the hovered node's name is drawn even where nothing fits", () => {
    const blockers = Array.from({ length: 30 }, (_, i) => ({ key: `n${i}`, x: 100 + (i % 6) * 26, y: 80 + Math.floor(i / 6) * 26 }));
    const hovered = req("h", 165, 132, 6, { forced: true, fold: undefined });
    assert.ok(run([hovered], [...blockers, hovered]).placed.has("h"));
  });
});
