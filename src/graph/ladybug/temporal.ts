/**
 * The statements behind `assert` on a Ladybug file (`../temporal.ts`): a
 * temporal edge type's edges in one slot, a new edge (CREATE, not MERGE:
 * history holds several edges between the same two nodes), a change to
 * one, the word-match scan over every temporal edge's `text`, and each
 * edge's search row (plans/graph-edge-search.md): an `EdgeText` node
 * holding the fact's composed text and vector, kept in step with its edge
 * in the same transaction. The decisions are `../temporal.ts`'s; this file
 * is the Cypher.
 */
import { randomUUID } from "node:crypto";
import type { GraphTx, Params, Row } from "../engine.js";
import { SCHEMA_EDGE } from "./ontology.js";
import { EDGE_TEXT_TYPE } from "./registry.js";

const q = (s: string) => `\`${s}\``;
/** The INT64 columns a temporal edge write sets: a JS number is cast. */
const TIMES = new Set(["created_at", "updated_at", "deleted_at", "valid_at", "invalid_at", "expired_at", "last_confirmed_at"]);
const value = (k: string, p: string) => (TIMES.has(k) ? `CAST(${p} AS INT64)` : p);

/** A temporal edge as `assert` reads it. Times are epoch ms; null unset. */
export interface TemporalEdge {
  ref_id: string;
  target: string;
  text: string;
  sources: string[];
  valid_at: number | null;
  invalid_at: number | null;
  expired_at: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function temporalEdge(r: Row): TemporalEdge {
  return {
    ref_id: String(r["ref_id"]),
    target: String(r["target"]),
    text: String(r["text"] ?? ""),
    sources: Array.isArray(r["sources"]) ? (r["sources"] as unknown[]).map(String) : [],
    valid_at: num(r["valid_at"]),
    invalid_at: num(r["invalid_at"]),
    expired_at: num(r["expired_at"]),
  };
}

/** `source`'s `edge` edges: the current ones (not expired), or with
 *  `ended`, the ones that are. */
export async function slotEdges(tx: GraphTx, edge: string, source: string, ended = false): Promise<TemporalEdge[]> {
  const rows = await tx.run(
    `MATCH (s:Node {ref_id: $s})-[r:${q(edge)}]->(t:Node) WHERE r.expired_at IS ${ended ? "NOT NULL" : "NULL"}
     RETURN r.ref_id AS ref_id, t.ref_id AS target, r.text AS text, r.sources AS sources, r.valid_at AS valid_at, r.invalid_at AS invalid_at, r.expired_at AS expired_at
     ORDER BY r.created_at`,
    { s: source },
  );
  return rows.map(temporalEdge);
}

/** A new temporal edge; a null or empty value is left out (the column stays
 *  NULL). */
export async function createTemporalEdge(tx: GraphTx, edge: string, src: string, tgt: string, props: Record<string, unknown>): Promise<void> {
  const params: Params = { src, tgt };
  const fields: string[] = [];
  let i = 0;
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    params[`p${i}`] = v;
    fields.push(`${q(k)}: ${value(k, `$p${i++}`)}`);
  }
  const made = await tx.run(`MATCH (s:Node {ref_id: $src}), (t:Node {ref_id: $tgt}) CREATE (s)-[r:${q(edge)} {${fields.join(", ")}}]->(t) RETURN r.ref_id AS ref_id`, params);
  if (made.length === 0) throw new Error(`temporal edge ${edge}: no endpoints (${src} → ${tgt})`);
}

/** Set columns on the temporal edge `ref_id`; a null value clears one. */
export async function setTemporalEdge(tx: GraphTx, edge: string, ref_id: string, set: Record<string, unknown>): Promise<void> {
  const params: Params = { ref_id };
  const assigns: string[] = [];
  let i = 0;
  for (const [k, v] of Object.entries(set)) {
    if (v === null || v === undefined) {
      assigns.push(`r.${q(k)} = NULL`);
      continue;
    }
    params[`v${i}`] = v;
    assigns.push(`r.${q(k)} = ${value(k, `$v${i++}`)}`);
  }
  if (assigns.length) await tx.run(`MATCH ()-[r:${q(edge)} {ref_id: $ref_id}]->() SET ${assigns.join(", ")}`, params);
}

/** The edge types the file marks temporal (any of their rules). */
export async function temporalEdgeTypes(run: (cypher: string, params?: Params) => Promise<Row[]>): Promise<string[]> {
  const rows = await run(`MATCH (:Node)-[r:${SCHEMA_EDGE}]->(:Node) WHERE r.temporal = true RETURN DISTINCT r.edge_type AS e`);
  return rows.map((r) => String(r["e"])).sort();
}

/** Every temporal edge of `edge` between live nodes, its ends' titles with
 *  it: what the word match scores. Current ones only unless `ended`. */
export async function factRows(run: (cypher: string, params?: Params) => Promise<Row[]>, edge: string, ended: boolean): Promise<Row[]> {
  return run(
    `MATCH (s:Node)-[r:${q(edge)}]->(t:Node) WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL AND r.text IS NOT NULL ${ended ? "" : "AND r.expired_at IS NULL"}
     RETURN r.ref_id AS ref_id, r.text AS text, r.namespace AS namespace, r.valid_at AS valid_at, r.invalid_at AS invalid_at, r.expired_at AS expired_at,
            s.ref_id AS source_ref_id, s.title AS source_title, t.ref_id AS target_ref_id, t.title AS target_title`,
  );
}

// ── Search rows ─────────────────────────────────────────────────────────────

type Run = (cypher: string, params?: Params) => Promise<Row[]>;

/** An edge type as words: `WORKS_AT` → "works at". */
export function edgePhrase(edge: string): string {
  return edge.toLowerCase().replace(/_+/g, " ").trim();
}

/** What a fact's row is searched and embedded by: both ends' titles first,
 *  so a sentence that names neither ("He works there") is still found by
 *  them, then the sentence. */
export function composeFact(sourceTitle: string | null | undefined, edge: string, targetTitle: string | null | undefined, text: string): string {
  const triplet = [sourceTitle?.trim(), edgePhrase(edge), targetTitle?.trim()].filter(Boolean).join(" ");
  return `${triplet}. ${text.trim()}`;
}

/** A row's title: the sentence's first line, cut down. */
export function rowTitle(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

export const rowKey = (edge_ref_id: string) => `edgetext-${edge_ref_id}`;

export interface EdgeRow {
  edge_ref_id: string;
  edge_type: string;
  source_ref_id: string;
  target_ref_id: string;
  text: string;
  composed: string;
  namespace: string | null | undefined;
  valid_at: number | null;
  invalid_at: number | null;
  expired_at: number | null;
  created_by?: string | undefined;
  /** Left out when the embedding failed: the row is keyword-only until filled. */
  vector?: number[] | undefined;
}

/** Both ends' titles, by ref_id. */
export async function titlesOf(run: Run, ids: string[]): Promise<Map<string, string>> {
  const rows = await run(`UNWIND $ids AS id MATCH (n:Node {ref_id: id}) RETURN id, n.title AS title`, { ids });
  return new Map(rows.filter((r) => typeof r["title"] === "string").map((r) => [String(r["id"]), String(r["title"])]));
}

/** The search row of a new edge, a NULL value left out. */
export async function writeEdgeRow(tx: GraphTx, row: EdgeRow, now: number): Promise<void> {
  const props: Record<string, unknown> = {
    ref_id: randomUUID(),
    node_type: EDGE_TEXT_TYPE,
    key: rowKey(row.edge_ref_id),
    namespace: row.namespace,
    edge_ref_id: row.edge_ref_id,
    edge_type: row.edge_type,
    source_ref_id: row.source_ref_id,
    target_ref_id: row.target_ref_id,
    text: row.text,
    composed: row.composed,
    search_text: row.composed,
    title: rowTitle(row.text),
    valid_at: row.valid_at,
    invalid_at: row.invalid_at,
    expired_at: row.expired_at,
    created_by: row.created_by,
    created_at: now,
    updated_at: now,
    text_embeddings: row.vector,
  };
  const params: Params = {};
  const fields: string[] = [];
  let i = 0;
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    params[`p${i}`] = v;
    fields.push(`${q(k)}: ${value(k, `$p${i++}`)}`);
  }
  await tx.run(`CREATE (n:Node {${fields.join(", ")}})`, params);
}

/** Copy an edge's changed clocks onto its row (a null clears one). */
export async function syncEdgeRow(tx: GraphTx, edge_ref_id: string, set: Partial<Record<"valid_at" | "invalid_at" | "expired_at", number | null>>, now: number): Promise<void> {
  const params: Params = { k: rowKey(edge_ref_id), now };
  const assigns = ["n.updated_at = CAST($now AS INT64)"];
  let i = 0;
  for (const [k, v] of Object.entries(set)) {
    if (v === null || v === undefined) assigns.push(`n.${q(k)} = NULL`);
    else {
      params[`v${i}`] = v;
      assigns.push(`n.${q(k)} = CAST($v${i++} AS INT64)`);
    }
  }
  await tx.run(`MATCH (n:Node {node_type: '${EDGE_TEXT_TYPE}', key: $k}) SET ${assigns.join(", ")}`, params);
}

/** The rows of edges just deleted: deleted with them. */
export async function deleteEdgeRows(tx: GraphTx, edge_ref_ids: string[], now: number): Promise<void> {
  if (!edge_ref_ids.length) return;
  await tx.run(
    `UNWIND $ids AS id MATCH (n:Node {node_type: '${EDGE_TEXT_TYPE}', edge_ref_id: id}) WHERE n.deleted_at IS NULL SET n.deleted_at = CAST($now AS INT64), n.updated_at = CAST($now AS INT64)`,
    { ids: edge_ref_ids, now },
  );
}

/** The rows of every fact `ref_id` is an end of, as its edges are deleted
 *  with it (a node's soft delete). */
export async function deleteRowsOf(tx: GraphTx, ref_id: string, now: number): Promise<void> {
  await tx.run(
    `MATCH (n:Node {node_type: '${EDGE_TEXT_TYPE}'}) WHERE (n.source_ref_id = $r OR n.target_ref_id = $r) AND n.deleted_at IS NULL
     SET n.deleted_at = CAST($now AS INT64), n.updated_at = CAST($now AS INT64)`,
    { r: ref_id, now },
  );
}

/** The live rows of every fact `ref_id` is an end of, composed again from
 *  the ends' titles now: a row whose text changes loses its vector until it
 *  is embedded again. Returns the rows whose text changed. */
export async function recomposeRowsOf(tx: GraphTx, ref_id: string, now: number): Promise<string[]> {
  const rows = await tx.run(
    `MATCH (n:Node {node_type: '${EDGE_TEXT_TYPE}'}) WHERE (n.source_ref_id = $r OR n.target_ref_id = $r) AND n.deleted_at IS NULL
     MATCH (s:Node {ref_id: n.source_ref_id}), (t:Node {ref_id: n.target_ref_id})
     RETURN n.ref_id AS ref_id, n.edge_type AS edge, n.text AS text, n.search_text AS was, s.title AS st, t.title AS tt`,
    { r: ref_id },
  );
  const changed: string[] = [];
  for (const r of rows) {
    const composed = composeFact(r["st"] as string | undefined, String(r["edge"]), r["tt"] as string | undefined, String(r["text"] ?? ""));
    if (composed === r["was"]) continue;
    await tx.run(
      `MATCH (n:Node {ref_id: $id}) SET n.composed = $c, n.search_text = $c, n.text_embeddings = NULL, n.updated_at = CAST($now AS INT64)`,
      { id: r["ref_id"], c: composed, now },
    );
    changed.push(String(r["ref_id"]));
  }
  return changed;
}

/** The live rows with text and no vector, oldest first: what is still to
 *  embed (a failed embedding, a rename). */
export async function pendingRows(run: Run, limit: number): Promise<Array<{ ref_id: string; text: string }>> {
  const rows = await run(
    `MATCH (n:Node {node_type: '${EDGE_TEXT_TYPE}'}) WHERE n.deleted_at IS NULL AND n.search_text IS NOT NULL AND n.text_embeddings IS NULL
     RETURN n.ref_id AS ref_id, n.search_text AS text ORDER BY n.created_at LIMIT ${Math.max(1, Math.floor(limit))}`,
  );
  return rows.map((r) => ({ ref_id: String(r["ref_id"]), text: String(r["text"]) }));
}

/** Set rows' vectors, unless a row's text changed since it was read. */
export async function setRowVectors(tx: GraphTx, rows: Array<{ ref_id: string; text: string; vector: number[] }>): Promise<void> {
  for (const r of rows) {
    await tx.run(`MATCH (n:Node {ref_id: $id}) WHERE n.search_text = $t SET n.text_embeddings = $v`, { id: r.ref_id, t: r.text, v: r.vector });
  }
}

/** Embed every live row still without a vector, a batch at a time, each
 *  batch one write: what a failed embedding or a rename left. A failing
 *  embedder stops it, leaving the rest for the next run. Returns how many
 *  it embedded. */
export async function embedPendingRows(
  read: Run,
  write: <T>(fn: (tx: GraphTx) => Promise<T>) => Promise<T>,
  embedder: { embed(texts: string[]): Promise<number[][]> },
  batch = 32,
): Promise<number> {
  let n = 0;
  for (;;) {
    const rows = await pendingRows(read, batch);
    if (!rows.length) return n;
    let vectors: number[][];
    try {
      vectors = await embedder.embed(rows.map((r) => r.text));
    } catch (err) {
      console.warn(`[graph] embedding ${rows.length} search row(s) failed, left for the next run: ${String(err).split("\n")[0]}`);
      return n;
    }
    await write((tx) => setRowVectors(tx, rows.map((r, i) => ({ ...r, vector: vectors[i]! }))));
    n += rows.length;
    if (rows.length < batch) return n;
  }
}

/** A row for every temporal edge with `text` and none (keyword only: the
 *  vectors come after). Returns how many it wrote. */
export async function writeMissingEdgeRows(run: Run, now: number): Promise<number> {
  const have = new Set((await run(`MATCH (n:Node {node_type: '${EDGE_TEXT_TYPE}'}) RETURN n.edge_ref_id AS e`)).map((r) => String(r["e"])));
  const tx: GraphTx = { run: (c, p) => run(c, p) };
  let n = 0;
  for (const edge of await temporalEdgeTypes(run)) {
    const rows = await run(
      `MATCH (s:Node)-[r:${q(edge)}]->(t:Node) WHERE r.text IS NOT NULL
       RETURN r.ref_id AS ref_id, r.text AS text, r.namespace AS ns, r.created_by AS by, r.valid_at AS valid_at, r.invalid_at AS invalid_at, r.expired_at AS expired_at,
              s.ref_id AS s, s.title AS st, t.ref_id AS t, t.title AS tt`,
    );
    for (const r of rows) {
      if (have.has(String(r["ref_id"]))) continue;
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      await writeEdgeRow(tx, {
        edge_ref_id: String(r["ref_id"]),
        edge_type: edge,
        source_ref_id: String(r["s"]),
        target_ref_id: String(r["t"]),
        text: String(r["text"]),
        composed: composeFact(r["st"] as string | undefined, edge, r["tt"] as string | undefined, String(r["text"])),
        namespace: r["ns"] as string | undefined,
        created_by: r["by"] as string | undefined,
        valid_at: num(r["valid_at"]),
        invalid_at: num(r["invalid_at"]),
        expired_at: num(r["expired_at"]),
      }, now);
      n++;
    }
  }
  return n;
}
