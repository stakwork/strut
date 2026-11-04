/**
 * Peel's memory on the workspace graph (plans/graph-memory-plan.md step 7):
 * what the generic tools gained to cover memory/remember and memory/forget
 * (`ended`, `said_by`, an all-or-nothing `facts` batch with new nodes and a
 * new temporal edge type, the user never deleted), `graph/duplicates`, the
 * host's `memory: "graph"` switch, and `graph/import-memory` from a
 * database the old memory/* steps wrote. Neo4j keeps refusing `assert`.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GraphBackend, LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { graphView, parseGraphReaders } from "./scope.js";
import { testBackends } from "./test-util.js";
import { defineStep, type StepContext } from "../core.js";
import { buildRegistryTools } from "../steps/core/agent.js";
import type { StepRegistry } from "../steps/registry.js";
import { hostConfigFromEnv } from "../server.js";
import assertStep from "../steps/lib/graph/assert.js";
import createNode from "../steps/lib/graph/create-node.js";
import deleteNode from "../steps/lib/graph/delete-node.js";
import duplicates from "../steps/lib/graph/duplicates.js";
import graphGet from "../steps/lib/graph/graph-get.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import importMemory from "../steps/lib/graph/import-memory.js";
import remember from "../steps/lib/memory/remember.js";
import forget from "../steps/lib/memory/forget.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
// The old memory database loads @ladybugdb/core on its own (steps/lib/memory/_db.ts),
// which can fail where the graph's Ladybug loads; the import suite needs both.
const hasMemoryDb = await import("@ladybugdb/core").then(
  () => true,
  () => false,
);
const neo4j = testBackends().find((b) => b.kind === "neo4j");

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const run = (step: Step, cfg: Record<string, unknown>, ctx: unknown): Promise<any> => step.run(step.input.parse(cfg), ctx);
const ctxOf = (services: object, extra: Record<string, unknown> = {}) =>
  ({ runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services, ...extra }) as unknown as StepContext;

type Edge = { ref_id: string; target: string; text: string; sources: string[]; valid_at: number | null; invalid_at: number | null; expired_at: number | null; namespace: string };
async function edgesOf(b: GraphBackend, edge: string, source: string): Promise<Edge[]> {
  const rows = await b.query(
    `MATCH (s:Node {ref_id: $s})-[r:\`${edge}\`]->(t:Node) RETURN r.ref_id AS ref_id, t.ref_id AS target, r.text AS text, r.sources AS sources,
       r.valid_at AS valid_at, r.invalid_at AS invalid_at, r.expired_at AS expired_at, r.namespace AS namespace ORDER BY r.created_at`,
    { s: source },
  );
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    ref_id: String(r["ref_id"]), target: String(r["target"]), text: String(r["text"]), sources: (r["sources"] as string[] | null) ?? [],
    valid_at: n(r["valid_at"]), invalid_at: n(r["invalid_at"]), expired_at: n(r["expired_at"]), namespace: String(r["namespace"]),
  }));
}
const nodeCount = async (b: GraphBackend) => Number((await b.query("MATCH (n:Node) WHERE n.node_type <> 'Schema' RETURN count(n) AS n"))[0]?.["n"]);

describe("the generic tools cover remember and forget (ladybug)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  let ctx: StepContext;
  let tom: string, kate: string, leeds: string;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
    ctx = ctxOf({ graph: b }, { actor: "agent" });
    await createNodeSchema(b, b.schemas, { type: "Place", attributes: { alt_names: "?list" }, role: "entity" });
    await b.schemas.createEdgeSchema("Person", "LIVES_IN", "Place", { temporal: true, cardinality: "one" });
  });
  after(() => lb.close(b));
  beforeEach(async () => {
    await lb.clear(b);
    [tom, kate, leeds] = (await b.nodes.writeMany([
      { type: "Person", data: { name: "Tom", is_owner: true } },
      { type: "Person", data: { name: "Kate" } },
      { type: "Place", data: { name: "Leeds" } },
    ])).map((r) => r.ref_id) as [string, string, string];
  });

  it("`ended` keeps a fact as past with no end date invented, and ends the same fact held now", async () => {
    const past = await run(assertStep, { source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Kate used to live in Leeds", ended: true }, ctx);
    assert.equal(past.action, "created");
    assert.equal(past.ended, true);
    let [e] = await edgesOf(b, "LIVES_IN", kate);
    assert.ok(e!.expired_at !== null, "not current");
    assert.equal(e!.invalid_at, null, "no end date made up");
    assert.equal(e!.valid_at, null);

    await lb.clear(b);
    const [k, l] = (await b.nodes.writeMany([{ type: "Person", data: { name: "Kate" } }, { type: "Place", data: { name: "Leeds" } }])).map((r) => r.ref_id);
    await run(assertStep, { source_ref_id: k, edge_type: "LIVES_IN", target_ref_id: l, text: "Kate lives in Leeds", valid_at: "2020" }, ctx);
    const out = await run(assertStep, { source_ref_id: k, edge_type: "LIVES_IN", target_ref_id: l, text: "Kate used to live in Leeds", ended: true }, ctx);
    assert.equal(out.action, "reconfirmed");
    assert.equal(out.ended, true);
    [e] = await edgesOf(b, "LIVES_IN", k!);
    assert.ok(e!.expired_at !== null);
    assert.equal(e!.invalid_at, null);
    assert.equal(e!.valid_at, Date.UTC(2020, 0, 1));
  });

  it("`said_by` is kept among the sources, once, and must be a node", async () => {
    const first = await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds", said_by: kate, source: "msg-1" }, ctx);
    assert.equal(first.action, "created");
    assert.deepEqual((await edgesOf(b, "LIVES_IN", tom))[0]!.sources, ["msg-1", kate, "run:r-1"]);
    const again = await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds", said_by: kate, source: "msg-1" }, ctx);
    assert.equal(again.action, "unchanged");
    const third = await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds", said_by: kate, source: "msg-2" }, ctx);
    assert.equal(third.action, "reconfirmed");
    assert.deepEqual((await edgesOf(b, "LIVES_IN", tom))[0]!.sources, ["msg-1", kate, "run:r-1", "msg-2"]);
    const bad = await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds", said_by: "nobody" }, ctx);
    assert.match(String(bad), /MISSING_REQUIRED: .*said_by nobody does not resolve to a node/);
  });

  it("the run is a fact's source with no source passed: the same run again changes nothing, another run re-confirms it", async () => {
    const said = (runId: string) => run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds" }, ctxOf({ graph: b }, { actor: "agent", runId }));
    assert.equal((await said("turn-1")).action, "created");
    assert.deepEqual((await edgesOf(b, "LIVES_IN", tom))[0]!.sources, ["run:turn-1"], "where it was said, though the model passed nothing");
    assert.equal((await said("turn-1")).action, "unchanged");
    assert.equal((await said("turn-2")).action, "reconfirmed", "told again in another turn");
    assert.deepEqual((await edgesOf(b, "LIVES_IN", tom))[0]!.sources, ["run:turn-1", "run:turn-2"]);
  });

  it("`facts` saves new nodes and several facts all or nothing", async () => {
    const before = await nodeCount(b);
    const failed = await run(assertStep, {
      facts: [
        { source_ref_id: kate, edge_type: "LIVES_IN", target_type: "Place", target_data: { name: "Bath" }, text: "Kate lives in Bath" },
        { source_ref_id: tom, edge_type: "LIVES_IN", target_type: "Place", target_data: { name: "Bath" }, text: "Tom lives in Bath", valid_at: "not a date" },
      ],
    }, ctx);
    assert.match(String(failed), /graph\/assert failed — WRONG_TYPE: .*valid_at "not a date" is not a date/);
    assert.equal(await nodeCount(b), before, "Bath was not left behind");
    assert.deepEqual(await edgesOf(b, "LIVES_IN", kate), [], "nor Kate's fact");

    const ok = await run(assertStep, {
      facts: [
        { source_ref_id: kate, edge_type: "LIVES_IN", target_type: "Place", target_data: { name: "Bath" }, text: "Kate lives in Bath" },
        { source_ref_id: tom, edge_type: "LIVES_IN", target_type: "Place", target_data: { name: "Bath" }, text: "Tom lives in Bath" },
      ],
    }, ctx);
    assert.equal(ok.status, "Success");
    assert.deepEqual(ok.facts.map((f: { action: string }) => f.action), ["created", "created"]);
    assert.equal(ok.created_nodes.length, 1, "one Bath for both");
    assert.equal((await edgesOf(b, "LIVES_IN", kate))[0]!.target, ok.created_nodes[0].ref_id);
    assert.equal((await edgesOf(b, "LIVES_IN", tom))[0]!.namespace, "private");
    // Found by its sentence straight after, keyword-only until its vector is filled.
    const found = await run(graphSearch, { q: "Bath", facts: true }, ctx);
    assert.deepEqual(found.facts.map((f: { text: string }) => f.text).sort(), ["Kate lives in Bath", "Tom lives in Bath"]);
  });

  it("`create_schema_if_missing` makes a new edge type temporal, never an existing plain one", async () => {
    const r = await run(assertStep, {
      source_ref_id: kate, edge_type: "knows", target_ref_id: tom, text: "Kate knows Tom", create_schema_if_missing: true,
    }, ctx);
    assert.equal(r.action, "created", JSON.stringify(r));
    assert.equal((await b.schemas.edgeSchema("KNOWS", "Person", "Person"))?.rule.temporal, true);
    const moved = await run(assertStep, {
      source_ref_id: kate, edge_type: "BASED_IN", target_ref_id: leeds, text: "Kate is based in Leeds", create_schema_if_missing: true, cardinality: "one",
    }, ctx);
    assert.equal(moved.action, "created");
    assert.deepEqual((await b.schemas.edgeSchema("BASED_IN", "Person", "Place"))?.rule, { temporal: true, cardinality: "one" });

    await b.schemas.createEdgeSchema("Person", "MENTORS", "Person");
    const plain = await run(assertStep, { source_ref_id: kate, edge_type: "MENTORS", target_ref_id: leeds, text: "Kate mentors in Leeds", create_schema_if_missing: true }, ctx);
    assert.match(String(plain), /MENTORS is a plain edge type/);
    assert.equal(await b.schemas.edgeSchema("MENTORS", "Person", "Place"), null, "nothing made");
    assert.equal((await b.schemas.edgeSchema("MENTORS", "Person", "Person"))?.rule.temporal, undefined, "left plain");
  });

  it("works under a reader list: a scoped caller asserts, makes a temporal type, and finds the user", async () => {
    const scoped = ctxOf({ graph: graphView(b, parseGraphReaders({ jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] } })) }, { actor: "agent" });
    const r = await run(assertStep, {
      facts: [{ source_ref_id: kate, edge_type: "WORKS_WITH", target_type: "Person", target_data: { name: "Sam" }, text: "Kate works with Sam", create_schema_if_missing: true }],
    }, scoped);
    assert.equal(r.status, "Success", JSON.stringify(r));
    // One fact between known nodes, on main refused as a raw query under any list.
    const lone = await run(assertStep, { source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Kate lives in Leeds" }, scoped);
    assert.equal(lone.action, "created", JSON.stringify(lone));
    assert.equal((await run(graphGet, { owner: true }, scoped)).ref_id, tom);
  });

  it("graph/graph-get with owner: true is the user, with no type named", async () => {
    const me = await run(graphGet, { owner: true }, ctx);
    assert.equal(me.ref_id, tom);
    await lb.clear(b);
    assert.match(String(await run(graphGet, { owner: true }, ctx)), /no Person is marked is_owner yet/);
  });

  it("graph/delete-node never deletes the user, and keeps the reason", async () => {
    assert.match(String(await run(deleteNode, { ref_id: tom }, ctx)), /REFUSED: this is the user/);
    assert.ok(await b.reader.getNode(tom));
    const out = await run(deleteNode, { ref_id: kate, reason: "the user asked" }, ctx);
    assert.equal(out.status, "Success");
    const [row] = await b.query("MATCH (n:Node {ref_id: $id}) RETURN n.deleted_reason AS why", { id: kate });
    assert.equal(row!["why"], "the user asked");
  });

  it("graph/duplicates lists the pairs merge would take, strongest first", async () => {
    await b.nodes.writeMany([{ type: "Person", data: { name: "Katie Moss" } }, { type: "Person", data: { name: "Kate Bell" } }]);
    const pairs = await run(duplicates, {}, ctx);
    assert.ok(pairs.length >= 2, JSON.stringify(pairs));
    assert.deepEqual(pairs.map((p: { score: number }) => p.score), [...pairs.map((p: { score: number }) => p.score)].sort((x: number, y: number) => y - x));
    const names = pairs.map((p: { a: { name: string }; b: { name: string } }) => [p.a.name, p.b.name].sort().join(" + "));
    assert.ok(names.includes("Kate + Katie Moss"), names.join("; "));
    assert.ok(names.includes("Kate + Kate Bell"), names.join("; "));
    assert.ok(!names.includes("Kate Bell + Katie Moss"), "surnames clash");
  });
});

describe("graph/import-memory from the old memory database (ladybug)", { skip: lb.skip || (!hasMemoryDb && "@ladybugdb/core is not installed") }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-import-memory-"));
  const secrets = { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? join(dir, "memory", "graph.lbug") : undefined) };
  const old = ctxOf({ secrets });
  let b: LadybugBackend;
  let ctx: StepContext;
  const me = { type: "Self", name: "Me" };
  before(async () => {
    // The old memory, written by its own steps.
    const say = async (input: Record<string, unknown>) => {
      const out = await run(remember as unknown as Step, input, old);
      assert.equal(out.error, undefined, JSON.stringify(out));
      return out;
    };
    await say({ episode: "My name is Alex Rivera.", facts: [{ subject: me, predicate: "name", text: "The user's name is Alex Rivera.", object: { type: "Person", name: "Alex Rivera" } }] });
    await say({ episode: "I live in London.", facts: [{ subject: me, predicate: "lives_in", object: { type: "Place", name: "London" }, text: "The user lives in London." }] });
    await say({ episode: "We moved to Bristol in 2026.", facts: [{ subject: me, predicate: "lives_in", object: { type: "Place", name: "Bristol" }, text: "The user moved to Bristol.", valid_at: "2026" }] });
    await say({ episode: "I used to work at Northwind.", facts: [{ subject: me, predicate: "works_at", object: { type: "Organization", name: "Northwind" }, text: "The user worked at Northwind.", ended: true }] });
    await say({ episode: "Kate's real name is Katherine Moss.", facts: [{ subject: { type: "Person", name: "Kate" }, predicate: "name", object: { type: "Person", name: "Katherine Moss" }, text: "Kate's full name is Katherine Moss." }] });
    await say({ episode: "I moved to Bath!", source: "msg-42", speaker: { type: "Person", name: "Kate" },
      facts: [{ subject: { type: "Person", name: "Kate" }, predicate: "lives_in", object: { type: "Place", name: "Bath" }, text: "Kate moved to Bath." }] });
    await say({ episode: "Alex knows Kate from uni, Kate says.", speaker: { type: "Person", name: "Kate" },
      facts: [{ subject: me, predicate: "knows", object: { type: "Person", name: "Kate" }, text: "The user has known Kate since university." }] });
    await say({ episode: "I'm vegetarian.", facts: [{ subject: me, predicate: "diet", text: "The user is vegetarian." }] });
    await say({ episode: "Peel says 'peal'.", facts: [{ subject: { type: "Project", name: "Peel" }, predicate: "heard_as", value: "peal", text: "Dictation writes Peel as peal." }] });
    await say({ episode: "Kate's coming over on Sunday.", mentions: [{ type: "Person", name: "Kate" }] });
    const gone = await say({ episode: "Bob is a plumber.", mentions: [{ type: "Person", name: "Bob" }] });
    await run(forget as unknown as Step, { ref_id: gone.entities[0].ref_id, reason: "wrong" }, old);

    b = (await lb.open()) as LadybugBackend;
    // As a step run sees the graph on Peel, with the note's lists: as a job.
    ctx = ctxOf({ graph: graphView(b, parseGraphReaders({ jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] } })), secrets }, { actor: "import" });
  });
  after(async () => {
    await lb.close(b);
    rmSync(dir, { recursive: true, force: true });
  });

  let first: any;
  it("imports entities as nodes, the user as the is_owner Person, all in private, read as a job", async () => {
    first = await run(importMemory, {}, ctx);
    assert.equal(first.status, "Success", JSON.stringify(first));
    const people = await b.query("MATCH (n:Node {node_type: 'Person'}) WHERE n.deleted_at IS NULL RETURN n.ref_id AS id, n.title AS title, n.is_owner AS owner, n.alt_names AS alts, n.namespace AS ns ORDER BY n.title");
    assert.deepEqual(people.map((p) => p["title"]), ["Alex Rivera", "Kate"], "Bob was forgotten; a name is no entity");
    const alex = people.find((p) => p["title"] === "Alex Rivera")!;
    assert.equal(alex["owner"], true);
    assert.ok((alex["alts"] as string[]).includes("Me"));
    assert.deepEqual(people.find((p) => p["title"] === "Kate")!["alts"], ["Katherine Moss"], "one spelling, as written");
    const all = await b.query("MATCH (n:Node) WHERE n.node_type IN ['Person', 'Place', 'Organization', 'Project'] RETURN DISTINCT n.namespace AS ns");
    assert.deepEqual(all.map((r) => r["ns"]), ["private"]);
    assert.ok(await b.schemas.schema("Place"), "the old types are made");
  });

  it("imports linked facts through assert: world times, ended and superseded history, sources and speaker", async () => {
    const [alex] = (await b.query("MATCH (n:Node {node_type: 'Person'}) WHERE n.is_owner = true RETURN n.ref_id AS id")).map((r) => String(r["id"]));
    const [kate] = (await b.query("MATCH (n:Node {node_type: 'Person', title: 'Kate'}) RETURN n.ref_id AS id")).map((r) => String(r["id"]));
    const title = async (id: string) => String((await b.reader.getNode(id))!.title);

    const lives = await edgesOf(b, "LIVES_IN", alex!);
    const current = lives.filter((e) => e.expired_at === null);
    assert.deepEqual(await Promise.all(current.map((e) => title(e.target))), ["Bristol"]);
    assert.equal(current[0]!.valid_at, Date.UTC(2026, 0, 1));
    const london = lives.find((e) => e.expired_at !== null)!;
    assert.equal(await title(london.target), "London", "the superseded home is history");
    assert.equal(london.invalid_at, Date.UTC(2026, 0, 1), "ended when Bristol began, as the old memory said");
    assert.equal((await b.schemas.edgeSchema("LIVES_IN", "Person", "Place"))?.rule.cardinality, "one");

    const [northwind] = await edgesOf(b, "WORKS_AT", alex!);
    assert.ok(northwind!.expired_at !== null, "used to: past");
    assert.equal(northwind!.invalid_at, null, "no end date invented");

    const [bath] = await edgesOf(b, "LIVES_IN", kate!);
    assert.deepEqual(bath!.sources, ["msg-42", kate], "the message, and Kate said it");
    const [knows] = await edgesOf(b, "KNOWS", alex!);
    assert.ok(knows!.sources.includes(kate!), "about the user, said by Kate");
  });

  it("lists what has no faithful place for review, and counts what it skipped", async () => {
    const kinds = first.review.map((r: { kind: string; text?: string }) => `${r.kind}: ${r.text}`);
    assert.ok(kinds.includes("fact: The user is vegetarian."), kinds.join("\n"));
    assert.ok(kinds.includes("episode: Kate's coming over on Sunday."), kinds.join("\n"));
    assert.equal(first.for_review, first.review.length);
    assert.equal(first.skipped_by_reason["a mishearing: dictation keeps reading it from the old memory"], 1);
    assert.ok(first.imported > 0);
  });

  it("is safe to run again, under a reader list too: nothing new, nothing doubled", async () => {
    const snapshot = async () => [
      await nodeCount(b),
      Number((await b.query("MATCH ()-[r]->() RETURN count(r) AS n"))[0]?.["n"]),
      JSON.stringify(await b.query("MATCH (s:Node)-[r:LIVES_IN]->(t:Node) RETURN s.title AS st, t.title AS tt, r.sources AS src, r.expired_at IS NULL AS cur ORDER BY st, tt")),
    ];
    const was = await snapshot();
    // As a step run sees the graph on a host with reader lists: as a job.
    const asJob = ctxOf({ graph: graphView(b, parseGraphReaders({ jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] } })), secrets }, { actor: "import" });
    const again = await run(importMemory, {}, asJob);
    assert.equal(again.imported, 0, JSON.stringify(again));
    assert.equal(again.for_review, first.for_review);
    assert.deepEqual(await snapshot(), was);
  });

  it("with no old database there is nothing to import", async () => {
    const none = await run(importMemory, {}, ctxOf({ graph: b, secrets: { get: async () => join(dir, "nowhere.lbug") } }));
    assert.equal(none.status, "Warning");
    assert.equal(none.imported, 0);
  });
});

describe('the host\'s memory switch (`memory: "graph"`)', () => {
  const echo = (type: string) => defineStep({ type, description: type, input: z.object({}), output: z.any(), async run() { return "ok"; } });
  const registry = { "memory/recall": echo("memory/recall"), "graph/graph-search": echo("graph/graph-search") } as unknown as StepRegistry;
  const fakeTool = (def: unknown) => def;

  it("leaves the old memory/* steps out of an agent's tools, and only then", () => {
    const names = ["memory/*", "graph/graph-search"];
    assert.deepEqual(Object.keys(buildRegistryTools(names, registry, ctxOf({ memory: "graph" }), fakeTool)), ["graph_graph_search"]);
    assert.deepEqual(Object.keys(buildRegistryTools(names, registry, ctxOf({}), fakeTool)).sort(), ["graph_graph_search", "memory_recall"]);
  });

  it("adds the Ladybug-only wording to a tool's description on a Ladybug graph, and only there", () => {
    const real = { "graph/delete-node": deleteNode, "graph/graph-get": graphGet, "graph/graph-search": graphSearch, "graph/create-node": createNode } as unknown as StepRegistry;
    const names = Object.keys(real);
    const describedOn = (graph: unknown) =>
      Object.values(buildRegistryTools(names, real, ctxOf(graph ? { graph } : {}), fakeTool) as Record<string, { description: string }>).map((t) => t.description);
    for (const [i, d] of describedOn({ kind: "neo4j" }).entries()) {
      assert.equal(d, real[names[i]!]!.description, "a Neo4j graph sees the description alone");
      assert.doesNotMatch(d, /is_owner|graph_assert|graph\/assert|Personal|sources/);
    }
    assert.deepEqual(describedOn(undefined), describedOn({ kind: "neo4j" }), "no wired graph is the same");
    for (const [i, d] of describedOn({ kind: "ladybug" }).entries()) {
      const def = real[names[i]!]!;
      assert.ok(def.graphNotes?.ladybug, `${def.type} has a Ladybug note`);
      assert.equal(d, `${def.description} ${def.graphNotes.ladybug}`);
    }
  });

  it("is read from STRUT_HOST_CONFIG, graph or legacy only, with concepts beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-host-memory-"));
    try {
      const file = join(dir, "host.json");
      writeFileSync(file, JSON.stringify({ memory: "graph" }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { memory: "graph" });
      writeFileSync(file, JSON.stringify({ memory: "neo4j" }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"memory" must be "graph" or "legacy"/);
      // The Personal root, for a host whose graph is one person's.
      writeFileSync(file, JSON.stringify({ memory: "graph", concepts: { personal: true } }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { memory: "graph", concepts: { personal: true } });
      writeFileSync(file, JSON.stringify({ concepts: { personal: "yes" } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"concepts" must be false or/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("graph/assert on neo4j", { skip: !neo4j || neo4j.skip }, () => {
  let b: GraphBackend;
  before(async () => {
    b = await neo4j!.open();
  });
  after(() => neo4j!.close(b));

  it("refuses a batch, creating nothing", async () => {
    await neo4j!.wipe(b);
    const before = Number((await b.query("MATCH (n) RETURN count(n) AS n"))[0]?.["n"]);
    const out = await run(assertStep, {
      facts: [{ source_type: "Thing", source_data: { name: "a" }, edge_type: "KNOWS", target_type: "Thing", target_data: { name: "b" }, text: "a knows b", create_schema_if_missing: true }],
    }, ctxOf({ graph: b }));
    assert.match(String(out), /works on a LadybugDB graph only/);
    assert.equal(Number((await b.query("MATCH (n) RETURN count(n) AS n"))[0]?.["n"]), before);
  });
});
