/**
 * jarvis-dialect edge writes (`plans/jarvis-graph-compat.md` §3, §6).
 *
 * Canonical semantics from jarvis's bulk path (`bulk_edge_helper.py:243-254`
 * + `node_service_v2.py` edge stamping) in plain Cypher — no APOC needed
 * because the edge type is static per statement:
 *
 *   - endpoints matched by `ref_id` on `:Data_Bank` (the only unique ref_id
 *     constraint), never by node_key;
 *   - `IS_ALIAS` COALESCE rewrite (jarvis node-merge parks aliases; the
 *     edge lands on the canonical node);
 *   - `edge_key` = the edge schema's `edge_key` pattern sanitized over the
 *     edge properties when it declares one, else `edgeType.toLowerCase()`;
 *   - one edge per (src, type, tgt): ON CREATE only — existing edges are
 *     never mutated, except that a legacy flagged one is made live again;
 *   - stamps: `ref_id`, `edge_key`, `weight` (1 unless given),
 *     `date_added_to_graph` (epoch ms), and `unique_source_id` when both
 *     endpoints carry the same one; NO `namespace` on edges;
 *   - delete = `DELETE r` (`deletion.ts`): edges are never muted or flagged.
 *
 * Validation: an edge whose SOURCE is a Strut type must be a row of the
 * closed Strut registry (§6 item 6; `ACCESSED` accepts any target). Any
 * other source type follows jarvis's own rules — the `EDGE_TYPES`
 * allowlist, else an edge schema must exist between the endpoint types or
 * their ancestors (or the `*` wildcard). Both endpoints must resolve — a
 * miss is an error, not a silent zero-row no-op.
 *
 * The statements live behind `EdgeEngine` (`engine.ts`): `neo4j-engine.ts`
 * holds the MERGE and the `shortestPath` cycle check, `ladybug/engine.ts`
 * the rel-table form. This file validates and decides; it issues no Cypher.
 */
import { randomUUID } from "node:crypto";
import type { EdgeMergeRow, EngineLike, GraphEngine, GraphTx } from "./engine.js";
import { asEngine } from "./neo4j-engine.js";
import { GraphValidationError } from "./node-writer.js";
import { SchemaResolver } from "./schema-resolver.js";
import { STRUT_EDGES, WILDCARD_TARGET_EDGES, isStrutType, typeLabelOf } from "./strut-schemas.js";

export { typeLabelOf };

export interface EdgeInput {
  edge: string;
  source_ref_id: string;
  target_ref_id: string;
  /** Extra edge attributes — unvalidated passthrough, as in jarvis. Stamp
   *  keys (`ref_id`, `edge_key`, `weight`, `date_added_to_graph`) may not
   *  be supplied. On Neo4j a plain JS number is written as FLOAT; wrap with
   *  `int()` from `bolt.ts` for an Integer. */
  properties?: Record<string, unknown>;
  /** Overrides the `weight: 1` stamp on create (jarvis accepts a caller
   *  weight on POST /v2/edges). Written as an Integer when integral. */
  weight?: number;
}

export interface EdgeWriteResult {
  ref_id: string;
  edge_key: string;
  created: boolean;
  /** The ref_ids the edge actually landed on after alias rewrite. */
  source_ref_id: string;
  target_ref_id: string;
}

/** How `update` finds its edge: by ref_id, or by the (source, EDGE, target) triple. */
export type EdgeLocator = { ref_id: string } | { edge: string; source_ref_id: string; target_ref_id: string };

export interface EdgeUpdate {
  /** Properties to set/overwrite (`undefined` values are skipped). */
  set?: Record<string, unknown>;
  /** Property names to remove. */
  remove?: string[];
}

export interface EdgeUpdateResult {
  ref_id: string;
  edge: string;
  source_ref_id: string;
  target_ref_id: string;
  updated: string[];
  removed: string[];
}

/** What `move` re-homes: the one live `edge` that ties `ref_id` to where it
 *  hangs now, re-pointed at `to_ref_id`. */
export interface EdgeMove {
  /** The node being moved. */
  ref_id: string;
  edge: string;
  /** Which way the edge points, from the moved node's side — graph-neighbors'
   *  `direction`: `reverse` = `(from)-[EDGE]->(node)`, `forward` =
   *  `(node)-[EDGE]->(from)`. The new edge points the same way. */
  direction: "forward" | "reverse";
  /** Where it hangs now. Needed only when it has more than one live `edge`
   *  that way. */
  from_ref_id?: string;
  to_ref_id: string;
}

export interface EdgeMoveResult {
  /** false: it already hung under `to_ref_id` — nothing written. */
  moved: boolean;
  ref_id: string;
  from_ref_id: string;
  to_ref_id: string;
  /** The live edge to `to_ref_id`. */
  edge_ref_id: string;
  /** The edge to `from_ref_id` — deleted by the move. */
  previous_edge_ref_id: string;
}

export interface EdgeWriterOptions {
  resolver?: SchemaResolver;
}

const STAMPS = new Set(["ref_id", "edge_key", "weight", "date_added_to_graph", "unique_source_id"]);
/** Stamps `update` may never touch (`weight` is caller-settable, as on create). */
const PROTECTED = new Set(["ref_id", "edge_key", "date_added_to_graph", "unique_source_id"]);
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const EDGE_TYPE = /^[A-Z][A-Z0-9_]*$/;

/** Registry check for one (source type, edge, target type) triple. */
export function isRegisteredEdge(edge: string, sourceType: string, targetType: string): boolean {
  return STRUT_EDGES.some(
    (r) => r.edge === edge && r.source === sourceType && (WILDCARD_TARGET_EDGES.has(edge) || r.target === targetType),
  );
}

export function edgeKeyFor(edge: string): string {
  return edge.toLowerCase();
}

/** jarvis `sanitize_edge_key`: each `-`-token of the schema's edge_key
 *  pattern is looked up (case-insensitively) in the edge properties and
 *  sanitized like node_key values. */
export function composeEdgeKey(pattern: string, properties: Record<string, unknown>): string {
  const lower = new Map(Object.entries(properties).map(([k, v]) => [k.toLowerCase(), v]));
  return pattern
    .split("-")
    .map((tok) => {
      if (!lower.has(tok.toLowerCase())) throw new GraphValidationError("MISSING_REQUIRED", "edge", `edge_key property ${tok} missing from edge data`, tok);
      return String(lower.get(tok.toLowerCase())).trim().replace(/ /g, "").toLowerCase().replace(/[^a-zA-Z0-9\s]/g, "");
    })
    .join("-");
}

interface ResolvedEdge {
  input: EdgeInput;
  edge_key: string;
  unique_source_id?: string;
}

export class EdgeWriter {
  readonly resolver: SchemaResolver;
  private readonly engine: GraphEngine;
  constructor(engine: EngineLike, opts: EdgeWriterOptions = {}) {
    this.engine = asEngine(engine);
    this.resolver = opts.resolver ?? new SchemaResolver(this.engine);
  }

  async write(input: EdgeInput): Promise<EdgeWriteResult> {
    const [r] = await this.writeMany([input]);
    return r!;
  }

  /**
   * Write many edges in one transaction — one UNWIND MERGE per edge type.
   * Results in input order. All-or-nothing: any validation failure
   * (unknown type, unregistered triple, unresolvable endpoint) writes
   * nothing.
   */
  async writeMany(inputs: EdgeInput[]): Promise<EdgeWriteResult[]> {
    if (inputs.length === 0) return [];
    for (const i of inputs) validateEdgeShape(i);
    const results: EdgeWriteResult[] = new Array(inputs.length);
    await this.engine.tx(async (tx) => {
      const resolved = await this.validateEndpoints(tx, inputs);
      const byType = new Map<string, number[]>();
      inputs.forEach((i, idx) => byType.set(i.edge, [...(byType.get(i.edge) ?? []), idx]));
      for (const [edge, idxs] of byType) {
        const out = await this.mergeEdges(tx, edge, idxs.map((i) => resolved[i]!));
        idxs.forEach((i, k) => {
          results[i] = out[k]!;
        });
      }
    });
    return results;
  }

  /**
   * Patch an existing edge's properties — jarvis `PATCH /v2/edges/:ref_id`
   * (`set_edge_properties`), the one way to change an edge after the
   * ON-CREATE-only MERGE. Located by `ref_id`, or by the
   * `(source, EDGE, target)` triple (alias-rewritten like a write; legacy
   * flagged edges are skipped; more than one live edge of that type between the
   * endpoints — distinct edge_keys — is an error: pass the ref_id).
   * Identity stamps (`ref_id`, `edge_key`, `date_added_to_graph`,
   * `unique_source_id`) cannot be set or removed; `weight` can. On Neo4j
   * numbers write as FLOAT (an integral `weight` as Integer, like create).
   */
  async update(where: EdgeLocator, patch: EdgeUpdate): Promise<EdgeUpdateResult> {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch.set ?? {})) {
      if (v === undefined) continue;
      if (PROTECTED.has(k)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", "edge", "edge stamp is system-managed", k);
      if (!IDENT.test(k)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", "edge", "edge property is not a bare identifier", k);
      set[k] = v;
    }
    const remove = [...new Set(patch.remove ?? [])];
    for (const k of remove) {
      if (PROTECTED.has(k) || k === "weight") throw new GraphValidationError("UNKNOWN_ATTRIBUTE", "edge", "edge stamp is system-managed", k);
      if (!IDENT.test(k)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", "edge", "edge property is not a bare identifier", k);
    }
    if (Object.keys(set).length === 0 && remove.length === 0) throw new GraphValidationError("MISSING_REQUIRED", "edge", "nothing to set or remove");

    return this.engine.tx(async (tx) => {
      let r;
      if ("ref_id" in where) {
        if (!where.ref_id) throw new GraphValidationError("MISSING_REQUIRED", "edge", "ref_id is required");
        r = await this.engine.edgeEngine.setProps(tx, where.ref_id, set, remove);
        if (!r) throw new GraphValidationError("NOT_FOUND", "edge", `no edge with ref_id ${where.ref_id}`);
      } else {
        const edge = where.edge.toUpperCase().replace(/ /g, "_");
        if (!EDGE_TYPE.test(edge)) throw new GraphValidationError("UNKNOWN_TYPE", edge, "edge type must match ^[A-Z][A-Z0-9_]*$");
        if (!where.source_ref_id || !where.target_ref_id) throw new GraphValidationError("MISSING_REQUIRED", edge, "source_ref_id and target_ref_id are required");
        const found = await this.engine.edgeEngine.findByTriple(tx, edge, where.source_ref_id, where.target_ref_id);
        if (found.length === 0) throw new GraphValidationError("NOT_FOUND", edge, `no ${edge} edge from ${where.source_ref_id} to ${where.target_ref_id}`);
        if (found.length > 1) throw new GraphValidationError("DUPLICATE_KEY", edge, `${found.length} ${edge} edges between those nodes — pass the edge ref_id`);
        r = (await this.engine.edgeEngine.setProps(tx, found[0]!, set, remove))!;
      }
      return { ...r, updated: Object.keys(set), removed: remove };
    });
  }

  /** Edge delete (`DELETE r`), by edge ref_id. false: no such edge. */
  async delete(ref_id: string): Promise<boolean> {
    return this.engine.edgeEngine.delete(ref_id);
  }

  /**
   * Move a node: re-point the live `edge` that ties it to where it hangs now
   * at `to_ref_id`, in one transaction. Edges cannot be re-pointed in place,
   * so the old edge is deleted and a new one written the same way round,
   * carrying the old edge's properties (the triple is validated like any
   * write). Refused when `to_ref_id` is the node itself or hangs under it
   * along `edge` (a cycle would cut the subtree loose). A legacy muted edge
   * to `to_ref_id` is made live rather than duplicated (`mergeEdges`).
   */
  async move(m: EdgeMove): Promise<EdgeMoveResult> {
    const edge = m.edge.toUpperCase().replace(/ /g, "_");
    if (!EDGE_TYPE.test(edge)) throw new GraphValidationError("UNKNOWN_TYPE", edge, "edge type must match ^[A-Z][A-Z0-9_]*$");
    if (!m.ref_id || !m.to_ref_id) throw new GraphValidationError("MISSING_REQUIRED", edge, "ref_id and to_ref_id are required");
    if (m.direction !== "forward" && m.direction !== "reverse") throw new GraphValidationError("MISSING_REQUIRED", edge, "direction must be forward or reverse");
    const forward = m.direction === "forward";
    const way = forward ? `(node)-[${edge}]->(…)` : `(…)-[${edge}]->(node)`;
    return this.engine.tx(async (tx) => {
      const found = await this.engine.edgeEngine.liveEdgesOf(tx, m.ref_id, edge, forward);
      if (!found) throw new GraphValidationError("NOT_FOUND", edge, `no node with ref_id ${m.ref_id}`);
      const node = found.node;
      const current = found.edges;
      const hits = m.from_ref_id ? current.filter((r) => r.other === m.from_ref_id) : current;
      if (hits.length === 0) {
        throw new GraphValidationError(
          "NOT_FOUND",
          edge,
          m.from_ref_id
            ? `no live ${way} edge between ${node} and ${m.from_ref_id}`
            : `${node} has no live ${way} edge — nothing to move (graph/create-triplet attaches it)`,
        );
      }
      if (hits.length > 1) {
        throw new GraphValidationError("DUPLICATE_KEY", edge, `${node} has ${hits.length} live ${way} edges (to ${hits.map((h) => h.other).join(", ")}) — pass from_ref_id`);
      }
      const old = hits[0]!;
      const from = old.other;
      const unmoved = { moved: false, ref_id: node, from_ref_id: from, to_ref_id: m.to_ref_id, edge_ref_id: old.edge_ref_id, previous_edge_ref_id: old.edge_ref_id };
      if (m.to_ref_id === from) return unmoved;
      if (m.to_ref_id === node) throw new GraphValidationError("WRONG_TYPE", edge, "a node cannot be moved under itself");

      // Everything below the node along `edge` — the target must not be there.
      if (await this.engine.edgeEngine.wouldCycle(tx, edge, node, m.to_ref_id, forward)) {
        throw new GraphValidationError("WRONG_TYPE", edge, `${m.to_ref_id} is under ${node} along ${edge} — moving there would make a cycle`);
      }

      const props = Object.fromEntries(Object.entries(old.props).filter(([k]) => !STAMPS.has(k) && k !== "is_muted" && k !== "is_deleted"));
      const input: EdgeInput = forward
        ? { edge, source_ref_id: node, target_ref_id: m.to_ref_id, properties: props }
        : { edge, source_ref_id: m.to_ref_id, target_ref_id: node, properties: props };
      validateEdgeShape(input);
      const resolved = await this.validateEndpoints(tx, [input]);
      const [written] = await this.mergeEdges(tx, edge, resolved);
      // `to_ref_id` was an alias of where it already hangs.
      if (written!.ref_id === old.edge_ref_id) return unmoved;
      // The old edge's properties verbatim, its own stamps back on top.
      if (written!.created) await this.engine.edgeEngine.copyProps(tx, old.edge_ref_id, written!.ref_id, resolved[0]!.unique_source_id ?? null);
      await this.engine.edgeEngine.delete(old.edge_ref_id, tx);
      return {
        moved: true,
        ref_id: node,
        from_ref_id: from,
        to_ref_id: forward ? written!.target_ref_id : written!.source_ref_id,
        edge_ref_id: written!.ref_id,
        previous_edge_ref_id: old.edge_ref_id,
      };
    });
  }

  /** Resolve every endpoint's type label and check each triple: Strut
   *  registry for Strut sources, jarvis's allowlist/edge-schema rules for the
   *  rest. Throws on a missing endpoint or disallowed triple. */
  private async validateEndpoints(tx: GraphTx, inputs: EdgeInput[]): Promise<ResolvedEdge[]> {
    const ids = [...new Set(inputs.flatMap((i) => [i.source_ref_id, i.target_ref_id]))];
    const nodes = await this.engine.edgeEngine.endpoints(tx, ids);
    const out: ResolvedEdge[] = [];
    for (const i of inputs) {
      const s = nodes.get(i.source_ref_id);
      const t = nodes.get(i.target_ref_id);
      if (!s) throw new GraphValidationError("MISSING_REQUIRED", i.edge, `source ${i.source_ref_id} does not resolve`, "source_ref_id");
      if (!t) throw new GraphValidationError("MISSING_REQUIRED", i.edge, `target ${i.target_ref_id} does not resolve`, "target_ref_id");
      const st = s.type;
      const tt = t.type;
      if (!st) throw new GraphValidationError("WRONG_TYPE", i.edge, "source node has no type label", "source_ref_id");
      let edge_key = edgeKeyFor(i.edge);
      if (isStrutType(st)) {
        if (!isRegisteredEdge(i.edge, st, tt ?? "")) {
          throw new GraphValidationError("WRONG_TYPE", i.edge, `${st}-[${i.edge}]->${tt ?? "?"} is not a registered Strut edge`);
        }
      } else {
        const match = await this.resolver.edgeSchema(i.edge, st, tt ?? "", tx);
        if (!match) throw new GraphValidationError("WRONG_TYPE", i.edge, `Invalid edge type: ${i.edge} (no edge schema ${st}-[${i.edge}]->${tt ?? "?"})`);
        const pattern = match.properties["edge_key"];
        if (typeof pattern === "string" && pattern) edge_key = composeEdgeKey(pattern, i.properties ?? {});
      }
      out.push({ input: i, edge_key, unique_source_id: s.uid && s.uid === t.uid ? s.uid : undefined });
    }
    return out;
  }

  /** Stamp every edge (`ref_id`, `edge_key`, `weight` 1 unless given,
   *  `date_added_to_graph`, `unique_source_id` when both ends share one) and
   *  merge the batch; results in input order. */
  private async mergeEdges(tx: GraphTx, edge: string, edges: ResolvedEdge[]): Promise<EdgeWriteResult[]> {
    const rows: EdgeMergeRow[] = edges.map((e, k) => ({
      k,
      src: e.input.source_ref_id,
      tgt: e.input.target_ref_id,
      edge_key: e.edge_key,
      ref_id: randomUUID(),
      weight: e.input.weight ?? 1,
      date_added_to_graph: Date.now(),
      ...(e.unique_source_id ? { unique_source_id: e.unique_source_id } : {}),
      props: e.input.properties ?? {},
    }));
    const out = await this.engine.edgeEngine.mergeBatch(tx, edge, rows);
    const byK = new Map(out.map((r) => [r.k, r]));
    return edges.map((e, k) => {
      const r = byK.get(k)!;
      return { ref_id: r.ref_id, edge_key: e.edge_key, created: r.created, source_ref_id: r.source_ref_id, target_ref_id: r.target_ref_id };
    });
  }
}

function validateEdgeShape(i: EdgeInput): void {
  if (!EDGE_TYPE.test(i.edge)) throw new GraphValidationError("UNKNOWN_TYPE", i.edge, "edge type must match ^[A-Z][A-Z0-9_]*$");
  if (!i.source_ref_id || !i.target_ref_id) throw new GraphValidationError("MISSING_REQUIRED", i.edge, "source_ref_id and target_ref_id are required");
  for (const k of Object.keys(i.properties ?? {})) {
    if (STAMPS.has(k)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", i.edge, "edge stamp is system-managed", k);
    if (!IDENT.test(k)) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", i.edge, "edge property is not a bare identifier", k);
  }
}
