/**
 * Fact trust on a Ladybug file, through the steps the model calls:
 * `graph/assert` keeps an edge type's `volatility` and `expects` the first
 * time they are given and never overwrites them; `graph/graph-search` (with
 * facts) and `graph/graph-neighbors` return each fact's evidence, status,
 * stance, belief and currency, worked out on read and never stored. Each
 * assert records the mention as evidence on the fact's claim, once; ending a
 * fact backs nothing, `refuted` keeps the speaker's word against it, and
 * deleting a fact clears its evidence.
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
import deleteEdge from "../steps/lib/graph/delete-edge.js";

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

  it("volatility and expects are kept the first time they are given, and never overwritten", async () => {
    await run(assertStep, lives(lisbon, { said_by: kate }), b);
    assert.equal((await rule("LIVES_IN"))?.["volatility"], undefined, "none given: unset, read as stable");
    await run(assertStep, lives(lisbon, { volatility: "stable", create_schema_if_missing: false }), b);
    assert.equal((await rule("LIVES_IN"))?.["volatility"], "stable", "filled on a type that had none");
    await run(assertStep, lives(lisbon, { volatility: "volatile" }), b);
    assert.equal((await rule("LIVES_IN"))?.["volatility"], "stable", "never overwritten");
    assert.equal((await rule("LIVES_IN"))?.["cardinality"], "one", "the rest of the rule kept");
    const expects = { step: "hive/activity", every_days: 7, window_days: 30 };
    await run(assertStep, { source_ref_id: tom, edge_type: "works at", target_ref_id: gym, text: "Tom works at PureGym", create_schema_if_missing: true, cardinality: "one", expects }, b);
    assert.deepEqual(JSON.parse(String((await rule("WORKS_AT"))?.["expects"])), expects);
    await run(assertStep, { source_ref_id: tom, edge_type: "WORKS_AT", target_ref_id: gym, text: "Tom works at PureGym", expects: { step: "other/check", every_days: 1 } }, b);
    assert.equal(JSON.parse(String((await rule("WORKS_AT"))?.["expects"])).step, "hive/activity", "never overwritten");
    await assert.rejects(async () => run(assertStep, lives(lisbon, { volatility: "sometimes" }), b), /volatility/);
  });

  it("search and neighbors return who said it, status and stance, and store nothing", async () => {
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
    assert.deepEqual([f.status, f.stance], ["disputed", "cite"], "her own word competes with Sam's");
    assert.equal(f.rival.target_ref_id, lisbon);
    assert.deepEqual(f.evidence.items.map((x: { sayer: { kind: string }; strength: number }) => [x.sayer.kind, x.strength]), [["other", 1]]);

    const near = await run(graphNeighbors, { ref_id: kate }, b);
    const n = near.find((x: { ref_id: string }) => x.ref_id === porto);
    assert.deepEqual([n.belief, n.stance, n.evidence.sayers[0].kind], [0.7, "cite", "other"]);

    // The user says it: no Person among the sources, so it is the user's word.
    await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: lisbon, text: "Tom lives in Lisbon" }, b);
    const mine = (await run(graphSearch, { q: "Tom lives Lisbon", facts: true }, b)).facts.find((x: { source: { ref_id: string } }) => x.source.ref_id === tom);
    assert.deepEqual([mine.evidence.sayers, mine.status, mine.stance], [[{ ref_id: tom, name: "Tom", kind: "owner" }], "supported", "state"]);

    // A scored read writes nothing: the scores are not stored.
    const before = await graphSnapshot(b);
    await run(graphSearch, { q: "Kate", facts: true }, b);
    await run(graphNeighbors, { ref_id: kate }, b);
    assert.deepEqual(await graphSnapshot(b), before);
  });

  it("each mention is evidence on the fact's claim, once; a message read again writes nothing", async () => {
    const count = async (type: string) => Number((await b.query(`MATCH (n:Node {node_type: '${type}'}) RETURN count(n) AS c`))[0]!["c"]);
    await run(assertStep, lives(lisbon, { said_by: kate, source: "msg-1" }), b);
    assert.deepEqual([await count("Claim"), await count("Evidence")], [1, 1]);
    await run(assertStep, lives(lisbon, { said_by: kate, source: "msg-1" }), b);
    assert.deepEqual([await count("Claim"), await count("Evidence")], [1, 1], "the same message again: nothing new");
    await run(assertStep, lives(lisbon, { said_by: sam, source: "msg-2" }), b);
    assert.deepEqual([await count("Claim"), await count("Evidence")], [1, 2], "a second sayer: one claim, two pieces");
    const [row] = await b.query(`MATCH (c:Node {node_type: 'Claim'})-[r:EVIDENCED_BY]->(e:Node) WHERE e.content = 'Kate lives there' RETURN c.claim_text AS text, r.context AS context, e.evidence_mode AS mode LIMIT 1`);
    assert.equal(row!["text"], "Kate lives there");
    assert.equal(row!["mode"], "asserted");
    assert.ok(String(row!["context"]).includes("msg-"));
    // Neither node is a neighbor of the fact's ends, nor found by a search.
    assert.ok(!(await b.reader.neighbors(kate)).nodes.some((n) => n.node_type === "Claim" || n.node_type === "Evidence"));
    assert.ok(!(await b.reader.search({ q: "Kate lives there" })).nodes.some((n) => n.node_type === "Claim" || n.node_type === "Evidence"));
    // Both sayers come back as the fact's evidence.
    const f = (await run(graphSearch, { q: "Kate lives there", facts: true }, b)).facts[0];
    assert.deepEqual(f.evidence.sayers.map((x: { kind: string }) => x.kind).sort(), ["other", "self"]);
  });

  it("a fact written before claims is read from its sources, with the same answer", async () => {
    await run(assertStep, lives(lisbon, { said_by: kate, source: "msg-1" }), b);
    const withClaims = (await run(graphSearch, { q: "Kate lives there", facts: true }, b)).facts[0];
    await b.query(`MATCH (c:Node {node_type: 'Claim'})-[r:EVIDENCED_BY]->(e:Node) DELETE r`);
    await b.query(`MATCH (n:Node) WHERE n.node_type IN ['Claim', 'Evidence'] DELETE n`);
    const fromSources = (await run(graphSearch, { q: "Kate lives there", facts: true }, b)).facts[0];
    const { items, ...rest } = withClaims.evidence;
    assert.ok(items);
    // Evidence keeps its time in seconds, as every claim-layer datetime is: the same answer, to the second.
    const second = (f: { evidence: { last_confirmed: string } }) => ({ ...f, evidence: { ...f.evidence, last_confirmed: f.evidence.last_confirmed.slice(0, 19) }, score: 0 });
    assert.deepEqual(second(fromSources), second({ ...withClaims, evidence: rest }));
  });

  it("a deleted fact holds no slot: it is no rival, and not scored", async () => {
    const first = await run(assertStep, lives(lisbon, { said_by: kate }), b);
    await run(assertStep, lives(porto, { said_by: sam, text: "Kate lives in Porto now" }), b);
    const porto1 = async () => (await run(graphSearch, { q: "Kate lives Porto", facts: true }, b)).facts.find((x: { target: { ref_id: string } }) => x.target.ref_id === porto);
    assert.equal((await porto1()).status, "disputed");
    await b.edges.delete(first.edge_ref_id);
    const after = await porto1();
    assert.deepEqual([after.status, after.stance, after.rival], ["hearsay", "cite", undefined], "Lisbon was a mistake: only Sam's word is left");
  });

  it("the vegan story: Sam says it, the user says it is wrong — refuted, and the correction backs nothing", async () => {
    const diet = (extra: Record<string, unknown> = {}) => ({ source_ref_id: tom, edge_type: "FOLLOWS_DIET", target_ref_id: gym, text: "Tom is vegan", create_schema_if_missing: true, ...extra });
    await run(assertStep, diet({ said_by: sam, source: "msg-sam" }), b);
    const r = await run(assertStep, diet({ refuted: true }), b);
    assert.equal(r.action, "refuted");
    const f = (await run(graphSearch, { q: "Tom is vegan", facts: true, include_ended: true }, b)).facts[0];
    assert.deepEqual([f.status, f.evidence.sayers], ["refuted", [{ ref_id: sam, name: "Sam", kind: "other" }]], "Sam backed it; the user did not");
    assert.deepEqual(f.evidence.items.map((x: { strength: number }) => x.strength).sort(), [-1, 1]);
    assert.equal((await run(graphSearch, { q: "Tom is vegan", facts: true }, b)).facts.length, 0, "not current");
    // Ending a held fact ("I used to") is world time, not support.
    await run(assertStep, lives(lisbon, { said_by: kate, source: "msg-1" }), b);
    await run(assertStep, lives(lisbon, { ended: true }), b);
    const ended = (await run(graphSearch, { q: "Kate lives there", facts: true, include_ended: true }, b)).facts[0];
    assert.deepEqual(ended.evidence.sayers.map((x: { kind: string }) => x.kind), ["self"], "only Kate backed it");
  });

  it("refuting a fact the graph does not hold makes no fact, only the word against it", async () => {
    const r = await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: porto, text: "Tom lives in Porto", create_schema_if_missing: true, cardinality: "one", refuted: true }, b);
    assert.equal(r.action, "refuted");
    const edges = await b.query(`MATCH (:Node {ref_id: $t})-[r:LIVES_IN]->(:Node) RETURN count(r) AS c`, { t: tom });
    assert.equal(Number(edges[0]!["c"]), 0);
    // Sam then says it: it comes back refuted, not stated.
    await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: porto, text: "Tom lives in Porto", said_by: sam }, b);
    const f = (await run(graphSearch, { q: "Tom lives in Porto", facts: true }, b)).facts[0];
    assert.deepEqual([f.status, f.stance], ["refuted", "ask"], "the user's word against it stands until they back it");
  });

  it("deleting a fact clears its evidence: saved again, it starts from nothing", async () => {
    const count = async () => Number((await b.query(`MATCH (n:Node {node_type: 'Evidence'}) RETURN count(n) AS c`))[0]!["c"]);
    await run(assertStep, lives(lisbon, { said_by: sam, source: "msg-1" }), b);
    assert.equal(await count(), 1);
    await run(deleteEdge, { source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: lisbon }, b);
    assert.equal(await count(), 0);
    await run(assertStep, lives(lisbon, { said_by: kate, source: "msg-2" }), b);
    const f = (await run(graphSearch, { q: "Kate lives there", facts: true }, b)).facts[0];
    assert.deepEqual(f.evidence.sayers.map((x: { kind: string }) => x.kind), ["self"], "Sam's old word is gone");
  });

  it("a search without facts and other reads are as before: no trust fields", async () => {
    await run(assertStep, lives(lisbon, { said_by: kate }), b);
    const nodes = await run(graphSearch, { q: "Kate" }, b);
    assert.ok(Array.isArray(nodes));
    const raw = await b.reader.neighbors(kate);
    assert.equal(raw.edges[0]!.trust, undefined, "the reader scores only when asked");
  });
});
