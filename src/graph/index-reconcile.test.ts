import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Bolt } from "./bolt.js";
import { JARVIS_ONTOLOGY } from "./fixtures/jarvis-ontology.js";
import { normalizeIndex, reconcileIndexLists, reconcileMigrationId, widenedIndex } from "./index-reconcile.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { graphSnapshot, testGraphConfig, wipeGraph } from "./test-util.js";

const cfg = testGraphConfig();
const LIB = ["name", "summary", "description"];

describe("widenedIndex (pure)", () => {
  it("the library's list for a non-empty strict subset, string or list", () => {
    assert.deepEqual(widenedIndex("name", LIB), LIB);
    assert.deepEqual(widenedIndex(["name"], LIB), LIB);
    assert.deepEqual(widenedIndex(["description", "name"], LIB), LIB, "order is the library's");
    assert.deepEqual(widenedIndex(["name", "name"], LIB), LIB, "duplicates count once");
  });
  it("null for the same list, a wider or foreign one, an absent one, and a library without a list", () => {
    assert.equal(widenedIndex(LIB, LIB), null);
    assert.equal(widenedIndex(["description", "summary", "name"], LIB), null);
    assert.equal(widenedIndex(["name", "extra"], LIB), null);
    assert.equal(widenedIndex(["name", "summary", "description", "extra"], LIB), null);
    assert.equal(widenedIndex(null, LIB), null);
    assert.equal(widenedIndex(undefined, LIB), null);
    assert.equal(widenedIndex([], LIB), null);
    assert.equal(widenedIndex("", LIB), null);
    assert.equal(widenedIndex("name", "name"), null);
    assert.equal(widenedIndex("name", undefined), null);
  });
  it("normalizes like jarvis's get_index_fields", () => {
    assert.deepEqual(normalizeIndex(" name "), ["name"]);
    assert.deepEqual(normalizeIndex(["a", "", " b "]), ["a", "b"]);
    assert.deepEqual(normalizeIndex(7), []);
  });
  it("the ledger id carries the fixture version", () => {
    assert.equal(reconcileMigrationId("m125"), "strut_index_reconcile_m125");
    // The jarvis migration the dump was taken at, plus a suffix for a library
    // change applied by hand since (a re-dump needs a jarvis DB at that state).
    assert.match(JARVIS_ONTOLOGY.version, /^m\d+(-[a-z0-9-]+)?$/);
  });
  it("the code types that index their body carry the generated description ahead of it, and a live [name, body] widens to it", () => {
    for (const type of ["Class", "Datamodel", "Page", "Trait", "Var"]) {
      const schema = JARVIS_ONTOLOGY.schemas.find((s) => s["type"] === type)!;
      assert.deepEqual(schema["index"], ["name", "description", "body"], type);
      assert.equal(schema["description"], "?string", type);
      assert.deepEqual(widenedIndex(["name", "body"], schema["index"]), ["name", "description", "body"], type);
    }
  });
});

describe("reconcileIndexLists (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  const index = async (type: string) => (await bolt.run(`MATCH (s:Schema {type: $t}) RETURN s.index AS i`, { t: type }))[0]!["i"];
  before(async () => {
    bolt = new Bolt(cfg!);
    await bolt.verify();
    await wipeGraph(bolt);
    await seedJarvisOntology(bolt);
  });
  after(async () => {
    await bolt?.close();
  });

  it("widens strict subsets to the library's list, leaves the rest alone, stamps per fixture version, never re-runs under it", async () => {
    // swarm38's shapes: the string `index` jarvis's early library declared,
    // a list with a field the library lacks, an absent `index`, a type the
    // library does not know, and a two-field subset.
    await bolt.run(`MATCH (s:Schema {type: "Function"}) SET s.index = "name"`);
    await bolt.run(`MATCH (s:Schema {type: "Commit"}) SET s.index = ["name", "message", "summary", "extra"]`);
    await bolt.run(`MATCH (s:Schema {type: "Class"}) REMOVE s.index`);
    await bolt.run(`CREATE (:Schema {type: "Alien", node_key: "alien-name", index: ["x"], name: "string", ref_id: "schema-alien"})`);
    await bolt.run(`MATCH (s:Schema {type: "Endpoint"}) SET s.index = ["summary", "name"]`);

    const r1 = await reconcileIndexLists(bolt);
    assert.equal(r1.status, "reconciled");
    assert.deepEqual(r1.widened, {
      Function: { from: ["name"], to: LIB },
      Endpoint: { from: ["summary", "name"], to: LIB },
    });
    assert.deepEqual(await index("Function"), LIB);
    assert.deepEqual(await index("Endpoint"), LIB);
    assert.deepEqual(await index("Commit"), ["name", "message", "summary", "extra"]);
    assert.equal(await index("Class"), null);
    assert.deepEqual(await index("Alien"), ["x"]);
    const stamped = await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: reconcileMigrationId(JARVIS_ONTOLOGY.version) });
    assert.equal(stamped[0]!["c"], 1);

    // Idempotent: nothing read, nothing written.
    const snap = await graphSnapshot(bolt);
    const r2 = await reconcileIndexLists(bolt);
    assert.deepEqual(r2, { status: "already_done", widened: {} });
    assert.deepEqual(await graphSnapshot(bolt), snap);

    // A list narrowed on purpose after the stamp stays narrow under the
    // same snapshot — no fight with a jarvis that meant it.
    await bolt.run(`MATCH (s:Schema {type: "Function"}) SET s.index = "name"`);
    assert.equal((await reconcileIndexLists(bolt)).status, "already_done");
    assert.equal(await index("Function"), "name");

    // The next snapshot widens once more.
    const r4 = await reconcileIndexLists(bolt, { ...JARVIS_ONTOLOGY, version: "m999" });
    assert.equal(r4.status, "reconciled");
    assert.deepEqual(Object.keys(r4.widened), ["Function"]);
    assert.deepEqual(await index("Function"), LIB);
    assert.deepEqual(await reconcileIndexLists(bolt, { ...JARVIS_ONTOLOGY, version: "m999" }), { status: "already_done", widened: {} });
  });
});
