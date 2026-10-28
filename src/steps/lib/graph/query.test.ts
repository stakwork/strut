/**
 * graph/query — read-only Cypher as a workflow step — on both engines
 * (`testBackends()`): a Ladybug file always, a throwaway Neo4j when
 * STRUT_TEST_NEO4J_URI is set (wiped). The step reads the wired backend
 * (`ctx.services.graph`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { StepContext } from "../../../core.js";
import type { GraphBackend } from "../../../graph/backend.js";
import { seedStrutDomain } from "../../../graph/schema-seed.js";
import { seedConceptSchema, testBackends } from "../../../graph/test-util.js";
import { grantRefusal } from "../../../apps/tools.js";
import { createRegistry } from "../../registry.js";
import step from "./query.js";

const LONG = "x".repeat(2_000);

for (const tb of testBackends()) {
  describe(`graph/query (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    // The layout differs by engine; the step does not hide it. Each ends in
    // a WHERE, so a case adds its own condition with AND.
    const concepts = () =>
      b.kind === "neo4j" ? "MATCH (n:Concept) WHERE n.namespace = $ns" : "MATCH (n:Node {node_type: 'Concept'}) WHERE n.deleted_at IS NULL";
    const params = (extra: Record<string, unknown> = {}) => (b.kind === "neo4j" ? { ns: b.namespace, ...extra } : extra);
    const run = (input: Record<string, unknown>) =>
      step.run(step.input.parse(input), { services: { graph: b } } as unknown as StepContext);

    before(async () => {
      b = await tb.open();
      await tb.wipe(b);
      if (b.kind === "neo4j") await seedStrutDomain(b);
      await seedConceptSchema(b);
      for (const name of ["Alpha", "Beta", "Gamma"]) await b.nodes.write({ type: "Concept", data: { name, docs: LONG } });
    });
    after(() => tb.close(b));

    it("returns the rows, keyed by column, with params", async () => {
      const out = await run({ cypher: `${concepts()} AND n.name <> $skip RETURN n.name AS name ORDER BY name`, params: params({ skip: "Beta" }) });
      assert.deepEqual(out.columns, ["name"]);
      assert.deepEqual(out.rows, [{ name: "Alpha" }, { name: "Gamma" }]);
      assert.equal(out.rowCount, 2);
      assert.equal(out.truncated, false);
    });

    it("stops at maxRows and says there were more", async () => {
      const out = await run({ cypher: `${concepts()} RETURN n.name AS name ORDER BY name`, params: params(), maxRows: 2 });
      assert.deepEqual(out.rows.map((r) => r["name"]), ["Alpha", "Beta"]);
      assert.equal(out.truncated, true);
    });

    it("keeps strings whole: a workflow reads the rows as data", async () => {
      const out = await run({ cypher: `${concepts()} RETURN n.docs AS docs LIMIT 1`, params: params() });
      assert.equal(out.rows[0]!["docs"], LONG);
    });

    it("fails the step on a write, and writes nothing", async () => {
      await assert.rejects(run({ cypher: "CREATE (n:Concept {name: 'Delta'}) RETURN n" }), /read-only Cypher: "CREATE" is not allowed/);
      const out = await run({ cypher: `${concepts()} RETURN count(n) AS n`, params: params() });
      assert.equal(Number(out.rows[0]!["n"]), 3);
    });

    it("fails the step on a query the engine refuses", async () => {
      await assert.rejects(run({ cypher: "MATCH (n RETURN n" }));
    });
  });
}

describe("graph/query at the app door", () => {
  it("is refused to a page, whatever the manifest grants", async () => {
    const registry = await createRegistry([]);
    assert.ok(registry["graph/query"], "a lib step");
    const manifest = { grants: { workflows: [], steps: ["graph/query", "graph/*"] } } as unknown as Parameters<typeof grantRefusal>[2];
    assert.match(grantRefusal("graph/query", {}, manifest, registry) ?? "", /not a thing a page does.*graph\/find/);
  });
});
