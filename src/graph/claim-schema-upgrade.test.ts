import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { closeGraphBackends, openGraphBackend } from "./backend.js";
import { Bolt } from "./bolt.js";
import { CLAIM_SCHEMA_UPGRADE_ID, upgradeClaimSchema } from "./claim-schema-upgrade.js";
import { JARVIS_ONTOLOGY, type OntologyFixture } from "./fixtures/jarvis-ontology.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { seedStrutDomain } from "./schema-seed.js";
import { SchemaResolver } from "./schema-resolver.js";
import { GraphValidationError, NodeWriter } from "./node-writer.js";
import { graphSnapshot, testGraphConfig, wipeGraph } from "./test-util.js";

const cfg = testGraphConfig();

const schemaOf = (type: string) => JARVIS_ONTOLOGY.schemas.find((s) => s["type"] === type)!;

/** The `Claim` schema as the pre-119 fixture had it (what an already-seeded
 *  standalone database still holds). */
const OLD_CLAIM = {
  speaker_name: "string",
  index: ["name", "claim_text", "speaker_name"],
  triplicate_subject: "?string",
  claim_text: "string",
  parent: "Content",
  node_key: "claim-claim_text-speaker_name",
  triplicate: "?string",
  type: "Claim",
  source_role: "?string",
  triplicate_predicate: "?string",
  description_key: "claim_text",
  title_key: "name",
  paid_properties: ["claim_text"],
  name: "string",
  triplicate_object: "?string",
  domain: "Content",
  ref_id: "67fcc508-e296-4411-896b-6f431e8c0c9d",
};

const fixtureWith = (claim: Record<string, unknown>): OntologyFixture => ({
  source: "test",
  schemas: [schemaOf("Thing"), schemaOf("Content"), claim],
  edge_schemas: [],
  hidden_domains: null,
});

describe("bundled fixture (pure)", () => {
  it("carries the post-125 epistemic layer", () => {
    const claim = schemaOf("Claim");
    assert.deepEqual(
      [claim["node_key"], claim["id"], claim["speaker_name"], claim["paid_properties"], claim["domain"], claim["parent"]],
      ["claim-id", "string", "?string", [], "Epistemic", "Thing"],
    );
    assert.deepEqual([schemaOf("Evidence")["node_key"], schemaOf("Check")["node_key"], schemaOf("Check")["created_at"]], ["evidence-id", "check-id", "datetime"]);
    const pairs = new Set(JARVIS_ONTOLOGY.edge_schemas.map((e) => `${e.source}-${e.edge}->${e.target}`));
    for (const p of [
      "Claim-ABOUT->Thing", "Evidence-ABOUT->Thing", "Check-TESTS->Claim", "Evidence-PRODUCED_BY->Check", "Check-SUPERSEDES->Check",
      "Claim-EVIDENCED_BY->Evidence", "Evidence-HAS_SOURCE->Thing", "Claim-SUPERSEDES->Claim", "Claim-PARENT_OF->Claim", "Claim-DERIVED_FROM->Claim",
    ]) assert.ok(pairs.has(p), p);
  });
});

describe("upgradeClaimSchema (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
  });
  after(async () => {
    await bolt?.close();
  });
  beforeEach(async () => {
    await wipeGraph(bolt);
  });

  it("old-shape Claim schema → upgraded once; the add-only seed alone would have left it", async () => {
    await seedJarvisOntology(bolt, fixtureWith(OLD_CLAIM));
    await seedStrutDomain(bolt);
    const nodes = new NodeWriter(bolt, { resolver: new SchemaResolver(bolt) });
    const old = await nodes.write({ type: "Claim", data: { name: "n", claim_text: "the sky is blue", speaker_name: "alice" } });
    assert.equal(old.node_key, "claim-theskyisblue-alice");

    // The re-dumped fixture by itself changes nothing on an existing Claim schema…
    const seeded = await seedJarvisOntology(bolt, fixtureWith(schemaOf("Claim")));
    assert.deepEqual(seeded.createdSchemas, []);
    await assert.rejects(
      new NodeWriter(bolt, { resolver: new SchemaResolver(bolt) }).write({ type: "Claim", data: { id: "c1", name: "n", claim_text: "t" } }),
      (e: unknown) => e instanceof GraphValidationError && (e.code === "UNKNOWN_ATTRIBUTE" || e.code === "MISSING_REQUIRED"),
    );

    // …the upgrade does.
    const r = await upgradeClaimSchema(bolt);
    assert.deepEqual(r, { status: "upgraded", deletedClaims: 1, previousNodeKey: "claim-claim_text-speaker_name" });
    const rows = await bolt.run(
      `MATCH (s:Schema {type: "Claim"}) RETURN properties(s) AS p, [(s)-[:CHILD_OF]->(p:Schema) | p.type] AS child_of`,
    );
    assert.equal(rows.length, 1);
    const live = rows[0]!["p"] as Record<string, unknown>;
    assert.equal(live["ref_id"], OLD_CLAIM.ref_id, "the Schema node keeps its identity");
    assert.deepEqual({ ...live, ref_id: undefined }, { ...schemaOf("Claim"), ref_id: undefined });
    assert.deepEqual(rows[0]!["child_of"], ["Thing"]);
    assert.equal((await bolt.run(`MATCH (c:Claim) RETURN count(c) AS c`))[0]!["c"], 0);

    // A claim nobody "said", keyed on id, is now writable — and lands in Epistemic.
    const fresh = new NodeWriter(bolt, { resolver: new SchemaResolver(bolt) });
    const c = await fresh.write({ type: "Claim", data: { id: "c1", name: "n", claim_text: "the clip contains the quote" } });
    assert.equal(c.node_key, "claim-c1");

    // A second boot is a no-op and never deletes new-shape claims.
    const snap = await graphSnapshot(bolt);
    assert.deepEqual(await upgradeClaimSchema(bolt), { status: "already_done", deletedClaims: 0 });
    assert.deepEqual(await graphSnapshot(bolt), snap);
  });

  it("a graph already keyed on claim-id (jarvis 124 ran, or a fresh seed) is untouched", async () => {
    await seedJarvisOntology(bolt, fixtureWith(schemaOf("Claim")));
    await seedStrutDomain(bolt);
    const nodes = new NodeWriter(bolt, { resolver: new SchemaResolver(bolt) });
    await nodes.write({ type: "Claim", data: { id: "keep", name: "n", claim_text: "kept" } });
    const snap = await graphSnapshot(bolt);

    const r = await upgradeClaimSchema(bolt);
    assert.deepEqual(r, { status: "nothing_to_do", deletedClaims: 0, previousNodeKey: "claim-id" });
    const after = await graphSnapshot(bolt);
    const ledger = after.nodes.filter((n) => n.labels.includes("Migration") && n.properties["migration_id"] === CLAIM_SCHEMA_UPGRADE_ID);
    assert.equal(ledger.length, 1);
    assert.deepEqual(after.nodes.filter((n) => !ledger.includes(n)), snap.nodes);
    assert.deepEqual(after.rels, snap.rels);
  });

  it("boot path: runs before the ontology seed, and only when that seed is on", async () => {
    await seedJarvisOntology(bolt, fixtureWith(OLD_CLAIM));
    try {
      // No seedOntology = a jarvis-hosted graph: jarvis's to migrate, never touched from here.
      const hosted = await openGraphBackend(cfg!, { embeddings: false });
      assert.equal(hosted.claimSchemaUpgrade, undefined);
      assert.equal((await bolt.run(`MATCH (s:Schema {type: "Claim"}) RETURN s.node_key AS k`))[0]!["k"], OLD_CLAIM.node_key);
      await hosted.close();

      const standalone = await openGraphBackend(cfg!, { embeddings: false, seedOntology: true });
      assert.equal(standalone.claimSchemaUpgrade?.status, "upgraded");
      assert.ok(standalone.ontologySeed!.createdSchemas.includes("Check") && standalone.ontologySeed!.createdSchemas.includes("Evidence"));
      // The whole layer is writable on the upgraded, re-seeded database.
      const c = await standalone.nodes.write({ type: "Claim", data: { id: "c1", name: "n", claim_text: "t" } });
      const k = await standalone.nodes.write({ type: "Check", data: { id: "k1", name: "k", created_at: 1 } });
      assert.ok((await standalone.edges.write({ edge: "TESTS", source_ref_id: k.ref_id, target_ref_id: c.ref_id })).created);
    } finally {
      await closeGraphBackends();
    }
  });

  it("no Claim schema at all → left for the seed to create; duplicates → left for a human, not stamped", async () => {
    assert.deepEqual(await upgradeClaimSchema(bolt), { status: "nothing_to_do", deletedClaims: 0 });

    await wipeGraph(bolt);
    await seedJarvisOntology(bolt, fixtureWith(OLD_CLAIM));
    await bolt.run(`CREATE (:Schema {type: "claim", node_key: "claim-name", ref_id: "dup"})`);
    assert.equal((await upgradeClaimSchema(bolt)).status, "skipped_duplicates");
    assert.equal((await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: CLAIM_SCHEMA_UPGRADE_ID }))[0]!["c"], 0);
    assert.equal((await bolt.run(`MATCH (s:Schema {type: "Claim"}) RETURN s.node_key AS k`))[0]!["k"], OLD_CLAIM.node_key);
  });
});
