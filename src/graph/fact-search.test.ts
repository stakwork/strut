/**
 * Search returns facts (plans/graph-memory-plan.md step 4, and the reads
 * of plans/graph-edge-search.md): on a Ladybug file a search hits the
 * temporal edges' search rows and returns each fact with its sentence, both
 * ends and its dates, apart from the nodes. Current facts by default;
 * `include_ended` shows history and `as_of` what was true then, in search,
 * neighbors and walk. Every read is held to the reader's list. On Neo4j a
 * search answers as on main.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GraphBackend, LadybugBackend } from "./backend.js";
import type { Embedder } from "./node-writer.js";
import { createNodeSchema } from "./schema-crud.js";
import { graphView, parseGraphReaders } from "./scope.js";
import { assertEdge } from "./temporal.js";
import { mergeNodes } from "./merge.js";
import { seedStrutDomain } from "./schema-seed.js";
import { testBackends } from "./test-util.js";
import type { Evaluate, EvalAnswer } from "../evaluate.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import graphNeighbors from "../steps/lib/graph/graph-neighbors.js";
import graphFind from "../steps/lib/graph/find.js";
import { runWalk } from "../steps/lib/graph/walk.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const neo4j = testBackends().find((b) => b.kind === "neo4j")!;

/** Words that mean the same thing share a dimension, so a query and a fact
 *  with no word in common still meet: a stand-in for meaning. */
const MEANING: Record<string, number> = { job: 1, work: 1, works: 1, worked: 1, employer: 1, engineer: 1 };
const embedder: Embedder = {
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(384).fill(0);
      for (const w of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) v[MEANING[w] ?? 10 + ([...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 370)]! += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

const READERS = parseGraphReaders({
  jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] },
  apps: { namespaces: ["shared"], exclude_domains: ["Strut"] },
});
type Ctx = Record<string, unknown>;
const jobCtx = (services: object, extra: Ctx = {}): Ctx => ({ runId: "r-1", path: "nightly/s", workflow: "nightly", scope: {}, input: undefined, emit: async () => {}, services, ...extra });
const appCtx = (services: object): Ctx => jobCtx(services, { app: { name: "notes", version: "1" } });
const run = (step: { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> }, cfg: Ctx, ctx: Ctx): Promise<any> => step.run(step.input.parse(cfg), ctx);

describe("search returns facts on a ladybug file (plans/graph-memory-plan.md step 4)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let tom: string, stakwork: string, acme: string;
  before(async () => {
    b = (await lb.open({ embedder })) as LadybugBackend;
    await createNodeSchema(b, b.schemas, { type: "Company", attributes: {}, role: "entity" });
    await b.schemas.createEdgeSchema("Person", "WORKS_AT", "Company", { temporal: true, cardinality: "one" });
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
    const [t, s, a] = await b.nodes.writeMany([
      { type: "Person", data: { name: "Tom" } },
      { type: "Company", data: { name: "Stakwork" } },
      { type: "Company", data: { name: "Acme" } },
    ]);
    [tom, stakwork, acme] = [t!.ref_id, s!.ref_id, a!.ref_id];
  });
  const works = (target: string, text: string, extra: Record<string, unknown> = {}) =>
    assertEdge(b, b.schemas, { edge: "WORKS_AT", source_ref_id: tom, target_ref_id: target, text, ...extra }, { embedder });
  /** Stakwork from 2020, then Acme from 2024: the first is superseded. */
  const history = async () => {
    const old = await works(stakwork, "Tom works at Stakwork", { valid_at: "2020" });
    const now = await works(acme, "Tom works at Acme", { valid_at: "2024" });
    assert.equal(now.action, "superseded");
    return { old: old.ref_id, now: now.ref_id };
  };
  const factIds = async (p: Parameters<GraphBackend["reader"]["search"]>[0], reader = b.reader) => ((await reader.search(p)).facts ?? []).map((f) => f.ref_id);

  it("a search by meaning finds the fact, with its sentence, both ends, its dates and a score, apart from the nodes", async () => {
    const r = await works(stakwork, "Tom works at Stakwork as an engineer", { valid_at: "2020-03", source: tom });
    const res = await b.reader.search({ q: "where's my job?" });
    const fact = res.facts?.[0];
    assert.ok(fact, JSON.stringify(res));
    assert.deepEqual(
      { ...fact, score: undefined, match_type: undefined },
      {
        ref_id: r.ref_id,
        edge_type: "WORKS_AT",
        text: "Tom works at Stakwork as an engineer",
        source: { ref_id: tom, node_type: "Person", title: "Tom" },
        target: { ref_id: stakwork, node_type: "Company", title: "Stakwork" },
        valid_at: Date.parse("2020-03-01T00:00:00Z"),
        sources: [tom],
        namespace: "private",
        score: undefined,
        match_type: undefined,
      },
    );
    assert.ok(fact.score > 0);
    assert.equal(fact.match_type, "semantic", "no word of the query is in the fact");
  });

  it("a name the sentence doesn't use is found through the composed text", async () => {
    const r = await works(stakwork, "He works there");
    assert.deepEqual(await factIds({ q: "Stakwork" }), [r.ref_id]);
    assert.deepEqual(await factIds({ q: "Tom Stakwork" }), [r.ref_id]);
  });

  it("an ended fact is hidden by default, and found with include_ended or a matching as_of", async () => {
    const { old, now } = await history();
    assert.deepEqual(await factIds({ q: "Tom works" }), [now]);
    assert.deepEqual((await factIds({ q: "Tom works", include_ended: true })).sort(), [old, now].sort());
    assert.deepEqual(await factIds({ q: "Tom works", as_of: "2022-06-01" }), [old]);
    assert.deepEqual(await factIds({ q: "Tom works", as_of: Date.parse("2025-01-01T00:00:00Z") }), [now]);
    assert.deepEqual(await factIds({ q: "Tom works", as_of: "2019" }), [], "neither had begun");
    const ended = (await b.reader.search({ q: "Stakwork", include_ended: true })).facts![0]!;
    assert.deepEqual([ended.invalid_at, ended.superseded_by, typeof ended.expired_at], [Date.parse("2024-01-01T00:00:00Z"), now, "number"]);
    await assert.rejects(b.reader.search({ q: "Tom", as_of: "soon" }), /as_of/);
  });

  it("neighbors and their counts hide an ended edge the same way, and show a fact's text and dates", async () => {
    const { old, now } = await history();
    const edges = async (p = {}) => (await b.reader.neighbors(tom, p)).edges.map((e) => e.ref_id).sort();
    assert.deepEqual(await edges(), [now]);
    assert.deepEqual(await edges({ include_ended: true }), [old, now].sort());
    assert.deepEqual(await edges({ as_of: "2021" }), [old]);
    assert.deepEqual((await b.reader.edgeCounts([tom], "private"))[tom], { WORKS_AT: 1 });
    assert.deepEqual(await b.reader.connectionCounts(tom), [{ edge_type: "WORKS_AT", target_type: "Company", direction: "out", count: 1 }]);

    const out = await run(graphNeighbors, { ref_id: tom }, jobCtx({ graph: b }));
    assert.equal(out.length, 1);
    assert.deepEqual(
      [out[0].ref_id, out[0].text, out[0].valid_at, out[0].invalid_at, out[0].edges],
      [acme, "Tom works at Acme", "2024-01-01T00:00:00.000Z", undefined, { WORKS_AT: 1 }],
    );
    const all = await run(graphNeighbors, { ref_id: tom, include_ended: true }, jobCtx({ graph: b }));
    const past = all.find((n: { ref_id: string }) => n.ref_id === stakwork);
    assert.deepEqual([past.text, past.valid_at, past.invalid_at, past.superseded_by], ["Tom works at Stakwork", "2020-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z", now]);
  });

  it("a walk hops current facts only, unless asked, and shows the edge's sentence and dates to the decider", async () => {
    await history();
    // Every candidate relevant; expand the first option; never sufficient.
    const evaluate: Evaluate = async ({ questions }) => {
      const answers: Record<string, EvalAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        if (id === "next" && q.type === "choice") answers[id] = { type: "choice", choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none" };
        else answers[id] = { type: "boolean", probability: id === "sufficient" ? 0 : 0.9 };
      }
      return { answers: answers as any, usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 } };
    };
    const walk = (extra = {}) => runWalk({ goal: "where does Tom work?", start: [tom], maxHops: 2, maxNodes: 10, threshold: 0.5, ...extra }, { reader: b.reader, evaluate });
    const kept = (await walk()).nodes.filter((n) => n.ref_id !== tom);
    assert.deepEqual(kept.map((n) => n.ref_id), [acme]);
    assert.deepEqual(kept[0]!.via!.properties, { text: "Tom works at Acme", valid_at: "2024-01-01T00:00:00.000Z" });
    assert.deepEqual((await walk({ include_ended: true })).nodes.map((n) => n.ref_id).sort(), [tom, stakwork, acme].sort());
  });

  it("a search row is never a node: not a search hit, not a node by its ref_id, not a neighbour", async () => {
    await works(stakwork, "Tom works at Stakwork");
    const [row] = await b.query(`MATCH (n:Node {node_type: 'EdgeText'}) RETURN n.ref_id AS r`);
    assert.ok(row);
    const res = await b.reader.search({ q: "Tom works at Stakwork", include_ended: true });
    assert.equal(res.facts?.length, 1);
    assert.deepEqual(res.nodes.filter((n) => n.node_type === "EdgeText"), []);
    assert.equal(await b.reader.getNode(String(row["r"])), null);
    assert.deepEqual((await b.reader.neighbors(tom)).nodes.filter((n) => n.node_type === "EdgeText"), []);
  });

  it("a typed search asks for nodes, and finds no facts", async () => {
    await works(stakwork, "Tom works at Stakwork");
    const res = await b.reader.search({ q: "Stakwork", types: ["Company"] });
    assert.equal(res.facts, undefined);
    assert.equal(res.nodes[0]?.ref_id, stakwork);
    assert.deepEqual(res.nodes.filter((n) => n.node_type !== "Company"), []);
  });

  it("a fact in private is not found by a shared-only reader, nor one whose end it can't see", async () => {
    const r = await works(stakwork, "Tom works at Stakwork");
    const shared = b.reader.withScope!({ namespaces: ["shared"] });
    assert.deepEqual(await factIds({ q: "Tom works at Stakwork" }, shared), []);
    assert.deepEqual(await factIds({ q: "Tom works at Stakwork" }, b.reader.withScope!({ namespaces: ["private"] })), [r.ref_id]);
    // A shared fact about a private person stays hidden: an edge needs both its ends.
    const kate = await b.nodes.write({ type: "Person", data: { name: "Kate" } }, "create", { namespace: "shared" });
    const acmeShared = await b.nodes.write({ type: "Company", data: { name: "Globex" } }, "create", { namespace: "shared" });
    const hers = await assertEdge(b, b.schemas, { edge: "WORKS_AT", source_ref_id: kate.ref_id, target_ref_id: acmeShared.ref_id, text: "Kate works at Globex", namespace: "shared" }, { embedder });
    const mixed = await assertEdge(b, b.schemas, { edge: "WORKS_AT", source_ref_id: tom, target_ref_id: acmeShared.ref_id, text: "Tom works at Globex too", namespace: "shared" }, { embedder });
    const seen = await factIds({ q: "works at Globex" }, shared);
    assert.deepEqual(seen, [hers.ref_id]);
    assert.ok((await factIds({ q: "works at Globex" })).includes(mixed.ref_id));
    // Through the step: an app reads only shared.
    const out = await run(graphSearch, { q: "Tom works at Stakwork", facts: true }, appCtx({ graph: graphView(b, READERS) }));
    assert.deepEqual(out.facts.map((f: { ref_id: string }) => f.ref_id), [hers.ref_id], JSON.stringify(out));
  });

  it("graph-search returns { nodes, facts } with facts: true, and a Strut-excluded search still finds facts", async () => {
    const r = await works(stakwork, "Tom works at Stakwork", { valid_at: "2020" });
    const view = graphView(b, READERS);
    for (const [ctx, cfg] of [[jobCtx({ graph: view }), {}], [jobCtx({ graph: b }), { exclude_domains: "Strut" }]] as const) {
      const out = await run(graphSearch, { q: "where's my job?", facts: true, ...cfg }, ctx);
      assert.ok(Array.isArray(out.nodes), JSON.stringify(out));
      assert.equal(out.facts.length, 1, JSON.stringify(out));
      const { score, ...fact } = out.facts[0];
      assert.ok(score > 0);
      assert.deepEqual(fact, {
        ref_id: r.ref_id,
        edge_type: "WORKS_AT",
        text: "Tom works at Stakwork",
        source: { ref_id: tom, node_type: "Person", title: "Tom" },
        target: { ref_id: stakwork, node_type: "Company", title: "Stakwork" },
        valid_at: "2020-01-01T00:00:00.000Z",
        sources: [],
        namespace: "private",
      });
    }
    assert.match(await run(graphSearch, { q: "Tom", as_of: "soon" }, jobCtx({ graph: b })), /as_of/);
  });

  it("without facts: true graph-search is the plain list, though a fact matches; with it and none matching, facts is []", async () => {
    await works(stakwork, "Tom works at Stakwork", { valid_at: "2020" });
    const plain = await run(graphSearch, { q: "Tom works at Stakwork" }, jobCtx({ graph: b }));
    assert.ok(Array.isArray(plain), JSON.stringify(plain));
    assert.ok(plain.some((h: { ref_id: string }) => h.ref_id === stakwork));
    assert.equal((await b.reader.search({ q: "Tom works at Stakwork", facts: false })).facts, undefined, "the reader runs no fact query");
    const none = await run(graphSearch, { q: "Stakwork", facts: true, as_of: "2001" }, jobCtx({ graph: b }));
    assert.deepEqual(none.facts, []);
    assert.ok(Array.isArray(none.nodes));
  });

  it("graph/find never lists a fact's search row or a merge record: EdgeText and Merge are no node types", async () => {
    await works(stakwork, "Tom works at Stakwork");
    assert.match(await run(graphFind, { node_type: "EdgeText" }, jobCtx({ graph: b })), /unknown node type/);
    assert.match(await run(graphFind, { node_type: "Merge" }, jobCtx({ graph: b })), /unknown node type/);
  });

  it("after a merge, a fact is found once, on the kept node", async () => {
    const dup = (await b.nodes.write({ type: "Company", data: { name: "Stakwork Inc" } })).ref_id;
    const fact = await works(dup, "Tom works at Stakwork Inc");
    await mergeNodes(b, { keep: stakwork, duplicate: dup });
    const facts = (await b.reader.search({ q: "Tom works at Stakwork" })).facts ?? [];
    assert.equal(facts.length, 1, JSON.stringify(facts));
    assert.notEqual(facts[0]!.ref_id, fact.ref_id, "the copy, not the duplicate's original");
    assert.equal(facts[0]!.target.ref_id, stakwork);
  });
});

describe("search on neo4j is as on main (plans/graph-memory-plan.md step 4)", { skip: neo4j.skip }, () => {
  let b: GraphBackend;
  before(async () => {
    b = await neo4j.open();
    await neo4j.wipe(b);
    await seedStrutDomain(b);
  });
  after(async () => {
    await neo4j.close(b);
  });

  it("no facts key, include_ended / as_of accepted and ignored, and facts: true gives facts: []", async () => {
    const made = await b.nodes.write({ type: "StrutWorkflow", data: { name: "lighthouse-keeper", description: "Lights the lighthouse lamp" } });
    await b.query(`CALL db.awaitIndexes(60)`);
    const plain = await b.reader.search({ q: "lighthouse" });
    assert.equal("facts" in plain, false);
    assert.deepEqual(await b.reader.search({ q: "lighthouse", include_ended: true, as_of: "2020" }), plain);
    const out = await run(graphSearch, { q: "lighthouse", include_ended: true, as_of: "2020" }, jobCtx({ graph: b }));
    assert.ok(Array.isArray(out) && out.some((h: { ref_id: string }) => h.ref_id === made.ref_id), JSON.stringify(out));
    const asked = await run(graphSearch, { q: "lighthouse", facts: true }, jobCtx({ graph: b }));
    assert.deepEqual(asked, { nodes: out, facts: [] });
  });
});
