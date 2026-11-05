/**
 * The types both engines seed (seed-types.ts, plans/ontology.md): a fresh
 * graph with no jarvis library holds Claim, Check, Evidence and Concept
 * with their keys and rules, allows every edge the claim layer and the
 * Concept tree write, and takes strut's own Concept pages. The claims
 * suites (claims, claims-authoring, verify) run on this seed too.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { seedConcepts, STRUT_CONCEPTS } from "../concept-seed.js";
import type { GraphBackend } from "./backend.js";
import { seedStrutDomain } from "./schema-seed.js";
import { SEED_EDGES, SEED_TYPES } from "./seed-types.js";
import { testBackends } from "./test-util.js";

for (const tb of testBackends()) {
  describe(`the seed types on a fresh graph (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    before(async () => {
      b = await tb.open();
      await tb.wipe(b);
      // A Ladybug file seeds them at open; Neo4j at boot.
      if (b.kind === "neo4j") await seedStrutDomain(b);
    });
    after(async () => {
      await tb.close(b);
    });

    it("holds Claim, Check, Evidence and Concept with jarvis's key specs and strut's attributes", async () => {
      for (const t of SEED_TYPES) {
        const s = await b.schemas.schema(t.type);
        assert.ok(s, t.type);
        assert.equal(s.type, t.type);
        assert.equal(s.key_spec, t.key_spec, t.type);
        assert.equal(s.role, t.role, t.type);
        for (const k of Object.keys(t.attributes)) assert.ok(k in s.attributes, `${t.type}.${k}`);
      }
    });

    it("allows every edge the claim layer and the Concept tree write", async () => {
      for (const e of SEED_EDGES) assert.ok(await b.schemas.edgeSchema(e.edge, e.source, e.target), `${e.source}-[${e.edge}]->${e.target}`);
    });

    it("takes strut's own Concept pages and their tree", async () => {
      const out = await seedConcepts(b, [STRUT_CONCEPTS]);
      const byName = Object.fromEntries(out.map((o) => [o.name, o]));
      for (const name of ["Job", "Workflow Builder", "App"]) assert.equal(byName[name]?.action, "create", name);
      const kids = await b.query(
        `MATCH ${b.dialect.node("p", "Concept", { ref_id: "$ref" })}-[:PARENT_OF]->${b.dialect.node("c", "Concept")} RETURN c.name AS name`,
        { ref: byName["Workflow Builder"]!.ref_id },
      );
      assert.deepEqual(kids.map((r) => r["name"]), ["App"]);
    });
  });
}
