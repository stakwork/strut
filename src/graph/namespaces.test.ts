/**
 * Namespaces and `created_by` on a Ladybug file (plans/graph-memory-plan.md
 * step 2; `ladybug/namespaces.ts`): a write with none goes to `private`,
 * the same key in two namespaces is two nodes, an edge is in one
 * namespace, Strut's records live in their writer's like anything else,
 * the Schema rows are file-wide, and the writer stamps who wrote a node or
 * edge. Neo4j keeps jarvis's namespaces and stores no new core stamps,
 * which the last suite checks.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraphBackend, type LadybugBackend } from "./backend.js";
import { GraphValidationError } from "./node-writer.js";
import { ladybugConfigFromEnv } from "./wiring.js";
import { rawNode, testBackends } from "./test-util.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;
const neo4j = testBackends().find((b) => b.kind === "neo4j");

const refused = (code: string, attribute?: string) => (e: unknown) => e instanceof GraphValidationError && e.code === code && (attribute === undefined || e.attribute === attribute);

const RUN = { run_id: "1725220000123", workflow_name: "lighthouse-keeper", run_status: "success", summary: "lit the lighthouse lamp", started_at: 1 };

describe("namespaces on a ladybug file (plans/graph-memory-plan.md step 2)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  before(async () => {
    b = (await lb.open()) as LadybugBackend;
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
  });

  const nsOf = async (ref_id: string) => (await rawNode(b, ref_id))!.props["namespace"];
  const edgeRow = async (ref_id: string) =>
    (await b.query(`MATCH ()-[r {ref_id: $id}]->() RETURN r.namespace AS ns, r.created_by AS by, r.created_at AS created, r.updated_at AS updated`, { id: ref_id }))[0]!;
  const concept = (name: string) => ({ type: "Concept", data: { name } });

  it("a write with no namespace goes to private, Strut's records too; the Schema rows hold none", async () => {
    assert.equal(b.namespace, "private");
    const c = await b.nodes.write(concept("Lighthouse"));
    assert.equal(await nsOf(c.ref_id), "private");
    const run = await b.nodes.write({ type: "StrutRun", data: RUN });
    assert.equal(await nsOf(run.ref_id), "private");
    const shared = await b.nodes.write({ type: "StrutWorkflow", data: { name: "harvey-deliver" } }, "create", { namespace: "shared" });
    assert.equal(await nsOf(shared.ref_id), "shared", "a Strut record lives in its writer's namespace");
    const scoped = await b.query(`MATCH (n:Node {node_type: 'Schema'}) WHERE n.namespace IS NOT NULL RETURN count(n) AS c`);
    assert.equal(scoped[0]!["c"], 0, "every Schema row, the seed's and the wildcard");
    // `system` is an ordinary name; a malformed one is refused.
    assert.equal(await nsOf((await b.nodes.write(concept("Lighthouse"), "create", { namespace: "system" })).ref_id), "system");
    await assert.rejects(b.nodes.write(concept("Lighthouse"), "create", { namespace: "Two Words" }), refused("UNKNOWN_ATTRIBUTE", "namespace"));
  });

  it("the same key in two namespaces gives two nodes; each upserts and deletes in its own", async () => {
    const mine = await b.nodes.write(concept("Lighthouse"));
    const ours = await b.nodes.write(concept("Lighthouse"), "create", { namespace: "shared" });
    assert.notEqual(mine.ref_id, ours.ref_id);
    assert.equal(mine.key, ours.key);
    assert.deepEqual([await nsOf(mine.ref_id), await nsOf(ours.ref_id)], ["private", "shared"]);
    const again = await b.nodes.write({ type: "Concept", data: { name: "lighthouse", description: "the shared one" } }, "upsert", { namespace: "SHARED" });
    assert.deepEqual([again.ref_id, again.outcome], [ours.ref_id, "updated"]);
    assert.equal((await rawNode(b, mine.ref_id))!.props["description"], undefined, "the private one untouched");
    const old = await b.nodes.write(concept("Lighthouse"), "create", { namespace: "default" });
    assert.deepEqual([old.ref_id, old.outcome], [mine.ref_id, "existing"], "default is the backend's own");
    // A key or name lookup reads the namespace asked for.
    assert.equal((await b.reader.getNodeByKey("Concept", mine.key))!.ref_id, mine.ref_id);
    assert.equal((await b.reader.getNodeByKey("Concept", mine.key, "shared"))!.ref_id, ours.ref_id);
    assert.equal(await b.reader.getNodeByKey("Concept", mine.key, "elsewhere"), null);
    assert.deepEqual((await b.reader.namesLike("Concept", "light", 8, "shared")).map((h) => h.ref_id), [ours.ref_id]);
    assert.deepEqual(await b.reader.listNamespaces(), ["shared"]);
    assert.equal(await b.nodes.deleteNode(ours.ref_id), null, "not in private");
    assert.deepEqual(await b.nodes.deleteNode(ours.ref_id, { namespace: "shared" }), { edges: 0 });
  });

  it("a type resolves file-wide: a write into any namespace uses the one Schema row", async () => {
    const rows = await b.query(`MATCH (n:Node {node_type: 'Schema', type: 'Concept'}) RETURN count(n) AS c`);
    assert.equal(rows[0]!["c"], 1);
    for (const ns of ["shared", "team-a"]) assert.equal((await b.nodes.write(concept("Harbour"), "create", { namespace: ns })).node_type, "Concept");
    assert.equal((await b.reader.getSchema("concept"))!.type, "Concept");
  });

  it("a duplicate identifier is refused within a namespace, not across two", async () => {
    await b.nodes.write({ type: "Person", data: { name: "Sam", email: "sam@example.com" } });
    await assert.rejects(b.nodes.write({ type: "Person", data: { name: "Samuel", email: "sam@example.com" } }), refused("DUPLICATE_KEY", "email"));
    const shared = await b.nodes.write({ type: "Person", data: { name: "Sam", email: "sam@example.com" } }, "create", { namespace: "shared" });
    assert.equal(await nsOf(shared.ref_id), "shared");
  });

  it("an edge is in one namespace: the one the write names, else its source's; with its author and times", async () => {
    const a = await b.nodes.write(concept("Ships"));
    const c = await b.nodes.write(concept("Lighthouse"));
    const e = await b.edges.write({ edge: "CHILD_OF", source_ref_id: c.ref_id, target_ref_id: a.ref_id, created_by: "assistant" });
    const row = await edgeRow(e.ref_id);
    assert.deepEqual([row["ns"], row["by"]], ["private", "assistant"]);
    assert.equal(row["updated"], row["created"]);
    const ours = await b.nodes.write(concept("Harbour"), "create", { namespace: "shared" });
    const cross = await b.edges.write({ edge: "CHILD_OF", source_ref_id: ours.ref_id, target_ref_id: a.ref_id });
    assert.equal((await edgeRow(cross.ref_id))["ns"], "shared", "a shared node's edge into private is shared's");
    const named = await b.edges.write({ edge: "CHILD_OF", source_ref_id: a.ref_id, target_ref_id: ours.ref_id, namespace: "shared" });
    assert.equal((await edgeRow(named.ref_id))["ns"], "shared");
    // A stamp is never a property; a malformed namespace is refused.
    await assert.rejects(b.edges.write({ edge: "CHILD_OF", source_ref_id: ours.ref_id, target_ref_id: c.ref_id, namespace: "Two Words" }), refused("UNKNOWN_ATTRIBUTE", "namespace"));
    await assert.rejects(b.edges.write({ edge: "CHILD_OF", source_ref_id: ours.ref_id, target_ref_id: c.ref_id, properties: { namespace: "x" } }), refused("UNKNOWN_ATTRIBUTE", "namespace"));
    // An update moves updated_at; a move keeps the namespace and the author.
    await new Promise((r) => setTimeout(r, 5));
    await b.edges.update({ ref_id: e.ref_id }, { set: { importance: 2 } });
    const updated = await edgeRow(e.ref_id);
    assert.ok(Number(updated["updated"]) > Number(updated["created"]));
    const moved = await b.edges.move({ edge: "CHILD_OF", ref_id: c.ref_id, direction: "forward", from_ref_id: a.ref_id, to_ref_id: ours.ref_id });
    const after = await edgeRow(moved.edge_ref_id);
    assert.deepEqual([after["ns"], after["by"]], ["private", "assistant"]);
  });

  it("a search with no namespace or type finds a StrutRun; neighbors and counts show Strut records", async () => {
    const run = await b.nodes.write({ type: "StrutRun", data: RUN });
    const c = await b.nodes.write({ type: "Concept", data: { name: "Lighthouse", description: "a tower with a lamp" } });
    const claim = await b.nodes.write({ type: "Claim", data: { id: "c1", claim_text: "the keeper lights the lighthouse" } });
    const w = await b.nodes.write({ type: "StrutWorkflow", data: { name: "lighthouse-keeper" } });
    await b.edges.write({ edge: "ABOUT", source_ref_id: claim.ref_id, target_ref_id: w.ref_id });
    const hits = (await b.reader.search({ q: "lighthouse" })).nodes.map((n) => n.ref_id);
    for (const id of [run.ref_id, c.ref_id, claim.ref_id, w.ref_id]) assert.ok(hits.includes(id), id);
    assert.deepEqual((await b.reader.search({ q: "lighthouse", domains: ["strut"] })).nodes.map((n) => n.node_type).sort(), ["StrutRun", "StrutWorkflow"], "the domain marks what kind of thing it is");
    assert.deepEqual((await b.reader.neighbors(claim.ref_id)).nodes.map((n) => n.ref_id).filter((r) => r !== claim.ref_id), [w.ref_id]);
    assert.deepEqual(await b.reader.edgeCounts([claim.ref_id], "private"), { [claim.ref_id]: { ABOUT: 1 } });
  });

  it("the writer stamps created_by from the caller's actor, on create only, and a caller can't set it", async () => {
    const c = await b.nodes.write({ ...concept("Lighthouse"), created_by: "tom" });
    assert.equal((await rawNode(b, c.ref_id))!.props["created_by"], "tom");
    await b.nodes.write({ type: "Concept", data: { name: "Lighthouse", description: "lit" }, created_by: "someone-else" }, "upsert");
    assert.equal((await rawNode(b, c.ref_id))!.props["created_by"], "tom", "who made it is kept");
    // A node made with no actor takes the first one a later write knows.
    const job = await b.nodes.write({ type: "StrutJob", data: { job_id: "j-1", title: "Landing page", started_at: 1 } }, "upsert");
    assert.equal((await rawNode(b, job.ref_id))!.props["created_by"], undefined);
    await b.nodes.write({ type: "StrutJob", data: { job_id: "j-1", title: "Landing page", started_at: 1 }, created_by: "ann" }, "upsert");
    assert.equal((await rawNode(b, job.ref_id))!.props["created_by"], "ann", "a job's creator is the core stamp");
    await assert.rejects(b.nodes.write({ type: "Concept", data: { name: "Harbour", created_by: "tom" } }), refused("UNKNOWN_ATTRIBUTE", "created_by"));
    await assert.rejects(b.nodes.update(c.ref_id, { set: { created_by: "x" } }), refused("UNKNOWN_ATTRIBUTE", "created_by"));
  });

  it("the backend's own namespace: default reads as private, a malformed name refuses the open", async () => {
    assert.equal(ladybugConfigFromEnv({}, "/data").namespace, "private");
    assert.equal(ladybugConfigFromEnv({ STRUT_GRAPH_NAMESPACE: "shared" }, "/data").namespace, "shared");
    const dir = mkdtempSync(join(tmpdir(), "strut-lbug-ns-"));
    try {
      const path = join(dir, "graph.lbug");
      await assert.rejects(openGraphBackend({ kind: "ladybug", path, namespace: "Two Words" }, { embeddings: false, skipBoot: true }), /namespace/);
      const d = await openGraphBackend({ kind: "ladybug", path, namespace: "default" }, { embeddings: false, skipBoot: true });
      try {
        assert.equal(d.namespace, "private");
      } finally {
        await d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("namespaces on Neo4j stay jarvis's", { skip: neo4j?.skip ?? "STRUT_TEST_NEO4J_URI not set" }, () => {
  let b: Awaited<ReturnType<NonNullable<typeof neo4j>["open"]>>;
  before(async () => {
    b = await neo4j!.open();
    await neo4j!.wipe(b);
  });
  after(async () => {
    await neo4j!.close(b);
  });

  it("an edge carries no namespace or author; created_by only on a job or chat, as main stored it", async () => {
    const w = await b.nodes.write({ type: "StrutWorkflow", data: { name: "harvey-deliver" }, created_by: "tom" });
    const v = await b.nodes.write({ type: "StrutWorkflowVersion", data: { name: "harvey-deliver", content_hash: "c-1", published_at: 1 } });
    const e = await b.edges.write({ edge: "VERSION_OF", source_ref_id: v.ref_id, target_ref_id: w.ref_id, namespace: "shared", created_by: "assistant" });
    const row = (await b.query(`MATCH ()-[r {ref_id: $id}]->() RETURN keys(r) AS k`, { id: e.ref_id }))[0]!;
    assert.ok(!(row["k"] as string[]).some((k) => ["namespace", "created_by", "updated_at"].includes(k)));
    const wf = (await rawNode(b, w.ref_id))!.props;
    assert.deepEqual([wf["namespace"], wf["created_by"]], ["default", undefined]);
    const job = await b.nodes.write({ type: "StrutJob", data: { job_id: "j-1", title: "Landing page", started_at: 1 }, created_by: "ann" }, "upsert");
    assert.equal((await rawNode(b, job.ref_id))!.props["created_by"], "ann");
  });
});
