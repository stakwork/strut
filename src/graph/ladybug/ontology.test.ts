/**
 * A Ladybug file's dynamic ontology (plans/memory-in-workspace-graph.md, PR
 * A): the seed at open, types and edge types created at runtime (on an open
 * file, with a read in flight), the column and name rules, and what the
 * readers and the test helpers do with Schema rows.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraphBackend, type LadybugBackend } from "../backend.js";
import { GraphValidationError } from "../node-writer.js";
import { createNodeSchema } from "../schema-crud.js";
import { EXCLUDED_NODE_TYPES } from "../../steps/lib/graph/_shared.js";
import { nodeCount, testBackends } from "../test-util.js";
import { readCatalog, seedOntology } from "./ontology.js";
import { LADYBUG_EDGES, LADYBUG_SCHEMAS, ontologySeed } from "./registry.js";

const tb = testBackends().find((b) => b.kind === "ladybug")!;

const open = (path: string) => openGraphBackend({ kind: "ladybug", path, namespace: "default" }, { embeddings: false, skipBoot: true });

const schemaRows = async (b: LadybugBackend) =>
  (await b.query(`MATCH (n:Node {node_type: 'Schema'}) RETURN n.type AS type, n.ref_id AS ref_id, n.attributes AS attributes ORDER BY type`)).map((r) => JSON.stringify(r));

const refusedWith = (code: string, re: RegExp) => (e: unknown) => e instanceof GraphValidationError && e.code === code && re.test(e.message);

describe("ladybug ontology: the seed", { skip: tb.skip }, () => {
  let dir: string;
  let b: LadybugBackend;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-lbug-onto-"));
    b = await open(join(dir, "graph.lbug"));
  });
  after(async () => {
    await b?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("a new file holds Thing and the seed types as Schema rows, their parent links and edge rules, stamped", async () => {
    const types = (await b.query(`MATCH (n:Node {node_type: 'Schema'}) RETURN n.type AS t ORDER BY t`)).map((r) => String(r["t"]));
    assert.deepEqual(types, ["Thing", ...LADYBUG_SCHEMAS.map((s) => s.type)].sort());
    const parents = await b.query(`MATCH (c:Node {node_type: 'Schema'})-[r:SCHEMA_EDGE {edge_type: 'CHILD_OF'}]->(p:Node {node_type: 'Schema', type: 'Thing'}) RETURN count(c) AS n`);
    assert.equal(Number(parents[0]!["n"]), LADYBUG_SCHEMAS.length);
    const run = (await b.schemaSource.schemaRow("strutrun"))!;
    assert.equal(run.type, "StrutRun");
    assert.equal(run.props["node_key"], "strutrun-run_id");
    assert.equal(run.props["run_id"], "string", "the attributes read back flat, as a Neo4j Schema node holds them");
    for (const e of LADYBUG_EDGES) assert.ok(await b.schemas.edgeSchema(e.edge, e.source, e.target), `${e.source}-[${e.edge}]->${e.target}`);
    for (const edge of ["VERSION_OF", "ABOUT", "CHILD_OF"]) {
      const rows = await b.query(`MATCH (a:Node)-[r:\`${edge}\`]->(c:Node) RETURN count(r) AS n`);
      assert.equal(Number(rows[0]!["n"]), 0, `the data's ${edge} table holds no ontology edge`);
    }
    const stamp = await b.query(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS n`, { id: ontologySeed().id });
    assert.equal(Number(stamp[0]!["n"]), 1);
  });

  it("runs twice with no change: a second seed creates and adds nothing", async () => {
    const rows = await schemaRows(b);
    const report = await b.lbug.withWrite((tx) => seedOntology((c, p) => tx.run(c, p)));
    assert.deepEqual(report, { createdSchemas: [], reconciled: {}, createdEdgeSchemas: [] });
    assert.deepEqual(await schemaRows(b), rows);
  });

  it("the Strut types resolve from the file as strut-schemas.ts would have them here: exact keys, no Thing vestiges", async () => {
    const step = (await b.schemas.schema("StrutStep"))!;
    assert.equal(step.isStrut, true);
    assert.equal(step.exact_key, true);
    assert.deepEqual(step.vector_index, []);
    assert.deepEqual(step.domainLabels, ["Domain_strut"]);
    assert.equal(step.attributes["weight"], undefined);
    assert.equal((await b.schemas.schema("StrutWorkflow"))!.attributes["name"], "string", "a Strut type keeps its required name");
    assert.equal(await b.schemas.resolveType("StrutToolCall"), null, "the types the seed leaves out stay out");
    assert.equal(await b.schemas.resolveType("Schema"), null, "Schema is not a type a node is written as");
  });
});

describe("ladybug ontology: runtime types", { skip: tb.skip }, () => {
  let dir: string;
  let path: string;
  let b: LadybugBackend;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-lbug-onto-rt-"));
    path = join(dir, "graph.lbug");
    b = await open(path);
  });
  after(async () => {
    await b?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a type and an edge type on an open file while a read is running, and both survive a reopen", async () => {
    await b.nodes.writeMany(Array.from({ length: 300 }, (_, i) => ({ type: "Concept", data: { name: `concept ${i}` } })));
    const ro = await b.lbug.readOnly();
    try {
      // A read that is still going when the schema write lands.
      const read = ro.query(`MATCH (a:Node), (b:Node) WHERE a.name < b.name RETURN count(*) AS c`);
      const write = (async () => {
        await createNodeSchema(b, b.schemas, { type: "Invoice", attributes: { number: "string", amount: "?float", paid: "?boolean" }, node_key: "number" });
        await b.schemas.createEdgeSchema("Invoice", "BILLED_FOR", "Concept");
      })();
      const [rows] = await Promise.all([read, write]);
      assert.ok(Number(rows[0]!["c"]) > 0);
    } finally {
      await ro.close();
    }
    const [inv, concept] = (await b.nodes.writeMany([
      { type: "Invoice", data: { number: "INV-1", amount: 12.5, paid: false } },
      { type: "Concept", data: { name: "Billing" } },
    ])).map((r) => r.ref_id);
    assert.equal((await b.edges.write({ edge: "BILLED_FOR", source_ref_id: inv!, target_ref_id: concept! })).created, true);
    assert.equal((await b.reader.getNode(inv!))?.properties["amount"], 12.5, "the new column is read back");

    await b.close();
    b = await open(path);
    assert.equal(await b.schemas.resolveType("invoice"), "Invoice");
    assert.ok(await b.schemas.edgeSchema("BILLED_FOR", "Invoice", "Concept"));
    const after = await b.reader.neighbors(inv!, { edge_types: ["BILLED_FOR"] });
    assert.deepEqual(after.edges.map((e) => [e.edge_type, e.target]), [["BILLED_FOR", concept]]);
    assert.equal((await b.reader.getNode(inv!))?.properties["number"], "INV-1");
  });

  it("lists a runtime type and its edge in the ontology, without Thing or the parent link to it", async () => {
    const { schemas, edges } = await b.reader.listSchemas();
    const invoice = schemas.find((s) => s.type === "Invoice")!;
    assert.equal(invoice.attributes["amount"], "?float");
    assert.equal(invoice["domain"], "entity");
    assert.ok(edges.some((e) => e.edge_type === "BILLED_FOR" && e.source_type === "Invoice" && e.target_type === "Concept"));
    assert.ok(!schemas.some((s) => s.type === "Thing") && !edges.some((e) => e.target_type === "Thing"));
    assert.equal((await b.reader.getSchema("INVOICE"))?.type, "Invoice");
    assert.deepEqual((await b.reader.listSchemas({ domains: ["entity"] })).schemas.map((s) => s.type), ["Invoice"]);
  });

  it("refuses a column clash: one attribute name keeps one column type, and the refused type writes nothing", async () => {
    await assert.rejects(
      createNodeSchema(b, b.schemas, { type: "Payment", attributes: { reference: "string", amount: "?int" } }),
      refusedWith("WRONG_TYPE", /amount is a DOUBLE column in this graph and \?int would need INT64/),
    );
    assert.equal(await b.schemas.resolveType("Payment"), null);
    assert.equal((await readCatalog(b.query))["columns"]["reference"], undefined, "not even the attribute that fit");
    await assert.rejects(
      createNodeSchema(b, b.schemas, { type: "Receipt", attributes: { created_at: "?string" } }),
      refusedWith("WRONG_TYPE", /created_at is a INT64 column/),
      "a seed type's column too",
    );
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Blob", attributes: { body: "complex" } }), refusedWith("WRONG_TYPE", /complex attribute has no column type/));
    // Extending to a clash is refused the same way; the same type is fine.
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Invoice", attributes: { number: "string", amount: "?float", run_id: "?int" }, node_key: "number" }), refusedWith("WRONG_TYPE", /run_id is a STRING column/));
    const ok = await createNodeSchema(b, b.schemas, { type: "Payment", attributes: { reference: "string", amount: "?float" }, node_key: "reference" });
    assert.equal(ok.created, true);
    assert.ok((await b.nodes.write({ type: "Payment", data: { reference: "P-1", amount: 3 } })).ref_id);
  });

  it("refuses a name or alias another type holds, case-blind; a type keeps its owner", async () => {
    const org = await createNodeSchema(b, b.schemas, { type: "Organization", attributes: {}, aliases: ["Company"] });
    assert.equal(org.created, true);
    assert.deepEqual((await b.schemaSource.schemaRow("Organization"))?.props["aliases"], ["Company"]);
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "company", attributes: {} }), refusedWith("DUPLICATE_KEY", /company is already an alias of Organization/));
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Firm", attributes: {}, aliases: ["ORGANIZATION"] }), refusedWith("DUPLICATE_KEY", /ORGANIZATION is already the type Organization/));
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Firm", attributes: {}, aliases: ["Invoice"] }), refusedWith("DUPLICATE_KEY", /Invoice is already the type Invoice/));
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Business", attributes: {}, aliases: ["Company"] }), refusedWith("DUPLICATE_KEY", /Company is already an alias of Organization/));
    assert.equal(await b.schemas.resolveType("Firm"), null);
    assert.equal(await b.schemas.resolveType("Business"), null);
    // The same type by name, any casing, is the add-only extend it always was.
    assert.deepEqual((await createNodeSchema(b, b.schemas, { type: "organization", attributes: { website: "?string" } })).added, ["website"]);

    await createNodeSchema(b, b.schemas, { type: "Pal", attributes: {}, aliases: ["Buddy"], managed_by: "memory" });
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Pal", attributes: { nickname: "?string" } }), refusedWith("DUPLICATE_KEY", /Pal is owned by memory/));
    await assert.rejects(createNodeSchema(b, b.schemas, { type: "Buddy", attributes: {} }), refusedWith("DUPLICATE_KEY", /Buddy is already an alias of Pal \(owned by memory\)/));
    assert.deepEqual((await createNodeSchema(b, b.schemas, { type: "Pal", attributes: { nickname: "?string" }, managed_by: "memory" })).added, ["nickname"], "its owner extends it");
  });

  it("search never returns a Schema row; the traversal steps leave Schema out", async () => {
    const r = await b.reader.search({ q: "Billing", limit: 50 });
    assert.ok(r.nodes.length > 0, "the Concept is found");
    assert.ok(r.nodes.every((n) => n.node_type !== "Schema"), JSON.stringify(r.nodes.map((n) => n.node_type)));
    assert.equal((await b.reader.search({ q: "Organization" })).nodes.length, 0, "a type with no nodes finds nothing");
    assert.ok(EXCLUDED_NODE_TYPES.includes("Schema"));
  });

  it("the test helpers' wipe keeps the ontology and drops the data; counts never include a Schema row", async () => {
    assert.ok((await nodeCount(b)) > 0);
    await tb.wipe(b);
    assert.equal(await nodeCount(b), 0);
    assert.equal(await b.schemas.resolveType("Invoice"), "Invoice", "a runtime type survives a wipe");
    assert.equal(await b.schemas.resolveType("StrutRun"), "StrutRun");
    assert.ok(await b.schemas.edgeSchema("BILLED_FOR", "Invoice", "Concept"));
    assert.ok((await b.nodes.write({ type: "Invoice", data: { number: "INV-2" } })).ref_id, "and is writable");
  });
});
