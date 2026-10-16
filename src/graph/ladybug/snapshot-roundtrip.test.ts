/**
 * EXPORT DATABASE → IMPORT DATABASE on the workspace graph (the Node table
 * with its FLOAT[384] vectors, the rel tables, the HNSW and FTS indexes): the
 * check a whole-brain snapshot rests on (peel docs/memory-backup.md, phase 0).
 * memory/export covers the memory graph; this is the other half, raw, because
 * no step exports the workspace yet. Skipped where Ladybug or its extensions
 * are missing, as the other graph suites are.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLadybug } from "./db.js";
import type { GraphBackend } from "../backend.js";
import { seedStrutDomain } from "../schema-seed.js";
import { testBackends } from "../test-util.js";
import { GraphWorkspaceStore } from "../workspace-store.js";

const tb = testBackends().find((b) => b.kind === "ladybug")!;
type Q = (cypher: string, params?: Record<string, unknown>) => Promise<Record<string, any>[]>;

/** A vector no two ids share, the same on every run. */
const vec = (seed: number) => Array.from({ length: 384 }, (_, k) => Math.fround(Math.sin(seed * 12.9898 + k * 78.233) * 0.5));

/** Every Node and rel row, all columns; INT64 as text (the driver would round them to numbers). */
async function dump(q: Q) {
  const read = async (table: string, alias: string, ends = "") => {
    const cols = (await q(`CALL table_info('${table}') RETURN *`)).map((c) => (c["type"] === "INT64" ? `CAST(${alias}.\`${c["name"]}\` AS STRING) AS \`${c["name"]}\`` : `${alias}.\`${c["name"]}\` AS \`${c["name"]}\``));
    return cols.join(", ") + ends;
  };
  const sort = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
  const out: Record<string, string[]> = { Node: sort(await q(`MATCH (n:Node) RETURN ${await read("Node", "n")}`)) };
  for (const t of await q("CALL show_tables() RETURN name, type")) {
    if (t["type"] !== "REL") continue;
    out[t["name"]] = sort(await q(`MATCH (a)-[r:\`${t["name"]}\`]->(b) RETURN a.ref_id AS from_id, b.ref_id AS to_id, ${await read(t["name"], "r")}`));
  }
  return out;
}

/** Same ids in the same order; the index's own scores within rounding (they are computed, not stored, and differ in the last bits across platforms). */
function sameHits(got: Record<string, any>[], want: Record<string, any>[], field: string) {
  assert.deepEqual(got.map((r) => r["id"]), want.map((r) => r["id"]));
  for (const [i, r] of got.entries()) assert.ok(Math.abs(Number(r[field]) - Number(want[i]![field])) < 1e-9, `${field} of ${r["id"]}: ${r[field]} vs ${want[i]![field]}`);
}

describe("workspace graph export → import is lossless", { skip: tb.skip }, () => {
  let backend: GraphBackend & { kind: "ladybug" };
  let dir: string;
  let imported: Q;
  let close: () => Promise<void>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-ws-roundtrip-"));
    backend = (await tb.open()) as typeof backend;
    await seedStrutDomain(backend);
    const ws = new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps") });
    const steps = [{ id: "s", type: "log", message: "hi" }] as never;
    for (let i = 0; i < 6; i++) {
      await ws.publishWorkflow(`wf${i}`, "v1", { steps, params: { greeting: 'é, "q"\nline' } } as never, `workflow ${i}`, "cat", "me");
      await ws.publishWorkflow(`wf${i}`, "v2", { steps, params: { greeting: "new" } } as never);
      await ws.publishStep(`pod/step${i}`, `export default { type: "pod/step${i}", input: {}, output: {}, async run() { return ${i}; } };`);
    }
    await ws.setWorkflowAutomations("wf0", [
      { id: "a-1", name: "Morning", enabled: true, trigger: { type: "schedule", every: "day", at: ["09:00"], tz: "UTC" }, input: { since: "{{ last.output.id }}" } },
    ] as never);
    await ws.deleteWorkflow("wf5"); // soft-deleted nodes and muted edges stay in the file
    // Vectors on every node, and the int64 extremes the stamps could hold.
    const ids = await backend.query("MATCH (n:Node) RETURN n.ref_id AS id");
    await backend.lbug.exclusive(async (w) => {
      for (const [i, r] of ids.entries()) await w("MATCH (n:Node {ref_id: $id}) SET n.text_embeddings = $v", { id: r["id"], v: vec(i) });
      await w("MATCH (n:Node {ref_id: $id}) SET n.date_added_to_graph = 9223372036854775807, n.deleted_at = 9007199254740993", { id: ids[0]!["id"] });
    });

    // The store writes two edge kinds; give every other rel table an edge too, with every column set.
    const rels = (await backend.query("CALL show_tables() RETURN name, type")).filter((t) => t["type"] === "REL").map((t) => String(t["name"]));
    await backend.lbug.exclusive(async (w) => {
      for (const [i, rel] of rels.entries()) {
        await w(
          `MATCH (a:Node {ref_id: $a}), (b:Node {ref_id: $b}) CREATE (a)-[:\`${rel}\` {ref_id: $id, edge_key: $id, date_added_to_graph: 9223372036854775807, weight: 0.1, importance: $i,
             strength: 1e-300, context: 'a, "b"\nc', start_time: -9223372036854775808, end_time: 9007199254740993, post_url: ''}]->(b)`,
          { a: ids[0]!["id"], b: ids[(i % 5) + 1]!["id"], id: `edge-${rel}`, i: i / 3 },
        );
      }
    });

    const out = join(dir, "export");
    await backend.lbug.exclusive(async (w) => {
      await w("CHECKPOINT");
      await w(`EXPORT DATABASE '${out}'`);
    });
    const lbug = await loadLadybug();
    mkdirSync(join(dir, "b"));
    const db = new lbug.Database(join(dir, "b", "graph.lbug"));
    const conn = new lbug.Connection(db);
    imported = async (cypher, params = {}) => {
      const r = Object.keys(params).length ? await conn.execute(await conn.prepare(cypher), params as never) : await conn.query(cypher);
      return (await (Array.isArray(r) ? r[r.length - 1]! : r).getAll()) as Record<string, any>[];
    };
    close = async () => {
      await conn.close();
      await db.close();
    };
    await imported(`IMPORT DATABASE '${out}'`);
  });
  after(async () => {
    await close?.();
    if (backend) await tb.close(backend);
    await rm(dir, { recursive: true, force: true });
  });

  it("every Node row (vectors included) and every edge, with all its columns, comes back exactly", async () => {
    const a = await dump(backend.query);
    const b = await dump(imported);
    assert.ok(a["Node"]!.length >= 20, "a real workspace was written");
    for (const [table, rows] of Object.entries(a)) assert.ok(rows.length > 0, `${table} holds rows`);
    assert.ok(a["Node"]!.some((r) => r.includes("9223372036854775807")) && a["Node"]!.some((r) => r.includes("9007199254740993")));
    // Ladybug does not promise an order for SHOW_TABLES; Linux and macOS differ.
    assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
    for (const table of Object.keys(a)) assert.deepEqual(b[table], a[table], `${table} differs after the round trip`);
  });

  it("the vector and full-text indexes are rebuilt and answer the same", async () => {
    const names = (await imported("CALL SHOW_INDEXES() RETURN index_name")).map((r) => String(r["index_name"]));
    assert.ok(names.includes("node_vec") && names.includes("node_fts"));
    const v = JSON.stringify(vec(0));
    const near = `CALL QUERY_VECTOR_INDEX('Node', 'node_vec', CAST(${v} AS FLOAT[384]), 5) RETURN node.ref_id AS id, distance ORDER BY distance, id`;
    sameHits(await imported(near), await backend.query(near), "distance");
    const text = "CALL QUERY_FTS_INDEX('Node', 'node_fts', 'step3') RETURN node.ref_id AS id, score ORDER BY id";
    const hits = await backend.query(text);
    assert.ok(hits.length > 0);
    sameHits(await imported(text), hits, "score");
  });
});
