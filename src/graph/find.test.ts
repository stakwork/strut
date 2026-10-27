/**
 * `findNodes` — `graph/find`'s property query — on both engines
 * (`testBackends()`): a Ladybug file always, a throwaway Neo4j when
 * STRUT_TEST_NEO4J_URI is set (wiped). Equality, the operators, order,
 * pages, the count, what every read hides, and the errors a caller reads.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { GraphBackend } from "./backend.js";
import { FindError, findNodes } from "./find.js";
import { createNodeSchema } from "./schema-crud.js";
import { seedStrutDomain } from "./schema-seed.js";
import { seedConceptSchema, setNodeProps, testBackends } from "./test-util.js";
import graphFind from "../steps/lib/graph/find.js";

const names = (r: { nodes: Array<{ name?: string }> }) => r.nodes.map((n) => n.name);

for (const tb of testBackends()) {
  describe(`findNodes (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    before(async () => {
      b = await tb.open();
      await tb.wipe(b);
      if (b.kind === "neo4j") await seedStrutDomain(b);
      await seedConceptSchema(b);
      for (const [name, description, file] of [
        ["Medicine", "Root of clinical methodology.", "med.md"],
        ["Medical Ethics", "Duties of a clinician.", "ethics.md"],
        ["Emergency Medicine", "Acute care.", null],
        ["Law", "Legal knowledge.", "law.md"],
      ] as const) {
        await b.nodes.write({ type: "Concept", data: { name, description, ...(file ? { file } : {}) } });
      }
      const hidden = await b.nodes.write({ type: "Concept", data: { name: "Medieval Law", description: "Hidden." } });
      await setNodeProps(b, hidden.ref_id, b.kind === "neo4j" ? { is_muted: true } : { deleted_at: 1 });
      const deleted = await b.nodes.write({ type: "Concept", data: { name: "Mediation", description: "Gone." } });
      await setNodeProps(b, deleted.ref_id, { deleted_at: 1 });
    });
    after(() => tb.close(b));

    it("equality, contains (case-blind), in, null, and text comparisons; every condition must hold", async () => {
      assert.deepEqual(names(await findNodes(b, { node_type: "Concept", where: { name: "Law" } })), ["Law"]);
      assert.deepEqual(names(await findNodes(b, { node_type: "Concept", where: { name: { contains: "MEDIC" } }, orderBy: "name" })), ["Emergency Medicine", "Medical Ethics", "Medicine"]);
      assert.deepEqual(names(await findNodes(b, { node_type: "Concept", where: { file: { in: ["law.md", "med.md"] } }, orderBy: "name" })), ["Law", "Medicine"]);
      assert.deepEqual(names(await findNodes(b, { node_type: "Concept", where: { file: null } })), ["Emergency Medicine"]);
      assert.deepEqual(names(await findNodes(b, { node_type: "Concept", where: { name: { gte: "M", lt: "Medicine" } }, orderBy: "name" })), ["Medical Ethics"]);
      assert.deepEqual(names(await findNodes(b, { node_type: "Concept", where: { name: { contains: "medic" }, file: { contains: ".md" } }, orderBy: "name", desc: true })), ["Medicine", "Medical Ethics"]);
    });

    it("hides what every read hides: a soft-deleted node, and on Neo4j a muted one", async () => {
      const all = await findNodes(b, { node_type: "Concept", limit: 500, count: true });
      assert.equal(all.total, 4);
      assert.deepEqual(names(all).sort(), ["Emergency Medicine", "Law", "Medical Ethics", "Medicine"]);
      const node = all.nodes.find((n) => n.name === "Law")!;
      assert.match(node.ref_id, /^[0-9a-f-]{36}$/);
      assert.equal(node.node_type, "Concept");
      assert.equal(node.properties["description"], "Legal knowledge.");
      assert.equal(node.properties["ref_id"], undefined, "the ref_id is the node's, not a property");
      assert.equal(typeof node.properties["date_added_to_graph"], "number");
    });

    it("pages with a cursor until there is none, and counts every match", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await findNodes(b, { node_type: "Concept", orderBy: "name", limit: 3, ...(cursor ? { cursor } : {}), count: pages === 0 });
        if (pages === 0) assert.equal(page.total, 4);
        seen.push(...names(page).map(String));
        cursor = page.cursor;
        pages++;
      } while (cursor);
      assert.equal(pages, 2);
      assert.deepEqual(seen, ["Emergency Medicine", "Law", "Medical Ethics", "Medicine"]);
    });

    it("refuses what it cannot answer with the fields to use, an unknown type, an operator it does not know, a bad cursor", async () => {
      await assert.rejects(findNodes(b, { node_type: "Concept", where: { colour: "red" } }), (e: Error) => e instanceof FindError && /Concept has no field "colour" — its fields: .*description.*name/.test(e.message));
      await assert.rejects(findNodes(b, { node_type: "Concept", orderBy: "nope" }), /orderBy: Concept has no field "nope"/);
      await assert.rejects(findNodes(b, { node_type: "NoSuchType" }), /unknown node type "NoSuchType"/);
      await assert.rejects(findNodes(b, { node_type: "Concept", where: { name: { like: "x" } as never } }), /where\.name\.like: not an operator/);
      await assert.rejects(findNodes(b, { node_type: "Concept", where: { name: ["a"] as never } }), /use \{ in: \[\.\.\.\] \}/);
      await assert.rejects(findNodes(b, { node_type: "Concept", cursor: "nope" }), /not a cursor graph\/find returned/);
    });

    it("graph/find is the step over it, and says an error back instead of throwing", async () => {
      const ctx = { services: { graph: b } } as never;
      const r = (await graphFind.run({ node_type: "Concept", where: { name: "Law" } } as never, ctx)) as { nodes: Array<{ name: string }> };
      assert.deepEqual(r.nodes.map((n) => n.name), ["Law"]);
      assert.match(String(await graphFind.run({ node_type: "Nope" } as never, ctx)), /^graph\/find failed: unknown node type/);
    });

    it("numbers compare as numbers, and a datetime takes an ISO string", { skip: tb.kind !== "neo4j" && "a file's types are fixed in code" }, async () => {
      await createNodeSchema(b, b.schemas, { type: "Bill", attributes: { amount: "float", due: "?datetime", status: "string" } });
      for (const [name, amount, due, status] of [
        ["b1", 9.5, "2026-10-01T00:00:00Z", "paid"],
        ["b2", 120, "2026-11-01T00:00:00Z", "unpaid"],
        ["b3", 40, "2026-12-01T00:00:00Z", "unpaid"],
      ] as const) {
        await b.nodes.write({ type: "Bill", data: { name, amount, due, status } });
      }
      assert.deepEqual(names(await findNodes(b, { node_type: "Bill", where: { amount: { gt: 10 } }, orderBy: "amount" })), ["b3", "b2"]);
      assert.deepEqual(names(await findNodes(b, { node_type: "Bill", where: { status: "unpaid", due: { lt: "2026-11-15T00:00:00Z" } } })), ["b2"]);
      await assert.rejects(findNodes(b, { node_type: "Bill", where: { due: { lt: "soon" } } }), /due is a datetime/);
      await assert.rejects(findNodes(b, { node_type: "Bill", where: { amount: { contains: "1" } } }), /contains takes a string field/);
    });
  });
}
