// Dictation's vocabulary on the workspace graph, for a host whose memory is
// the graph (`services.memory === "graph"`, createStrut.ts). The steps keep
// their names, inputs and outputs; only where the words live changes:
//
//   - a word is a node of an entity type: a Lingo word dictation made, or
//     any person or thing the graph knows, its `name` and `alt_names` the
//     ways it is written;
//   - a mishearing is a hidden `Mishearing` record (registry.ts) naming its
//     node by `entity_ref_id`: dictation writes `value` for it, as `form`
//     (absent: its name);
//   - undo and remove are soft deletes with the reason; `dictation_off` is
//     a field of the node, added to its type the first time one is turned off.
//
// Leading underscore: imported by siblings, skipped by registry discovery.
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { entryWriting, type Lexicon } from "../../../audio/lingo.js";
import type { GraphBackend, LadybugBackend } from "../../../graph/backend.js";
import type { Row } from "../../../graph/engine.js";
import { mergedInto } from "../../../graph/ladybug/merge.js";
import { PRIVATE_NAMESPACE } from "../../../graph/ladybug/namespaces.js";
import { readCatalog } from "../../../graph/ladybug/ontology.js";
import { HIDDEN_TYPES, LINGO_TYPE, MISHEARING_TYPE, PERSON_TYPE } from "../../../graph/ladybug/registry.js";
import { createNodeSchema } from "../../../graph/schema-crud.js";
import { boundsOf } from "../../../graph/scope.js";
import { iso, type Query } from "../memory/_db.js";
import { vocabulary } from "../memory/_ontology.js";
import { UNDONE } from "../memory/lexicon.js";
import { graphCtx } from "../graph/_shared.js";
import type { ChangeT } from "./_shared.js";

const BY = "dictation";
/** The node field that keeps a node out of dictation. */
const OFF = "dictation_off";

/** Whether this host's memory, dictation's vocabulary with it, is the graph. */
export function onGraph(ctx: StepContext<unknown> | undefined): boolean {
  return (ctx?.services as { memory?: unknown } | undefined)?.memory === "graph";
}

async function backend(ctx: StepContext<unknown>): Promise<LadybugBackend> {
  const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
  if (b.kind !== "ladybug") throw new Error("dictation: a vocabulary on the graph needs a Ladybug graph");
  return b;
}

// One dictation write or changes read at a time per graph file, as the old
// memory's queue: a write stamps its time before it commits, so a read of
// the changes beside it could miss it for good.
const queues = new Map<string, Promise<unknown>>();
function exclusive<T>(b: LadybugBackend, fn: () => Promise<T>): Promise<T> {
  const key = b.cfg.path;
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** Raw reads, as graph/import-memory makes them: a step's reader list (scope.ts) refuses `b.query`. */
const raw = (b: GraphBackend) => boundsOf(b)?.query ?? b.query.bind(b);

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Every mishearing record, live or not, oldest first. */
async function mishearings(b: GraphBackend): Promise<Row[]> {
  return raw(b)(
    `MATCH (h:Node {node_type: $t}) RETURN h.ref_id AS ref_id, h.entity_ref_id AS entity, h.value AS value, h.form AS form,
       h.created_at AS created_at, h.created_by AS created_by, h.deleted_at AS deleted_at, h.deleted_reason AS reason
     ORDER BY h.created_at, h.ref_id`,
    { t: MISHEARING_TYPE },
  );
}

/** The names of nodes, deleted or not. */
async function namesOf(b: GraphBackend, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await raw(b)(`MATCH (n:Node) WHERE n.ref_id IN $ids RETURN n.ref_id AS id, coalesce(n.name, n.title) AS name`, { ids: [...new Set(ids)] });
  return new Map(rows.map((r) => [String(r["id"]), String(r["name"] ?? "")]));
}

// ── memory/lexicon ──────────────────────────────────────────────────────────

/** memory/lexicon's output, read from the graph: the same shape the old memory gives. */
export async function graphLexicon(ctx: StepContext<unknown>): Promise<unknown> {
  const b = await backend(ctx);
  const types: string[] = [];
  for (const r of await raw(b)(`MATCH (n:Node) WHERE n.deleted_at IS NULL AND NOT n.node_type IN $hidden RETURN DISTINCT n.node_type AS t`, { hidden: HIDDEN_TYPES })) {
    const t = String(r["t"]);
    if ((await b.schemas.schema(t))?.role === "entity") types.push(t);
  }
  // A field no type declares yet is no column yet.
  const { columns } = await readCatalog(raw(b));
  const col = (c: string) => (c in columns ? `n.${c}` : "NULL");
  const nodes = types.length
    ? await raw(b)(
        `MATCH (n:Node) WHERE n.node_type IN $types AND n.deleted_at IS NULL
         RETURN n.ref_id AS ref_id, n.node_type AS type, coalesce(n.name, n.title) AS name, ${col("alt_names")} AS alt_names,
                ${col(OFF)} AS off, ${col("is_owner")} AS owner, n.updated_at AS updated_at`,
        { types },
      )
    : [];
  const live = new Set(nodes.map((n) => String(n["ref_id"])));
  const ids = [...live];

  // Edges: what is known of each node, and when it was last learned.
  // What is known of each node: its live edges (a plain edge has no clocks; an
  // ended fact, `expired_at`, is no longer known), and whether one is to the user.
  const owner = nodes.find((n) => n["owner"] === true && n["type"] === PERSON_TYPE);
  const edges = new Map<string, { n: number; last: number }>();
  const known = new Set<string>();
  if (ids.length) {
    for (const r of await raw(b)(
      `MATCH (n:Node)-[r]-(m:Node) WHERE n.ref_id IN $ids AND m.deleted_at IS NULL AND NOT m.node_type IN $hidden
       RETURN n.ref_id AS id, m.ref_id AS other, r AS r`,
      { ids, hidden: HIDDEN_TYPES },
    )) {
      const rel = (r["r"] ?? {}) as Record<string, unknown>;
      if (rel["expired_at"] != null) continue;
      const id = String(r["id"]);
      const e = edges.get(id) ?? { n: 0, last: 0 };
      edges.set(id, { n: e.n + 1, last: Math.max(e.last, Number(rel["created_at"] ?? 0)) });
      if (owner && r["other"] === owner["ref_id"]) known.add(id);
    }
  }

  // A mishearing of a node merged away is the kept node's.
  const all = await mishearings(b);
  const kept = new Map<string, string | null>();
  const heardBy = new Map<string, Row[]>();
  for (const h of all) {
    if (h["deleted_at"] != null) continue;
    let at = String(h["entity"]);
    if (!live.has(at)) {
      if (!kept.has(at)) kept.set(at, await mergedInto(raw(b), at));
      const k = kept.get(at);
      if (!k || !live.has(k)) continue;
      at = k;
    }
    heardBy.set(at, [...(heardBy.get(at) ?? []), h]);
  }
  const undoneRows = all.filter((h) => h["reason"] === UNDONE).sort((x, y) => Number(x["deleted_at"]) - Number(y["deleted_at"]) || String(x["ref_id"]).localeCompare(String(y["ref_id"])));
  const undoneNames = await namesOf(b, undoneRows.map((h) => String(h["entity"])));

  const byName = (x: Row, y: Row) => String(x["name"]).localeCompare(String(y["name"])) || String(x["ref_id"]).localeCompare(String(y["ref_id"]));
  return {
    lingo_type: LINGO_TYPE,
    person_type: PERSON_TYPE,
    mishearing: MISHEARING_TYPE,
    entities: nodes.filter((n) => typeof n["name"] === "string").sort(byName).map((n) => {
      const id = String(n["ref_id"]);
      const heard = heardBy.get(id) ?? [];
      const e = edges.get(id) ?? { n: 0, last: 0 };
      const alts = Array.isArray(n["alt_names"]) ? (n["alt_names"] as unknown[]).filter((a): a is string => typeof a === "string") : [];
      return {
        ref_id: id, type: n["type"], name: n["name"], ...(n === owner ? { user: true } : {}),
        written: [...new Set([n["name"] as string, ...alts])],
        heard: heard.map((h) => ({ ref_id: h["ref_id"], value: h["value"], form: str(h["form"]), created_at: iso(h["created_at"]) })),
        dictation_off: n["off"] === true,
        facts: e.n + heard.length,
        updated_at: iso(Math.max(Number(n["updated_at"] ?? 0), e.last, ...heard.map((h) => Number(h["created_at"] ?? 0)))),
        known_by_user: known.has(id),
      };
    }),
    undone: undoneRows.map((h) => ({
      ref_id: h["ref_id"], value: h["value"], form: str(h["form"]),
      entity: { ref_id: h["entity"], name: undoneNames.get(String(h["entity"])) ?? "" }, undone_at: iso(h["deleted_at"]),
    })),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** dictation/add's and dictation/correction's write, as `learnInput` reads
 *  the old memory's: the pair on the node that writes it (with `name`, the
 *  node of that full name), else on a new word (with `name`, a new person).
 *  A `term` is the new word alone. Returns what dictation/undo takes back:
 *  the new node, else the new mishearing; nothing when it was known. */
export async function graphLearn(ctx: StepContext<unknown>, heard: string, written: string, lexicon: Lexicon, term = false, name?: string): Promise<string[]> {
  const b = await backend(ctx);
  const namespace = await b.reader.resolveNamespace(PRIVATE_NAMESPACE);
  const full = name && !term ? name : undefined;
  const entry = entryWriting(lexicon, full ?? written);
  if (term && entry) return [];
  if (entry && !term) {
    const form = written !== entry.name ? written : null;
    if (entry.heard.some((h) => same(h.value, heard) && same(h.form ?? entry.name, form ?? entry.name))) return [];
  }
  return exclusive(b, () => b.tx(async (tx) => {
    let subject = entry?.refId;
    if (!subject) {
      subject = full
        ? (await b.nodes.write({ type: PERSON_TYPE, data: { name: full }, created_by: BY }, "create", { namespace, tx })).ref_id
        : (await b.nodes.write({ type: LINGO_TYPE, data: { name: written }, created_by: BY }, "create", { namespace, tx })).ref_id;
      if (term) return [subject];
    }
    const subjectName = entry?.name ?? full ?? written;
    const form = written !== subjectName ? written : undefined;
    const h = await b.nodes.write({ type: MISHEARING_TYPE, data: { entity_ref_id: subject, value: heard, ...(form ? { form } : {}) }, created_by: BY }, "create", { namespace, tx });
    return [entry ? h.ref_id : subject];
  }));
}

/** memory/forget for dictation: a mishearing alone, or a node with its
 *  mishearings, soft-deleted with `reason`. The user is never forgotten whole. */
export async function graphForget(ctx: StepContext<unknown>, ref_id: string, reason: string): Promise<void> {
  const b = await backend(ctx);
  await exclusive(b, () => b.tx(async (tx) => {
    const [n] = await tx.run(`MATCH (n:Node {ref_id: $id}) WHERE n.deleted_at IS NULL RETURN n.node_type AS type, n.namespace AS ns`, { id: ref_id });
    if (!n) throw new Error(`no live node ${ref_id}`);
    if (n["type"] !== MISHEARING_TYPE) {
      const [owner] = await tx.run(`MATCH (n:Node {ref_id: $id}) WHERE n.is_owner = true RETURN n.ref_id AS id`, { id: ref_id });
      if (owner) throw new Error("refused: the user cannot be forgotten whole; forget their mishearings one by one");
      const own = await tx.run(`MATCH (h:Node {node_type: $t}) WHERE h.entity_ref_id = $id AND h.deleted_at IS NULL RETURN h.ref_id AS id, h.namespace AS ns`, { t: MISHEARING_TYPE, id: ref_id });
      for (const h of own) await b.nodes.deleteNode(String(h["id"]), { namespace: String(h["ns"]), reason, tx });
    }
    await b.nodes.deleteNode(ref_id, { namespace: String(n["ns"]), reason, tx });
  }));
}

/** Which of `ids` dictation wrote. */
export async function graphOurs(ctx: StepContext<unknown>, ids: string[]): Promise<Set<string>> {
  const b = await backend(ctx);
  const rows = await raw(b)(`MATCH (n:Node) WHERE n.ref_id IN $ids AND n.created_by = $by RETURN n.ref_id AS id`, { ids, by: BY });
  return new Set(rows.map((r) => String(r["id"])));
}

/** Whether a word `written` dictation made was undone here already. */
export async function graphTermUndone(ctx: StepContext<unknown>, written: string): Promise<boolean> {
  const b = await backend(ctx);
  const rows = await raw(b)(
    `MATCH (n:Node {node_type: $t}) WHERE lower(n.name) = $n AND n.deleted_reason = $undone RETURN n.ref_id AS id LIMIT 1`,
    { t: LINGO_TYPE, n: written.toLowerCase(), undone: UNDONE },
  );
  return rows.length > 0;
}

/** dictation/enable: sets or clears the node's `dictation_off`. Returns the
 *  node changed (the one a merged-away ref_id was merged into). */
export async function graphEnable(ctx: StepContext<unknown>, ref_id: string, on: boolean): Promise<string> {
  const b = await backend(ctx);
  return exclusive(b, async () => {
    let id = ref_id;
    let [n] = await raw(b)(`MATCH (n:Node {ref_id: $id}) WHERE n.deleted_at IS NULL RETURN n.node_type AS type`, { id });
    if (!n) {
      const kept = await mergedInto(raw(b), ref_id);
      if (kept) [n] = await raw(b)(`MATCH (n:Node {ref_id: $id}) WHERE n.deleted_at IS NULL RETURN n.node_type AS type`, { id: (id = kept) });
    }
    const schema = n ? await b.schemas.schema(String(n["type"])) : null;
    if (!schema || HIDDEN_TYPES.includes(schema.type)) throw new Error(`no node ${ref_id}`);
    if (!(OFF in schema.attributes)) {
      if (on) return id;
      await createNodeSchema(b, b.schemas, { type: schema.type, attributes: { [OFF]: "?boolean" } });
    }
    await b.nodes.update(id, on ? { remove: [OFF] } : { set: { [OFF]: true } });
    return id;
  });
}

// ── dictation/changes-since ─────────────────────────────────────────────────

/** What dictation changed on the graph over [since, now), read in the writes'
 *  queue with `until` taken there, as `dictationChanges` reads the old memory. */
export async function graphChanges(ctx: StepContext<unknown>, since: number): Promise<{ kind: "dictation"; since: string; until: string; changes: ChangeT[] }> {
  const b = await backend(ctx);
  return exclusive(b, async () => {
    const until = Date.now();
    const all = await mishearings(b);
    const names = await namesOf(b, all.map((h) => String(h["entity"])));
    const changes: Array<ChangeT & { ms: number }> = [];
    const pair = (h: Row) => {
      const form = str(h["form"]);
      const name = names.get(String(h["entity"])) ?? "";
      return { heard: String(h["value"]), written: form ?? name, ...(form ? { name } : {}) };
    };
    const within = (t: number | null) => t !== null && t >= since && t < until;
    for (const h of all) {
      const created = num(h["created_at"]), deleted = num(h["deleted_at"]);
      const undone = h["reason"] === UNDONE;
      if (h["created_by"] === BY && within(created) && (deleted === null || undone)) changes.push({ op: "learn", ...pair(h), ...(undone ? { undone: true } : {}), at: iso(created)!, ms: created! });
      if (undone && within(deleted)) changes.push({ op: "undo", ...pair(h), at: iso(deleted)!, ms: deleted! });
    }
    // Terms: words dictation made with no mishearing ever kept on them.
    const withPairs = new Set(all.map((h) => String(h["entity"])));
    for (const w of await raw(b)(
      `MATCH (n:Node {node_type: $t}) WHERE n.created_by = $by RETURN n.ref_id AS id, n.name AS name, n.created_at AS created_at, n.deleted_at AS deleted_at, n.deleted_reason AS reason`,
      { t: LINGO_TYPE, by: BY },
    )) {
      if (withPairs.has(String(w["id"]))) continue;
      const created = num(w["created_at"]), deleted = num(w["deleted_at"]);
      const undone = w["reason"] === UNDONE;
      const written = String(w["name"]);
      if (within(created) && (deleted === null || undone)) changes.push({ op: "learn", written, term: true, ...(undone ? { undone: true } : {}), at: iso(created)!, ms: created! });
      if (undone && within(deleted)) changes.push({ op: "undo", written, term: true, at: iso(deleted)!, ms: deleted! });
    }
    changes.sort((x, y) => x.ms - y.ms || (x.op === y.op ? 0 : x.op === "learn" ? -1 : 1));
    return { kind: "dictation", since: new Date(since).toISOString(), until: new Date(until).toISOString(), changes: changes.map(({ ms: _ms, ...c }) => c) };
  });
}

// ── From the old memory ─────────────────────────────────────────────────────

/** Copies the old memory's mishearings (facts of a predicate with role
 *  mishearing, read with `oldQuery`) onto the graph as Mishearing records of
 *  the nodes `nodeOf` maps their subjects to, keeping when they were learned
 *  and who wrote them; an undone one comes as undone, so it is not learned
 *  again. A pair the node already holds is `already`, and one whose subject has no node is `skipped`. For graph/import-memory. */
export async function importMishearings(b: GraphBackend, oldQuery: Query, nodeOf: Map<string, string>): Promise<{ imported: number; already: number; skipped: number }> {
  const heardAs = (await vocabulary(oldQuery)).predicatesWithRole("mishearing");
  if (!heardAs.length) return { imported: 0, already: 0, skipped: 0 };
  const rows = await oldQuery(
    `MATCH (f:Fact)-[:SUBJECT]->(s:Entity)
     WHERE f.predicate IN $heardAs AND f.value IS NOT NULL AND f.expired_at IS NULL AND (f.deleted_at IS NULL OR f.deleted_reason = $undone)
     RETURN f.value AS value, f.form AS form, s.ref_id AS subject, f.created_at AS created_at, f.created_by AS created_by, f.deleted_at AS deleted_at
     ORDER BY f.created_at, f.ref_id`,
    { heardAs, undone: UNDONE },
  );
  const held = await mishearings(b);
  const namespace = await b.reader.resolveNamespace(PRIVATE_NAMESPACE);
  let imported = 0, already = 0, skipped = 0;
  for (const f of rows) {
    const node = nodeOf.get(String(f["subject"]));
    const value = String(f["value"]), form = str(f["form"]);
    if (!node) {
      skipped++;
      continue;
    }
    if (held.some((h) => h["entity"] === node && same(str(h["value"]), value) && same(str(h["form"]), form))) {
      already++;
      continue;
    }
    await b.tx(async (tx) => {
      const by = str(f["created_by"]);
      const w = await b.nodes.write({ type: MISHEARING_TYPE, data: { entity_ref_id: node, value, ...(form ? { form } : {}) }, ...(by ? { created_by: by } : {}) }, "create", { namespace, tx });
      const at = num(f["created_at"]);
      if (at !== null) await tx.run(`MATCH (n:Node {ref_id: $id}) SET n.created_at = $at`, { id: w.ref_id, at });
      if (f["deleted_at"] != null) {
        await b.nodes.deleteNode(w.ref_id, { namespace, reason: UNDONE, tx });
        await tx.run(`MATCH (n:Node {ref_id: $id}) SET n.deleted_at = $at`, { id: w.ref_id, at: num(f["deleted_at"]) });
      }
    });
    held.push({ entity: node, value, form });
    imported++;
  }
  return { imported, already, skipped };
}
