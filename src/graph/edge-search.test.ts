/**
 * The temporal edges' search rows on a Ladybug file
 * (plans/graph-edge-search.md): an `EdgeText` node per fact, written with
 * its edge, holding the composed fact (both ends' titles, the edge type as
 * words, the sentence) and its vector, in the fact's namespace and time
 * window, hidden as a node. Reading facts through the rows is step 4's:
 * these tests query the rows through the file's own indexes.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openGraphBackend, type GraphBackend, type LadybugBackend } from "./backend.js";
import { EDGE_ROWS_MIGRATION } from "./ladybug/db.js";
import { PRIVATE_NAMESPACE } from "./ladybug/namespaces.js";
import { GraphValidationError, type Embedder } from "./node-writer.js";
import { createNodeSchema } from "./schema-crud.js";
import { assertEdge, embedPendingEdgeRows } from "./temporal.js";
import { graphSnapshot, testBackends } from "./test-util.js";

const lb = testBackends().find((b) => b.kind === "ladybug")!;

/** Words that mean the same thing share a dimension, so a query and a fact
 *  with no word in common still meet: a stand-in for meaning. */
const MEANING: Record<string, number> = { job: 1, work: 1, works: 1, worked: 1, employer: 1, engineer: 1, lives: 2, live: 2, home: 2, house: 2 };
function meaningOf(text: string): number[] {
  const v = new Array<number>(384).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const d = MEANING[w] ?? 10 + ([...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 370);
    v[d]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** An embedder that can be told to fail, and counts what it embedded. */
function testEmbedder() {
  const state = { failing: false, texts: [] as string[] };
  const embedder: Embedder = {
    async embed(texts) {
      if (state.failing) throw new Error("the model is not loaded");
      state.texts.push(...texts);
      return texts.map(meaningOf);
    },
  };
  return { embedder, state };
}

async function ontology(b: GraphBackend): Promise<void> {
  await createNodeSchema(b, b.schemas, { type: "Company", attributes: {}, role: "entity" });
  await createNodeSchema(b, b.schemas, { type: "Place", attributes: {}, role: "entity" });
  await b.schemas.createEdgeSchema("Person", "WORKS_AT", "Company", { temporal: true, cardinality: "one" });
  await b.schemas.createEdgeSchema("Person", "LIVES_IN", "Place", { temporal: true, cardinality: "one" });
}

type RowView = Record<string, unknown>;
const rowOf = async (b: GraphBackend, edge_ref_id: string): Promise<RowView | undefined> =>
  (await b.query(`MATCH (n:Node {node_type: 'EdgeText', edge_ref_id: $e}) RETURN n`, { e: edge_ref_id }))[0]?.["n"] as RowView | undefined;

describe("edge search rows on a ladybug file (plans/graph-edge-search.md)", { skip: lb.skip }, () => {
  let b: LadybugBackend;
  const { embedder, state } = testEmbedder();
  let tom: string, stakwork: string, lisbon: string, kate: string;
  before(async () => {
    b = (await lb.open({ embedder })) as LadybugBackend;
    await ontology(b);
  });
  after(async () => {
    await lb.close(b);
  });
  beforeEach(async () => {
    await lb.clear(b);
    state.failing = false;
    state.texts.length = 0;
    const [t, s, l, k] = await b.nodes.writeMany([
      { type: "Person", data: { name: "Tom" } },
      { type: "Company", data: { name: "Stakwork" } },
      { type: "Place", data: { name: "Lisbon" } },
      { type: "Person", data: { name: "Kate" } },
    ]);
    [tom, stakwork, lisbon, kate] = [t!.ref_id, s!.ref_id, l!.ref_id, k!.ref_id];
    state.texts.length = 0;
  });
  const works = (text = "Tom works at Stakwork as an engineer", extra = {}) =>
    assertEdge(b, b.schemas, { edge: "WORKS_AT", source_ref_id: tom, target_ref_id: stakwork, text, ...extra }, { embedder });

  /** The live rows the vector index ranks first for `q`, with their facts' text. */
  const byMeaning = async (q: string, where = "true") =>
    (await b.query(
      `CALL QUERY_VECTOR_INDEX('Node', 'node_vec', $v, 10) WITH node, distance
       WHERE node.node_type = 'EdgeText' AND node.deleted_at IS NULL AND ${where}
       RETURN node.text AS text ORDER BY distance`,
      { v: meaningOf(q) },
    )).map((r) => String(r["text"]));
  /** The live rows the keyword index finds for `q`. */
  const byWords = async (q: string, where = "true") =>
    (await b.query(
      `CALL QUERY_FTS_INDEX('Node', 'node_fts', $q, conjunctive := true, top := 20) WITH node, score
       WHERE node.node_type = 'EdgeText' AND node.deleted_at IS NULL AND ${where}
       RETURN node.text AS text`,
      { q },
    )).map((r) => String(r["text"]));

  it("an assert writes its edge and its row together: the composed fact, keyed by the edge, in its namespace and window", async () => {
    const r = await works(undefined, { valid_at: "2024", created_by: "tom" });
    const row = (await rowOf(b, r.ref_id))!;
    assert.equal(row["key"], `edgetext-${r.ref_id}`);
    assert.deepEqual(
      [row["edge_type"], row["source_ref_id"], row["target_ref_id"], row["namespace"], row["created_by"], row["valid_at"], row["expired_at"] ?? null],
      ["WORKS_AT", tom, stakwork, "private", "tom", Date.parse("2024-01-01T00:00:00Z"), null],
    );
    assert.equal(row["search_text"], "Tom works at Stakwork. Tom works at Stakwork as an engineer");
    assert.equal(row["title"], "Tom works at Stakwork as an engineer");
    assert.equal((row["text_embeddings"] as number[]).length, 384);
    assert.deepEqual(state.texts, [row["search_text"]], "the composed fact is what is embedded, once");
    assert.equal(r.unembedded, undefined);
    // A re-confirm leaves the row as it is.
    const snap = await graphSnapshot(b);
    await works(undefined, { source: "message-1" });
    const again = (await rowOf(b, r.ref_id))!;
    assert.deepEqual([again["search_text"], again["updated_at"]], [row["search_text"], row["updated_at"]]);
    assert.notDeepEqual(await graphSnapshot(b), snap, "the edge took the source");
  });

  it("a search by meaning finds the fact; a name the sentence leaves out finds it through the composed text", async () => {
    await works();
    await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: kate, target_ref_id: lisbon, text: "Kate lives by the sea" }, { embedder });
    const [first] = await byMeaning("where's my job?");
    assert.equal(first, "Tom works at Stakwork as an engineer");
    const he = await assertEdge(b, b.schemas, { edge: "WORKS_AT", source_ref_id: kate, target_ref_id: stakwork, text: "She works there" }, { embedder });
    assert.ok(he.ref_id);
    assert.deepEqual((await byWords("Kate")).sort(), ["She works there", "Kate lives by the sea"].sort());
    assert.deepEqual(await byWords("Lisbon"), ["Kate lives by the sea"]);
  });

  it("an ended fact's row carries its end: left out of current facts, found for its own time", async () => {
    const old = await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: kate, target_ref_id: lisbon, text: "Kate lives in Lisbon", valid_at: "2019" }, { embedder });
    const [porto] = await b.nodes.writeMany([{ type: "Place", data: { name: "Porto" } }]);
    await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: kate, target_ref_id: porto!.ref_id, text: "Kate lives in Porto", valid_at: "2024" }, { embedder });
    const row = (await rowOf(b, old.ref_id))!;
    assert.ok(row["expired_at"] !== undefined, "superseded: the row ended with its edge");
    assert.equal(row["invalid_at"], Date.parse("2024-01-01T00:00:00Z"));
    assert.deepEqual(await byWords("Kate lives", "node.expired_at IS NULL"), ["Kate lives in Porto"], "current facts only");
    assert.deepEqual((await byWords("Kate lives")).sort(), ["Kate lives in Lisbon", "Kate lives in Porto"], "include_ended");
    const asOf = Date.parse("2021-06-01T00:00:00Z");
    const window = `(node.valid_at IS NULL OR node.valid_at <= ${asOf}) AND (node.invalid_at IS NULL OR node.invalid_at > ${asOf})`;
    assert.deepEqual(await byWords("Kate lives", window), ["Kate lives in Lisbon"], "as_of 2021");
  });

  it("a row is never a node: search, get, neighbours and counts leave it out, and no write may make one", async () => {
    const r = await works();
    const row = (await rowOf(b, r.ref_id))!;
    const hits = await b.reader.search({ q: "Stakwork engineer", limit: 20 });
    assert.ok(hits.nodes.every((n) => n.node_type !== "EdgeText"));
    assert.ok(hits.nodes.some((n) => n.ref_id === stakwork), "the node itself still is");
    assert.equal(await b.reader.getNode(String(row["ref_id"])), null);
    const around = await b.reader.neighbors(tom, { include_edge_counts: true });
    assert.ok(around.nodes.every((n) => n.node_type !== "EdgeText"));
    assert.deepEqual(await b.reader.edgeCounts([tom], "private"), { [tom]: { WORKS_AT: 1 } });
    assert.deepEqual(await b.reader.connectionCounts(tom), [{ edge_type: "WORKS_AT", target_type: "Company", direction: "out", count: 1 }]);
    await assert.rejects(b.nodes.write({ type: "EdgeText", data: { edge_ref_id: "x", edge_type: "X", source_ref_id: "a", target_ref_id: "b", text: "t", composed: "c" } }), (e: unknown) => e instanceof GraphValidationError && e.code === "WRONG_TYPE");
  });

  it("the rows are memory: no Strut domain, so a search leaving Strut out still finds facts", async () => {
    const schema = (await b.schemas.schema("EdgeText"))!;
    assert.deepEqual([schema.role, schema.embed, schema.domainLabels], ["record", true, []]);
    await works();
    const strut = await b.query(`MATCH (n:Node {node_type: 'Schema', type: 'EdgeText'}) RETURN n.domain AS d`);
    assert.equal(strut[0]!["d"] ?? null, null);
    assert.deepEqual(await byWords("Stakwork"), ["Tom works at Stakwork as an engineer"]);
  });

  it("a fact in private is not found by a reader limited to shared", async () => {
    await works();
    const ours = await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: kate, target_ref_id: lisbon, text: "Kate lives in Lisbon", namespace: "shared" }, { embedder });
    assert.equal((await rowOf(b, ours.ref_id))!["namespace"], "shared", "the row is in its edge's namespace");
    assert.deepEqual(await byWords("Stakwork", "node.namespace IN ['shared']"), []);
    assert.deepEqual(await byWords("Lisbon", "node.namespace IN ['shared']"), ["Kate lives in Lisbon"]);
  });

  it("a deleted edge deletes its row; a node's soft delete keeps its edges' rows, its facts hidden by the deleted end", async () => {
    const r = await works();
    await b.edges.delete(r.ref_id);
    assert.ok((await rowOf(b, r.ref_id))!["deleted_at"] !== undefined);
    const l = await assertEdge(b, b.schemas, { edge: "LIVES_IN", source_ref_id: kate, target_ref_id: lisbon, text: "Kate lives in Lisbon" }, { embedder });
    await b.nodes.deleteNode(lisbon);
    assert.equal((await rowOf(b, l.ref_id))!["deleted_at"], undefined, "kept: the node may be restored");
    assert.equal((await b.reader.search({ q: "Lisbon" })).facts, undefined, "no read shows it");
  });

  it("a rename of either end recomposes its facts' rows and embeds them again", async () => {
    const r = await works("He works there");
    const before = (await rowOf(b, r.ref_id))!;
    await b.nodes.update(stakwork, { set: { name: "Stakwork Labs" } });
    // The re-embed runs in the background once the rename has committed.
    await embedPendingEdgeRows(b);
    const after = (await rowOf(b, r.ref_id))!;
    assert.equal(after["search_text"], "Tom works at Stakwork Labs. He works there");
    assert.notEqual(after["search_text"], before["search_text"]);
    assert.deepEqual(await byWords("Labs"), ["He works there"]);
    assert.deepEqual(after["text_embeddings"], meaningOf("Tom works at Stakwork Labs. He works there").map((x) => Math.fround(x)), "embedded again once the rename committed");
    // An upsert that keeps the title leaves the row alone.
    const kept = (await rowOf(b, r.ref_id))!;
    await b.nodes.write({ type: "Person", data: { name: "Kate", description: "no change to Tom" } }, "upsert");
    assert.equal((await rowOf(b, r.ref_id))!["updated_at"], kept["updated_at"]);
  });

  it("an embedding failure still writes the edge, its row keyword-only, and the vector is filled later", async () => {
    state.failing = true;
    const r = await works();
    assert.equal(r.unembedded, true);
    const row = (await rowOf(b, r.ref_id))!;
    assert.equal(row["text_embeddings"], undefined);
    assert.deepEqual(await byWords("Stakwork"), ["Tom works at Stakwork as an engineer"], "found by its words meanwhile");
    // The run the write started failed too, and logged: the row waits.
    await embedPendingEdgeRows(b);
    assert.equal((await rowOf(b, r.ref_id))!["text_embeddings"], undefined);
    // The next run (after the next open, or the next such write) fills it.
    // Two asks at once share one run: one row, embedded once.
    state.failing = false;
    state.texts.length = 0;
    assert.deepEqual(await Promise.all([embedPendingEdgeRows(b), embedPendingEdgeRows(b)]), [1, 1]);
    assert.equal(state.texts.length, 1);
    assert.equal(((await rowOf(b, r.ref_id))!["text_embeddings"] as number[]).length, 384);
    assert.deepEqual((await byMeaning("my job"))[0], "Tom works at Stakwork as an engineer");
    assert.equal(await embedPendingEdgeRows(b), 0, "nothing left");
  });
});

describe("the open's backfill of data nodes written with no embedder", { skip: lb.skip }, () => {
  it("embeds an entity's text at the next open with an embedder, never a no-embed type's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-node-backfill-"));
    const cfg = { kind: "ladybug", path: join(dir, "graph.lbug"), namespace: PRIVATE_NAMESPACE } as const;
    try {
      let b = await openGraphBackend(cfg, { embeddings: false });
      await createNodeSchema(b, b.schemas, { type: "Jotting", attributes: {}, embed: false });
      await b.nodes.writeMany([
        { type: "Person", data: { name: "Tom" } },
        { type: "Jotting", data: { name: "keyword only" } },
      ]);
      await b.close();
      const { embedder, state } = testEmbedder();
      b = await openGraphBackend(cfg, { embeddings: embedder });
      await b.nodeEngine.idle?.();
      const missing = async (type: string) =>
        (await b.query(`MATCH (n:Node {node_type: $t}) RETURN n.text_embeddings IS NULL AS missing`, { t: type }))[0]?.["missing"];
      assert.equal(await missing("Person"), false);
      assert.equal(await missing("Jotting"), true);
      assert.ok(!state.texts.some((t) => t.includes("keyword only")), "a no-embed type's text is never embedded");
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("edge search rows: the backfill (plans/graph-edge-search.md)", { skip: lb.skip }, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "strut-lbug-rows-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** One open of the file in a process of its own, running `body` (`b` the
   *  backend) and returning what it prints last. Each open is a process:
   *  a closed handle holds on to the file until its process exits. */
  function inProcess(path: string, body: string): unknown {
    const mod = (f: string) => JSON.stringify(fileURLToPath(new URL(f, import.meta.url)));
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { openGraphBackend } from ${mod("./backend.js")};
         import { createNodeSchema } from ${mod("./schema-crud.js")};
         import { createTemporalEdge } from ${mod("./ladybug/temporal.js")};
         import { graphSnapshot } from ${mod("./test-util.js")};
         ${ontology.toString()}
         const b = await openGraphBackend({ kind: "ladybug", path: ${JSON.stringify(path)}, namespace: "private" }, { embeddings: false, skipBoot: true });
         const out = await (async () => { ${body} })();
         await b.close();
         process.stdout.write(JSON.stringify(out ?? null));`,
      ],
      { env: process.env, encoding: "utf-8" },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").pop()!);
  }

  it("gives an older file a row for every temporal edge with text, and a second run changes nothing", () => {
    const path = join(dir, "graph.lbug");
    // Temporal edges as a build from before the rows wrote them: no row, and no stamp.
    const none = inProcess(
      path,
      `await ontology(b);
       const [t, s, l] = await b.nodes.writeMany([{ type: "Person", data: { name: "Tom" } }, { type: "Company", data: { name: "Stakwork" } }, { type: "Place", data: { name: "Lisbon" } }]);
       const at = Date.now();
       await b.tx(async (tx) => {
         await createTemporalEdge(tx, "WORKS_AT", t.ref_id, s.ref_id, { ref_id: "e-works", edge_key: "works_at", namespace: "shared", created_at: at, updated_at: at, weight: 1, text: "Tom works at Stakwork" });
         await createTemporalEdge(tx, "LIVES_IN", t.ref_id, l.ref_id, { ref_id: "e-lives", edge_key: "lives_in", namespace: "private", created_at: at, updated_at: at, weight: 1, text: "Tom lives in Lisbon", invalid_at: 1, expired_at: at });
         await tx.run("MATCH (m:Migration {migration_id: $id}) DELETE m", { id: ${JSON.stringify(EDGE_ROWS_MIGRATION)} });
       });
       return (await b.query("MATCH (n:Node {node_type: 'EdgeText'}) RETURN count(n) AS c"))[0].c;`,
    );
    assert.equal(none, 0);

    const rows = inProcess(
      path,
      `return {
         rows: await b.query("MATCH (n:Node {node_type: 'EdgeText'}) RETURN n.edge_ref_id AS e, n.search_text AS t, n.namespace AS ns, n.expired_at AS x, n.text_embeddings AS v ORDER BY n.edge_ref_id"),
         stamp: (await b.query("MATCH (m:Migration {migration_id: $id}) RETURN count(m) AS c", { id: ${JSON.stringify(EDGE_ROWS_MIGRATION)} }))[0].c,
       };`,
    ) as { rows: Array<Record<string, unknown>>; stamp: number };
    assert.deepEqual(
      rows.rows.map((r) => [r["e"], r["t"], r["ns"], r["x"] !== undefined && r["x"] !== null, r["v"] ?? null]),
      [
        ["e-lives", "Tom lives in Lisbon. Tom lives in Lisbon", "private", true, null],
        ["e-works", "Tom works at Stakwork. Tom works at Stakwork", "shared", false, null],
      ],
      "composed, in the edge's namespace, ended with it, keyword-only",
    );
    assert.equal(rows.stamp, 1);

    const snap = (p: string) => inProcess(p, `return await graphSnapshot(b);`);
    const once = snap(path);
    assert.deepEqual(snap(path), once, "a second open writes nothing");
  });
});
