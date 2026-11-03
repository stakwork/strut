/**
 * `merge` (plans/graph-memory-plan.md step 5): two nodes that are one thing
 * become one. Ported from memory/merge (`src/steps/lib/memory/merge.ts`)
 * onto the workspace graph, its rules kept:
 *
 *   - the duplicate's edges, both directions, move to the kept node. An edge
 *     the kept node already holds (same type, direction and other end) is
 *     not moved twice; on a one-value plain type a slot the kept node
 *     already fills keeps its own edge. A temporal edge follows `assert`'s
 *     rules: the same current fact re-confirms the kept node's (its sources
 *     joined, a missing date filled), and on a `cardinality: one` type two
 *     current values keep the newest (the one that began later when both
 *     say when, else the one written last) and supersede the rest. Every
 *     moved fact gets a search row composed from the kept node's title,
 *     embedded after the commit;
 *   - its title and `alt_names` join the kept node's `alt_names`;
 *   - it is soft-deleted (`deleted_at`, "merged into …"), its own edges left
 *     in place behind it, hidden as an end is deleted, and its facts' search
 *     rows deleted. Nothing is hard-deleted;
 *   - a hidden `Merge` node records who merged what when, and every edge it
 *     moved (ref_id before and after). The reader follows it, so the
 *     duplicate's ref_id still leads to the kept node (`ladybug/reader.ts`
 *     `getNode`, `resolve.ts`'s key stage), and the undo reads it;
 *   - the user (the Person marked `is_owner`) is never the duplicate;
 *   - the janitor (`SYSTEM_WRITER`) merges at most `JANITOR_CAP` pairs a
 *     day, only a pair `duplicatePairs` offers, and into the user only on a
 *     full-name match.
 *
 * Both nodes must be of one type and in one namespace, and both visible to
 * the caller's reader (`scope.ts`): a node it cannot see is not there.
 *
 * `unmergeNodes` undoes one: the copies go, the kept node's edges it
 * re-confirmed or superseded and its `alt_names` are set back, and the
 * duplicate is live again with its own edges. It refuses when a later write
 * touched anything it would set back.
 *
 * A Ladybug file only: a Neo4j graph has no per-node namespace or
 * `alt_names`, and its edges no core columns, so it refuses.
 */
import { randomUUID } from "node:crypto";
import type { GraphBackend } from "./backend.js";
import type { GraphTx } from "./engine.js";
import { copyEdge, deleteEdges, edgesOf, hideRows, markUndone, mergesBy, mergesSince, mergedInto, readMergeRow, showRows, storedEdge, writeMergeRow, type StoredEdge } from "./ladybug/merge.js";
import { EDGE_TEXT_TYPE, MERGE_TYPE, SCHEMA_TYPE } from "./ladybug/registry.js";
import { composeFact, deleteEdgeRows, setTemporalEdge, slotEdges, syncEdgeRow, titlesOf, writeEdgeRow } from "./ladybug/temporal.js";
import { named, pairsOf, type Candidate, type Named } from "./name-pairs.js";
import { refNodeKey } from "./node-writer.js";
import { boundsOf } from "./scope.js";
import { ALT_NAMES } from "./resolve.js";
import { endOfReplaced } from "./temporal.js";
import { SYSTEM_WRITER } from "../system-workflows.js";

/** The janitor merges with no person watching, reading memory that holds
 *  what other people said: at most this many merges in a rolling day. */
export const JANITOR_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MergeErrorCode = "NOT_FOUND" | "REFUSED" | "INVALID_INPUT";

/** A merge or undo refused. Read as a graph error (`graphErrorCode`). */
export class MergeError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphReadError";
  }
}

export interface MergeInput {
  /** The node kept. */
  keep: string;
  /** The node that is the same thing: merged into `keep`. */
  duplicate: string;
  /** Who merges: the caller's actor, or `janitor`. */
  by?: string;
}

/** Edge fields an undo sets back, as they were before the merge. */
type Before = Record<string, unknown>;

/** What a merge did, stored on its record as JSON: what the undo reads. */
export interface MergeMoves {
  /** Edges copied onto the kept node: `from` stays on the duplicate. */
  moved: Array<{ edge: string; from: string; to: string }>;
  /** Current facts the kept node already held: re-confirmed (`before` null
   *  when nothing on it changed). */
  reconfirmed: Array<{ edge: string; from: string; into: string; before: Before | null }>;
  /** The kept node's current edges a newer moved one superseded. */
  superseded: Array<{ edge: string; ref_id: string; by: string; before: Before }>;
  /** Edges left on the duplicate, and why. */
  skipped: Array<{ edge: string; ref_id: string; reason: string }>;
  /** The duplicate's facts whose search rows were deleted. */
  rows: string[];
  kept: { alt_names_before: string[] | null; alt_names_after: string[] | null; updated_at_before: number | null };
}

export interface MergeResult {
  /** The record's ref_id: what `unmergeNodes` takes. */
  merge: string;
  kept: { ref_id: string; node_type: string; title?: string };
  merged: { ref_id: string; node_type: string; title?: string };
  moved: MergeMoves["moved"];
  reconfirmed: Array<{ from: string; into: string }>;
  superseded: string[];
  skipped: MergeMoves["skipped"];
  alt_names: string[];
  notes?: string[];
}

interface Live {
  ref_id: string;
  type: string;
  namespace: string;
  title: string | undefined;
  alt_names: string[] | null;
  is_owner: boolean;
  updated_at: number | null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function ladybugOnly(b: GraphBackend, what: string): void {
  if (b.kind !== "ladybug") throw new MergeError("REFUSED", `${what} works on a LadybugDB graph only: this graph is ${b.kind}, whose nodes carry no namespace or alt_names and whose edges have no core columns`);
}

async function readLive(tx: GraphTx, ref_id: string): Promise<Live | null> {
  const rows = await tx.run(
    `MATCH (n:Node {ref_id: $r}) WHERE n.deleted_at IS NULL
     RETURN n.node_type AS type, n.namespace AS ns, n.title AS title, n.${ALT_NAMES} AS alts, n.is_owner AS owner, n.updated_at AS u`,
    { r: ref_id },
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ref_id,
    type: String(r["type"]),
    namespace: String(r["ns"]),
    title: typeof r["title"] === "string" ? r["title"] : undefined,
    alt_names: Array.isArray(r["alts"]) ? (r["alts"] as unknown[]).map(String) : null,
    is_owner: r["owner"] === true,
    updated_at: num(r["u"]),
  };
}

/** The newer of two current facts first: the one that began later when both
 *  say when, else the one written later (memory/merge's rule). */
function newerFirst(a: { valid_at: number | null; created_at: number; ref_id: string }, b: typeof a): number {
  if (a.valid_at !== null && b.valid_at !== null && a.valid_at !== b.valid_at) return b.valid_at - a.valid_at;
  return b.created_at - a.created_at || b.ref_id.localeCompare(a.ref_id);
}

/**
 * The pairs in `namespace` that may be one thing saved twice, strongest
 * first: memory/duplicates' rules (`name-pairs.ts`) over the graph's live
 * nodes of types whose role is `entity`, by title and `alt_names`. The user
 * is the Person marked `is_owner`, named by its title and `alt_names`; the
 * people are the other nodes of its type. Pairs across types are left out:
 * merge takes one type.
 */
export async function duplicatePairs(b: GraphBackend, namespace: string, tx?: GraphTx): Promise<Candidate[]> {
  ladybugOnly(b, "graph duplicates");
  const run = tx ? tx.run.bind(tx) : b.query.bind(b);
  const types = (await run(`MATCH (n:Node {namespace: $ns}) WHERE n.deleted_at IS NULL RETURN DISTINCT n.node_type AS t`, { ns: namespace })).map((r) => String(r["t"]));
  const entityTypes: string[] = [];
  for (const t of types) if ((await b.schemas.schema(t, tx))?.role === "entity") entityTypes.push(t);
  if (!entityTypes.length) return [];
  const rows = await run(
    `MATCH (n:Node {namespace: $ns}) WHERE n.deleted_at IS NULL AND n.node_type IN $types AND n.title IS NOT NULL
     RETURN n.ref_id AS ref_id, n.node_type AS type, n.title AS title, n.${ALT_NAMES} AS alts, n.is_owner AS owner ORDER BY n.created_at, n.ref_id`,
    { ns: namespace, types: entityTypes },
  );
  const owner = rows.find((r) => r["owner"] === true);
  const entities: Named[] = rows.map((r) => named({ ref_id: String(r["ref_id"]), name: String(r["title"]), node_type: String(r["type"]) }, Array.isArray(r["alts"]) ? (r["alts"] as unknown[]).map(String) : []));
  const isUser = (e: Named) => !!owner && e.side.ref_id === owner["ref_id"];
  const isPerson = (e: Named) => !!owner && !isUser(e) && e.side.node_type === owner["type"];
  const userNames = owner ? [String(owner["title"]), ...(Array.isArray(owner["alts"]) ? (owner["alts"] as unknown[]).map(String) : [])] : [];
  return pairsOf(entities, isUser, userNames, isPerson).filter((p) => p.a.node_type === p.b.node_type);
}

/** Why the janitor may not merge this pair, or undefined when it may. */
async function janitorRefusal(b: GraphBackend, tx: GraphTx, kept: Live, dup: Live, now: number): Promise<string | undefined> {
  if ((await mergesBy(tx.run.bind(tx), SYSTEM_WRITER, now - DAY_MS)) >= JANITOR_CAP) return `the janitor has already merged ${JANITOR_CAP} pairs in the last 24 hours; stop merging`;
  const pair = (await duplicatePairs(b, kept.namespace, tx)).find((p) => (p.a.ref_id === kept.ref_id && p.b.ref_id === dup.ref_id) || (p.a.ref_id === dup.ref_id && p.b.ref_id === kept.ref_id));
  if (!pair) return "the janitor may only merge a pair the duplicates list offers; this pair is not one";
  if (kept.is_owner && pair.score < 100) return "the janitor may merge into the user only a Person with the user's full name";
  return undefined;
}

/** The two nodes as the caller's reader sees them: a node it cannot see,
 *  or one already merged away, is refused. */
async function visible(b: GraphBackend, ref_id: string, role: string): Promise<void> {
  const env = await b.reader.getNode(ref_id);
  if (!env) throw new MergeError("NOT_FOUND", `no node ${ref_id} (the ${role}) that this caller can see`);
  if (env.ref_id !== ref_id) throw new MergeError("REFUSED", `${ref_id} (the ${role}) was already merged into ${env.ref_id}`);
}

/**
 * Merge `duplicate` into `keep` (see the header). All or nothing, in one
 * write transaction. Throws `MergeError` when refused.
 */
export async function mergeNodes(b: GraphBackend, input: MergeInput, opts: { now?: () => number } = {}): Promise<MergeResult> {
  ladybugOnly(b, "graph/merge");
  const { keep, duplicate: dup } = input;
  const by = input.by?.trim() || "agent";
  if (!keep || !dup) throw new MergeError("INVALID_INPUT", "keep and duplicate are required");
  if (keep === dup) throw new MergeError("INVALID_INPUT", "keep and duplicate are the same node");
  await visible(b, keep, "node kept");
  await visible(b, dup, "duplicate");
  const now = (opts.now ?? Date.now)();
  const id = randomUUID();

  const out = await b.tx(async (tx): Promise<MergeResult> => {
    const kept = await readLive(tx, keep);
    const gone = await readLive(tx, dup);
    if (!kept) throw new MergeError("NOT_FOUND", `no node ${keep} (the node kept)`);
    if (!gone) throw new MergeError("NOT_FOUND", `no node ${dup} (the duplicate)`);
    for (const n of [kept, gone]) {
      if (n.type === SCHEMA_TYPE || n.type === EDGE_TEXT_TYPE || n.type === MERGE_TYPE) throw new MergeError("REFUSED", `${n.ref_id} is a ${n.type}, not a node merge takes`);
    }
    if (gone.is_owner) throw new MergeError("REFUSED", "the user cannot be merged into another node; merge the other one into the user");
    if (kept.type !== gone.type) throw new MergeError("REFUSED", `a ${gone.type} cannot be merged into a ${kept.type}: merge takes two nodes of one type`);
    if (kept.namespace !== gone.namespace) throw new MergeError("REFUSED", `the two nodes are in different namespaces (${kept.namespace}, ${gone.namespace}): move one first`);
    if (by === SYSTEM_WRITER) {
      const why = await janitorRefusal(b, tx, kept, gone, now);
      if (why) throw new MergeError("REFUSED", why);
    }

    const moves: MergeMoves = { moved: [], reconfirmed: [], superseded: [], skipped: [], rows: [], kept: { alt_names_before: kept.alt_names, alt_names_after: kept.alt_names, updated_at_before: kept.updated_at } };
    const edges = await edgesOf(tx, dup);
    const rules = new Map<string, { temporal: boolean; one: boolean }>();
    const ruleOf = async (e: StoredEdge) => {
      const k = `${e.edge}|${e.dir}|${e.other}`;
      if (!rules.has(k)) {
        const otherType = String((await tx.run(`MATCH (n:Node {ref_id: $r}) RETURN n.node_type AS t`, { r: e.other }))[0]?.["t"] ?? "");
        const m = await b.schemas.edgeSchema(e.edge, e.dir === "out" ? kept.type : otherType, e.dir === "out" ? otherType : kept.type, tx);
        rules.set(k, { temporal: !!m?.rule.temporal || e.props["text"] !== undefined, one: m?.rule.cardinality === "one" });
      }
      return rules.get(k)!;
    };

    // Decide each edge, then write: a moved edge's `superseded_by` names the
    // copy of what superseded it.
    const copies: Array<{ e: StoredEdge; to: string; src: string; tgt: string; temporal: boolean; one: boolean }> = [];
    const plainOne = new Map<string, number>();
    for (const e of edges) {
      if (e.other === keep || e.other === dup) {
        moves.skipped.push({ edge: e.edge, ref_id: e.ref_id, reason: e.other === keep ? "between the two nodes" : "a loop on the duplicate" });
        continue;
      }
      const [src, tgt] = e.dir === "out" ? [keep, e.other] : [e.other, keep];
      const rule = await ruleOf(e);
      if (rule.temporal && e.props["expired_at"] === undefined) {
        const held = (await slotEdges(tx, e.edge, src)).find((x) => x.target === tgt);
        if (held) {
          moves.reconfirmed.push({ edge: e.edge, from: e.ref_id, into: held.ref_id, before: await reconfirm(tx, e, held, now) });
          continue;
        }
      } else if (!rule.temporal) {
        if ((await b.edgeEngine.findByTriple(tx, e.edge, src, tgt)).length) {
          moves.skipped.push({ edge: e.edge, ref_id: e.ref_id, reason: "the node kept already holds it" });
          continue;
        }
        if (rule.one && e.dir === "out") {
          const filled = plainOne.get(e.edge) ?? (await b.edgeEngine.liveEdgesOf(tx, keep, e.edge, true))?.edges.length ?? 0;
          if (filled > 0) {
            moves.skipped.push({ edge: e.edge, ref_id: e.ref_id, reason: `the node kept already has its one ${e.edge}` });
            continue;
          }
          plainOne.set(e.edge, 1);
        }
      }
      copies.push({ e, to: randomUUID(), src, tgt, temporal: rule.temporal, one: rule.one });
    }
    const renamed = new Map([...copies.map((c) => [c.e.ref_id, c.to] as const), ...moves.reconfirmed.map((r) => [r.from, r.into] as const)]);
    const titles = await titlesOf(tx.run.bind(tx), [keep, ...new Set(copies.map((c) => c.e.other))]);
    for (const c of copies) {
      const props: Record<string, unknown> = { ...c.e.props, ref_id: c.to, updated_at: now };
      const sup = props["superseded_by"];
      if (typeof sup === "string" && renamed.has(sup)) props["superseded_by"] = renamed.get(sup);
      await copyEdge(tx, c.e.edge, c.src, c.tgt, props);
      moves.moved.push({ edge: c.e.edge, from: c.e.ref_id, to: c.to });
      if (typeof props["text"] === "string") {
        await writeEdgeRow(tx, {
          edge_ref_id: c.to,
          edge_type: c.e.edge,
          source_ref_id: c.src,
          target_ref_id: c.tgt,
          text: props["text"],
          composed: composeFact(titles.get(c.src), c.e.edge, titles.get(c.tgt), props["text"]),
          namespace: props["namespace"] as string | undefined,
          created_by: props["created_by"] as string | undefined,
          valid_at: num(props["valid_at"]),
          invalid_at: num(props["invalid_at"]),
          expired_at: num(props["expired_at"]),
        }, now);
      }
    }

    // A one-value temporal slot of the kept node now holding two current
    // facts keeps the newest.
    const slots = new Set(copies.filter((c) => c.temporal && c.one && c.e.dir === "out" && c.e.props["expired_at"] === undefined).map((c) => c.e.edge));
    for (const edge of slots) {
      const current = (await slotEdges(tx, edge, keep)).filter((x) => x.target !== dup);
      if (current.length < 2) continue;
      const ranked = await Promise.all(current.map(async (x) => ({ ...x, created_at: Number((await storedEdge(tx, edge, x.ref_id))?.["created_at"] ?? 0) })));
      ranked.sort(newerFirst);
      const [winner, ...rest] = ranked;
      for (const o of rest) {
        const before = await storedEdge(tx, edge, o.ref_id);
        const end = { expired_at: now, invalid_at: endOfReplaced(o, winner!.valid_at, now) };
        await setTemporalEdge(tx, edge, o.ref_id, { ...end, superseded_by: winner!.ref_id, updated_at: now });
        await syncEdgeRow(tx, o.ref_id, end, now);
        moves.superseded.push({ edge, ref_id: o.ref_id, by: winner!.ref_id, before: pick(before, ["expired_at", "invalid_at", "superseded_by", "updated_at"]) });
      }
    }

    // The duplicate's facts are found through the kept node now.
    moves.rows = await hideRows(tx, edges.filter((e) => e.props["text"] !== undefined).map((e) => e.ref_id), now);

    // Its names become the kept node's other names.
    const notes: string[] = [];
    const schema = await b.schemas.schema(kept.type, tx);
    let alt_names = kept.alt_names ?? [];
    if (schema && ALT_NAMES in schema.attributes) {
      const seen = new Set([kept.title, ...alt_names].filter((n): n is string => !!n).map(norm));
      const add: string[] = [];
      for (const n of [gone.title, ...(gone.alt_names ?? [])]) {
        if (!n?.trim() || seen.has(norm(n))) continue;
        seen.add(norm(n));
        add.push(n.trim());
      }
      if (add.length) {
        alt_names = [...alt_names, ...add];
        await b.nodes.update(keep, { set: { [ALT_NAMES]: alt_names } }, { tx });
        moves.kept.alt_names_after = alt_names;
      }
    } else if (gone.title && norm(gone.title) !== norm(kept.title ?? "")) {
      notes.push(`${kept.type} has no alt_names: the name "${gone.title}" is kept only on the merge record`);
    }

    await tx.run(
      `MATCH (n:Node {ref_id: $r}) SET n.deleted_at = CAST($now AS INT64), n.deleted_reason = $why`,
      { r: dup, now, why: `merged into ${keep} by ${by}` },
    );
    await writeMergeRow(tx, {
      ref_id: id,
      key: refNodeKey(MERGE_TYPE, id),
      namespace: kept.namespace,
      title: `${gone.title ?? dup} merged into ${kept.title ?? keep}`,
      kept_ref_id: keep,
      duplicate_ref_id: dup,
      merge_moves: JSON.stringify(moves),
      created_by: by,
      created_at: now,
    });
    return {
      merge: id,
      kept: { ref_id: keep, node_type: kept.type, ...(kept.title ? { title: kept.title } : {}) },
      merged: { ref_id: dup, node_type: gone.type, ...(gone.title ? { title: gone.title } : {}) },
      moved: moves.moved,
      reconfirmed: moves.reconfirmed.map(({ from, into }) => ({ from, into })),
      superseded: moves.superseded.map((s) => s.ref_id),
      skipped: moves.skipped,
      alt_names,
      ...(notes.length ? { notes } : {}),
    };
  });
  // The moved facts' rows are embedded now, after the commit.
  if (out.moved.length && b.embedder) await b.nodeEngine.embedPendingRows?.(b.embedder);
  return out;
}

function pick(row: Record<string, unknown> | null, keys: string[]): Before {
  return Object.fromEntries(keys.map((k) => [k, row?.[k] ?? null]));
}

/** `assert`'s re-confirm of the kept node's `held` fact by the duplicate's
 *  `e`: its sources joined, a missing date filled. The fields as they were,
 *  or null when nothing changed. */
async function reconfirm(tx: GraphTx, e: StoredEdge, held: Awaited<ReturnType<typeof slotEdges>>[number], now: number): Promise<Before | null> {
  const ov = num(e.props["valid_at"]);
  const oi = num(e.props["invalid_at"]);
  const v = held.valid_at ?? (ov !== null && (held.invalid_at === null || ov <= held.invalid_at) ? ov : null);
  const end = held.invalid_at ?? oi;
  const inv = end !== null && v !== null && end < v ? held.invalid_at : end;
  const theirs = Array.isArray(e.props["sources"]) ? (e.props["sources"] as unknown[]).map(String) : [];
  const sources = [...held.sources, ...theirs.filter((s) => !held.sources.includes(s))];
  const changed = v !== held.valid_at || inv !== held.invalid_at || sources.length !== held.sources.length;
  if (!changed) return null;
  const before = pick(await storedEdge(tx, e.edge, held.ref_id), ["valid_at", "invalid_at", "sources", "last_confirmed_at", "updated_at"]);
  await setTemporalEdge(tx, e.edge, held.ref_id, { valid_at: v, invalid_at: inv, sources, last_confirmed_at: now, updated_at: now });
  if (v !== held.valid_at || inv !== held.invalid_at) await syncEdgeRow(tx, held.ref_id, { valid_at: v, invalid_at: inv }, now);
  return before;
}

export interface UnmergeInput {
  /** The merge record's ref_id (`MergeResult.merge`). */
  merge: string;
  by?: string;
}

export interface UnmergeResult {
  merge: string;
  kept: string;
  restored: string;
  /** The copies removed from the kept node. */
  removed: string[];
}

/**
 * Undo the merge `merge` (see the header): all or nothing, refused with the
 * reasons when a later write touched the duplicate, the kept node's names,
 * or an edge the merge wrote or would set back, or when a later merge took
 * the kept node in.
 */
export async function unmergeNodes(b: GraphBackend, input: UnmergeInput, opts: { now?: () => number } = {}): Promise<UnmergeResult> {
  ladybugOnly(b, "graph/unmerge");
  const by = input.by?.trim() || "agent";
  const now = (opts.now ?? Date.now)();
  // The caller must see the node it would change: a record is read through
  // the node it kept, which its reader must see.
  const found = await readMergeRow(boundsOf(b)?.query ?? b.query.bind(b), String(input.merge ?? ""));
  if (!found || !(await b.reader.getNode(found.kept_ref_id))) throw new MergeError("NOT_FOUND", `no merge ${input.merge} that this caller can see`);
  return b.tx(async (tx) => {
    const run = tx.run.bind(tx);
    const rec = await readMergeRow(run, found.ref_id);
    if (!rec) throw new MergeError("NOT_FOUND", `no merge ${input.merge}`);
    if (rec.undone_at !== null) throw new MergeError("REFUSED", `merge ${rec.ref_id} was already undone`);
    const moves = JSON.parse(rec.merge_moves) as MergeMoves;
    const at = rec.created_at;
    const why: string[] = [];

    const later = await mergesSince(run, rec.kept_ref_id, at);
    if (later.length) why.push(`a later merge took in the node kept (${later.join(", ")}): undo it first`);
    const kept = await readLive(tx, rec.kept_ref_id);
    if (!kept) why.push(`the node kept (${rec.kept_ref_id}) was deleted since`);
    else if (JSON.stringify(kept.alt_names) !== JSON.stringify(moves.kept.alt_names_after)) why.push("the node kept's alt_names changed since");
    const dup = (await tx.run(`MATCH (n:Node {ref_id: $r}) RETURN n.deleted_at AS d`, { r: rec.duplicate_ref_id }))[0];
    if (!dup || num(dup["d"]) !== at) why.push(`the duplicate (${rec.duplicate_ref_id}) was written since: it is no longer as the merge left it`);

    const check = async (edge: string, ref_id: string, ok: (u: number | null) => boolean, what: string) => {
      const row = await storedEdge(tx, edge, ref_id);
      if (!row) why.push(`${what} ${ref_id} was deleted since`);
      else if (!ok(num(row["updated_at"]))) why.push(`${what} ${ref_id} was changed since`);
    };
    for (const m of moves.moved) await check(m.edge, m.to, (u) => u === at, "the moved edge");
    for (const r of moves.reconfirmed) if (r.before) await check(r.edge, r.into, (u) => u === at, "the re-confirmed edge");
    for (const s of moves.superseded) await check(s.edge, s.ref_id, (u) => u === at, "the superseded edge");
    for (const e of [...moves.moved.map((m) => ({ edge: m.edge, ref_id: m.from })), ...moves.reconfirmed.map((r) => ({ edge: r.edge, ref_id: r.from })), ...moves.skipped]) {
      await check(e.edge, e.ref_id, (u) => u === null || u <= at, "the duplicate's edge");
    }
    if (why.length) throw new MergeError("REFUSED", `merge ${rec.ref_id} cannot be undone safely: ${why.join("; ")}`);

    const byEdge = new Map<string, string[]>();
    for (const m of moves.moved) byEdge.set(m.edge, [...(byEdge.get(m.edge) ?? []), m.to]);
    for (const [edge, ids] of byEdge) await deleteEdges(tx, edge, ids);
    await deleteEdgeRows(tx, moves.moved.map((m) => m.to), now);
    const restore = async (edge: string, ref_id: string, before: Before) => {
      await setTemporalEdge(tx, edge, ref_id, before);
      const clocks = Object.fromEntries(["valid_at", "invalid_at", "expired_at"].filter((k) => k in before).map((k) => [k, num(before[k])]));
      if (Object.keys(clocks).length) await syncEdgeRow(tx, ref_id, clocks, now);
    };
    for (const s of [...moves.superseded].reverse()) await restore(s.edge, s.ref_id, s.before);
    for (const r of moves.reconfirmed) if (r.before) await restore(r.edge, r.into, r.before);
    if (JSON.stringify(moves.kept.alt_names_before) !== JSON.stringify(moves.kept.alt_names_after)) {
      const before = moves.kept.alt_names_before;
      await b.nodes.update(rec.kept_ref_id, before?.length ? { set: { [ALT_NAMES]: before } } : { remove: [ALT_NAMES] }, { tx });
      const u = moves.kept.updated_at_before;
      await tx.run(`MATCH (n:Node {ref_id: $r}) SET n.updated_at = ${u === null ? "NULL" : "CAST($u AS INT64)"}`, { r: rec.kept_ref_id, ...(u === null ? {} : { u }) });
    }
    await showRows(tx, moves.rows, at);
    await tx.run(`MATCH (n:Node {ref_id: $r}) SET n.deleted_at = NULL, n.deleted_reason = NULL`, { r: rec.duplicate_ref_id });
    await markUndone(tx, rec.ref_id, by, now);
    return { merge: rec.ref_id, kept: rec.kept_ref_id, restored: rec.duplicate_ref_id, removed: moves.moved.map((m) => m.to) };
  });
}

export { mergedInto };
