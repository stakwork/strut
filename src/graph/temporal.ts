/**
 * Temporal edges and `assert` (plans/graph-memory-plan.md step 3). An edge
 * type whose rule says `temporal` holds edges with two clocks: the world's
 * (`valid_at`, `invalid_at`: when it was true) and the graph's
 * (`created_at`, `expired_at`: when the graph held it), a sentence
 * (`text`), and the nodes it was learned from (`sources`). Its edges are
 * written by `assertEdge` alone: plain edge creation on the type is refused
 * (`edge-writer.ts`). In one transaction, `assertEdge` loads the schema, then
 *
 *   - re-confirms: the same source, type and target held now (or, for an
 *     assert of something already past, held before) gains the source once
 *     and a date it was missing; the same source again changes nothing;
 *   - supersedes: on a `cardinality: one` type a different target ends the
 *     current edge (`expired_at` now, `invalid_at` when the new one began,
 *     `superseded_by` the new one) and creates the new one;
 *   - creates: a back-dated assert (begun before the current edge did)
 *     becomes history, ended when the current one began, which stays.
 *
 * `observed_at` is when the evidence is from (the message, email, event or
 * document it was read from), when that is not now. It sets
 * `last_confirmed_at`, which only moves forward, and older evidence never
 * replaces newer: a different value observed before the current one was
 * last confirmed is history, and the current one stays. The graph's own
 * clock (`created_at`, `expired_at`) stays the writer's.
 *
 * The rules are `remember.ts`'s and its `supersede()` (C's branch), on the
 * shape of jarvis's `temporal_edge_helper.py`. A Ladybug file only: its
 * writes are serialised through one writer, so two asserts on one slot
 * leave one current edge. Neo4j has no `assert`, and is as before.
 *
 * Every new edge gets its search row in the same transaction
 * (plans/graph-edge-search.md; `ladybug/temporal.ts`): an `EdgeText` node
 * holding the composed fact (both ends' titles, the edge type as words, the
 * sentence) and its vector, embedded before the transaction. A failed
 * embedding writes the row keyword-only (`unembedded`), filled in the
 * background after the commit (`embedPendingEdgeRows`). The
 * row copies its edge's namespace and clocks, and ends with it.
 *
 * Facts are also found by word match over the temporal edges' `text`
 * (`findFacts`), ranked by how many words hit, as `memory/recall` does;
 * searching the rows is step 4's.
 */
import { randomUUID } from "node:crypto";
import type { EngineLike, GraphTx } from "./engine.js";
import { edgeKeyFor } from "./edge-writer.js";
import { writeNamespace } from "./ladybug/namespaces.js";
import { composeFact, createTemporalEdge, factRows, setTemporalEdge, slotEdges, syncEdgeRow, temporalEdgeTypes, titlesOf, writeEdgeRow } from "./ladybug/temporal.js";
import { asEngine } from "./neo4j-engine.js";
import { boundsOf } from "./scope.js";
import { GraphValidationError, type Embedder } from "./node-writer.js";
import type { SchemaResolver } from "./schema-resolver.js";
import { foldText, worldTime } from "./world-time.js";

/** A run as one of a fact's sources: `run:<runId>`, which StrutRun's `run_id` finds. */
export const runSource = (runId: string): string => `run:${runId}`;

export { foldText, worldTime };

export interface AssertInput {
  edge: string;
  source_ref_id: string;
  target_ref_id: string;
  /** The sentence the edge stands for ("Kate lives in Lisbon"). */
  text: string;
  /** When it became / stopped being true: an ISO date ('2026', '2026-09'
   *  for a year or month) or epoch ms. Unknown when left out. */
  valid_at?: string | number;
  invalid_at?: string | number;
  /** When the evidence is from: the time of the message, email, event or
   *  document it was read from, as for `valid_at`. Now when left out; a time
   *  to come is taken as now. */
  observed_at?: string | number;
  /** The ref_id of the node it was learned from (an episode, a message). */
  source?: string;
  /** The ref_id of the node that said it, when not the graph's owner (a
   *  Person who told the user). Kept among the edge's `sources`, like
   *  `source`; it must resolve to a node. */
  said_by?: string;
  /** The run that asserted it, kept among the edge's sources as
   *  `run:<id>` (`runSource`): stamped by the caller from its own context,
   *  never the model's to choose, so every fact leads back to the run, and
   *  from it to the chat and message it came from. */
  run?: string;
  /** It is no longer true ("used to …"), even with no `invalid_at`: kept
   *  as past, ending the same fact held now, with no end date invented. */
  ended?: boolean;
  /** The edge's namespace; default its source node's. */
  namespace?: string;
  /** Who is asserting it: the host's name for the caller's actor. */
  created_by?: string;
}

export type AssertAction = "created" | "superseded" | "history" | "reconfirmed" | "unchanged";

export interface AssertResult {
  ref_id: string;
  action: AssertAction;
  /** The current edges this one ended (`superseded`). */
  superseded: string[];
  /** It is not current: past when asserted, or history. */
  ended: boolean;
  /** Dates a re-confirm filled on the edge it found. */
  filled?: string[];
  /** A new edge's search row is still to be embedded (no embedder, or the
   *  embedding failed): written keyword-only, its vector filled later. */
  unembedded?: boolean;
}

export interface AssertOptions {
  /** On the caller's write transaction, landing with its other statements. */
  tx?: GraphTx;
  /** The writer's clock (epoch ms). */
  now?: () => number;
  /** Embeds a new edge's search row, before the transaction. */
  embedder?: Embedder;
}

const EDGE_TYPE = /^[A-Z][A-Z0-9_]*$/;

/** A date given as epoch ms or ISO, or null when none is given. */
function timeOf(edge: string, field: string, v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const ms = typeof v === "number" ? (Number.isFinite(v) ? Math.trunc(v) : undefined) : worldTime(v);
  if (ms === undefined) throw new GraphValidationError("WRONG_TYPE", edge, `${field} ${JSON.stringify(v)} is not a date (ISO, a year, a year-month, or epoch ms)`, field);
  return ms;
}

/** When an edge `by` replaces began (`valid`, null when unknown), the end of
 *  the edge `o` it replaces in the world: `supersede()`'s rule. An end not
 *  set becomes `valid` when that is known and not before `o` began; an end
 *  still to come is brought forward to then, or to now. */
export function endOfReplaced(o: { valid_at: number | null; invalid_at: number | null }, valid: number | null, now: number): number | null {
  const began = valid !== null && (o.valid_at === null || o.valid_at <= valid);
  if (o.invalid_at === null) return began ? valid : null;
  if (o.invalid_at <= now) return o.invalid_at;
  if (began) return Math.min(valid!, o.invalid_at);
  return now;
}

/**
 * Assert a temporal edge (see the header). Throws a `GraphValidationError`
 * on a Neo4j graph, an endpoint that does not resolve, an edge type that is
 * not temporal between the endpoints' types, an empty `text`, a date that
 * is not one, or an end before its start. All or nothing.
 */
export async function assertEdge(e: EngineLike, resolver: SchemaResolver, input: AssertInput, opts: AssertOptions = {}): Promise<AssertResult> {
  const engine = asEngine(e);
  const edge = String(input.edge ?? "").trim();
  if (engine.kind !== "ladybug") throw new GraphValidationError("WRONG_TYPE", edge || "?", "graph/assert works on a LadybugDB graph only: this graph is Neo4j, whose edges are not temporal");
  if (!EDGE_TYPE.test(edge)) throw new GraphValidationError("UNKNOWN_TYPE", edge || "?", "edge type must match ^[A-Z][A-Z0-9_]*$");
  if (!input.source_ref_id || !input.target_ref_id) throw new GraphValidationError("MISSING_REQUIRED", edge, "source_ref_id and target_ref_id are required");
  const text = String(input.text ?? "").trim();
  if (!text) throw new GraphValidationError("MISSING_REQUIRED", edge, "an asserted edge needs its sentence", "text");
  const valid = timeOf(edge, "valid_at", input.valid_at);
  const invalid = timeOf(edge, "invalid_at", input.invalid_at);
  if (valid !== null && invalid !== null && invalid < valid) throw new GraphValidationError("WRONG_TYPE", edge, "invalid_at is before valid_at: it ends before it starts", "invalid_at");
  const now = (opts.now ?? Date.now)();
  // Given, the evidence's own time; left out, now, and no older-evidence rule: two writes at
  // once read their clocks before the writer orders them.
  const seen = timeOf(edge, "observed_at", input.observed_at);
  const observed = Math.min(seen ?? now, now);
  // When each edge was last confirmed: an edge from before the column, when it was made.
  const confirmed = (x: { last_confirmed_at: number | null }) => x.last_confirmed_at ?? 0;
  // A fact said to be over, or whose end is given and not in the future, is past.
  const past = input.ended === true || (invalid !== null && invalid <= now);
  const saidBy = input.said_by?.trim() || undefined;

  // The search row's text and vector, made before the transaction: a failed
  // embedding leaves the row keyword-only, never the write undone.
  // Read on the caller's transaction when there is one: an end it created
  // is not committed yet. Otherwise unscoped (a reader's list refuses a raw
  // query): the titles go into the hidden search row alone.
  const unscoped = boundsOf(e)?.query ?? ((c: string, p?: Record<string, unknown>) => engine.query(c, p));
  const titles = await titlesOf((c, p) => (opts.tx ? opts.tx.run(c, p) : unscoped(c, p)), [input.source_ref_id, input.target_ref_id]);
  const composed = composeFact(titles.get(input.source_ref_id), edge, titles.get(input.target_ref_id), text);
  let vector: number[] | undefined;
  if (opts.embedder) {
    try {
      [vector] = await opts.embedder.embed([composed]);
    } catch {
      vector = undefined;
    }
  }

  const go = async (tx: GraphTx): Promise<AssertResult> => {
    const ends = await engine.edgeEngine.endpoints(tx, [input.source_ref_id, input.target_ref_id, ...(saidBy ? [saidBy] : [])]);
    const s = ends.get(input.source_ref_id);
    const t = ends.get(input.target_ref_id);
    if (!s?.type) throw new GraphValidationError("MISSING_REQUIRED", edge, `source ${input.source_ref_id} does not resolve`, "source_ref_id");
    if (!t?.type) throw new GraphValidationError("MISSING_REQUIRED", edge, `target ${input.target_ref_id} does not resolve`, "target_ref_id");
    if (saidBy && !ends.get(saidBy)?.type) throw new GraphValidationError("MISSING_REQUIRED", edge, `said_by ${saidBy} does not resolve to a node`, "said_by");
    const match = await resolver.edgeSchema(edge, s.type, t.type, tx);
    if (!match) throw new GraphValidationError("WRONG_TYPE", edge, `no edge schema ${s.type}-[${edge}]->${t.type}`);
    if (!match.rule.temporal) throw new GraphValidationError("WRONG_TYPE", edge, `${edge} is not a temporal edge type: write it with graph/create-triplet`);
    const one = match.rule.cardinality === "one";
    // Where it was learned and who said it: each kept once among the edge's sources.
    const given = [...new Set([input.source?.trim(), saidBy, input.run ? runSource(input.run) : undefined].filter((x): x is string => !!x))];

    // The same edge held now, or for a past fact, held before.
    const current = await slotEdges(tx, edge, input.source_ref_id);
    const held = current.find((x) => x.target === input.target_ref_id);
    const hit = held ?? (past ? (await slotEdges(tx, edge, input.source_ref_id, true)).find((x) => x.target === input.target_ref_id) : undefined);
    if (hit) {
      // A date it was missing is filled, never one that would end it before
      // it began. Said to be past while held now, it stops being held.
      const ending = !!held && past;
      const v = hit.valid_at ?? (valid !== null && (hit.invalid_at === null || valid <= hit.invalid_at) ? valid : null);
      const end = ending ? invalid ?? (hit.invalid_at !== null && hit.invalid_at > now ? null : hit.invalid_at) : hit.invalid_at ?? invalid;
      const inv = end !== null && v !== null && end < v ? hit.invalid_at : end;
      const filled = [...(v !== hit.valid_at ? ["valid_at"] : []), ...(inv !== hit.invalid_at ? ["invalid_at"] : [])];
      const expire = !!held && (ending || (inv !== null && inv <= now));
      const fresh = given.filter((x) => !hit.sources.includes(x));
      const later = observed > confirmed(hit);
      // The same sources again (or nothing new) change nothing: the same evidence confirms nothing.
      if (!filled.length && !expire && given.length && !fresh.length) {
        return { ref_id: hit.ref_id, action: "unchanged", superseded: [], ended: hit.expired_at !== null };
      }
      await setTemporalEdge(tx, edge, hit.ref_id, {
        ...(filled.includes("valid_at") ? { valid_at: v } : {}),
        ...(filled.includes("invalid_at") ? { invalid_at: inv } : {}),
        ...(expire ? { expired_at: now } : {}),
        ...(fresh.length ? { sources: [...hit.sources, ...fresh] } : {}),
        ...(later ? { last_confirmed_at: observed } : {}),
        updated_at: now,
      });
      if (filled.length || expire) {
        await syncEdgeRow(tx, hit.ref_id, {
          ...(filled.includes("valid_at") ? { valid_at: v } : {}),
          ...(filled.includes("invalid_at") ? { invalid_at: inv } : {}),
          ...(expire ? { expired_at: now } : {}),
        }, now);
      }
      return { ref_id: hit.ref_id, action: "reconfirmed", superseded: [], ended: hit.expired_at !== null || expire, ...(filled.length ? { filled } : {}) };
    }

    // A current fact on a one-value slot replaces the slot's current edges,
    // unless it began before one of them, or was observed before one was
    // last confirmed: then it is history, ended when the earliest of those
    // began (unknown when none says).
    const replaced = one && !past ? current : [];
    const later = valid === null ? [] : replaced.map((x) => x.valid_at).filter((v): v is number => v !== null && v > valid);
    const newer = seen === null ? [] : replaced.filter((x) => confirmed(x) > observed);
    const after = newer.map((x) => x.valid_at).filter((v): v is number => v !== null && (valid === null || v > valid));
    const history = later.length > 0 || newer.length > 0;
    const until = [...later, ...after, ...(invalid !== null ? [invalid] : [])];
    const ended = past || history;
    const ref_id = randomUUID();
    const own = s.namespace ?? engine.namespace;
    const namespace = input.namespace === undefined ? own : writeNamespace(edge, input.namespace, own);
    const clocks = { valid_at: valid, invalid_at: history ? (until.length ? Math.min(...until) : null) : invalid, expired_at: ended ? now : null };
    await createTemporalEdge(tx, edge, input.source_ref_id, input.target_ref_id, {
      ref_id,
      edge_key: edgeKeyFor(edge),
      namespace,
      created_by: input.created_by,
      created_at: now,
      updated_at: now,
      weight: 1,
      text,
      sources: given,
      ...clocks,
      last_confirmed_at: observed,
    });
    await writeEdgeRow(tx, {
      edge_ref_id: ref_id,
      edge_type: edge,
      source_ref_id: input.source_ref_id,
      target_ref_id: input.target_ref_id,
      text,
      composed,
      namespace,
      created_by: input.created_by,
      vector,
      ...clocks,
    }, now);
    const superseded = ended ? [] : replaced;
    for (const o of superseded) {
      const end = { expired_at: now, invalid_at: endOfReplaced(o, valid, now) };
      await setTemporalEdge(tx, edge, o.ref_id, { ...end, superseded_by: ref_id, updated_at: now });
      await syncEdgeRow(tx, o.ref_id, end, now);
    }
    return {
      ref_id,
      action: superseded.length ? "superseded" : history ? "history" : "created",
      superseded: superseded.map((o) => o.ref_id),
      ended,
      ...(vector ? {} : { unembedded: true }),
    };
  };
  const out = await (opts.tx ? go(opts.tx) : engine.tx(go));
  // A row written without its vector is filled in the background once the
  // write has committed (a caller's transaction: at the next open).
  if (out.unembedded && opts.embedder && !opts.tx) void engine.nodeEngine.embedPendingRows?.(opts.embedder);
  return out;
}

/** Embed the facts' search rows still without a vector on a Ladybug
 *  backend: what a failed embedding or a rename left. One run at a time per
 *  handle; it runs by itself after open and after such a write, and never
 *  rejects. How many it embedded; 0 without an embedder or on Neo4j. */
export async function embedPendingEdgeRows(b: { nodeEngine: { embedPendingRows?(embedder: Embedder): Promise<number> }; embedder: Embedder | undefined }): Promise<number> {
  return b.embedder && b.nodeEngine.embedPendingRows ? b.nodeEngine.embedPendingRows(b.embedder) : 0;
}

export interface FactQuery {
  /** Plain words ("Kate lives"). */
  q: string;
  /** Only these temporal edge types (default: all of them). */
  edge_types?: string[];
  /** Ended facts too (default: current only). */
  include_ended?: boolean;
  limit?: number;
  /** Words not to match on. */
  stop?: Iterable<string>;
}

export interface FactHit {
  ref_id: string;
  edge_type: string;
  text: string;
  namespace?: string;
  source_ref_id: string;
  target_ref_id: string;
  valid_at?: number;
  invalid_at?: number;
  expired_at?: number;
  /** How many of the query's words it holds. */
  score: number;
}

/**
 * Temporal edges whose sentence (or either end's title) holds the query's
 * words, most words first: `memory/recall`'s word match over facts, on the
 * edges. A scan, fine at Peel's size; search rows replace it later. Words
 * of three letters or more count, the stop words left out; a query of none
 * is matched whole. A Ladybug file only.
 */
export async function findFacts(e: EngineLike, p: FactQuery): Promise<FactHit[]> {
  const engine = asEngine(e);
  if (engine.kind !== "ladybug") throw new GraphValidationError("WRONG_TYPE", "?", "facts are temporal edges, which a LadybugDB graph alone holds");
  const stop = new Set(p.stop ?? []);
  const words = foldText(p.q ?? "").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
  const terms = words.length ? words : [foldText(p.q ?? "")].filter(Boolean);
  if (!terms.length) return [];
  const run = (cypher: string, params?: Record<string, unknown>) => engine.query(cypher, params);
  const types = await temporalEdgeTypes(run);
  const wanted = p.edge_types?.length ? types.filter((t) => p.edge_types!.includes(t)) : types;
  const hits: FactHit[] = [];
  for (const edge of wanted) {
    for (const r of await factRows(run, edge, !!p.include_ended)) {
      const hay = foldText(`${r["text"]} ${r["source_title"] ?? ""} ${r["target_title"] ?? ""}`);
      const score = terms.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      if (score === 0) continue;
      const time = (k: string) => (r[k] === null || r[k] === undefined ? {} : { [k]: Number(r[k]) });
      hits.push({
        ref_id: String(r["ref_id"]),
        edge_type: edge,
        text: String(r["text"]),
        ...(typeof r["namespace"] === "string" ? { namespace: r["namespace"] } : {}),
        source_ref_id: String(r["source_ref_id"]),
        target_ref_id: String(r["target_ref_id"]),
        ...time("valid_at"),
        ...time("invalid_at"),
        ...time("expired_at"),
        score,
      });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, p.limit ?? 10));
}
