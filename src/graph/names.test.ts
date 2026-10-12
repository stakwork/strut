/**
 * LIVE: `GraphReader.namesLike` — the Run popover's typeahead read — against
 * a throwaway Neo4j (skipped without STRUT_TEST_NEO4J_URI; wipes it).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Bolt } from "./bolt.js";
import { closeGraphBackends, openGraphBackend, type GraphBackend } from "./backend.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";

const cfg = testGraphConfig();

describe("GraphReader.namesLike (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let b: GraphBackend;
  before(async () => {
    const bolt = new Bolt(cfg!);
    await wipeGraph(bolt);
    await bolt.close();
    b = await openGraphBackend(cfg!, { embeddings: false, seedOntology: true });
    const ns = b.cfg.namespace;
    for (const [name, description] of [
      ["Medicine", "Root of clinical methodology."],
      ["Medical Ethics", "Duties of a clinician."],
      ["Emergency Medicine", "Acute care."],
      ["Law", "Legal knowledge."],
    ] as const) {
      await b.nodes.write({ type: "Concept", data: { name, description } }, "create", { namespace: ns });
    }
    const muted = await b.nodes.write({ type: "Concept", data: { name: "Medieval Law", description: "Muted." } }, "create", { namespace: ns });
    await b.bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) SET n.is_muted = true`, { r: muted.ref_id });
  });
  after(async () => {
    await closeGraphBackends();
  });

  it("matches a fragment anywhere in the name, case-insensitive, prefix matches first, then alphabetical", async () => {
    const hits = await b.reader.namesLike("Concept", "med");
    assert.deepEqual(hits.map((h) => h.name), ["Medical Ethics", "Medicine", "Emergency Medicine"]);
    assert.equal(hits[0]!.node_type, "Concept");
    assert.equal(hits[0]!.description, "Duties of a clinician.");
    assert.match(hits[0]!.ref_id, /^[0-9a-f-]{36}$/);
  });

  it("is a contains match, not a fulltext search: a word's middle finds it", async () => {
    assert.deepEqual((await b.reader.namesLike("Concept", "ICIN")).map((h) => h.name), ["Emergency Medicine", "Medicine"]);
  });

  it("hides what every read hides (a muted node), scopes to the type, caps the limit, and answers nothing to nothing", async () => {
    assert.deepEqual((await b.reader.namesLike("Concept", "medieval")).map((h) => h.name), []);
    assert.deepEqual(await b.reader.namesLike("Person", "med"), []);
    assert.equal((await b.reader.namesLike("Concept", "e", 2)).length, 2);
    assert.deepEqual(await b.reader.namesLike("Concept", "   "), []);
    assert.deepEqual(await b.reader.namesLike("", "med"), []);
  });
});
