/**
 * Fact trust on a Ladybug file, through the steps the model calls:
 * `graph/assert` keeps an edge type's `volatility` and `depends_on` the first
 * time they are given and never overwrites them; `graph/graph-search` (with
 * facts) and `graph/graph-neighbors` return each fact's evidence, belief,
 * currency and hedge, worked out on read and never stored.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { edgeRule } from "./ladybug/ontology.js";
import { graphSnapshot, testBackends } from "./test-util.js";
import assertStep from "../steps/lib/graph/assert.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import graphNeighbors from "../steps/lib/graph/graph-neighbors.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const run = (step: Step, cfg: Record<string, unknown>, b: LadybugBackend): Promise<any> =>
  step.run(step.input.parse(cfg), { runId: "r-1", path: "chat/s", workflow: "chat", scope: {}, input: undefined, emit: async () => {}, services: { graph: b }, actor: "tom" });

describe("fact trust on a ladybug file", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let tom: string, kate: string, sam: string, lisbon: string, porto: string, gym: string;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
    for (const type of ["Place", "Organization"]) await createNodeSchema(b, b.schemas, { type, attributes: {}, role: "entity" });
    const ids = await b.nodes.writeMany([
      { type: "Person", data: { name: "Tom", is_owner: true } },
      { type: "Person", data: { name: "Kate" } },
      { type: "Person", data: { name: "Sam" } },
      { type: "Place", data: { name: "Lisbon" } },
      { type: "Place", data: { name: "Porto" } },
      { type: "Organization", data: { name: "PureGym" } },
    ]);
    [tom, kate, sam, lisbon, porto, gym] = ids.map((r) => r!.ref_id) as [string, string, string, string, string, string];
  });
  const rule = async (edge: string) => edgeRule((c, p) => b.query(c, p), edge);
  const lives = (target: string, extra: Record<string, unknown> = {}) => ({
    source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: target, text: "Kate lives there", create_schema_if_missing: true, cardinality: "one", ...extra,
  });

  it("volatility and depends_on are kept the first time they are given, and never overwritten", async () => {
    await run(assertStep, lives(lisbon, { said_by: kate }), b);
    assert.equal((await rule("LIVES_IN"))?.["volatility"], undefined, "none given: unset, read as stable");
    await run(assertStep, lives(lisbon, { volatility: "stable", create_schema_if_missing: false }), b);
    assert.equal((await rule("LIVES_IN"))?.["volatility"], "stable", "filled on a type that had none");
    await run(assertStep, lives(lisbon, { volatility: "volatile" }), b);
    assert.equal((await rule("LIVES_IN"))?.["volatility"], "stable", "never overwritten");
    assert.equal((await rule("LIVES_IN"))?.["cardinality"], "one", "the rest of the rule kept");
    await run(assertStep, { source_ref_id: tom, edge_type: "uses gym", target_ref_id: gym, text: "Tom goes to PureGym", create_schema_if_missing: true, cardinality: "one", depends_on: ["lives in"] }, b);
    assert.deepEqual((await rule("USES_GYM"))?.["depends_on"], ["LIVES_IN"]);
    await assert.rejects(async () => run(assertStep, lives(lisbon, { volatility: "sometimes" }), b), /volatility/);
  });

  it("search and neighbors return who said it, belief, currency and hedge, and store nothing", async () => {
    await run(assertStep, lives(lisbon, { said_by: kate, volatility: "stable" }), b);
    // Sam says she moved: hearsay replacing what she said herself.
    await run(assertStep, lives(porto, { said_by: sam, text: "Kate lives in Porto now" }), b);

    const out = await run(graphSearch, { q: "Kate lives Porto", facts: true }, b);
    const f = out.facts.find((x: { target: { ref_id: string } }) => x.target.ref_id === porto);
    assert.ok(f, JSON.stringify(out));
    assert.deepEqual(f.evidence.sayers, [{ ref_id: sam, name: "Sam", kind: "other" }]);
    assert.match(f.evidence.last_confirmed, /^\d{4}-\d\d-\d\dT/);
    assert.equal(f.belief, 0.7);
    assert.equal(f.currency, 1);
    assert.equal(f.hearsay, true);
    assert.equal(f.hedge, true, "her own word competes with Sam's");
    assert.equal(f.rival.target_ref_id, lisbon);

    const near = await run(graphNeighbors, { ref_id: kate }, b);
    const n = near.find((x: { ref_id: string }) => x.ref_id === porto);
    assert.deepEqual([n.belief, n.hedge, n.evidence.sayers[0].kind], [0.7, true, "other"]);

    // The user says it: no Person among the sources, so it is the user's word.
    await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: lisbon, text: "Tom lives in Lisbon" }, b);
    const mine = (await run(graphSearch, { q: "Tom lives Lisbon", facts: true }, b)).facts.find((x: { source: { ref_id: string } }) => x.source.ref_id === tom);
    assert.deepEqual([mine.evidence.sayers, mine.hedge, mine.hearsay], [[{ ref_id: tom, name: "Tom", kind: "owner" }], false, undefined]);

    // A scored read writes nothing: the scores are not stored.
    const before = await graphSnapshot(b);
    await run(graphSearch, { q: "Kate", facts: true }, b);
    await run(graphNeighbors, { ref_id: kate }, b);
    assert.deepEqual(await graphSnapshot(b), before);
  });

  it("a search without facts and other reads are as before: no trust fields", async () => {
    await run(assertStep, lives(lisbon, { said_by: kate }), b);
    const nodes = await run(graphSearch, { q: "Kate" }, b);
    assert.ok(Array.isArray(nodes));
    const raw = await b.reader.neighbors(kate);
    assert.equal(raw.edges[0]!.trust, undefined, "the reader scores only when asked");
  });
});
