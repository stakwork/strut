import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineStep } from "../core.js";
import { createRegistry } from "../steps/registry.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { buildTools } from "../ai/tools.js";
import { buildSystem } from "../ai/prompts.js";
import { compactValue, findWriteKeyword, readQuery, ReadOnlyViolation } from "./query.js";
import type { GraphBackend, Neo4jBackend } from "./backend.js";
import { testBackends } from "./test-util.js";

// ── Pure (no DB) ───────────────────────────────────────────────────────────

describe("findWriteKeyword", () => {
  it("passes read-only queries", () => {
    for (const q of [
      "MATCH (n:Concept {namespace: $ns}) RETURN count(n)",
      "MATCH (a)-[r:RELATED_TO]->(b) RETURN type(r), count(*) ORDER BY count(*) DESC LIMIT 5",
      "CALL db.labels() YIELD label RETURN label",
      "MATCH (n) WHERE n.data_set = 'x' RETURN n.settings, n.offset",
      "MATCH (n) WHERE n.name = 'please SET this' RETURN n // no CREATE here",
      "MATCH (n) RETURN n.`create` /* MERGE in a comment */",
      "UNWIND $ids AS id MATCH (n {ref_id: id}) RETURN n",
      "SHOW INDEXES YIELD name RETURN name",
      // Ladybug reads: the index queries, the catalog.
      "CALL QUERY_FTS_INDEX('Node', 'node_fts', 'budget') RETURN node.name, score",
      "CALL QUERY_VECTOR_INDEX('Node', 'node_vec', $q, 5) RETURN node.ref_id, distance",
      "CALL SHOW_LOADED_EXTENSIONS() RETURN *",
      "MATCH (n:Node {node_type: 'Concept'}) WHERE n.deleted_at IS NULL RETURN n.name",
    ]) assert.equal(findWriteKeyword(q), undefined, q);
  });

  it("flags every write clause, case-insensitively", () => {
    for (const q of [
      "CREATE (n:X)",
      "merge (n:X {k: 1})",
      "MATCH (n) SET n.a = 1",
      "MATCH (n) DETACH DELETE n",
      "MATCH (n) DELETE n",
      "MATCH (n) REMOVE n.a",
      "DROP INDEX foo",
      "MATCH (n) FOREACH (x IN [1] | SET n.a = x)",
      "LOAD CSV FROM 'file:///x.csv' AS row RETURN row",
      "CALL apoc.periodic.iterate('MATCH (n) RETURN n', 'DELETE n', {})",
      "CALL apoc.meta.stats()",
      "CALL db.index.fulltext.createNodeIndex('x', ['A'], ['b'])",
      "CALL { MATCH (n) SET n.a = 1 } RETURN 1",
      "ALTER DATABASE neo4j SET ACCESS READ ONLY",
      // Ladybug: files, extensions, other databases, the index procedures.
      "LOAD FROM '/etc/passwd' RETURN *",
      "LOAD EXTENSION json",
      "INSTALL json",
      "COPY Node FROM '/tmp/rows.csv'",
      "COPY (MATCH (n:Node) RETURN n.name) TO '/tmp/out.csv'",
      "ATTACH '/tmp/other.lbug' AS other (dbtype lbug)",
      "IMPORT DATABASE '/tmp/dump'",
      "EXPORT DATABASE '/tmp/dump'",
      "CALL CREATE_FTS_INDEX('Node', 'i', ['name'])",
      "CALL DROP_VECTOR_INDEX('Node', 'node_vec')",
    ]) assert.notEqual(findWriteKeyword(q), undefined, q);
    // The reported keyword names the offender.
    assert.equal(findWriteKeyword("MATCH (n) SET n.a = 1"), "SET");
    assert.equal(findWriteKeyword("CALL apoc.meta.stats()"), "apoc.*");
    assert.equal(findWriteKeyword("LOAD FROM 'x.csv' RETURN *"), "LOAD");
    assert.equal(findWriteKeyword("CALL CREATE_FTS_INDEX('Node', 'i', ['name'])"), "CREATE_*_INDEX/DROP_*_INDEX");
  });
});

describe("compactValue", () => {
  it("truncates long strings and collapses vectors, recursively", () => {
    const long = "x".repeat(600);
    const vec = Array.from({ length: 384 }, (_, i) => i / 384);
    const out = compactValue({ s: long, e: vec, short: [1, 2, 3], nested: { e: vec, t: "ok" }, n: 5, nil: null }) as any;
    assert.ok(out.s.startsWith("x".repeat(500)) && out.s.endsWith("[+100 chars]"));
    assert.equal(out.e, "[vector: 384 numbers]");
    assert.deepEqual(out.short, [1, 2, 3]);
    assert.equal(out.nested.e, "[vector: 384 numbers]");
    assert.equal(out.nested.t, "ok");
    assert.equal(out.n, 5);
    assert.equal(out.nil, null);
  });
});

describe("graph_query tool gating + the per-backend conventions", () => {
  async function deps(graph?: GraphBackend) {
    const s = defineStep({ type: "noop", input: z.object({}), output: z.any(), async run() { return 1; } });
    const registry = await createRegistry([s]);
    return { workspace: new WorkspaceManager("/nonexistent-graph-query-test"), registry, store: new MemoryRunStore(), getRegistry: async () => registry, graph };
  }
  it("is absent without a backend and present with one", async () => {
    assert.ok(!("graph_query" in buildTools(await deps())));
    const fake = { kind: "neo4j", cfg: { namespace: "ns-x" } } as unknown as Neo4jBackend;
    const tools = buildTools(await deps(fake)) as Record<string, { description?: string }>;
    assert.ok("graph_query" in tools);
    assert.match(tools["graph_query"]!.description ?? "", /"ns-x"/);
    assert.match(tools["graph_query"]!.description ?? "", /Neo4j/);
  });
  it("describes a Ladybug file's layout, in the tool and in the prompt", async () => {
    const lb = { kind: "ladybug", cfg: { kind: "ladybug", path: "/data/graph/graph.lbug", namespace: "default" } } as unknown as GraphBackend;
    const tools = buildTools(await deps(lb)) as Record<string, { description?: string }>;
    assert.match(tools["graph_query"]!.description ?? "", /LadybugDB file/);
    assert.match(tools["graph_query"]!.description ?? "", /node_type: 'Concept'/);
    assert.doesNotMatch(tools["graph_query"]!.description ?? "", /Data_Bank/);
    const system = await buildSystem(await deps(lb));
    assert.match(system, /Graph backend: a LadybugDB file \(\/data\/graph\/graph\.lbug\)\. In graph_query, every node is a row of the one Node table/);
    const neo = await buildSystem(await deps({ kind: "neo4j", cfg: { namespace: "default" } } as unknown as Neo4jBackend));
    assert.match(neo, /Graph backend: Neo4j \(namespace "default"\)\. In graph_query, every node has its type as a label/);
    assert.doesNotMatch(await buildSystem(await deps()), /Graph backend:/);
  });
});

// ── Live, on both engines (Ladybug always; Neo4j with STRUT_TEST_NEO4J_URI) ──

const BLOB = "b".repeat(2000);
const VEC = Array.from({ length: 384 }, (_, i) => i / 384);

for (const tb of testBackends()) {
  describe(`readQuery (${tb.name})`, { skip: tb.skip }, () => {
    let backend: GraphBackend;
    let node: string;
    before(async () => {
      backend = await tb.open();
      await tb.wipe(backend);
      node = backend.dialect.node("n", "Concept");
      // 250 Concepts, each with a long description and a vector — as rows
      // of the one table on Ladybug, as labelled nodes on Neo4j.
      if (backend.kind === "neo4j") {
        await backend.bolt.run(
          `UNWIND range(1, 250) AS i
           CREATE (:Concept:Node:Data_Bank {ref_id: 'w' + i, node_key: 'w' + i, namespace: 'default',
                   name: 'widget ' + i, description: $blob, text_embeddings: $vec})`,
          { blob: BLOB, vec: VEC },
        );
      } else {
        await backend.lbug.exclusive((w) =>
          w(
            `UNWIND range(1, 250) AS i
             CREATE (:Node {ref_id: 'w' + CAST(i AS STRING), node_key: 'w' + CAST(i AS STRING), namespace: 'default', node_type: 'Concept',
                     name: 'widget ' + CAST(i AS STRING), description: $blob, text_embeddings: CAST($vec AS FLOAT[384])})`,
            { blob: BLOB, vec: VEC },
          ),
        );
      }
    });
    after(async () => {
      await tb.wipe(backend);
      await tb.close(backend);
    });

    it("returns columns + rows with params", async () => {
      const r = await readQuery(backend, `MATCH ${node} WHERE n.namespace = $ns RETURN count(n) AS n`, { params: { ns: "default" } });
      assert.deepEqual(r.columns, ["n"]);
      assert.deepEqual(r.rows, [{ n: 250 }]);
      assert.equal(r.truncated, false);
      assert.equal(r.rowCount, 1);
    });

    it("caps rows (streaming) and compacts values", async () => {
      const r = await readQuery(backend, `MATCH ${node} RETURN n ORDER BY n.name`, { maxRows: 10 });
      assert.equal(r.rowCount, 10);
      assert.equal(r.rows.length, 10);
      assert.equal(r.truncated, true);
      if (backend.kind === "neo4j") {
        const got = r.rows[0]!["n"] as { labels: string[]; properties: Record<string, unknown> };
        assert.ok(got.labels.includes("Concept"));
        assert.equal(got.properties["text_embeddings"], "[vector: 384 numbers]");
        assert.match(String(got.properties["description"]), /\[\+1500 chars\]$/);
      } else {
        // The whole row: every column, nulls dropped, no engine keys.
        const got = r.rows[0]!["n"] as Record<string, unknown>;
        assert.equal(got["node_type"], "Concept");
        assert.equal(got["text_embeddings"], "[vector: 384 numbers]");
        assert.match(String(got["description"]), /\[\+1500 chars\]$/);
        assert.ok(!("_id" in got) && !("_label" in got) && !("deleted_at" in got));
      }
    });

    it("default cap is 100", async () => {
      const r = await readQuery(backend, `MATCH ${node} RETURN n.ref_id`);
      assert.equal(r.rowCount, 100);
      assert.equal(r.truncated, true);
    });

    it("rejects writes at the pre-check", async () => {
      await assert.rejects(readQuery(backend, `MATCH ${node} SET n.name = 'x'`), ReadOnlyViolation);
      await assert.rejects(readQuery(backend, `COPY (MATCH ${node} RETURN n.name) TO '/tmp/out.csv'`), ReadOnlyViolation);
      const n = await readQuery(backend, `MATCH ${node} WHERE n.name = 'x' RETURN count(n) AS n`);
      assert.deepEqual(n.rows, [{ n: 0 }]);
    });

    it("the engine rejects a write that slips past the pre-check", async () => {
      // Bypass the keyword guard: run the same read-only path the tool uses
      // with a write statement.
      if (backend.kind === "neo4j") {
        const session = backend.bolt.session("READ");
        try {
          await assert.rejects(
            session.executeRead((tx) => tx.run(`MATCH ${node} SET n.name = 'x' RETURN n`)),
            /read access mode|read-only|Writing in read access mode/i,
          );
        } finally {
          await session.close();
        }
      } else {
        const ro = await backend.lbug.readOnly();
        try {
          await assert.rejects(ro.run(`MATCH ${node} SET n.name = 'x' RETURN n.name`));
          await assert.rejects(ro.run(`CALL DROP_FTS_INDEX('Node', 'node_fts')`));
        } finally {
          await ro.close();
        }
      }
      const n = await readQuery(backend, `MATCH ${node} WHERE n.name = 'x' RETURN count(n) AS n`);
      assert.deepEqual(n.rows, [{ n: 0 }]);
    });

    it("surfaces syntax errors from the engine", async () => {
      await assert.rejects(readQuery(backend, "MATCH (n RETURN n"), /Invalid input|SyntaxError|Parser exception|syntax/i);
    });

    it("empty result still reports columns", async () => {
      const r = await readQuery(backend, `MATCH ${backend.dialect.node("n", "Nope")} RETURN n.name AS a, n.description AS b`);
      assert.deepEqual(r.columns, ["a", "b"]);
      assert.equal(r.rowCount, 0);
    });
  });
}
