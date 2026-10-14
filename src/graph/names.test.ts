/**
 * `GraphReader.namesLike` — the Run popover's typeahead read — on both
 * engines (`testBackends()`): a Ladybug file always, a throwaway Neo4j when
 * STRUT_TEST_NEO4J_URI is set (wiped).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { GraphBackend } from "./backend.js";
import { seedStrutDomain } from "./schema-seed.js";
import { seedConceptSchema, setNodeProps, testBackends } from "./test-util.js";

for (const tb of testBackends()) {
  describe(`GraphReader.namesLike (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    before(async () => {
      b = await tb.open();
      await tb.wipe(b);
      if (b.kind === "neo4j") await seedStrutDomain(b);
      await seedConceptSchema(b);
      for (const [name, description] of [
        ["Medicine", "Root of clinical methodology."],
        ["Medical Ethics", "Duties of a clinician."],
        ["Emergency Medicine", "Acute care."],
        ["Law", "Legal knowledge."],
      ] as const) {
        await b.nodes.write({ type: "Concept", data: { name, description } });
      }
      // What every read hides: a muted node on Neo4j (jarvis's flag, which
      // the file does not keep), a deleted one on Ladybug.
      const hidden = await b.nodes.write({ type: "Concept", data: { name: "Medieval Law", description: "Hidden." } });
      await setNodeProps(b, hidden.ref_id, b.kind === "neo4j" ? { is_muted: true } : { deleted_at: 1 });
    });
    after(() => tb.close(b));

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

    it("hides what every read hides, scopes to the type, caps the limit, and answers nothing to nothing", async () => {
      assert.deepEqual((await b.reader.namesLike("Concept", "medieval")).map((h) => h.name), []);
      assert.deepEqual(await b.reader.namesLike("Person", "med"), []);
      assert.equal((await b.reader.namesLike("Concept", "e", 2)).length, 2);
      assert.deepEqual(await b.reader.namesLike("Concept", "   "), []);
      assert.deepEqual(await b.reader.namesLike("", "med"), []);
    });

    it("the type resolves case-insensitively on a file (the registry); the label is exact on Neo4j", { skip: tb.kind === "neo4j" && "neo4j: exact label" }, async () => {
      assert.deepEqual((await b.reader.namesLike("concept", "law")).map((h) => h.name), ["Law"]);
    });
  });
}
