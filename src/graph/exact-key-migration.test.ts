import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { composeNodeKey } from "./node-writer.js";
import { seedStrutDomain } from "./schema-seed.js";
import { getStrutSchema, nodeKeyFields, typeLabelOf } from "./strut-schemas.js";
import { graphSnapshot, testGraphConfig, wipeGraph } from "./test-util.js";
import { Neo4jWorkspaceStore } from "./workspace-store.js";
import { EXACT_KEY_MIGRATION_ID, migrateExactKeys } from "./exact-key-migration.js";

const cfg = testGraphConfig();
const STEP = (type: string) => `export default { type: ${JSON.stringify(type)}, input: {}, output: {}, async run() { return 1; } };`;
const steps = (message: string) => ({ steps: [{ id: "a", type: "log", config: { message } }] });

describe("exact-key-migration (live Neo4j)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let backend: GraphBackend;
  let scratch: string;
  before(async () => {
    backend = await openGraphBackend(cfg!, { embeddings: false, skipBoot: true });
    scratch = await mkdtemp(join(tmpdir(), "strut-exact-key-"));
    await wipeGraph(backend.bolt);
    await seedStrutDomain(backend.bolt);
  });
  after(async () => {
    await backend.close();
    await rm(scratch, { recursive: true, force: true });
  });

  /** Every workspace node with the identity attributes its key is made of. */
  async function workspaceNodes() {
    const rows = await backend.bolt.run(
      `MATCH (n:Domain_strut) WHERE n:StrutWorkflow OR n:StrutWorkflowVersion OR n:StrutStep OR n:StrutStepVersion
       RETURN n.ref_id AS ref_id, labels(n) AS labels, properties(n) AS p ORDER BY ref_id`,
    );
    return rows.map((r) => {
      const schema = getStrutSchema(typeLabelOf(r["labels"] as string[])!)!;
      const p = r["p"] as Record<string, unknown>;
      const values: Record<string, unknown> = {};
      for (const f of nodeKeyFields(schema)) values[f] = p[f];
      return { ref_id: r["ref_id"] as string, schema, values, node_key: p["node_key"] as string };
    });
  }

  it("re-keys an older graph's workspace nodes on their exact names; the names that used to collide can then be published beside them", async () => {
    const { bolt } = backend;
    const ws = new Neo4jWorkspaceStore(backend, { materializeDir: join(scratch, "steps") });
    await ws.publishStep("pod_test", STEP("pod_test"), "underscore");
    await ws.publishStep("old/one", STEP("old/one"), "gone");
    assert.equal(await ws.deleteStep("old/one"), true); // soft-deleted nodes move too
    await ws.publishWorkflow("a-b", "v1", steps("one"), "dash");
    await ws.publishWorkflow("a-b", "v2", steps("two"), "dash two");
    await bolt.run(
      `CREATE (:Node:Data_Bank:StrutRun:Domain_strut {ref_id: "r1", run_id: "1", node_key: "strutrun-1", namespace: $ns,
               workflow_name: "a-b", run_status: "success", started_at: 1})`,
      { ns: cfg!.namespace },
    );
    const deletedRef = (await bolt.run(`MATCH (s:StrutStep {step_type: "old/one"}) RETURN s.ref_id AS r`))[0]!["r"];

    // What a pre-fix strut wrote: the same spec, jarvis's sanitizer.
    const nodes = await workspaceNodes();
    assert.equal(nodes.length, 7, "2 steps + 2 step versions + 1 workflow + 2 versions");
    await bolt.run(`UNWIND $rows AS row MATCH (n:Data_Bank {ref_id: row.ref_id}) SET n.node_key = row.key`, {
      rows: nodes.map((n) => ({ ref_id: n.ref_id, key: composeNodeKey({ type: n.schema.type, node_key: n.schema.node_key }, n.values) })),
    });
    assert.equal((await bolt.run(`MATCH (s:StrutStep {step_type: "pod_test"}) RETURN s.node_key AS k`))[0]!["k"], "strutstep-podtest");

    const r = await migrateExactKeys(bolt);
    assert.deepEqual(r, {
      status: "migrated",
      rekeyed: { StrutWorkflow: 1, StrutWorkflowVersion: 2, StrutStep: 2, StrutStepVersion: 2 },
      skipped: 0,
    });
    for (const n of await workspaceNodes()) {
      assert.equal(n.node_key, composeNodeKey(n.schema, n.values), `${n.schema.type} ${JSON.stringify(n.values)}`);
    }
    assert.equal((await bolt.run(`MATCH (r:StrutRun) RETURN r.node_key AS k`))[0]!["k"], "strutrun-1", "run nodes keep jarvis's keys");
    assert.equal((await migrateExactKeys(bolt)).status, "already_done");
    assert.equal(
      Number((await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: EXACT_KEY_MIGRATION_ID }))[0]!["c"]),
      1,
    );

    // Everything is still reachable by name …
    assert.deepEqual((await ws.listSteps()).map((s) => [s.type, s.description]), [["pod_test", "underscore"]]);
    assert.deepEqual(Object.keys((await ws.getWorkflowMetadata("a-b"))!.versions), ["v1", "v2"]);
    assert.ok((await ws.getWorkflowSource("a-b", "v2")).includes("two"));
    // … the names that used to land on these nodes get nodes of their own …
    await ws.publishStep("pod/test", STEP("pod/test"), "slash");
    await ws.publishWorkflow("a_b", "v1", steps("under"), "underscore");
    assert.deepEqual((await ws.listSteps()).map((s) => [s.type, s.description]), [["pod/test", "slash"], ["pod_test", "underscore"]]);
    assert.deepEqual(
      (await ws.listWorkflows()).map((w) => [w.name, w.description, w.versions]),
      [["a-b", "dash two", ["v1", "v2"]], ["a_b", "underscore", ["v1"]]],
    );
    // … and a republish of the deleted name restores ITS node (found by key).
    await ws.publishStep("old/one", STEP("old/one"), "back");
    assert.equal(
      (await bolt.run(`MATCH (s:StrutStep {step_type: "old/one"}) WHERE s.is_deleted = false RETURN s.ref_id AS r`))[0]!["r"],
      deletedRef,
    );
  });

  it("runs at boot, once", async () => {
    await backend.close();
    backend = await openGraphBackend(cfg!, { embeddings: false });
    assert.equal(backend.exactKeyMigration?.status, "already_done");
  });

  it("refuses a graph where a node already holds the key another would move to, and changes nothing", async () => {
    const { bolt } = backend;
    await bolt.run(`MATCH (m:Migration {migration_id: $id}) DELETE m`, { id: EXACT_KEY_MIGRATION_ID });
    // Two nodes for one step: one on the sanitized key (a renamed Vein node,
    // say), one already exact — the first would move onto the second.
    await bolt.run(
      `CREATE (:StrutStep:Node:Data_Bank:Domain_strut {node_key: 'strutstep-s', namespace: $ns, ref_id: 'old-ref', step_type: 's'})
       CREATE (:StrutStep:Node:Data_Bank:Domain_strut {node_key: 'strutstep-73', namespace: $ns, ref_id: 'new-ref', step_type: 's'})`,
      { ns: cfg!.namespace },
    );
    const snap = await graphSnapshot(bolt);
    await assert.rejects(migrateExactKeys(bolt), /strutstep-s → strutstep-73 \(held by new-ref\)/);
    assert.deepEqual(await graphSnapshot(bolt), snap);
    assert.equal(Number((await bolt.run(`MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c`, { id: EXACT_KEY_MIGRATION_ID }))[0]!["c"]), 0);
  });
});
