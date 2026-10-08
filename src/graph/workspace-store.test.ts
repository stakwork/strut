import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraphBackend, type GraphBackend } from "./backend.js";
import { composeNodeKey } from "./node-writer.js";
import { seedStrutDomain } from "./schema-seed.js";
import { getStrutSchema } from "./strut-schemas.js";
import { testGraphConfig, wipeGraph } from "./test-util.js";
import { Neo4jWorkspaceStore } from "./workspace-store.js";
import { workspaceConformance } from "../test-util/workspace-conformance.js";

/**
 * Live tests (opt-in via STRUT_TEST_NEO4J_URI — see test-util.ts). The
 * graph store passes the same `WorkspaceStore` conformance suite as the
 * file store; the cases below cover what is graph-specific: the edges,
 * soft deletion, and persistence across store instances.
 */

const cfg = testGraphConfig();
let backend: GraphBackend;
let scratch: string;

async function reset() {
  await wipeGraph(backend.bolt);
  await seedStrutDomain(backend.bolt);
  await rm(scratch, { recursive: true, force: true });
}

if (cfg) {
  before(async () => {
    backend = await openGraphBackend(cfg, { embeddings: false, skipBoot: true });
    scratch = await mkdtemp(join(tmpdir(), "strut-graph-ws-"));
  });
  after(async () => {
    await backend.close();
    await rm(scratch, { recursive: true, force: true });
  });
}

workspaceConformance({
  name: "Neo4jWorkspaceStore",
  skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set",
  reset,
  make: () => new Neo4jWorkspaceStore(backend, { materializeDir: join(scratch, "steps") }),
});

const STEP = (type: string) => `export default { type: ${JSON.stringify(type)}, input: {}, output: {}, async run() { return 1; } };`;
/** The key the writer composes for a workspace node (`exact_key`: hex of the name). */
const key = (type: string, data: Record<string, unknown>) => composeNodeKey(getStrutSchema(type)!, data);

describe("Neo4jWorkspaceStore (graph-specific)", { skip: cfg ? false : "STRUT_TEST_NEO4J_URI not set" }, () => {
  let ws: Neo4jWorkspaceStore;
  beforeEach(async () => {
    await reset();
    ws = new Neo4jWorkspaceStore(backend, { materializeDir: join(scratch, "steps") });
  });

  const edgesOf = async (edge: string) =>
    backend.bolt.run(`MATCH (a:Data_Bank)-[r:\`${edge}\`]->(b:Data_Bank) RETURN a.node_key AS a, b.node_key AS b ORDER BY a, b`);

  it("writes jarvis-dialect nodes with the Strut labels and VERSION_OF / ACTIVE_VERSION edges", async () => {
    await ws.publishWorkflow("wf", "v1", { steps: [{ id: "a", type: "log", config: { message: "x" } }] }, "first");
    const rows = await backend.bolt.run(
      `MATCH (n:Domain_strut) RETURN labels(n) AS labels, n.node_key AS key, n.namespace AS ns ORDER BY key`,
    );
    assert.deepEqual(
      rows.map((r) => [(r["labels"] as string[]).filter((l) => l.startsWith("Strut"))[0], r["key"], r["ns"]]),
      [
        ["StrutWorkflow", key("StrutWorkflow", { name: "wf" }), cfg!.namespace],
        ["StrutWorkflowVersion", key("StrutWorkflowVersion", { name: "wf", content_hash: await ws.getWorkflowHash("wf") }), cfg!.namespace],
      ],
    );
    assert.equal((await edgesOf("VERSION_OF")).length, 1);
    assert.equal((await edgesOf("ACTIVE_VERSION")).length, 1);
  });

  it("swaps the ACTIVE_VERSION edge on activation and never duplicates it", async () => {
    await ws.publishWorkflow("wf", "v1", { steps: [{ id: "a", type: "log", config: { message: "1" } }] });
    await ws.publishWorkflow("wf", "v2", { steps: [{ id: "a", type: "log", config: { message: "2" } }] });
    let active = await edgesOf("ACTIVE_VERSION");
    assert.equal(active.length, 1);
    assert.equal(active[0]!["b"], key("StrutWorkflowVersion", { name: "wf", content_hash: await ws.getWorkflowHash("wf", "v2") }));
    await ws.setActiveVersion("wf", "v1");
    active = await edgesOf("ACTIVE_VERSION");
    assert.equal(active.length, 1);
    assert.equal(active[0]!["b"], key("StrutWorkflowVersion", { name: "wf", content_hash: await ws.getWorkflowHash("wf", "v1") }));
    assert.equal((await edgesOf("VERSION_OF")).length, 2);
  });

  it("links a version to the custom steps it uses and the workflows it depends on", async () => {
    await ws.publishStep("my/tool", STEP("my/tool"));
    await ws.publishWorkflow("child", "v1", { steps: [{ id: "a", type: "log", config: { message: "c" } }] });
    await ws.publishWorkflow("parent", "v1", {
      steps: [
        { id: "t", type: "my/tool", config: {} },
        { id: "s", type: "subflow", config: { workflow: "child" } },
        { id: "l", type: "loop", config: { steps: [{ id: "inner", type: "my/tool", config: {} }] } },
      ],
    });
    assert.deepEqual(
      (await edgesOf("USES_STEP")).map((r) => [r["a"], r["b"]]),
      [[key("StrutWorkflowVersion", { name: "parent", content_hash: await ws.getWorkflowHash("parent") }), key("StrutStep", { step_type: "my/tool" })]],
    );
    assert.deepEqual(
      (await edgesOf("DEPENDS_ON")).map((r) => [r["a"], r["b"]]),
      [[key("StrutWorkflowVersion", { name: "parent", content_hash: await ws.getWorkflowHash("parent") }), key("StrutWorkflow", { name: "child" })]],
    );
  });

  it("re-labels rather than duplicates when the same content is published under a new label", async () => {
    const content = { steps: [{ id: "a", type: "log", config: { message: "same" } }] };
    await ws.publishWorkflow("wf", "v1", content);
    await ws.publishWorkflow("wf", "v9", content);
    const meta = await ws.getWorkflowMetadata("wf");
    assert.deepEqual(Object.keys(meta!.versions), ["v9"]);
    assert.equal(meta!.active, "v9");
    const count = await backend.bolt.run(`MATCH (v:StrutWorkflowVersion) RETURN count(v) AS c`);
    assert.equal(count[0]!["c"], 1);
  });

  it("deleteStep is a soft delete: nodes stay, stamped, edges go, and a republish restores the identity with its edges", async () => {
    await ws.publishStep("s", STEP("s"), "one");
    const before = await backend.bolt.run(`MATCH (n:StrutStep) RETURN n.ref_id AS ref_id`);
    assert.equal(await ws.deleteStep("s"), true);
    const flagged = await backend.bolt.run(`MATCH (n) WHERE n:StrutStep OR n:StrutStepVersion RETURN n.is_deleted AS d, n.deleted_at IS NOT NULL AS stamped`);
    assert.deepEqual(flagged, [{ d: true, stamped: true }, { d: true, stamped: true }]);
    assert.deepEqual([(await edgesOf("VERSION_OF")).length, (await edgesOf("ACTIVE_VERSION")).length], [0, 0], "a delete removes the edges");
    assert.deepEqual(await ws.listSteps(), []);
    assert.equal(await ws.getStepSource("s"), null);

    await ws.publishStep("s", STEP("s"), "again");
    const after = await backend.bolt.run(`MATCH (n:StrutStep) WHERE n.is_deleted IS NULL AND n.deleted_at IS NULL RETURN n.ref_id AS ref_id`);
    assert.equal(after[0]!["ref_id"], before[0]!["ref_id"], "same node_key → restored, ref_id preserved");
    assert.deepEqual([(await edgesOf("VERSION_OF")).length, (await edgesOf("ACTIVE_VERSION")).length], [1, 1], "the re-create writes the edges it needs");
    assert.deepEqual((await ws.listSteps()).map((s) => [s.type, s.description]), [["s", "again"]]);
    assert.deepEqual(await ws.listStepVersions("s"), { active: "v1", versions: ["v1"] });
  });

  it("deleteWorkflow: a re-publish of the same content comes back with its own edges, not the ones other nodes had to it", async () => {
    await ws.publishStep("my/tool", STEP("my/tool"));
    const content = { steps: [{ id: "t", type: "my/tool", config: {} }] };
    await ws.publishWorkflow("child", "v1", content);
    await ws.publishWorkflow("parent", "v1", { steps: [{ id: "s", type: "subflow", config: { workflow: "child" } }] });
    assert.equal((await edgesOf("DEPENDS_ON")).length, 1);

    assert.equal(await ws.deleteWorkflow("child"), true);
    assert.equal(await ws.getWorkflowMetadata("child"), null);
    const childEdges = await backend.bolt.run(`MATCH (n:Data_Bank)-[r]-() WHERE (n:StrutWorkflow OR n:StrutWorkflowVersion) AND n.name = "child" RETURN count(r) AS c`);
    assert.equal(childEdges[0]!["c"], 0, "every edge of the deleted workflow is gone");

    await ws.publishWorkflow("child", "v1", content);
    assert.equal((await ws.getWorkflowMetadata("child"))!.active, "v1");
    const hash = await ws.getWorkflowHash("child");
    const v = key("StrutWorkflowVersion", { name: "child", content_hash: hash });
    const w = key("StrutWorkflow", { name: "child" });
    assert.deepEqual((await edgesOf("VERSION_OF")).filter((r) => r["b"] === w).map((r) => r["a"]), [v]);
    assert.deepEqual((await edgesOf("ACTIVE_VERSION")).filter((r) => r["a"] === w).map((r) => r["b"]), [v]);
    assert.deepEqual((await edgesOf("USES_STEP")).filter((r) => r["a"] === v).length, 1);
    assert.equal((await edgesOf("DEPENDS_ON")).length, 0, "parent's DEPENDS_ON to it does not come back");
  });

  it("a node with only deleted_at (no is_deleted) is hidden", async () => {
    await ws.publishStep("s", STEP("s"));
    await ws.publishWorkflow("wf", "v1", { steps: [{ id: "a", type: "log", config: { message: "x" } }] });
    await backend.bolt.run(`MATCH (n) WHERE n:StrutStep OR n:StrutWorkflow SET n.deleted_at = 1`);
    assert.deepEqual(await ws.listSteps(), []);
    assert.deepEqual(await ws.listWorkflows(), []);
    assert.equal(await ws.getWorkflowMetadata("wf"), null);
  });

  it("is persistent: a second store over the same backend sees everything, and materialization prunes stale files", async () => {
    await ws.publishStep("keep", STEP("keep"));
    await ws.publishStep("drop", STEP("drop"));
    const dir = await ws.materializeCustomSteps();
    const other = new Neo4jWorkspaceStore(backend, { materializeDir: join(scratch, "steps") });
    assert.deepEqual((await other.listSteps()).map((s) => s.type), ["drop", "keep"]);
    await other.deleteStep("drop");
    assert.equal(await ws.materializeCustomSteps(), dir);
    const { readdir } = await import("node:fs/promises");
    // package.json is the ESM-scope marker `ensureEsmScope` pins beside the steps.
    assert.deepEqual((await readdir(dir)).sort(), ["keep.ts", "package.json"]);
  });

  it("helpers (_-prefixed) are stored and materialized but not listed", async () => {
    await ws.publishStep("ns/_shared", "export const x = 1;");
    await ws.publishStep("ns/real", STEP("ns/real"));
    assert.deepEqual((await ws.listSteps()).map((s) => s.type), ["ns/real"]);
    const dir = await ws.materializeCustomSteps();
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual((await readdir(join(dir, "ns"))).sort(), ["_shared.ts", "real.ts"]);
  });
});
