/**
 * The statements behind `assert` on a Ladybug file (`../temporal.ts`): a
 * temporal edge type's edges in one slot, a new edge (CREATE, not MERGE:
 * history holds several edges between the same two nodes), a change to
 * one, and the word-match scan over every temporal edge's `text`. The
 * decisions are `../temporal.ts`'s; this file is the Cypher.
 */
import type { GraphTx, Params, Row } from "../engine.js";
import { SCHEMA_EDGE } from "./ontology.js";

const q = (s: string) => `\`${s}\``;
/** The INT64 columns a temporal edge write sets: a JS number is cast. */
const TIMES = new Set(["created_at", "updated_at", "valid_at", "invalid_at", "expired_at", "last_confirmed_at"]);
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
