/**
 * The statements behind `merge` on a Ladybug file (`../merge.ts`): a node's
 * edges as they are stored, a copy of one onto another node, the merge's
 * record (a hidden `Merge` node), and following a merged ref_id to the node
 * it was merged into. The decisions are `../merge.ts`'s; this file is the
 * Cypher.
 */
import type { GraphTx, Params, Row } from "../engine.js";
import { SCHEMA_EDGE } from "./ontology.js";
import { ALL_EDGE_COLUMNS, MERGE_TYPE } from "./registry.js";
import { createTemporalEdge } from "./temporal.js";

type Run = (cypher: string, params?: Params) => Promise<Row[]>;
const q = (s: string) => `\`${s}\``;

/** Merges chained further than this are not followed (a cycle cannot be
 *  made, since a merged node is deleted; this only bounds the walk). */
const MAX_HOPS = 16;

/** One edge as stored: its type, the other end, its direction from the
 *  node read, and its columns (nulls left out). */
export interface StoredEdge {
  edge: string;
  ref_id: string;
  /** `out`: the node read is its source. */
  dir: "out" | "in";
  other: string;
  props: Record<string, unknown>;
}

function columns(rel: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(ALL_EDGE_COLUMNS)) if (rel[k] !== undefined && rel[k] !== null) out[k] = rel[k];
  return out;
}

/** Every live edge of `ref_id`, both directions, the ontology's own left
 *  out: a deleted edge stays where it is. */
export async function edgesOf(tx: GraphTx, ref_id: string): Promise<StoredEdge[]> {
  const half = async (dir: "out" | "in") =>
    (await tx.run(
      `MATCH (n:Node {ref_id: $r})${dir === "out" ? "-[e]->" : "<-[e]-"}(o:Node) WHERE label(e) <> '${SCHEMA_EDGE}' AND e.deleted_at IS NULL
       RETURN label(e) AS edge, e AS rel, o.ref_id AS other ORDER BY e.created_at, e.ref_id`,
      { r: ref_id },
    )).map((r): StoredEdge => {
      const props = columns((r["rel"] as Record<string, unknown>) ?? {});
      return { edge: String(r["edge"]), ref_id: String(props["ref_id"]), dir, other: String(r["other"]), props };
    });
  return [...(await half("out")), ...(await half("in"))];
}

/** A copy of an edge between two other nodes: its columns as stored, under
 *  a new ref_id. */
export async function copyEdge(tx: GraphTx, edge: string, src: string, tgt: string, props: Record<string, unknown>): Promise<void> {
  await createTemporalEdge(tx, edge, src, tgt, props);
}

/** Hard-delete the edges `ref_ids` (a merge's own copies, on undo). */
export async function deleteEdges(tx: GraphTx, edge: string, ref_ids: string[]): Promise<void> {
  if (ref_ids.length) await tx.run(`UNWIND $ids AS id MATCH ()-[r:${q(edge)} {ref_id: id}]->() DELETE r`, { ids: ref_ids });
}

/** The edge `ref_id` of type `edge` as stored, or null. */
export async function storedEdge(tx: GraphTx, edge: string, ref_id: string): Promise<Record<string, unknown> | null> {
  const rows = await tx.run(`MATCH ()-[r:${q(edge)} {ref_id: $id}]->() RETURN r AS rel`, { id: ref_id });
  return rows[0] ? columns(rows[0]["rel"] as Record<string, unknown>) : null;
}

/** The search rows of `edge_ref_ids` that are live: deleted at `now`. */
export async function hideRows(tx: GraphTx, edge_ref_ids: string[], now: number): Promise<string[]> {
  if (!edge_ref_ids.length) return [];
  const rows = await tx.run(
    `UNWIND $ids AS id MATCH (n:Node {node_type: 'EdgeText', edge_ref_id: id}) WHERE n.deleted_at IS NULL
     SET n.deleted_at = CAST($now AS INT64) RETURN n.edge_ref_id AS e`,
    { ids: edge_ref_ids, now },
  );
  return rows.map((r) => String(r["e"]));
}

/** The rows `hideRows` deleted at `at`, live again. */
export async function showRows(tx: GraphTx, edge_ref_ids: string[], at: number): Promise<void> {
  if (!edge_ref_ids.length) return;
  await tx.run(
    `UNWIND $ids AS id MATCH (n:Node {node_type: 'EdgeText', edge_ref_id: id}) WHERE n.deleted_at = CAST($at AS INT64) SET n.deleted_at = NULL`,
    { ids: edge_ref_ids, at },
  );
}

/** A merge's record as stored. */
export interface MergeRow {
  ref_id: string;
  kept_ref_id: string;
  duplicate_ref_id: string;
  namespace: string;
  created_by: string | null;
  created_at: number;
  merge_moves: string;
  undone_at: number | null;
}

export async function writeMergeRow(tx: GraphTx, row: Omit<MergeRow, "undone_at"> & { key: string; title: string }): Promise<void> {
  await tx.run(
    `CREATE (n:Node {ref_id: $ref_id, node_type: '${MERGE_TYPE}', \`key\`: $key, namespace: $namespace, title: $title,
       kept_ref_id: $kept_ref_id, duplicate_ref_id: $duplicate_ref_id, merge_moves: $merge_moves,
       created_by: $created_by, created_at: CAST($created_at AS INT64), updated_at: CAST($created_at AS INT64)})`,
    { ...row },
  );
}

export async function readMergeRow(run: Run, ref_id: string): Promise<MergeRow | null> {
  const rows = await run(
    `MATCH (n:Node {ref_id: $id, node_type: '${MERGE_TYPE}'})
     RETURN n.ref_id AS ref_id, n.kept_ref_id AS kept_ref_id, n.duplicate_ref_id AS duplicate_ref_id, n.namespace AS namespace,
            n.created_by AS created_by, n.created_at AS created_at, n.merge_moves AS merge_moves, n.undone_at AS undone_at`,
    { id: ref_id },
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ref_id: String(r["ref_id"]),
    kept_ref_id: String(r["kept_ref_id"]),
    duplicate_ref_id: String(r["duplicate_ref_id"]),
    namespace: String(r["namespace"]),
    created_by: (r["created_by"] as string | undefined) ?? null,
    created_at: Number(r["created_at"]),
    merge_moves: String(r["merge_moves"]),
    undone_at: r["undone_at"] === null || r["undone_at"] === undefined ? null : Number(r["undone_at"]),
  };
}

export async function markUndone(tx: GraphTx, ref_id: string, by: string, now: number): Promise<void> {
  await tx.run(
    `MATCH (n:Node {ref_id: $id, node_type: '${MERGE_TYPE}'}) SET n.undone_at = CAST($now AS INT64), n.undone_by = $by, n.updated_at = CAST($now AS INT64)`,
    { id: ref_id, by, now },
  );
}

/** The merges in force that touch `ref_id` (kept or duplicate) made after `since`. */
export async function mergesSince(run: Run, ref_id: string, since: number): Promise<string[]> {
  const rows = await run(
    `MATCH (n:Node {node_type: '${MERGE_TYPE}'}) WHERE n.undone_at IS NULL AND n.created_at > CAST($since AS INT64)
       AND (n.kept_ref_id = $r OR n.duplicate_ref_id = $r)
     RETURN n.ref_id AS ref_id ORDER BY n.created_at`,
    { r: ref_id, since },
  );
  return rows.map((r) => String(r["ref_id"]));
}

/** How many merges `by` made since `since`, undone ones too. */
export async function mergesBy(run: Run, by: string, since: number): Promise<number> {
  const rows = await run(`MATCH (n:Node {node_type: '${MERGE_TYPE}'}) WHERE n.created_by = $by AND n.created_at > CAST($since AS INT64) RETURN count(n) AS n`, { by, since });
  return Number(rows[0]?.["n"] ?? 0);
}

/** The node `ref_id` was merged into, following later merges of that one
 *  too; null when it was not merged (or the merge was undone). */
export async function mergedInto(run: Run, ref_id: string): Promise<string | null> {
  let at = ref_id;
  for (let i = 0; i < MAX_HOPS; i++) {
    const rows = await run(
      `MATCH (n:Node {node_type: '${MERGE_TYPE}'}) WHERE n.duplicate_ref_id = $r AND n.undone_at IS NULL RETURN n.kept_ref_id AS k ORDER BY n.created_at DESC LIMIT 1`,
      { r: at },
    );
    const next = rows[0]?.["k"];
    if (typeof next !== "string") break;
    at = next;
  }
  return at === ref_id ? null : at;
}
