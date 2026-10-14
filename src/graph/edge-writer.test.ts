import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { GraphBackend } from "./backend.js";
import { Bolt, int } from "./bolt.js";
import { seedJarvisOntology } from "./ontology-seed.js";
import { seedStrutDomain } from "./schema-seed.js";
import { GraphValidationError, NodeWriter } from "./node-writer.js";
import { EdgeWriter, edgeKeyFor, isRegisteredEdge, typeLabelOf } from "./edge-writer.js";
import { edgeCount, graphSnapshot, rawEdge, rawWrite, testBackends } from "./test-util.js";

describe("edge registry checks (pure)", () => {
  it("resolves the type label from jarvis's label set", () => {
    assert.equal(typeLabelOf(["Data_Bank", "Domain_strut", "Node", "StrutRun"]), "StrutRun");
    assert.equal(typeLabelOf(["Node", "Data_Bank", "Concept", "Domain_general"]), "Concept");
    assert.equal(typeLabelOf(["Node", "Data_Bank"]), undefined);
  });
  it("matches registry rows; ACCESSED accepts any target", () => {
    assert.equal(isRegisteredEdge("IN_RUN", "StrutAgentSession", "StrutRun"), true);
    assert.equal(isRegisteredEdge("IN_RUN", "StrutRun", "StrutAgentSession"), false);
    assert.equal(isRegisteredEdge("VERSION_OF", "StrutStepVersion", "StrutStep"), true);
    assert.equal(isRegisteredEdge("VERSION_OF", "StrutStepVersion", "StrutWorkflow"), false);
    assert.equal(isRegisteredEdge("ACCESSED", "StrutToolCall", "Concept"), true);
    assert.equal(isRegisteredEdge("ACCESSED", "StrutToolCall", ""), true);
    assert.equal(isRegisteredEdge("ACCESSED", "StrutRun", "Concept"), false);
    assert.equal(isRegisteredEdge("HAS_TURN", "StrutChat", "StrutTurn"), false);
  });
  it("edge_key is the lowercased type", () => {
    assert.equal(edgeKeyFor("IN_RUN"), "in_run");
  });
});

for (const tb of testBackends()) {
  describe(`EdgeWriter on ${tb.name}`, { skip: tb.skip }, () => {
    const neo = tb.kind === "neo4j";
    const neoOnly = (why: string) => ({ skip: neo ? false : `neo4j only: ${why}` });
    let backend: GraphBackend;
    let nodes: NodeWriter;
    let edges: EdgeWriter;
    let run: string;
    let job: string;
    let wf: string;
    let wfv: string;
    before(async () => {
      backend = await tb.open();
      await tb.wipe(backend);
      // Concept (the move tests) and the claim types need the jarvis ontology on Neo4j; the file has them in its registry.
      if (neo) await seedJarvisOntology(backend);
      await seedStrutDomain(backend);
    });
    after(async () => {
      await tb.close(backend);
    });
    beforeEach(async () => {
      await tb.clear(backend);
      nodes = backend.nodes;
      edges = backend.edges;
      const rs = await nodes.writeMany([
        { type: "StrutRun", data: { run_id: "r1", workflow_name: "wf", run_status: "ok", started_at: 1 } },
        { type: "StrutJob", data: { job_id: "j1", created_at: 1 } },
        { type: "StrutWorkflow", data: { name: "wf" } },
        { type: "StrutWorkflowVersion", data: { name: "wf", content_hash: "h1", created_at: 1 } },
      ]);
      [run, job, wf, wfv] = rs.map((r) => r.ref_id) as [string, string, string, string];
    });

    const rel = async (ref_id: string) => (await rawEdge(backend, ref_id))!;
    const bolt = () => (backend as { bolt: Bolt }).bolt;

    it("creates with the stamps, no namespace, and never mutates an existing edge", async () => {
      const t0 = Date.now();
      const a = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job });
      assert.equal(a.created, true);
      assert.equal(a.edge_key, "in_job");
      assert.equal(a.source_ref_id, run);
      assert.equal(a.target_ref_id, job);
      const r = await rel(a.ref_id);
      assert.equal(r.type, "IN_JOB");
      assert.deepEqual([r.src, r.tgt], [run, job]);
      assert.deepEqual(Object.keys(r.props).sort(), ["date_added_to_graph", "edge_key", "ref_id", "weight"]);
      assert.equal(r.props["weight"], 1);
      assert.ok((r.props["date_added_to_graph"] as number) >= t0);
      if (neo) {
        const vt = await bolt().run(`MATCH ()-[r {ref_id: $r}]->() RETURN valueType(r.weight) AS w, valueType(r.date_added_to_graph) AS d`, { r: a.ref_id });
        assert.deepEqual([vt[0]!["w"], vt[0]!["d"]], ["INTEGER NOT NULL", "INTEGER NOT NULL"]);
      }

      const snap = await graphSnapshot(backend);
      const b = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, weight: 5 });
      assert.equal(b.created, false);
      assert.equal(b.ref_id, a.ref_id);
      assert.deepEqual(await graphSnapshot(backend), snap);
      assert.equal(await edgeCount(backend, "IN_JOB"), 1);
    });

    it("rejects unknown types, unregistered triples, stamp overrides, and unresolvable endpoints — writing nothing", async () => {
      const snap = await graphSnapshot(backend);
      const cases: Array<[Parameters<EdgeWriter["write"]>[0], string]> = [
        [{ edge: "HAS_TURN", source_ref_id: run, target_ref_id: job }, "WRONG_TYPE"],
        [{ edge: "in_job", source_ref_id: run, target_ref_id: job }, "UNKNOWN_TYPE"],
        [{ edge: "IN_JOB", source_ref_id: job, target_ref_id: run }, "WRONG_TYPE"],
        [{ edge: "EXECUTED", source_ref_id: run, target_ref_id: job }, "WRONG_TYPE"],
        [{ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, properties: { ref_id: "x" } }, "UNKNOWN_ATTRIBUTE"],
        [{ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, properties: { "bad-name": 1 } }, "UNKNOWN_ATTRIBUTE"],
        [{ edge: "IN_JOB", source_ref_id: run, target_ref_id: randomUUID() }, "MISSING_REQUIRED"],
        [{ edge: "IN_JOB", source_ref_id: "", target_ref_id: job }, "MISSING_REQUIRED"],
      ];
      for (const [input, code] of cases) {
        await assert.rejects(edges.write(input), (e: unknown) => e instanceof GraphValidationError && e.code === code, `${JSON.stringify(input)} → ${code}`);
      }
      // Batch: one bad row poisons the whole batch.
      await assert.rejects(
        edges.writeMany([
          { edge: "IN_JOB", source_ref_id: run, target_ref_id: job },
          { edge: "EXECUTED", source_ref_id: run, target_ref_id: job },
        ]),
        GraphValidationError,
      );
      assert.deepEqual(await graphSnapshot(backend), snap);
    });

    it("the file takes only the edge properties the claim layer writes", { skip: neo && "ladybug only" }, async () => {
      await assert.rejects(
        edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, properties: { note: "x" } }),
        (e: unknown) => e instanceof GraphValidationError && e.code === "UNKNOWN_ATTRIBUTE" && e.attribute === "note",
      );
      const a = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, properties: { context: "{}", start_time: 3, strength: 0.5 } });
      const p = (await rel(a.ref_id)).props;
      assert.deepEqual([p["context"], p["start_time"], p["strength"]], ["{}", 3, 0.5]);
      assert.equal(await edgeCount(backend), 1);
    });

    it("update patches an existing edge by ref_id or by triple; stamps stay protected", async () => {
      const a = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, properties: { context: "x", strength: 0.5 } });
      const stamped = (await rel(a.ref_id)).props;

      const u = await edges.update({ ref_id: a.ref_id }, { set: { strength: -0.75, weight: 3 }, remove: ["context"] });
      assert.deepEqual(u, { ref_id: a.ref_id, edge: "IN_JOB", source_ref_id: run, target_ref_id: job, updated: ["strength", "weight"], removed: ["context"] });
      let p = (await rel(a.ref_id)).props;
      assert.equal(p["strength"], -0.75);
      assert.equal(p["weight"], 3);
      assert.ok(!("context" in p));
      for (const k of ["ref_id", "edge_key", "date_added_to_graph"]) assert.equal(p[k], stamped[k], `${k} untouched`);
      if (neo) {
        const vt = await bolt().run(`MATCH ()-[r {ref_id: $r}]->() RETURN valueType(r.weight) AS w`, { r: a.ref_id });
        assert.equal(vt[0]!["w"], "INTEGER NOT NULL", "integral weight stays an Integer");
      }

      // By triple (case-insensitive edge type), undefined values skipped.
      const t = await edges.update({ edge: "in job", source_ref_id: run, target_ref_id: job }, { set: { strength: 0.4, context: undefined } });
      assert.equal(t.ref_id, a.ref_id);
      assert.deepEqual(t.updated, ["strength"]);
      p = (await rel(a.ref_id)).props;
      assert.equal(p["strength"], 0.4);

      const cases: Array<[Parameters<EdgeWriter["update"]>, string]> = [
        [[{ ref_id: a.ref_id }, { set: { ref_id: "y" } }], "UNKNOWN_ATTRIBUTE"],
        [[{ ref_id: a.ref_id }, { set: { edge_key: "y" } }], "UNKNOWN_ATTRIBUTE"],
        [[{ ref_id: a.ref_id }, { remove: ["date_added_to_graph"] }], "UNKNOWN_ATTRIBUTE"],
        [[{ ref_id: a.ref_id }, { remove: ["weight"] }], "UNKNOWN_ATTRIBUTE"],
        [[{ ref_id: a.ref_id }, { set: { "bad-name": 1 } }], "UNKNOWN_ATTRIBUTE"],
        [[{ ref_id: a.ref_id }, {}], "MISSING_REQUIRED"],
        [[{ ref_id: randomUUID() }, { set: { strength: 1 } }], "NOT_FOUND"],
        [[{ edge: "IN_JOB", source_ref_id: job, target_ref_id: run }, { set: { strength: 1 } }], "NOT_FOUND"],
        [[{ edge: "in_job!", source_ref_id: run, target_ref_id: job }, { set: { strength: 1 } }], "UNKNOWN_TYPE"],
      ];
      for (const [args, code] of cases) {
        await assert.rejects(edges.update(...args), (e: unknown) => e instanceof GraphValidationError && e.code === code, `${JSON.stringify(args)} → ${code}`);
      }
    });

    it("a legacy flagged edge (muted, or is_deleted) is invisible to the triple lookup, and a write onto it makes it live", neoOnly("the file has no edge flags"), async () => {
      const a = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, properties: { note: "x" } });
      for (const flag of ["is_muted", "is_deleted"]) {
        await rawWrite(backend, `MATCH ()-[r {ref_id: $r}]->() SET r.is_muted = null, r.is_deleted = null SET r.${flag} = true`, { r: a.ref_id });
        await assert.rejects(edges.update({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job }, { set: { x: 1 } }), (e: any) => e.code === "NOT_FOUND", flag);
      }
      await rawWrite(backend, `MATCH ()-[r {ref_id: $r}]->() SET r.is_muted = true, r.is_deleted = true, r.muted_by_delete_of = "n1"`, { r: a.ref_id });
      const b = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job });
      assert.deepEqual([b.created, b.ref_id], [false, a.ref_id]);
      assert.deepEqual(Object.keys((await rel(a.ref_id)).props).sort(), ["date_added_to_graph", "edge_key", "note", "ref_id", "weight"], "flags cleared, nothing else touched");
    });

    it("ACCESSED may point at any node, including a jarvis-owned one; source must still be a Strut node", neoOnly("tool calls and ACCESSED are not in the file"), async () => {
      const [session, call] = (
        await nodes.writeMany([
          { type: "StrutAgentSession", data: { run_id: "r1", path: "wf/agent" } },
          { type: "StrutToolCall", data: { run_id: "r1", path: "wf/agent", seq: 0, tool_name: "search" } },
        ])
      ).map((r) => r.ref_id) as [string, string];
      await edges.write({ edge: "IN_RUN", source_ref_id: session, target_ref_id: run });
      // A jarvis-style Concept node: no Strut label, plain Data_Bank ref_id.
      const concept = randomUUID();
      await rawWrite(backend, `CREATE (:Concept:Node:Data_Bank:Domain_general {ref_id: $r, node_key: "concept-x", namespace: "default", name: "x"})`, { r: concept });
      const a = await edges.write({ edge: "ACCESSED", source_ref_id: call, target_ref_id: concept });
      assert.equal(a.created, true);
      assert.equal((await rel(a.ref_id)).tgt, concept);
      await assert.rejects(edges.write({ edge: "ACCESSED", source_ref_id: concept, target_ref_id: call }), GraphValidationError);
    });

    it("IS_ALIAS rewrite lands the edge on the canonical node", neoOnly("no alias rewrite in the file"), async () => {
      const canonical = (await nodes.write({ type: "StrutJob", data: { job_id: "canon", created_at: 1 } })).ref_id;
      // Park `job` as an alias of `canonical` (what jarvis node-merge does).
      await rawWrite(backend, `MATCH (a:Data_Bank {ref_id: $a}), (c:Data_Bank {ref_id: $c}) CREATE (a)-[:IS_ALIAS {ref_id: $e}]->(c)`, { a: job, c: canonical, e: randomUUID() });
      const r = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job });
      assert.equal(r.target_ref_id, canonical);
      assert.equal((await rel(r.ref_id)).tgt, canonical);
      const direct = await bolt().run(`MATCH (:StrutRun)-[r:IN_JOB]->(t:StrutJob {ref_id: $t}) RETURN count(r) AS c`, { t: job });
      assert.equal(direct[0]!["c"], 0);
    });

    it("writeMany: mixed edge types in one tx, input-order results; an explicit int stays one", async () => {
      const rs = await edges.writeMany([
        { edge: "EXECUTED", source_ref_id: run, target_ref_id: wfv, properties: { start_time: neo ? int(3) : 3 } },
        { edge: "IN_JOB", source_ref_id: run, target_ref_id: job },
        { edge: "EXECUTED", source_ref_id: run, target_ref_id: wfv },
      ]);
      assert.deepEqual(rs.map((r) => [r.edge_key, r.created]), [["executed", true], ["in_job", true], ["executed", false]]);
      assert.equal(rs[0]!.ref_id, rs[2]!.ref_id);
      assert.equal((await rel(rs[0]!.ref_id)).props["start_time"], 3);
      if (neo) {
        const vt = await bolt().run(`MATCH ()-[r {ref_id: $r}]->() RETURN valueType(r.start_time) AS t`, { r: rs[0]!.ref_id });
        assert.equal(vt[0]!["t"], "INTEGER NOT NULL");
      }
    });

    it("caller weight overrides the stamp", async () => {
      const a = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job, weight: 3 });
      assert.equal((await rel(a.ref_id)).props["weight"], 3);
      await edges.delete(a.ref_id);
      const b = await edges.write({ edge: "EXECUTED", source_ref_id: run, target_ref_id: wfv, weight: 0.5 });
      assert.equal((await rel(b.ref_id)).props["weight"], 0.5);
      if (neo) {
        const vt = await bolt().run(`MATCH ()-[r {ref_id: $r}]->() RETURN valueType(r.weight) AS t`, { r: b.ref_id });
        assert.equal(vt[0]!["t"], "FLOAT NOT NULL");
      }
    });

    it("delete removes the edge; an unknown ref_id is a miss", async () => {
      const a = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job });
      assert.equal(await edges.delete(a.ref_id), true);
      assert.equal(await rawEdge(backend, a.ref_id), null);
      assert.equal(await edges.delete(a.ref_id), false);
      assert.equal(await edges.delete("nope"), false);
      const again = await edges.write({ edge: "IN_JOB", source_ref_id: run, target_ref_id: job });
      assert.equal(again.created, true, "a re-write after a delete is a new edge");
    });

    it("the claim edges: TESTS, ABOUT, EVIDENCED_BY with strength, HAS_SOURCE with context", async () => {
      const [claim, check, ev] = (
        await nodes.writeMany([
          { type: "Claim", data: { id: "c1", name: "n", claim_text: "it holds", belief_valid_from: 1 } },
          { type: "Check", data: { id: "k1", name: "k", created_at: 1, policy: "always" } },
          { type: "Evidence", data: { id: "e1", name: "e", evidence_mode: "observed", evidence_status: "collected" } },
        ])
      ).map((r) => r.ref_id) as [string, string, string];
      const rs = await edges.writeMany([
        { edge: "ABOUT", source_ref_id: claim, target_ref_id: wf },
        { edge: "TESTS", source_ref_id: check, target_ref_id: claim },
        { edge: "EVIDENCED_BY", source_ref_id: claim, target_ref_id: ev, properties: { strength: 1 } },
        { edge: "PRODUCED_BY", source_ref_id: ev, target_ref_id: check },
        { edge: "ABOUT", source_ref_id: ev, target_ref_id: wfv },
        { edge: "HAS_SOURCE", source_ref_id: ev, target_ref_id: run, properties: { context: JSON.stringify({ path: "wf/step" }), start_time: 1, end_time: 2 } },
      ]);
      assert.deepEqual(rs.map((r) => r.created), [true, true, true, true, true, true]);
      assert.equal((await rel(rs[2]!.ref_id)).props["strength"], 1);
      assert.equal((await rel(rs[5]!.ref_id)).props["context"], JSON.stringify({ path: "wf/step" }));
      // The registry knows the triples exactly; jarvis's rules are looser (TESTS
      // is on its allowlist, Claim-[ABOUT]->Thing reaches any type by ancestry).
      if (neo) {
        assert.equal((await edges.write({ edge: "TESTS", source_ref_id: claim, target_ref_id: check })).created, true);
        assert.equal((await edges.write({ edge: "ABOUT", source_ref_id: claim, target_ref_id: run })).created, true);
      } else {
        await assert.rejects(edges.write({ edge: "TESTS", source_ref_id: claim, target_ref_id: check }), (e: unknown) => e instanceof GraphValidationError && e.code === "WRONG_TYPE", "the other way round");
        await assert.rejects(edges.write({ edge: "ABOUT", source_ref_id: claim, target_ref_id: run }), (e: unknown) => e instanceof GraphValidationError && e.code === "WRONG_TYPE", "a claim is about a workflow or a step");
      }
    });

    it("move re-homes a Concept along CHILD_OF, carries the edge's properties, and refuses a cycle", async () => {
      const [root, a, b, c] = (
        await nodes.writeMany([
          { type: "Concept", data: { name: "Root" } },
          { type: "Concept", data: { name: "A" } },
          { type: "Concept", data: { name: "B" } },
          { type: "Concept", data: { name: "C" } },
        ])
      ).map((r) => r.ref_id) as [string, string, string, string];
      // root ← a ← b ← c
      const [ar] = await edges.writeMany([
        { edge: "CHILD_OF", source_ref_id: a, target_ref_id: root, weight: 2 },
        { edge: "CHILD_OF", source_ref_id: b, target_ref_id: a },
        { edge: "CHILD_OF", source_ref_id: c, target_ref_id: b },
      ]);
      // a under c would put a below itself.
      await assert.rejects(
        edges.move({ ref_id: a, edge: "CHILD_OF", direction: "forward", to_ref_id: c }),
        (e: unknown) => e instanceof GraphValidationError && e.code === "WRONG_TYPE" && /cycle/.test(e.message),
      );
      await assert.rejects(edges.move({ ref_id: a, edge: "CHILD_OF", direction: "forward", to_ref_id: a }), (e: unknown) => e instanceof GraphValidationError && e.code === "WRONG_TYPE");
      // Already there: nothing written.
      const same = await edges.move({ ref_id: a, edge: "CHILD_OF", direction: "forward", to_ref_id: root });
      assert.equal(same.moved, false);
      // c under root: the old edge goes, the new one carries the properties.
      const moved = await edges.move({ ref_id: c, edge: "CHILD_OF", direction: "forward", to_ref_id: root });
      assert.deepEqual([moved.moved, moved.ref_id, moved.from_ref_id, moved.to_ref_id], [true, c, b, root]);
      assert.equal(await rawEdge(backend, moved.previous_edge_ref_id), null, "the old edge is gone");
      const now = (await rel(moved.edge_ref_id));
      assert.deepEqual([now.src, now.tgt], [c, root]);
      // b is below a, so a under b is still a cycle; c is not any more.
      await assert.rejects(edges.move({ ref_id: a, edge: "CHILD_OF", direction: "forward", to_ref_id: b }), (e: unknown) => e instanceof GraphValidationError && /cycle/.test(e.message));
      const again = await edges.move({ ref_id: a, edge: "CHILD_OF", direction: "forward", to_ref_id: c });
      assert.equal(again.moved, true);
      assert.equal((await rel(again.edge_ref_id)).props["weight"], 2, "the moved edge keeps its properties");
      assert.equal(await rawEdge(backend, ar!.ref_id), null);
      await assert.rejects(edges.move({ ref_id: randomUUID(), edge: "CHILD_OF", direction: "forward", to_ref_id: root }), (e: unknown) => e instanceof GraphValidationError && e.code === "NOT_FOUND");
      await assert.rejects(edges.move({ ref_id: root, edge: "CHILD_OF", direction: "forward", to_ref_id: a }), (e: unknown) => e instanceof GraphValidationError && e.code === "NOT_FOUND", "root hangs under nothing");
    });
  });
}
