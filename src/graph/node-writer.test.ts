import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GraphBackend } from "./backend.js";
import { Bolt } from "./bolt.js";
import { seedStrutDomain } from "./schema-seed.js";
import {
  GraphValidationError,
  NodeWriter,
  buildSearchText,
  composeNodeKey,
  renderVectorField,
  toEpochSeconds,
  validateNode,
  type Embedder,
} from "./node-writer.js";
import { getStrutSchema } from "./strut-schemas.js";
import { fromStrut } from "./schema-resolver.js";
import { edgeCount, graphSnapshot, nodeCount, rawNode, seedConceptSchema, setNodeProps, testBackends, testGraphConfig } from "./test-util.js";
import { composeTitle, nodeTitle, nodeTitleFor } from "./title.js";
import { createNodeSchema } from "./schema-crud.js";

const fixturesDir = new URL("./fixtures/", import.meta.url);

function rejects(fn: () => unknown, code: string, attribute?: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GraphValidationError, `expected GraphValidationError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (attribute) assert.equal(e.attribute, attribute);
    return;
  }
  assert.fail(`expected ${code}`);
}

const RUN = {
  run_id: "1725220000123",
  workflow_name: "harvey-deliver",
  run_status: "success",
  summary: "Delivered 60 of 60",
  started_at: "2026-09-01T20:00:00Z",
  duration_ms: 1234,
};

describe("validateNode (§6 gate)", () => {
  it("accepts a valid payload and normalizes datetime to epoch seconds", () => {
    const v = validateNode("StrutRun", RUN);
    assert.equal(v.values["started_at"], 1788292800);
    assert.equal(v.values["duration_ms"], 1234);
    assert.equal(v.values["summary"], "Delivered 60 of 60");
    // Neo4j params: ints wrapped as Integer.
    assert.equal(String(v.params["started_at"]), "1788292800");
    assert.equal(typeof v.params["summary"], "string");
  });
  it("rejects unknown types (exact match only)", () => {
    rejects(() => validateNode("Run", RUN), "UNKNOWN_TYPE");
    rejects(() => validateNode("strutrun", RUN), "UNKNOWN_TYPE");
  });
  it("rejects unknown and generic attributes", () => {
    rejects(() => validateNode("StrutRun", { ...RUN, colour: "red" }), "UNKNOWN_ATTRIBUTE", "colour");
    rejects(() => validateNode("StrutRun", { ...RUN, ref_id: "x" }), "UNKNOWN_ATTRIBUTE", "ref_id");
    rejects(() => validateNode("StrutRun", { ...RUN, Data_Bank: "x" }), "UNKNOWN_ATTRIBUTE", "Data_Bank");
    rejects(() => validateNode("StrutRun", { ...RUN, node_key: "x" }), "UNKNOWN_ATTRIBUTE", "node_key");
  });
  it("accepts Thing-inherited attributes", () => {
    const v = validateNode("StrutRun", { ...RUN, unique_source_id: "strutrun:1", is_muted: false, weight: 2 });
    assert.equal(v.values["unique_source_id"], "strutrun:1");
    assert.equal(v.values["weight"], 2);
  });
  it("rejects missing / null / empty required attributes", () => {
    const { run_status: _s, ...noStatus } = RUN;
    rejects(() => validateNode("StrutRun", noStatus), "MISSING_REQUIRED", "run_status");
    rejects(() => validateNode("StrutRun", { ...RUN, run_status: null }), "MISSING_REQUIRED", "run_status");
    rejects(() => validateNode("StrutRun", { ...RUN, run_status: "" }), "MISSING_REQUIRED", "run_status");
  });
  it("drops optional null/undefined/empty values instead of writing them", () => {
    const v = validateNode("StrutRun", { ...RUN, summary: "", log_ref: null, error_message: undefined });
    assert.ok(!("summary" in v.values));
    assert.ok(!("log_ref" in v.values));
    assert.ok(!("error_message" in v.values));
  });
  it("type-checks per the grammar, stricter than Python", () => {
    rejects(() => validateNode("StrutRun", { ...RUN, duration_ms: true }), "WRONG_TYPE", "duration_ms");
    rejects(() => validateNode("StrutRun", { ...RUN, duration_ms: 1.5 }), "WRONG_TYPE", "duration_ms");
    rejects(() => validateNode("StrutRun", { ...RUN, duration_ms: "12" }), "WRONG_TYPE", "duration_ms");
    rejects(() => validateNode("StrutRun", { ...RUN, run_status: 1 }), "WRONG_TYPE", "run_status");
    rejects(() => validateNode("StrutRun", { ...RUN, is_muted: "no" }), "WRONG_TYPE", "is_muted");
    rejects(() => validateNode("StrutRun", { ...RUN, started_at: "yesterday" }), "INVALID_DATETIME", "started_at");
    // int-where-float is fine.
    assert.equal(validateNode("StrutRun", { ...RUN, weight: 3 }).values["weight"], 3);
  });
  it("datetime accepts ISO, epoch seconds, epoch ms, numeric strings", () => {
    assert.equal(toEpochSeconds("2026-09-01T20:00:00Z"), 1788292800);
    assert.equal(toEpochSeconds("2026-09-01T20:00:00+00:00"), 1788292800);
    assert.equal(toEpochSeconds(1788292800), 1788292800);
    assert.equal(toEpochSeconds(1788292800123), 1788292800);
    assert.equal(toEpochSeconds("1788292800123"), 1788292800);
    assert.equal(toEpochSeconds(new Date(1788292800000)), 1788292800);
    assert.equal(toEpochSeconds("nope"), null);
    assert.equal(toEpochSeconds({}), null);
  });
  it("rejects node_key attributes that sanitize to nothing", () => {
    rejects(() => validateNode("StrutRun", { ...RUN, run_id: "---" }), "EMPTY_NODE_KEY_TOKEN", "run_id");
  });
});

describe("composeNodeKey (parity with jarvis sanitize_node_key)", () => {
  const cases = JSON.parse(readFileSync(new URL("node-key-parity.json", fixturesDir), "utf8")) as Array<{
    type: string;
    node_key_spec: string;
    props: Record<string, unknown>;
    expected: string;
  }>;
  for (const c of cases) {
    it(`${c.type} ${JSON.stringify(c.props).slice(0, 60)}`, () => {
      // The fixture's own spec, no `exact_key`: jarvis's algorithm as such,
      // whatever strut keys the type on today.
      assert.equal(composeNodeKey({ type: c.type, key_spec: c.node_key_spec }, c.props), c.expected);
    });
  }
  it("property lookup is case-insensitive", () => {
    assert.equal(composeNodeKey(getStrutSchema("StrutRun")!, { RUN_ID: "Abc" }), "strutrun-abc");
  });
});

describe("composeNodeKey (exact_key — strut's workspace types)", () => {
  it("keys on the hex of the exact name, so punctuation-only differences are different nodes", () => {
    const step = getStrutSchema("StrutStep")!;
    const keys = ["pod/test", "pod-test", "pod_test", "podtest", "Pod/Test"].map((t) => composeNodeKey(step, { step_type: t }));
    assert.equal(new Set(keys).size, keys.length, keys.join(" "));
    assert.equal(keys[0], "strutstep-706f642f74657374");
    assert.equal(Buffer.from(keys[0]!.slice("strutstep-".length), "hex").toString("utf8"), "pod/test", "reversible");
    // Everything else about a key holds: the type token, `-` between tokens,
    // case-insensitive lookup, the 200-char collapse.
    const version = getStrutSchema("StrutWorkflowVersion")!;
    assert.equal(composeNodeKey(version, { NAME: "a-b", content_hash: "c1" }), "strutworkflowversion-612d62-6331");
    assert.match(composeNodeKey(version, { name: "x".repeat(120), content_hash: "c1" }), /^strutworkflowversion-[0-9a-f]{32}$/);
    for (const t of ["StrutWorkflow", "StrutWorkflowVersion", "StrutStep", "StrutStepVersion"]) assert.equal(getStrutSchema(t)!.exact_key, true, t);
    assert.equal(getStrutSchema("StrutRun")!.exact_key, undefined, "run and chat nodes keep jarvis's keys");
    assert.equal(fromStrut(step).exact_key, true, "the resolver's view carries the flag");
  });
  it("validates exact-key tokens like any other", () => {
    assert.equal(validateNode("StrutStep", { step_type: "pod/test" }).values["step_type"], "pod/test");
    rejects(() => validateNode("StrutStep", { step_type: "" }), "MISSING_REQUIRED", "step_type");
  });
});

describe("titles (title.ts)", () => {
  it("a title_key is a field or a template, trimmed; else the first line of the text, then of the search text", () => {
    assert.equal(composeTitle("name", { name: "  Ada  " }), "Ada");
    assert.equal(composeTitle("{first} {last}", { first: "Ada", last: "Lovelace" }), "Ada Lovelace");
    assert.equal(composeTitle("{first} {last}", { first: "Ada" }), "Ada");
    assert.equal(composeTitle(undefined, { name: "n" }), "n", "name by default");
    assert.equal(composeTitle("name", { name: "x".repeat(300) }).length, 200, "bounded");
    assert.equal(nodeTitleFor({ title_key: "name" }, { text: "first line\nsecond" }, "ignored"), "first line");
    assert.equal(nodeTitleFor({ title_key: "name" }, {}, "  search line\nmore"), "search line");
    assert.equal(nodeTitleFor({ title_key: "name" }, {}, null), "");
  });
  it("a reader takes the type's title_key over the properties, then the stored title", () => {
    assert.equal(nodeTitle({ name: "Alice Smith", title: "CEO" }, "name"), "Alice Smith", "a jarvis Person's title is a job title");
    assert.equal(nodeTitle({ name: "Alice Smith", title: "CEO" }), "Alice Smith", "title_key defaults to name");
    assert.equal(nodeTitle({ title: "Plan", name: "plan" }, "title"), "Plan", "a type whose title_key is title");
    assert.equal(nodeTitle({ title: "First line of the text" }, "name"), "First line of the text", "the writer's fallback when the key is empty");
    assert.equal(nodeTitle({ workflow_name: "wf" }, "workflow_name"), "wf", "a node written before titles");
    assert.equal(nodeTitle({}, "name"), "");
  });
});

describe("buildSearchText (Data_Bank)", () => {
  it("joins index fields in declared order with newlines, skipping blanks", () => {
    const s = fromStrut(getStrutSchema("StrutRun")!);
    assert.deepEqual(buildSearchText(s, { summary: " sum ", workflow_name: "wf", run_status: "  " }), {
      text: "wf\nsum",
      fields: ["workflow_name", "summary"],
    });
    // No usable index field → jarvis's kitchen-sink fallback (priority
    // fields first, then everything not in DATA_BANK_EXCLUDED_FIELDS).
    assert.deepEqual(buildSearchText(s, { run_id: "x", duration_ms: 5, run_status: "" }), { text: "x\n5", fields: ["run_id", "duration_ms"] });
    assert.deepEqual(buildSearchText(s, { log_ref: "" }), { text: null, fields: [] });
  });
  it("kitchen-sink fallback: priority order, exclusions, non-string values", () => {
    const s = fromStrut(getStrutSchema("StrutChat")!);
    // StrutChat index [title, summary] both absent → fallback over the rest.
    assert.deepEqual(buildSearchText(s, { chat_id: "c1", model: "m", status: "live", turn_count: 3, name: "n" }), {
      text: "n\nc1\nm\n3",
      fields: ["name", "chat_id", "model", "turn_count"],
    });
  });
  it("renders vector fields like jarvis render_schema", () => {
    assert.equal(renderVectorField("input_schema", " {a: 1} "), "Input:\n{a: 1}");
    assert.equal(renderVectorField("output_schema", "x"), "Output:\nx");
    assert.equal(renderVectorField("usage_examples", "x"), "Usage examples:\nx");
    assert.equal(renderVectorField("input_schema", "  "), null);
  });
});

for (const tb of testBackends()) {
  describe(`NodeWriter on ${tb.name}`, { skip: tb.skip }, () => {
    const neo = tb.kind === "neo4j";
    /** The stored search text: a Ladybug file keeps it on one line (its full-text index splits on spaces alone). */
    const st = (text: string) => (neo ? text : text.replace(/\s+/g, " "));
    const neoOnly = (why: string) => ({ skip: neo ? false : `neo4j only: ${why}` });
    let backend: GraphBackend;
    let writer: NodeWriter;
    before(async () => {
      backend = await tb.open();
    });
    after(async () => {
      await tb.close(backend);
    });
    beforeEach(async () => {
      await tb.wipe(backend);
      await seedStrutDomain(backend);
      writer = backend.nodes;
    });

    const node = (ref_id: string) => rawNode(backend, ref_id);
    const props = async (ref_id: string) => (await node(ref_id))!.props;
    const fakeEmbedder = (seen: string[]): Embedder => ({
      async embed(texts) {
        seen.push(...texts);
        return texts.map((t) => Array.from({ length: 384 }, (_, i) => (i === 0 ? t.length : 0)));
      },
    });
    const JOB = { job_id: "job-1", title: "A job", started_at: 1788292800 };

    it("create: the type, the stamps, key, search_text, title — and on Neo4j jarvis's label set and typed ints", async () => {
      const t0 = Date.now();
      const r = await writer.write({ type: "StrutRun", data: { ...RUN, log_ref: "", ...(neo ? { weight: 1 } : {}) } });
      assert.equal(r.outcome, "created");
      assert.equal(r.key, "strutrun-1725220000123");
      assert.match(r.ref_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      const n = (await node(r.ref_id))!;
      assert.equal(n.type, "StrutRun");
      const p = n.props;
      assert.equal(p["namespace"], neo ? "default" : "private", "a file's own namespace is private");
      assert.equal(p["key"], "strutrun-1725220000123");
      assert.ok((p["created_at"] as number) >= t0 && (p["created_at"] as number) <= Date.now() + 1);
      assert.equal(p["started_at"], 1788292800);
      assert.equal(p["search_text"], st("harvey-deliver\nsuccess\nDelivered 60 of 60"));
      assert.equal(p["title"], neo ? undefined : "harvey-deliver", "the type's title_key, workflow_name (Neo4j stores no core title)");
      assert.ok(!("log_ref" in p), "empty string never written");
      assert.ok(!("text_embeddings" in p), "no embedder → NULL, not a marker");
      assert.ok(!("is_deleted" in p) && !("deleted_at" in p));
      if (neo) {
        assert.deepEqual(p["_search_fields_used"], ["workflow_name", "run_status", "summary"]);
        assert.deepEqual(
          Object.keys(p).sort(),
          ["_search_fields_used", "created_at", "duration_ms", "key", "namespace", "ref_id", "run_id", "run_status", "search_text", "started_at", "summary", "updated_at", "weight", "workflow_name"],
        );
        const bolt = (backend as { bolt: Bolt }).bolt;
        const rows = await bolt.run(
          `MATCH (n:Data_Bank {ref_id: $r})
           RETURN labels(n) AS labels, valueType(n.date_added_to_graph) AS dateType, valueType(n.started_at) AS startedType,
                  valueType(n.duration_ms) AS durType, valueType(n.weight) AS weightType`,
          { r: r.ref_id },
        );
        assert.deepEqual([...(rows[0]!["labels"] as string[])].sort(), ["Data_Bank", "Domain_strut", "Node", "StrutRun"]);
        assert.equal(rows[0]!["dateType"], "INTEGER NOT NULL", "date_added_to_graph is a Neo4j Integer (ms)");
        assert.equal(rows[0]!["startedType"], "INTEGER NOT NULL", "datetime attrs are Integer seconds");
        assert.equal(rows[0]!["durType"], "INTEGER NOT NULL");
        assert.equal(rows[0]!["weightType"], "FLOAT NOT NULL");
      } else {
        // The file keeps no jarvis stamps and no `_search_fields_used`.
        assert.deepEqual(
          Object.keys(p).sort(),
          ["created_at", "duration_ms", "key", "namespace", "ref_id", "run_id", "run_status", "search_text", "started_at", "summary", "title", "updated_at", "workflow_name"],
        );
      }
    });

    it("create on an existing key is a no-op returning the existing ref_id", async () => {
      const a = await writer.write({ type: "StrutRun", data: RUN });
      const snap = await graphSnapshot(backend);
      const b = await writer.write({ type: "StrutRun", data: { ...RUN, summary: "CHANGED" } });
      assert.equal(b.outcome, "existing");
      assert.equal(b.ref_id, a.ref_id);
      assert.deepEqual(await graphSnapshot(backend), snap);
    });

    it("upsert updates everything except the preserved identity and rebuilds Data_Bank", async () => {
      const a = await writer.write({ type: "StrutRun", data: RUN });
      const before = await props(a.ref_id);
      const b = await writer.write({ type: "StrutRun", data: { ...RUN, run_status: "error", summary: "boom", error_message: "x" } }, "upsert");
      assert.equal(b.outcome, "updated");
      assert.equal(b.ref_id, a.ref_id);
      const after = await props(a.ref_id);
      assert.equal(after["created_at"], before["created_at"]);
      assert.equal(after["key"], before["key"]);
      assert.equal(after["run_status"], "error");
      assert.equal(after["error_message"], "x");
      assert.equal(after["search_text"], st("harvey-deliver\nerror\nboom"));
      assert.ok(!("is_deleted" in after), "upsert on a live node does not add is_deleted");
    });

    it("soft delete stamps deleted_at (ms, first time kept) and deletes the node's edges (on a Ladybug file, hides them)", async () => {
      const run = await writer.write({ type: "StrutRun", data: RUN });
      const job = await writer.write({ type: "StrutJob", data: JOB });
      await backend.edges.write({ edge: "IN_JOB", source_ref_id: run.ref_id, target_ref_id: job.ref_id });
      assert.equal(await edgeCount(backend, "IN_JOB"), 1);
      const t0 = Date.now();
      assert.equal(await writer.softDelete(run.ref_id), true);
      const p = await props(run.ref_id);
      assert.ok(typeof p["deleted_at"] === "number" && p["deleted_at"] >= t0 && p["deleted_at"] <= Date.now(), `deleted_at in ms, got ${p["deleted_at"]}`);
      if (neo) assert.equal(p["is_deleted"], true);
      assert.equal(await edgeCount(backend, "IN_JOB"), neo ? 0 : 1, "the edge is gone (Neo4j) or kept (Ladybug)");
      assert.deepEqual((await backend.reader.neighbors(job.ref_id)).edges, [], "no read shows it");
      assert.equal(await nodeCount(backend, "StrutRun"), 0, "hidden from live reads");
      assert.equal(await nodeCount(backend, "StrutJob"), 1, "the other end stays");

      // A second delete keeps the first time.
      await setNodeProps(backend, run.ref_id, { deleted_at: 1 });
      assert.equal(await writer.softDelete(run.ref_id), true);
      assert.equal((await props(run.ref_id))["deleted_at"], 1);
      assert.equal(await writer.softDelete("not-a-ref"), false);
      assert.equal(await writer.softDelete(job.ref_id), true, "any Strut node");
    });

    it("deleteNode: any type in the namespace, the edges counted; a miss is null; the Strut guard stays on softDelete", async () => {
      const run = await writer.write({ type: "StrutRun", data: RUN });
      const job = await writer.write({ type: "StrutJob", data: JOB });
      const wf = await writer.write({ type: "StrutWorkflowVersion", data: { name: "wf", content_hash: "h1", published_at: 1 } });
      await backend.edges.writeMany([
        { edge: "IN_JOB", source_ref_id: run.ref_id, target_ref_id: job.ref_id },
        { edge: "EXECUTED", source_ref_id: run.ref_id, target_ref_id: wf.ref_id },
      ]);
      const t0 = Date.now();
      // Neo4j deletes both edges, counted; a Ladybug file keeps them, hidden.
      assert.deepEqual(await writer.deleteNode(run.ref_id), { edges: neo ? 2 : 0 }, "both edges went with it, counted");
      const p = await props(run.ref_id);
      assert.ok(typeof p["deleted_at"] === "number" && p["deleted_at"] >= t0, `deleted_at in ms, got ${p["deleted_at"]}`);
      assert.equal(await edgeCount(backend), neo ? 0 : 2);
      assert.equal(await nodeCount(backend, "StrutRun"), 0, "hidden from live reads");
      assert.equal(await nodeCount(backend, "StrutJob"), 1, "the other ends stay");
      assert.equal(await writer.deleteNode("not-a-ref"), null);
      assert.deepEqual(await writer.deleteNode(job.ref_id), { edges: 0 }, "a node with no edges");
      assert.equal(await writer.deleteNode(wf.ref_id, { namespace: "elsewhere" }), null, "scoped to the namespace");
      assert.equal(await nodeCount(backend, "StrutWorkflowVersion"), 1);
      // Not a Strut type: softDelete's Domain_strut guard refuses it, deleteNode takes it.
      if (!neo) return; // the file's registry has no Concept Schema row to seed here; the step suite covers it
      const bolt = (backend as { bolt: Bolt }).bolt;
      await bolt.run(
        `MATCH (w:Data_Bank {ref_id: $w})
         CREATE (c:Concept:Node:Data_Bank {ref_id: "concept-1", node_key: "concept-1", namespace: $ns})
         CREATE (c)-[:PARENT_OF {ref_id: "e-c"}]->(w)`,
        { w: wf.ref_id, ns: backend.namespace },
      );
      assert.equal(await writer.softDelete("concept-1"), false, "not a Strut node");
      assert.deepEqual(await writer.deleteNode("concept-1"), { edges: 1 });
      assert.equal(await edgeCount(backend, "PARENT_OF"), 0);
    });

    it("soft delete scope: only in-scope edges go (Schema and other-namespace ends stay)", neoOnly("Schema nodes and namespaces exist only on Neo4j"), async () => {
      const bolt = (backend as { bolt: Bolt }).bolt;
      const a = await writer.write({ type: "StrutRun", data: RUN });
      const b = await writer.write({ type: "StrutRun", data: { ...RUN, run_id: "2" } });
      await bolt.run(
        `MATCH (a:Data_Bank {ref_id: $a}), (b:Data_Bank {ref_id: $b})
         CREATE (s:Schema {type: "Scratch", ref_id: "schema-x"})
         CREATE (o:Concept:Node:Data_Bank {ref_id: "other-ns", node_key: "concept-o", namespace: "elsewhere"})
         CREATE (a)-[:IN_RUN {ref_id: "e-in"}]->(b), (a)-[:INSTANCE_OF {ref_id: "e-schema"}]->(s), (o)-[:MENTIONS {ref_id: "e-ns"}]->(a)`,
        { a: a.ref_id, b: b.ref_id },
      );
      assert.equal(await writer.softDelete(a.ref_id), true);
      const vt = await bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) RETURN valueType(n.deleted_at) AS t`, { r: a.ref_id });
      assert.equal(vt[0]!["t"], "INTEGER NOT NULL");
      const left = await bolt.run(`MATCH ()-[r]-() WHERE r.ref_id STARTS WITH "e-" RETURN DISTINCT r.ref_id AS r ORDER BY r`);
      assert.deepEqual(left.map((r) => r["r"]), ["e-ns", "e-schema"], "the in-scope edge is gone; Schema and other-namespace edges stay");
    });

    it("soft delete + create restores in place (markers cleared; its edges back on a Ladybug file only)", async () => {
      const run = await writer.write({ type: "StrutRun", data: RUN });
      const job = await writer.write({ type: "StrutJob", data: JOB });
      await backend.edges.write({ edge: "IN_JOB", source_ref_id: run.ref_id, target_ref_id: job.ref_id });
      assert.equal(await writer.softDelete(run.ref_id), true);
      const r = await writer.write({ type: "StrutRun", data: { ...RUN, summary: "back" } });
      assert.equal(r.outcome, "restored");
      assert.equal(r.ref_id, run.ref_id);
      const p = await props(run.ref_id);
      assert.ok(!("is_deleted" in p) && !("deleted_at" in p), "a restore clears the markers");
      assert.equal(p["summary"], "back");
      assert.equal(await edgeCount(backend, "IN_JOB"), neo ? 0 : 1, "a restore brings back no edges (Neo4j) or the ones it kept (Ladybug)");
      assert.equal((await backend.reader.neighbors(job.ref_id)).edges.length, neo ? 0 : 1);

      // A node with only deleted_at set is deleted, and restored.
      await setNodeProps(backend, run.ref_id, { deleted_at: 5 });
      const r1 = await writer.write({ type: "StrutRun", data: { ...RUN, summary: "again" } });
      assert.equal(r1.outcome, "restored");
      const p1 = await props(run.ref_id);
      assert.ok(!("deleted_at" in p1));
      assert.equal(p1["summary"], "again");
    });

    it("delete and mute are independent: a muted, deleted node is restored but stays muted", neoOnly("is_muted is a jarvis stamp the file does not keep"), async () => {
      const a = await writer.write({ type: "StrutRun", data: RUN });
      await setNodeProps(backend, a.ref_id, { is_muted: true });
      assert.equal(await writer.softDelete(a.ref_id), true);
      const r2 = await writer.write({ type: "StrutRun", data: { ...RUN, summary: "muted" } });
      assert.equal(r2.outcome, "restored");
      const p2 = await props(a.ref_id);
      assert.ok(!("deleted_at" in p2) && !("is_deleted" in p2));
      assert.equal(p2["is_muted"], true);
      assert.equal(p2["summary"], "muted");
    });

    it("writeMany: mixed types in one tx, input-order results, per-type batches", async () => {
      const rs = await writer.writeMany([
        { type: "StrutJob", data: JOB },
        { type: "StrutRun", data: RUN },
        { type: "StrutWorkflow", data: { name: "wf", description: "a workflow" } },
        { type: "StrutRun", data: { ...RUN, run_id: "2" } },
      ]);
      assert.deepEqual(rs.map((r) => r.outcome), ["created", "created", "created", "created"]);
      assert.deepEqual(rs.map((r) => r.key), ["strutjob-6a6f622d31", "strutrun-1725220000123", "strutworkflow-7766", "strutrun-2"]);
      assert.equal(await nodeCount(backend), 4);
      assert.equal((await props(rs[2]!.ref_id))["search_text"], st("wf\na workflow"));
      const rs2 = await writer.writeMany([
        { type: "StrutRun", data: { ...RUN, summary: "again" } },
        { type: "StrutRun", data: { ...RUN, run_id: "3" } },
      ]);
      assert.deepEqual(rs2.map((r) => r.outcome), ["existing", "created"]);
      assert.equal(rs2[0]!.ref_id, rs[1]!.ref_id);
    });

    it("a validation failure anywhere in a batch writes nothing", async () => {
      const snap = await graphSnapshot(backend);
      await assert.rejects(
        writer.writeMany([
          { type: "StrutRun", data: RUN },
          { type: "StrutRun", data: { ...RUN, run_id: "2", bogus: 1 } },
        ]),
        GraphValidationError,
      );
      assert.deepEqual(await graphSnapshot(backend), snap);
    });

    it("with an embedder: text_embeddings rebuilt on upsert; per-stem vectors on Neo4j only", async () => {
      const seen: string[] = [];
      const w = new NodeWriter(backend, { embedder: fakeEmbedder(seen), resolver: backend.schemas });
      const r = await w.write({ type: "StrutStep", data: { step_type: "x/y", description: "d", input_schema: "{a}", output_schema: "" } });
      const p = await props(r.ref_id);
      assert.equal((p["text_embeddings"] as number[]).length, 384);
      assert.equal((p["text_embeddings"] as number[])[0], "x/y\nd".length);
      if (neo) {
        assert.deepEqual(seen, ["x/y\nd", "Input:\n{a}"]);
        assert.equal((p["input_embeddings"] as number[])[0], "Input:\n{a}".length);
        assert.ok(!("output_embeddings" in p));
        const vt = await (backend as { bolt: Bolt }).bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) RETURN valueType(n.text_embeddings) AS t`, { r: r.ref_id });
        assert.equal(vt[0]!["t"], "LIST<FLOAT NOT NULL> NOT NULL");
      } else {
        assert.deepEqual(seen, [st("x/y\nd")], "no per-stem vectors in the file");
        assert.ok(!("input_embeddings" in p));
      }
      await w.write({ type: "StrutStep", data: { step_type: "x/y", description: "dd", input_schema: "{ab}" } }, "upsert");
      const p2 = await props(r.ref_id);
      assert.equal((p2["text_embeddings"] as number[])[0], "x/y\ndd".length);
      if (neo) assert.equal((p2["input_embeddings"] as number[])[0], "Input:\n{ab}".length);
    });

    it("embed: later — the text written, the vector left to the background embedder (and cleared on an update); inline where there is none", async () => {
      const seen: string[] = [];
      const handed: string[] = [];
      const w = new NodeWriter(backend, { embedder: fakeEmbedder(seen), resolver: backend.schemas, later: (refs) => handed.push(...refs) });
      const a = await w.write({ type: "StrutStep", data: { step_type: "x/y", description: "d" } });
      assert.equal(((await props(a.ref_id))["text_embeddings"] as number[])[0], "x/y\nd".length, "written as always: a vector");
      seen.length = 0;
      const [b, c] = await w.writeMany(
        [
          { type: "StrutStep", data: { step_type: "x/y", description: "dd" } },
          { type: "StrutStep", data: { step_type: "x/z", description: "e" } },
        ],
        "upsert",
        { embed: "later" },
      );
      assert.equal(b!.ref_id, a.ref_id);
      assert.deepEqual(seen, [], "nothing embedded on the write");
      assert.deepEqual(handed, [a.ref_id, c!.ref_id], "both handed on, in order");
      const pb = await props(b!.ref_id);
      assert.equal(pb["search_text"], st("x/y\ndd"), "the text is written now");
      assert.ok(!("text_embeddings" in pb), "the old vector is gone with the old text");
      assert.ok(!("text_embeddings" in (await props(c!.ref_id))));
      // No background embedder, or the caller's transaction: inline, as always.
      handed.length = 0;
      const inline = new NodeWriter(backend, { embedder: fakeEmbedder(seen), resolver: backend.schemas });
      await inline.write({ type: "StrutStep", data: { step_type: "x/z", description: "ee" } }, "upsert", { embed: "later" });
      assert.equal(((await props(c!.ref_id))["text_embeddings"] as number[])[0], "x/z\nee".length);
      await backend.tx((tx) => w.write({ type: "StrutStep", data: { step_type: "x/y", description: "ddd" } }, "upsert", { embed: "later", tx }));
      assert.equal(((await props(a.ref_id))["text_embeddings"] as number[])[0], "x/y\nddd".length);
      assert.deepEqual(handed, []);
    });

    it("update: merge, remove, re-validate, re-key with collision check, rebuild Data_Bank", async () => {
      const seen: string[] = [];
      const w = new NodeWriter(backend, { embedder: fakeEmbedder(seen), resolver: backend.schemas });
      const a = await w.write({ type: "StrutRun", data: { ...RUN, log_ref: "runs/1" } });
      const before = await props(a.ref_id);
      const u = await w.update(a.ref_id, { set: { run_status: "error", error_message: "boom" }, remove: ["log_ref"] });
      assert.deepEqual(u, { ref_id: a.ref_id, key: "strutrun-1725220000123", rekeyed: false });
      const p = await props(a.ref_id);
      assert.equal(p["run_status"], "error");
      assert.equal(p["error_message"], "boom");
      assert.ok(!("log_ref" in p));
      assert.equal(p["summary"], RUN.summary, "untouched attrs survive");
      assert.equal(p["created_at"], before["created_at"]);
      assert.equal(p["search_text"], st("harvey-deliver\nerror\nDelivered 60 of 60"));
      assert.equal((p["text_embeddings"] as number[])[0], "harvey-deliver\nerror\nDelivered 60 of 60".length);
      // Remove every index field but one → Data_Bank rebuilt; remove all → dropped.
      await w.update(a.ref_id, { remove: ["summary"] });
      assert.equal((await props(a.ref_id))["search_text"], st("harvey-deliver\nerror"));
      // Validation still applies to the merged payload.
      await assert.rejects(w.update(a.ref_id, { set: { bogus: 1 } }), (e: unknown) => e instanceof GraphValidationError && e.code === "UNKNOWN_ATTRIBUTE");
      await assert.rejects(w.update(a.ref_id, { remove: ["run_status"] }), (e: unknown) => e instanceof GraphValidationError && e.code === "MISSING_REQUIRED");
      await assert.rejects(w.update(a.ref_id, { set: { duration_ms: "x" } }), (e: unknown) => e instanceof GraphValidationError && e.code === "WRONG_TYPE");
      await assert.rejects(w.update("nope", { set: { status: "x" } }), (e: unknown) => e instanceof GraphValidationError && e.code === "NOT_FOUND");
      // Re-key: editing an identity attr recomposes node_key; colliding fails.
      const b = await w.write({ type: "StrutRun", data: { ...RUN, run_id: "other" } });
      await assert.rejects(w.update(b.ref_id, { set: { run_id: "1725220000123" } }), (e: unknown) => e instanceof GraphValidationError && e.code === "DUPLICATE_KEY");
      const rk = await w.update(b.ref_id, { set: { run_id: "renamed" } });
      assert.deepEqual(rk, { ref_id: b.ref_id, key: "strutrun-renamed", rekeyed: true });
      assert.equal((await props(b.ref_id))["key"], "strutrun-renamed");
      // Without an embedder, a changed text drops the stale vector so backfill heals it.
      await writer.update(a.ref_id, { set: { run_status: "success" } });
      assert.ok(!("text_embeddings" in (await props(a.ref_id))));
    });

    it("stamps updated_at (epoch ms integer) on create, overwriting a caller value; undeclared types too", async () => {
      let clock = 1_800_000_000_000;
      const w = new NodeWriter(backend, { resolver: backend.schemas, now: () => clock });
      const a = await w.write({ type: "StrutRun", data: { ...RUN, updated_at: "yesterday" } });
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_000_000);
      assert.equal(typeof (await props(a.ref_id))["updated_at"], "number");
      assert.equal((await props(a.ref_id))["created_at"], 1_800_000_000_000, "one stamp: updated_at = created_at on create");
      clock += 1000;
      await w.write({ type: "StrutRun", data: RUN });
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_000_000);
    });

    it("update stamps updated_at, overwrites a caller value, and a no-op edit keeps the old stamp", async () => {
      let clock = 1_800_000_000_000;
      const w = new NodeWriter(backend, { resolver: backend.schemas, now: () => clock });
      const a = await w.write({ type: "StrutRun", data: RUN });
      clock += 5000;
      await w.update(a.ref_id, { set: { run_status: "error", updated_at: "x" } });
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_005_000);
      clock += 5000;
      const same = await w.update(a.ref_id, { set: { run_status: "error" } });
      assert.equal(same.rekeyed, false);
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_005_000, "no-op edit does not restamp");
      await w.write({ type: "StrutRun", data: { ...RUN, run_status: "error" } }, "upsert");
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_005_000, "no-op upsert does not restamp");
      await w.write({ type: "StrutRun", data: { ...RUN, run_status: "ok", summary: "changed" } }, "upsert");
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_010_000);
      await assert.rejects(
        w.update(a.ref_id, { remove: ["updated_at"] }),
        (e: unknown) => e instanceof GraphValidationError && e.attribute === "updated_at",
      );
    });

    it("updated_at follows the attributes: vectors keep it, a removal or a restore moves it", async () => {
      let clock = 1_800_000_000_000;
      const now = () => clock;
      const plain = new NodeWriter(backend, { resolver: backend.schemas, now });
      // Another model's vectors for the same text (jarvis's, the embedding pass's).
      const other: Embedder = { async embed(texts) { return texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 1 ? 0.5 : 0))); } };
      const a = await plain.write({ type: "StrutRun", data: RUN });
      clock += 1000;
      await new NodeWriter(backend, { embedder: fakeEmbedder([]), resolver: backend.schemas, now }).update(a.ref_id, { set: { summary: RUN.summary } });
      assert.ok("text_embeddings" in (await props(a.ref_id)));
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_000_000, "an update that only adds vectors");
      await new NodeWriter(backend, { embedder: other, resolver: backend.schemas, now }).write({ type: "StrutRun", data: RUN }, "upsert");
      assert.equal(((await props(a.ref_id))["text_embeddings"] as number[])[1], 0.5);
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_000_000, "an upsert whose vectors differ");
      await plain.update(a.ref_id, { remove: ["summary"] });
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_001_000, "removing an attribute is a change");
      clock += 1000;
      assert.ok(await plain.softDelete(a.ref_id));
      const r = await plain.write({ type: "StrutRun", data: RUN });
      assert.equal(r.outcome, "restored");
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_002_000);
      assert.equal((await props(a.ref_id))["created_at"], 1_800_000_000_000);
    });

    it("update: other generic keys stay refused even when the schema declares them", async () => {
      const a = await writer.write({ type: "StrutRun", data: RUN });
      const declaring = (k: string) => ({
        async schema(raw: string, tx?: never) {
          const s = await backend.schemas.schema(raw, tx);
          return !s || s.type !== "StrutRun" ? s : { ...s, attributes: { ...s.attributes, [k]: "?string" } };
        },
      }) as unknown as typeof backend.schemas;
      for (const k of ["ref_id", "namespace", "embeddings", "is_deleted"]) {
        const w = new NodeWriter(backend, { resolver: declaring(k) });
        await assert.rejects(
          w.update(a.ref_id, { set: { [k]: "x" } }),
          (e: unknown) => e instanceof GraphValidationError && e.code === "UNKNOWN_ATTRIBUTE" && e.attribute === k,
        );
      }
    });

    it("update: a type still declaring updated_at as ?string is editable after an integer stamp (edit trap)", neoOnly("the ladybug file has fixed columns: none of Strut's types declares updated_at"), async () => {
      const declaring = {
        async schema(raw: string, tx?: never) {
          const s = await backend.schemas.schema(raw, tx);
          return s && s.type === "StrutRun" ? { ...s, attributes: { ...s.attributes, updated_at: "?string" } } : s;
        },
      } as unknown as typeof backend.schemas;
      let clock = 1_800_000_000_000;
      const w = new NodeWriter(backend, { resolver: declaring, now: () => clock });
      const a = await w.write({ type: "StrutRun", data: { ...RUN, updated_at: "2026-09-02T00:00:00Z" } });
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_000_000);
      clock += 1000;
      await w.update(a.ref_id, { set: { run_status: "error" } });
      assert.equal((await props(a.ref_id))["updated_at"], 1_800_000_001_000);
    });

    it("a type that declares its own created_at keeps it: an edit writes none where the node held none, and removes the field, never the stamp", neoOnly("a Ladybug file refuses the declaration: one created_at, the core"), async () => {
      // jarvis's Concept, Feature, PullRequest declare it as a string; EvalSet and Cause as a datetime.
      await createNodeSchema(backend, backend.schemas, { type: "Ticket", attributes: { created_at: "?string" } });
      await createNodeSchema(backend, backend.schemas, { type: "Batch", attributes: { created_at: "?datetime" } });
      const bolt = (backend as { bolt: Bolt }).bolt;
      const stored = async (ref_id: string) => (await bolt.run(`MATCH (n:Data_Bank {ref_id: $r}) RETURN n.created_at AS own, n.date_added_to_graph AS stamp`, { r: ref_id }))[0]!;
      for (const type of ["Ticket", "Batch"]) {
        const bare = await writer.write({ type, data: { name: `${type} one` } });
        const before = await stored(bare.ref_id);
        assert.equal(before["own"], null);
        await writer.update(bare.ref_id, { set: { description: "edited" } });
        const after = await stored(bare.ref_id);
        assert.equal(after["own"], null, `${type}: the stamp is not the type's created_at`);
        assert.equal(Number(after["stamp"]), Number(before["stamp"]));
      }
      const dated = await writer.write({ type: "Ticket", data: { name: "Ticket two", created_at: "2026-09-30T12:00:00Z" } });
      await writer.update(dated.ref_id, { set: { description: "edited" } });
      assert.equal((await stored(dated.ref_id))["own"], "2026-09-30T12:00:00Z");
      await writer.update(dated.ref_id, { remove: ["created_at"] });
      const removed = await stored(dated.ref_id);
      assert.equal(removed["own"], null);
      assert.ok(Number(removed["stamp"]) > 0, "removing the type's created_at leaves the stamp");
    });

    it("the no-embed mark: an execution record gets Data_Bank and no vector", neoOnly("the no-embed types (tool calls, turns) are not in the file"), async () => {
      const seen: string[] = [];
      const w = new NodeWriter(backend, { embedder: fakeEmbedder(seen), resolver: backend.schemas });
      const tc = await w.write({ type: "StrutToolCall", data: { run_id: "r", path: "wf/agent", seq: 1, tool_name: "bash", input_preview: "ls" } });
      const turn = await w.write({ type: "StrutTurn", data: { chat_id: "c", turn: 1, user_text_preview: "hello" } });
      assert.deepEqual(seen, [], "nothing embedded");
      const p = await props(tc.ref_id);
      assert.equal(p["search_text"], "bash\nls");
      assert.deepEqual(p["_search_fields_used"], ["tool_name", "input_preview"]);
      assert.ok(!("text_embeddings" in p));
      assert.equal((await props(turn.ref_id))["search_text"], "hello");
      assert.ok(!("text_embeddings" in (await props(turn.ref_id))));
      // A vector an earlier strut left on one goes with the next update.
      await setNodeProps(backend, tc.ref_id, { text_embeddings: [1.0] });
      await w.update(tc.ref_id, { set: { input_preview: "pwd" } });
      const p2 = await props(tc.ref_id);
      assert.equal(p2["search_text"], "bash\npwd");
      assert.ok(!("text_embeddings" in p2));
      assert.deepEqual(seen, []);
      // An embedded type still is.
      await w.write({ type: "StrutRun", data: RUN });
      assert.deepEqual(seen, ["harvey-deliver\nsuccess\nDelivered 60 of 60"]);
    });

    it("per-write namespace overrides the backend default", async () => {
      const r = await writer.write({ type: "StrutRun", data: RUN }, "create", { namespace: "tenant-z" });
      assert.equal((await props(r.ref_id))["namespace"], "tenant-z");
      const again = await writer.write({ type: "StrutRun", data: RUN }, "create", { namespace: "tenant-z" });
      assert.equal(again.outcome, "existing");
      const dflt = await writer.write({ type: "StrutRun", data: RUN });
      assert.equal(dflt.outcome, "created");
    });

    it("namespace scopes identity", neoOnly("a second Bolt client; namespaces.test.ts covers a file"), async () => {
      const other = new Bolt({ ...testGraphConfig()!, namespace: "tenant-b" });
      try {
        const a = await writer.write({ type: "StrutRun", data: RUN });
        const b = await new NodeWriter(other).write({ type: "StrutRun", data: RUN });
        assert.equal(b.outcome, "created");
        assert.notEqual(a.ref_id, b.ref_id);
        const ns = await other.run(`MATCH (n:StrutRun) RETURN n.namespace AS ns ORDER BY ns`);
        assert.deepEqual(ns.map((r) => r["ns"]), ["default", "tenant-b"]);
      } finally {
        await other.close();
      }
    });

    it("fills title from the type's title_key on create and update, and refuses an Entity whose title is empty", async () => {
      // A Neo4j graph stores no core title (no new data shapes there); the
      // Entity rule holds on both.
      const stored = (t: string) => (neo ? undefined : t);
      await seedConceptSchema(backend);
      const run = await writer.write({ type: "StrutRun", data: RUN });
      assert.equal((await props(run.ref_id))["title"], stored("harvey-deliver"));
      await writer.update(run.ref_id, { set: { workflow_name: "renamed" } });
      assert.equal((await props(run.ref_id))["title"], stored("renamed"), "rebuilt with the attributes");
      // A type that declares `title` owns it: no computed one in its place.
      const job = await writer.write({ type: "StrutJob", data: { job_id: "j-untitled", started_at: 1 } });
      assert.equal((await props(job.ref_id))["title"], undefined);
      // An Entity (a type under Entity) with nothing to call it is refused;
      // another type is written without a title.
      await createNodeSchema(backend, backend.schemas, { type: "Entity", attributes: {} });
      await createNodeSchema(backend, backend.schemas, { type: "Org", parent: "Entity", attributes: { id: "string" }, key_spec: "id", index: ["name"] });
      await assert.rejects(
        writer.write({ type: "Org", data: { id: "o1" } }),
        (e: unknown) => e instanceof GraphValidationError && e.code === "MISSING_REQUIRED" && e.attribute === "name",
      );
      assert.equal((await writer.write({ type: "Org", data: { id: "o2", name: "Acme" } })).outcome, "created");
      await createNodeSchema(backend, backend.schemas, { type: "Tally", attributes: { id: "string" }, key_spec: "id", index: ["name"] });
      const tally = await writer.write({ type: "Tally", data: { id: "t1" } });
      assert.equal((await props(tally.ref_id))["title"], undefined);
      await assert.rejects(writer.write({ type: "StrutRun", data: { ...RUN, title: "mine" } }), (e: unknown) => e instanceof GraphValidationError && e.code === "UNKNOWN_ATTRIBUTE");
      // A template, and a type with no title field (its text's first line).
      await createNodeSchema(backend, backend.schemas, { type: "Contact", attributes: { first: "string", last: "?string" }, key_spec: "first", title_key: "{first} {last}" });
      const ada = await writer.write({ type: "Contact", data: { first: "Ada", last: "Lovelace" } });
      assert.equal((await props(ada.ref_id))["title"], stored("Ada Lovelace"));
      await createNodeSchema(backend, backend.schemas, { type: "Utterance", attributes: { said: "string", text: "string" }, key_spec: "said" });
      const said = await writer.write({ type: "Utterance", data: { said: "u1", text: "hello there\nand more" } });
      assert.equal((await props(said.ref_id))["title"], stored("hello there"));
    });

    it("a malformed namespace, the registry's types, and none of Thing's vestiges", { skip: neo && "ladybug only" }, async () => {
      await assert.rejects(writer.write({ type: "Concept", data: { name: "Job" } }, "create", { namespace: "Not A Name" }), (e: unknown) => e instanceof GraphValidationError && e.code === "UNKNOWN_ATTRIBUTE");
      await assert.rejects(writer.write({ type: "StrutToolCall", data: { run_id: "r", path: "p", seq: 1, tool_name: "bash" } }), (e: unknown) => e instanceof GraphValidationError && e.code === "UNKNOWN_TYPE");
      await assert.rejects(writer.write({ type: "StrutRun", data: { ...RUN, weight: 1 } }), (e: unknown) => e instanceof GraphValidationError && e.code === "UNKNOWN_ATTRIBUTE" && e.attribute === "weight");
      const c = await writer.write({ type: "concept", data: { name: "Job", description: "the root" } });
      assert.equal(c.node_type, "Concept");
      assert.equal(c.key, "concept-job");
    });
  });
}
