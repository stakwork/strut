/**
 * A delete hides, never erases (plans/graph-temporal.md), on a Ladybug file:
 * a node's delete keeps its edges and facts, hidden while it is deleted and
 * back when it is restored; an edge's delete marks it `deleted_at`, and it
 * never holds a slot again. `include_deleted` shows both, marked.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { assertEdge } from "./temporal.js";
import { mergeNodes } from "./merge.js";
import { testBackends } from "./test-util.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import graphNeighbors from "../steps/lib/graph/graph-neighbors.js";
import graphGet from "../steps/lib/graph/graph-get.js";
import deleteEdge from "../steps/lib/graph/delete-edge.js";
import restoreNode from "../steps/lib/graph/restore-node.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

type Ctx = Record<string, unknown>;
const ctxOf = (graph: object): Ctx => ({ runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services: { graph } });
const run = (step: { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> }, cfg: Ctx, ctx: Ctx): Promise<any> => step.run(step.input.parse(cfg), ctx);

describe("a delete hides, never erases (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let alex: string, kate: string, sam: string, lisbon: string, porto: string, acme: string;
  before(async () => {
    b = (await lb.open({})) as LadybugBackend;
    await createNodeSchema(b, b.schemas, { type: "City", attributes: {}, role: "entity" });
    await createNodeSchema(b, b.schemas, { type: "Company", attributes: {}, role: "entity" });
    await b.schemas.createEdgeSchema("Person", "LIVES_IN", "City", { temporal: true, cardinality: "one" });
    await b.schemas.createEdgeSchema("Person", "WORKS_AT", "Company", { temporal: true, cardinality: "many" });
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
    const ids = await b.nodes.writeMany([
      { type: "Person", data: { name: "Alex", is_owner: true } },
      { type: "Person", data: { name: "Kate" } },
      { type: "Person", data: { name: "Sam" } },
      { type: "City", data: { name: "Lisbon" } },
      { type: "City", data: { name: "Porto" } },
      { type: "Company", data: { name: "Acme" } },
    ]);
    [alex, kate, sam, lisbon, porto, acme] = ids.map((r) => r.ref_id) as [string, string, string, string, string, string];
  });
  const lives = (city: string, extra: Record<string, unknown> = {}) =>
    assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: kate, target_ref_id: city, text: `Kate lives in ${city === lisbon ? "Lisbon" : "Porto"}`, ...extra });
  const factIds = async (q: string, extra: Record<string, unknown> = {}) => ((await b.reader.search({ q, ...extra })).facts ?? []).map((f) => f.ref_id);

  it("delete Kate: her facts are hidden, include_deleted shows them marked, a restore brings them back", async () => {
    const fact = await lives(lisbon);
    const kept = await b.nodes.deleteNode(kate);
    assert.deepEqual(kept, { edges: 0 }, "nothing erased");

    assert.deepEqual(await factIds("Kate lives in Lisbon"), []);
    assert.deepEqual((await b.reader.neighbors(lisbon)).edges, [], "not from the other end either");
    assert.equal(await b.reader.getNode(kate), null);

    const shown = (await b.reader.search({ q: "Kate lives in Lisbon", include_deleted: true })).facts ?? [];
    assert.deepEqual(shown.map((f) => f.ref_id), [fact.ref_id]);
    assert.ok(shown[0]!.deleted_at! > 0, "marked: hidden by its deleted subject");
    assert.ok(shown[0]!.source.deleted_at! > 0);
    assert.equal(shown[0]!.target.deleted_at, undefined);
    const node = await b.reader.getNode(kate, { include_deleted: true });
    assert.ok(Number(node!.properties["deleted_at"]) > 0);
    assert.deepEqual((await b.reader.neighbors(lisbon, { include_deleted: true })).edges.map((e) => e.ref_id), [fact.ref_id]);

    // The steps take the flag too.
    const got = await run(graphGet, { ref_id: kate, include_deleted: true }, ctxOf(b));
    assert.match(got.deleted_at, /^\d{4}-/);
    assert.match(await run(graphGet, { ref_id: kate }, ctxOf(b)), /node not found/);
    const near = await run(graphNeighbors, { ref_id: lisbon, include_deleted: true }, ctxOf(b));
    assert.equal(near[0].ref_id, kate);
    assert.match(near[0].node_deleted_at, /^\d{4}-/);
    assert.deepEqual(await run(graphNeighbors, { ref_id: lisbon }, ctxOf(b)), []);

    // Restore. A Person is keyed by ref_id, so a create is a new one: the step brings her back.
    const back = await run(restoreNode, { ref_id: kate }, ctxOf(b));
    assert.deepEqual([back.status, back.name], ["Success", "Kate"], JSON.stringify(back));
    assert.match(await run(restoreNode, { ref_id: kate }, ctxOf(b)), /NOT_DELETED/);
    assert.deepEqual(await factIds("Kate lives in Lisbon"), [fact.ref_id]);
    assert.deepEqual((await b.reader.neighbors(kate)).edges.map((e) => e.ref_id), [fact.ref_id]);
  });

  it("delete a fact: hidden, never the current value, shown with include_deleted", async () => {
    const old = await lives(lisbon);
    const out = await run(deleteEdge, { edge_ref_id: old.ref_id }, ctxOf(b));
    assert.equal(out.status, "Success", JSON.stringify(out));
    assert.equal(await b.edges.delete(old.ref_id), null, "already deleted: a miss");

    assert.deepEqual(await factIds("Kate lives in Lisbon"), []);
    assert.deepEqual(await factIds("Kate lives in Lisbon", { include_ended: true }), [], "not history either: deleted");
    assert.deepEqual((await b.reader.neighbors(kate)).edges, []);
    assert.deepEqual(await b.reader.edgeCounts([kate], b.namespace), {});

    // A one-value slot is free: a new value is created, superseding nothing.
    const now = await lives(porto);
    assert.deepEqual([now.action, now.superseded], ["created", []]);
    // The same fact asserted again is a new edge; the deleted one stays deleted.
    const again = await lives(lisbon);
    assert.notEqual(again.ref_id, old.ref_id);
    assert.equal(again.action, "superseded");

    const all = await b.reader.search({ q: "Kate lives in Lisbon", include_deleted: true, include_ended: true });
    const deleted = (all.facts ?? []).find((f) => f.ref_id === old.ref_id);
    assert.ok(deleted && deleted.deleted_at! > 0, JSON.stringify(all.facts));
    const shown = (await b.reader.neighbors(kate, { include_deleted: true, include_ended: true })).edges.find((e) => e.ref_id === old.ref_id);
    assert.ok(Number(shown!.properties["deleted_at"]) > 0);
    const step = await run(graphSearch, { q: "Kate lives in Lisbon", facts: true, include_deleted: true, include_ended: true }, ctxOf(b));
    assert.match(step.facts.find((f: { ref_id: string }) => f.ref_id === old.ref_id).deleted_at, /^\d{4}-/);
  });

  it("a node a create restores comes back with its edges; a merged one is refused", async () => {
    const lisbonLives = await lives(lisbon);
    await b.nodes.deleteNode(lisbon);
    const back = await b.nodes.write({ type: "City", data: { name: "Lisbon" } });
    assert.deepEqual([back.outcome, back.ref_id], ["restored", lisbon]);
    assert.deepEqual(await factIds("Kate lives in Lisbon"), [lisbonLives.ref_id]);

    await mergeNodes(b, { keep: lisbon, duplicate: porto });
    assert.match(await run(restoreNode, { ref_id: porto }, ctxOf(b)), /REFUSED: .* merged into/);
  });

  it("a plain edge's delete hides it; writing it again brings it back", async () => {
    await b.schemas.createEdgeSchema("Person", "KNOWS", "Person", {});
    const e = await b.edges.write({ edge: "KNOWS", source_ref_id: kate, target_ref_id: sam });
    await b.edges.delete(e.ref_id);
    assert.deepEqual((await b.reader.neighbors(kate)).edges, []);
    const again = await b.edges.write({ edge: "KNOWS", source_ref_id: kate, target_ref_id: sam });
    assert.deepEqual([again.ref_id, again.created], [e.ref_id, true]);
    assert.deepEqual((await b.reader.neighbors(kate)).edges.map((x) => x.ref_id), [e.ref_id]);
  });
});
