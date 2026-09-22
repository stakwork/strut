import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Bolt } from "./bolt.js";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { seedStrutDomain, DOMAIN_FULLTEXT_INDEX_V2 } from "./schema-seed.js";
import { searchableAttributes } from "./strut-schemas.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";
import { RUN_STATUS_MIGRATION_ID, migrateRunStatus } from "./run-status-migration.js";

const cfg = testGraphConfig();

describe("run-status-migration (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let bolt: Bolt;
  before(async () => {
    bolt = new Bolt(cfg!);
    await wipeGraph(bolt);
  });
  after(async () => {
    await bolt.close();
  });

  it("moves an old graph's StrutRun.status to run_status, fixes the Schema and the fulltext index, and failed runs become visible", async () => {
    // A graph seeded before the rename: old Schema attribute + index list,
    // the fulltext index over `status`, runs carrying `status`.
    await seedStrutDomain(bolt);
    await bolt.run(
      `MATCH (s:Schema {type: "StrutRun"}) SET s.status = "string", s.index = ["workflow_name", "status", "summary"] REMOVE s.run_status`,
    );
    await bolt.run(`DROP INDEX \`${DOMAIN_FULLTEXT_INDEX_V2}\``);
    const oldProps = [...searchableAttributes().filter((p) => p !== "run_status"), "status", "node_key"].map((p) => `n.\`${p}\``).join(", ");
    await bolt.run(`CREATE FULLTEXT INDEX \`${DOMAIN_FULLTEXT_INDEX_V2}\` FOR (n:Domain_strut) ON EACH [${oldProps}]`);
    await bolt.run(
      `UNWIND [["r1", "error"], ["r2", "success"]] AS row
       CREATE (:Node:Data_Bank:StrutRun:Domain_strut {ref_id: row[0], run_id: row[0], node_key: "strutrun-" + row[0], namespace: "default",
               workflow_name: "wf", status: row[1], started_at: 1})`,
    );

    const r = await migrateRunStatus(bolt);
    assert.deepEqual(r, { status: "migrated", runs: 2, schemaUpdated: true, droppedFulltextIndex: true });
    const runs = await bolt.run(`MATCH (r:StrutRun) RETURN r.run_id AS id, r.run_status AS rs, r.status AS s ORDER BY id`);
    assert.deepEqual(runs.map((x) => [x["id"], x["rs"], x["s"]]), [["r1", "error", null], ["r2", "success", null]]);
    const [schema] = await bolt.run(`MATCH (s:Schema {type: "StrutRun"}) RETURN s.status AS s, s.run_status AS rs, s.index AS idx`);
    assert.deepEqual([schema!["s"], schema!["rs"], schema!["idx"]], [null, "string", ["workflow_name", "run_status", "summary"]]);
    assert.equal((await migrateRunStatus(bolt)).status, "already_done");
    assert.equal(Number((await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: RUN_STATUS_MIGRATION_ID }))[0]!["c"]), 1);

    // Boot: the seed rebuilds the fulltext index over run_status, and the
    // reader no longer hides the failed run.
    let backend: GraphBackend | undefined;
    try {
      backend = await openGraphBackend(cfg!, { embeddings: false });
      assert.equal(backend.runStatusMigration?.status, "already_done");
      const [idx] = await bolt.run(`SHOW INDEXES YIELD name, properties WHERE name = $n RETURN properties`, { n: DOMAIN_FULLTEXT_INDEX_V2 });
      assert.ok((idx!["properties"] as string[]).includes("run_status"));
      assert.equal((await backend.reader.getNode("r1"))?.ref_id, "r1", "a failed run is visible to the reader");
    } finally {
      await backend?.close();
    }
  });
});
