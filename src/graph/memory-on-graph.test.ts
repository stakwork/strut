/**
 * Peel's memory on the workspace graph (plans/graph-memory-plan.md step 7):
 * what the generic tools gained to cover memory/remember and memory/forget
 * (`ended`, `said_by`, an all-or-nothing `facts` batch with new nodes and a
 * new temporal edge type, the user never deleted), `graph/duplicates`, the
 * host config's `memory` kept as a no-op, and `graph/import-memory` from a
 * database the old memory/* steps wrote (fixtures/old-memory.json, dumped
 * from one they wrote). Neo4j keeps refusing `assert`.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphBackend, LadybugBackend } from "./backend.js";
import { createNodeSchema } from "./schema-crud.js";
import { graphView, parseGraphReaders } from "./scope.js";
import { testBackends } from "./test-util.js";
import type { StepContext } from "../core.js";
import { buildRegistryTools } from "../steps/core/agent.js";
import type { StepRegistry } from "../steps/registry.js";
import { hostConfigFromEnv } from "../server.js";
import assertStep from "../steps/lib/graph/assert.js";
import createNode from "../steps/lib/graph/create-node.js";
import deleteNode from "../steps/lib/graph/delete-node.js";
import deleteEdge from "../steps/lib/graph/delete-edge.js";
import restoreNode from "../steps/lib/graph/restore-node.js";
import duplicates from "../steps/lib/graph/duplicates.js";
import graphGet from "../steps/lib/graph/graph-get.js";
import graphSearch from "../steps/lib/graph/graph-search.js";
import importMemory, { restates, spelledIn } from "../steps/lib/graph/import-memory.js";
import { assertEdge } from "./temporal.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const neo4j = testBackends().find((b) => b.kind === "neo4j");

type Step = { input: { parse(v: unknown): unknown }; run: (cfg: any, ctx: any) => Promise<unknown> };
const run = (step: Step, cfg: Record<string, unknown>, ctx: unknown): Promise<any> => step.run(step.input.parse(cfg), ctx);
const ctxOf = (services: object, extra: Record<string, unknown> = {}) =>
  ({ runId: "r-1", path: "t/s", workflow: "t", scope: {}, input: undefined, emit: async () => {}, services, ...extra }) as unknown as StepContext;

type Edge = { ref_id: string; target: string; text: string; sources: string[]; valid_at: number | null; invalid_at: number | null; expired_at: number | null; namespace: string };
async function edgesOf(b: GraphBackend, edge: string, source: string): Promise<Edge[]> {
  const rows = await b.query(
    `MATCH (s:Node {ref_id: $s})-[r:\`${edge}\`]->(t:Node) WHERE r.deleted_at IS NULL RETURN r.ref_id AS ref_id, t.ref_id AS target, r.text AS text, r.sources AS sources,
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

  it("never files a node as Thing: no node, no edge type, from any tool that creates one", async () => {
    const count = async () => Number((await b.query("MATCH (n:Node) WHERE n.node_type = 'Thing' RETURN count(n) AS n"))[0]?.["n"]);
    const fact = await run(assertStep, {
      source_ref_id: kate, edge_type: "LIKES", target_type: "Thing", target_data: { name: "Tea" }, text: "Kate likes tea", create_schema_if_missing: true,
    }, ctx);
    assert.match(String(fact), /ontology's root, never a node's type/);
    assert.equal(await b.schemas.edgeSchema("LIKES", "Person", "Thing"), null, "no edge type against the root");
    for (const node_type of ["Thing", "thing"]) {
      assert.match(String(await run(createNode, { node_type, node_data: { name: "Tea" } }, ctx)), /ontology's root, never a node's type/, node_type);
    }
    await assert.rejects(b.nodes.write({ type: "Thing", data: { name: "Tea" } }), /ontology's root/);
    await assert.rejects(b.schemas.createEdgeSchema("Thing", "LIKES", "Person", { temporal: true }), /ontology's root/);
    assert.equal(await count(), 0);
  });

  it("a new end named like an entity of another type is refused, naming it; nothing is written", async () => {
    await createNodeSchema(b, b.schemas, { type: "Topic", attributes: {}, role: "entity" });
    const football = (await b.nodes.write({ type: "Topic", data: { name: "5-a-side football" } })).ref_id;
    const before = await nodeCount(b);
    const out = await run(assertStep, {
      facts: [
        { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds" },
        { source_ref_id: tom, edge_type: "PLAYS", target_type: "Place", target_data: { name: "5-A-Side Football" }, text: "Tom plays 5-a-side football on Saturdays", create_schema_if_missing: true },
      ],
    }, ctx);
    assert.match(String(out), new RegExp(`facts\\[1\\]: "5-A-Side Football" already exists as Topic ${football}: pass target_ref_id`));
    assert.equal(await nodeCount(b), before, "nothing written");
    assert.equal(await b.schemas.edgeSchema("PLAYS", "Person", "Place"), null);
    const same = await run(assertStep, { source_ref_id: tom, edge_type: "PLAYS", target_type: "Topic", target_data: { name: "5-a-side football" }, text: "Tom plays 5-a-side football", create_schema_if_missing: true }, ctx);
    assert.equal(same.target_ref_id, football, "the same type is the same node");
  });

  it("`replaces` ends the fact a correction replaces, superseded by the new one; a refuted fact replaces nothing", async () => {
    await b.schemas.createEdgeSchema("Person", "VISITS", "Place", { temporal: true, cardinality: "many", volatility: "evolving" });
    const lisbon = (await b.nodes.write({ type: "Place", data: { name: "Lisbon" } })).ref_id;
    const old = await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds" }, ctx);
    const fix = await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: lisbon, text: "Tom visits Lisbon", replaces: old.edge_ref_id }, ctx);
    assert.equal(fix.action, "created", JSON.stringify(fix));
    assert.equal(fix.replaced, old.edge_ref_id);
    const [was] = await b.query("MATCH ()-[r:VISITS {ref_id: $id}]->() RETURN r.expired_at AS ended, r.superseded_by AS by", { id: old.edge_ref_id });
    assert.ok(was?.["ended"] !== null);
    assert.equal(was?.["by"], fix.edge_ref_id);
    assert.match(String(await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds", refuted: true, replaces: fix.edge_ref_id }, ctx)), /a refuted fact replaces nothing/);
    assert.match(String(await run(assertStep, { source_ref_id: kate, edge_type: "VISITS", target_ref_id: leeds, text: "Kate visits Leeds", replaces: fix.edge_ref_id }, ctx)), /a fact about another subject/);
    assert.match(String(await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds", replaces: "nope" }, ctx)), /no such fact/);
  });

  it("a refutation is of the fact it was said about: a new fact on the same two nodes is not read as refuted", async () => {
    await b.schemas.createEdgeSchema("Person", "VISITS", "Place", { temporal: true, cardinality: "many", volatility: "evolving" });
    await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds on Mondays" }, ctx);
    await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds on Mondays", refuted: true }, ctx);
    const now = await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds on Fridays" }, ctx);
    assert.equal(now.action, "created", JSON.stringify(now));
    const found = await run(graphSearch, { q: "Tom visits Leeds", facts: true }, ctx);
    const fact = (found.facts as Array<{ ref_id: string; status?: string }>).find((f) => f.ref_id === now.edge_ref_id);
    assert.ok(fact, JSON.stringify(found.facts));
    assert.notEqual(fact.status, "refuted", JSON.stringify(fact));
  });

  it("a fact joining two nodes that hold other current facts lists them; a re-confirm with another sentence says so", async () => {
    await b.schemas.createEdgeSchema("Person", "VISITS", "Place", { temporal: true, cardinality: "many", volatility: "evolving" });
    const first = await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds every Monday" }, ctx);
    assert.equal(first.between, undefined);
    const other = await run(assertStep, { source_ref_id: tom, edge_type: "TRAINS_IN", target_ref_id: leeds, text: "Tom trains in Leeds on Saturdays", create_schema_if_missing: true }, ctx);
    assert.deepEqual(other.between, [{ ref_id: first.edge_ref_id, edge_type: "VISITS", text: "Tom visits Leeds every Monday" }]);
    assert.ok(other.notes.some((n: string) => /ask whether this corrects one of them/.test(n)));
    const again = await run(assertStep, { source_ref_id: tom, edge_type: "VISITS", target_ref_id: leeds, text: "Tom visits Leeds on Saturday mornings" }, ctxOf({ graph: b }, { actor: "agent", runId: "r-2" }));
    assert.equal(again.action, "reconfirmed");
    assert.equal(again.held_text, "Tom visits Leeds every Monday");
    assert.ok(again.notes.some((n: string) => /another sentence/.test(n)));
  });

  it("a fact on an edge type with no volatility says so, until one is given", async () => {
    const r = await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds" }, ctx);
    assert.ok(r.notes.some((n: string) => /LIVES_IN has no volatility/.test(n)), JSON.stringify(r));
    const kept = await run(assertStep, { source_ref_id: kate, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Kate lives in Leeds", volatility: "stable" }, ctx);
    assert.equal(kept.notes, undefined, JSON.stringify(kept));
  });

  it("the evidence keeps the person's words, and the session and turn beside the run", async () => {
    const turnCtx = ctxOf({ graph: b }, { actor: "agent", agentTurn: { session: "chat-1", turn: 3 } });
    await run(assertStep, { source_ref_id: tom, edge_type: "LIVES_IN", target_ref_id: leeds, text: "Tom lives in Leeds", words: "I'm in Leeds these days" }, turnCtx);
    const [ev] = await b.query("MATCH (:Node {node_type: 'Claim'})-[r:EVIDENCED_BY]->(e:Node {node_type: 'Evidence'}) RETURN e.content AS content, r.context AS context");
    assert.equal(ev?.["content"], "I'm in Leeds these days");
    assert.deepEqual(JSON.parse(String(ev?.["context"])), { run: "r-1", session: "chat-1", turn: 3 });
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

/** Writes the old memory database `fixtures/old-memory.json` holds at
 *  `path` (scripts/write-old-memory.ts), in a process of its own: Ladybug
 *  finishes writing a closed file later, so a file this process opened
 *  could change under the test that says nothing here writes it. */
function writeOldMemory(path: string): void {
  const out = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")), fileURLToPath(new URL("../../scripts/write-old-memory.ts", import.meta.url)), path], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
}

describe("graph/import-memory from the old memory database (ladybug)", { skip: lb.skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "strut-import-memory-"));
  const oldFile = join(dir, "memory", "graph.lbug");
  const secrets = { get: async (n: string) => (n === "STRUT_MEMORY_DB" ? oldFile : undefined) };
  let b: LadybugBackend;
  let ctx: StepContext;
  let oldBytes: Buffer;
  before(async () => {
    writeOldMemory(oldFile);
    oldBytes = readFileSync(oldFile);
    b = (await lb.open()) as LadybugBackend;
    // As a step run sees the graph on Peel, with the note's lists: as a job.
    ctx = ctxOf({ graph: graphView(b, parseGraphReaders({ jobs: { namespaces: ["private", "shared"], exclude_domains: ["Strut"] } })), secrets }, { actor: "import" });
  });
  after(async () => {
    await lb.close(b);
    rmSync(dir, { recursive: true, force: true });
  });

  let first: any;
  let started = 0;
  it("imports entities as nodes, the user as the is_owner Person, all in private, read as a job", async () => {
    started = Date.now();
    first = await run(importMemory, {}, ctx);
    assert.equal(first.status, "Success", JSON.stringify(first));
    const people = await b.query("MATCH (n:Node {node_type: 'Person'}) WHERE n.deleted_at IS NULL RETURN n.ref_id AS id, n.title AS title, n.is_owner AS owner, n.alt_names AS alts, n.namespace AS ns ORDER BY n.title");
    assert.deepEqual(people.map((p) => p["title"]), ["Alex Rivera", "Alex's uncle", "Kate", "Sam"], "Bob was forgotten; a name is no entity");
    const alex = people.find((p) => p["title"] === "Alex Rivera")!;
    assert.equal(alex["owner"], true);
    assert.ok(!((alex["alts"] as string[] | null) ?? []).some((a) => a.toLowerCase() === "me"), "the old memory's \"Me\" is no name of theirs");
    const sam = people.find((p) => p["title"] === "Sam")!;
    assert.equal(sam["alts"], null, "a sentence is no name");
    assert.equal((await b.reader.getNode(String(sam["id"])))!.properties["description"], "Sam, also called Sammy J, is a teammate who shows up in the tribes.");
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

  it("keeps when the old memory learned each node and fact", async () => {
    const [kate] = await b.query("MATCH (n:Node {node_type: 'Person', title: 'Kate'}) RETURN n.ref_id AS id, n.created_at AS at");
    assert.ok(Number(kate!["at"]) < started, "Kate is as old as the old memory says");
    const [bath] = await edgesOf(b, "LIVES_IN", String(kate!["id"]));
    const [row] = await b.query("MATCH ()-[x:LIVES_IN]->() WHERE x.ref_id = $id RETURN x.created_at AS at", { id: bath!.ref_id });
    assert.ok(Number(row!["at"]) < started, "and so is what it knew of her");
  });

  it("drops what has no place on the graph, and counts it by reason", async () => {
    const by = first.skipped_by_reason;
    assert.equal(by["a fact about one entity alone"], 1, JSON.stringify(by));
    assert.equal(by["an episode no fact came from"], 2, "Kate coming over, and Bob, forgotten");
    assert.equal(by["a fact whose sentence only names its two ends"], 1, JSON.stringify(by));
    assert.equal(Object.keys(by).some((r) => /mishearing/.test(r)), false, "a mishearing is migrated");
    const heard = await b.query("MATCH (h:Node {node_type: 'Mishearing'}), (p:Node {title: 'Peel'}) WHERE h.entity_ref_id = p.ref_id RETURN h.value AS v");
    assert.deepEqual(heard.map((r) => r["v"]), ["peal"], "onto Peel, as dictation reads it on the graph");
    assert.equal(first.review, undefined, "nothing is listed for review");
    assert.equal(first.skipped, Object.values(by as Record<string, number>).reduce((a, n) => a + n, 0));
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
    assert.equal(again.skipped, first.skipped);
    assert.deepEqual(await snapshot(), was);
  });

  it("run again, repairs what an earlier import wrote and this one would not", async () => {
    const [alex] = (await b.query("MATCH (n:Node {node_type: 'Person'}) WHERE n.is_owner = true RETURN n.ref_id AS id")).map((r) => String(r["id"]));
    const [sam] = (await b.query("MATCH (n:Node {node_type: 'Person', title: 'Sam'}) RETURN n.ref_id AS id")).map((r) => String(r["id"]));
    const [uncle] = (await b.query("MATCH (n:Node {node_type: 'Person', title: \"Alex's uncle\"}) RETURN n.ref_id AS id")).map((r) => String(r["id"]));
    // As the earlier import left them: "Me" and part of a sentence as names, no description, the empty fact written.
    await b.nodes.update(alex!, { set: { alt_names: ["Me", "Al"] } });
    await b.nodes.update(sam!, { set: { alt_names: ["Sammy J, is a teammate who shows up in the tribes"], description: null } });
    if (!(await b.schemas.edgeSchema("UNCLE_OF", "Person", "Person"))) await b.schemas.createEdgeSchema("Person", "UNCLE_OF", "Person", { temporal: true, cardinality: "many" });
    await assertEdge(b, b.schemas, { edge: "UNCLE_OF", source_ref_id: uncle!, target_ref_id: alex!, text: "Alex's uncle is Alex's uncle.", source: "memory/episode:old" });
    await b.query("MATCH (n:Node) WHERE n.ref_id = $id SET n.created_at = $at RETURN n.ref_id", { id: sam!, at: Date.now() + 1000 });

    const again = await run(importMemory, {}, ctx);
    assert.equal(again.status, "Success", JSON.stringify(again));
    assert.ok(again.counts.repaired >= 4, JSON.stringify(again.counts));
    assert.deepEqual((await b.reader.getNode(alex!))!.properties["alt_names"], ["Al"], "a name the user was given stays");
    const s = (await b.reader.getNode(sam!))!.properties;
    assert.deepEqual(s["alt_names"], []);
    assert.equal(s["description"], "Sam, also called Sammy J, is a teammate who shows up in the tribes.");
    const [dated] = await b.query("MATCH (n:Node) WHERE n.ref_id = $id RETURN n.created_at AS at", { id: sam! });
    assert.ok(Number(dated!["at"]) < started, "dated back to the old memory");
    assert.deepEqual(await edgesOf(b, "UNCLE_OF", uncle!), []);
  });

  it("finds names as their sentences spell them, and sentences that only name their ends", () => {
    assert.equal(spelledIn("Tom's wife is Kate O’Brien.", "kate o’brien"), "Kate O’Brien");
    assert.equal(spelledIn("The user's name is Tom.", "me"), undefined, "a whole word, not part of one");
    assert.equal(spelledIn("Je m'appelle Zoë Durand.", "zoe durand"), "Zoë Durand");
    assert.equal(restates("Tom's uncle is Tom's uncle.", ["Tom's uncle", "Tom", "Me"]), true);
    assert.equal(restates("Kate is from Leicester.", ["Kate", "Leicester"]), false);
    assert.equal(restates("凯特住在伦敦。", ["凯特", "伦敦"]), false, "unsplit text is never said to restate");
  });

  it("never changes the old database: it reads a copy", () => {
    const now = readFileSync(oldFile);
    assert.ok(now.equals(oldBytes));
  });

  it("with no old database there is nothing to import", async () => {
    const none = await run(importMemory, {}, ctxOf({ graph: b, secrets: { get: async () => join(dir, "nowhere.lbug") } }));
    assert.equal(none.status, "Warning");
    assert.equal(none.imported, 0);
  });
});

describe("agent tools on the graph", () => {
  const fakeTool = (def: unknown) => def;

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
      assert.equal(d, `${def.graphNotes.ladybugDescription ?? def.description} ${def.graphNotes.ladybug}`);
    }
  });

  it("what only a Ladybug graph has stays out of a Neo4j agent's tools: the step, its fields, its wording", () => {
    const real = { "graph/delete-node": deleteNode, "graph/delete-edge": deleteEdge, "graph/graph-search": graphSearch, "graph/restore-node": restoreNode } as unknown as StepRegistry;
    type Built = Record<string, { description: string; inputSchema: { shape: Record<string, unknown> } }>;
    const on = (kind: string) => buildRegistryTools(["graph/*"], real, ctxOf({ graph: { kind } }), fakeTool) as Built;
    const neo = on("neo4j");
    assert.deepEqual(Object.keys(neo).sort(), ["graph_delete_edge", "graph_delete_node", "graph_graph_search"], "no restore: a Neo4j delete takes the edges");
    assert.ok(!("include_deleted" in neo["graph_graph_search"]!.inputSchema.shape));
    assert.equal(neo["graph_delete_edge"]!.description, deleteEdge.description, "the description as before");
    assert.equal(neo["graph_delete_node"]!.description, deleteNode.description);
    assert.match(deleteEdge.description!, /removed for good, never hidden/);
    const lb = on("ladybug");
    assert.ok("graph_restore_node" in lb);
    assert.ok("include_deleted" in lb["graph_graph_search"]!.inputSchema.shape);
    assert.match(lb["graph_delete_edge"]!.description, /hidden, never erased/);
    assert.doesNotMatch(lb["graph_delete_edge"]!.description, /removed for good/, "never both");
  });

  it("a host config's `memory` is accepted and ignored; concepts are read beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-host-memory-"));
    try {
      const file = join(dir, "host.json");
      writeFileSync(file, JSON.stringify({ memory: "graph" }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), {}, "an older Peel's config still starts");
      writeFileSync(file, JSON.stringify({ memory: "legacy" }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), {});
      // The Personal root, for a host whose graph is one person's.
      writeFileSync(file, JSON.stringify({ memory: "graph", concepts: { personal: true } }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { concepts: { personal: true } });
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
