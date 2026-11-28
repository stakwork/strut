// Dictation's vocabulary on the workspace graph, a Ladybug file or Neo4j:
//
//   - a word is a node of an entity type: a Lingo word dictation made, or
//     any person or thing the graph knows, its `name` and `alt_names` the
//     ways it is written;
//   - a mishearing is a hidden `Mishearing` record (seed-types.ts) naming its
//     node by `entity_ref_id`: dictation writes `value` for it, as `form`
//     (absent: its name);
//   - undo and remove are soft deletes with the reason; `dictation_off` is
//     a field of the node, added to its type the first time one is turned off.
//
// Whose it is: on a Ladybug file (a person's Mac) the person's, written in
// the private namespace; on Neo4j (a box) the organisation's, written in the
// graph's own namespace and shared by everyone who uses it. There dictation
// makes no person: a fix inside a full name is kept on a node the graph
// already knows by that name.
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
import { HIDDEN_TYPES, PERSON_TYPE } from "../../../graph/ladybug/registry.js";
import { createNodeSchema } from "../../../graph/schema-crud.js";
import { boundsOf } from "../../../graph/scope.js";
import { LINGO_TYPE, MISHEARING_TYPE, VOCABULARY_TYPES, notDictations } from "../../../graph/seed-types.js";
import { typeValue } from "../../../graph/strut-schemas.js";
import { iso, type Query } from "../memory/_db.js";
import { vocabulary } from "../memory/_ontology.js";
import { graphCtx } from "../graph/_shared.js";
import type { ChangeT } from "./_shared.js";

const BY = "dictation";
/** The node field that keeps a node out of dictation. */
const OFF = "dictation_off";
/** The delete reason dictation/undo gives: a pair undone so is never learned again. */
export const UNDONE = "undone";

/** The workspace graph, where dictation keeps its vocabulary. */
const backend = (ctx: StepContext<unknown>): Promise<GraphBackend> => graphCtx(ctx as StepContext<StrutCapabilities>);

/** The graph home sync moves the memory of: a Ladybug one (home/_memory.ts). */
export async function dictationGraph(ctx: StepContext<unknown>): Promise<LadybugBackend> {
  const b = await backend(ctx);
  if (b.kind !== "ladybug") throw new Error("dictation: a vocabulary on the graph needs a Ladybug graph");
  return b;
}

// One dictation write or changes read at a time per graph: a write stamps
// its time before it commits, so a read of the changes beside it could miss
// it for good. home/sync replaces the memory inside it too.
const queues = new Map<string, Promise<unknown>>();
export function exclusive<T>(b: GraphBackend, fn: () => Promise<T>): Promise<T> {
  const key = b.kind === "ladybug" ? b.cfg.path : `${b.cfg.uri}/${b.cfg.database ?? ""}`;
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** Raw reads, as graph/import-memory makes them: a step's reader list (scope.ts) refuses `b.query`. */
const raw = (b: GraphBackend) => boundsOf(b)?.query ?? b.query.bind(b);

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** A data node of any type, matched by its ref_id: Ladybug's one table,
 *  Neo4j's `Data_Bank` (where ref_id is indexed). `props` as `{ref_id: $id}`. */
const anyNode = (b: GraphBackend, alias: string, props = "") => `(${alias}:${b.kind === "ladybug" ? "Node" : "Data_Bank"}${props ? ` ${props}` : ""})`;

/** An edge a row returned, as its properties: Neo4j's driver hands them
 *  apart, with the edge's creation under its jarvis name. */
function edgeProps(b: GraphBackend, r: unknown): Record<string, unknown> {
  const e = (r ?? {}) as Record<string, unknown>;
  if (b.kind === "ladybug") return e;
  const p = (e["properties"] ?? {}) as Record<string, unknown>;
  return { ...p, created_at: p["date_added_to_graph"] };
}

const byTime = (x: Row, y: Row) => Number(x["created_at"]) - Number(y["created_at"]) || (String(x["ref_id"]) < String(y["ref_id"]) ? -1 : String(x["ref_id"]) > String(y["ref_id"]) ? 1 : 0);

/** Every mishearing record, live or not, oldest first. */
async function mishearings(b: GraphBackend): Promise<Row[]> {
  const fields = ["ref_id", "entity_ref_id", "value", "form", "created_at", "created_by", "deleted_at", "deleted_reason"];
  const rows = await raw(b)(`MATCH ${b.dialect.node("h", MISHEARING_TYPE)} RETURN ${b.dialect.project("h", fields)} AS h`);
  return rows
    .map((r) => {
      const h = r["h"] as Row;
      return {
        ref_id: h["ref_id"], entity: h["entity_ref_id"], value: h["value"], form: h["form"],
        created_at: h["created_at"], created_by: h["created_by"], deleted_at: h["deleted_at"], reason: h["deleted_reason"],
      };
    })
    .sort(byTime);
}

/** The names of nodes, deleted or not. */
async function namesOf(b: GraphBackend, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await raw(b)(`MATCH ${anyNode(b, "n")} WHERE n.ref_id IN $ids RETURN n.ref_id AS id, coalesce(n.name, n.title) AS name`, { ids: [...new Set(ids)] });
  return new Map(rows.map((r) => [String(r["id"]), String(r["name"] ?? "")]));
}

/** The node `ref_id` was merged into (graph/merge, a Ladybug file's alone), or null. */
const keptFor = (b: GraphBackend, ref_id: string) => (b.kind === "ladybug" ? mergedInto(raw(b), ref_id) : Promise.resolve(null));

/** The types a word may be a node of: an entity type (`role: entity`). A
 *  Ladybug file: those of its live nodes. Neo4j: those the ontology marks,
 *  with their subtypes, never a scan of every node (a box may hold a code
 *  graph). */
async function entityTypes(b: GraphBackend): Promise<string[]> {
  const rows =
    b.kind === "ladybug"
      ? await raw(b)(`MATCH (n:Node) WHERE n.deleted_at IS NULL AND NOT n.node_type IN $hidden RETURN DISTINCT n.node_type AS t`, { hidden: HIDDEN_TYPES })
      : await raw(b)(`MATCH (c:Schema)-[:CHILD_OF*0..10]->(s:Schema) WHERE s.role = 'entity' RETURN DISTINCT c.type AS t`);
  const types: string[] = [];
  for (const r of rows) {
    const t = String(r["t"]);
    if ((await b.schemas.schema(t))?.role === "entity") types.push(t);
  }
  return types;
}

// ── memory/lexicon ──────────────────────────────────────────────────────────

/** memory/lexicon's output, read from the graph. */
export async function graphLexicon(ctx: StepContext<unknown>): Promise<unknown> {
  const b = await backend(ctx);
  const d = b.dialect;
  const types = await entityTypes(b);
  // On a Ladybug file a field no type declares yet is no column yet.
  const columns = b.kind === "ladybug" ? (await readCatalog(raw(b))).columns : null;
  const col = (c: string) => (!columns || c in columns ? `n.${c}` : "NULL");
  // Neo4j: no label on the pattern, so the type check is a scan of those labels.
  const nodes = types.length
    ? (await raw(b)(
        `MATCH ${b.kind === "ladybug" ? "(n:Node)" : "(n)"} WHERE ${d.isType("n", types)} AND ${d.live("n")}
         RETURN n.ref_id AS ref_id, ${d.typeOf("n")} AS type, coalesce(n.name, n.title) AS name, ${col("alt_names")} AS alt_names,
                ${col(OFF)} AS off, ${col("is_owner")} AS owner, n.updated_at AS updated_at`,
      )).map((n): Row => ({ ...n, type: typeValue(n["type"]) }))
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
      `MATCH ${anyNode(b, "n")}-[r]-${anyNode(b, "m")} WHERE n.ref_id IN $ids AND ${d.live("m")} AND NOT ${d.isType("m", HIDDEN_TYPES)}
       RETURN n.ref_id AS id, m.ref_id AS other, r AS r`,
      { ids },
    )) {
      const rel = edgeProps(b, r["r"]);
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
      if (!kept.has(at)) kept.set(at, await keptFor(b, at));
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

/** Refuses a graph whose Lingo or Mishearing is not dictation's: an app's
 *  own `Lingo`, which the seed leaves as it is (schema-seed.ts). A word
 *  written there would be half one type and half the other. */
async function vocabularyHere(b: GraphBackend): Promise<void> {
  for (const t of VOCABULARY_TYPES) {
    const held = await b.schemas.schema(t.type);
    const why = held ? notDictations(held, t) : "no such type";
    if (why) throw new Error(`this graph's ${t.type} is not dictation's (${why}), so dictation keeps no vocabulary here`);
  }
}

/** dictation/add's and dictation/correction's write: the pair on the node that writes it (with `name`, the
 *  node of that full name), else on a new word (with `name`, a new person;
 *  on Neo4j, refused). A `term` is the new word alone. Returns what
 *  dictation/undo takes back: the new node, else the new mishearing;
 *  nothing when it was known. */
export async function graphLearn(ctx: StepContext<unknown>, heard: string, written: string, lexicon: Lexicon, term = false, name?: string): Promise<string[]> {
  const b = await backend(ctx);
  const full = name && !term ? name : undefined;
  const entry = entryWriting(lexicon, full ?? written);
  if (term && entry) return [];
  if (entry && !term) {
    const form = written !== entry.name ? written : null;
    if (entry.heard.some((h) => same(h.value, heard) && same(h.form ?? entry.name, form ?? entry.name))) return [];
  }
  if (full && !entry && b.kind !== "ladybug") throw new Error(`nothing here is named ${full}, and on a shared graph dictation makes no person: add ${full} as a word first`);
  await vocabularyHere(b);
  const namespace = b.kind === "ladybug" ? await b.reader.resolveNamespace(PRIVATE_NAMESPACE) : b.namespace;
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

/** Dictation's forget: a mishearing alone, or a node with its
 *  mishearings, soft-deleted with `reason`. The user is never forgotten whole. */
export async function graphForget(ctx: StepContext<unknown>, ref_id: string, reason: string): Promise<void> {
  const b = await backend(ctx);
  const d = b.dialect;
  await exclusive(b, () => b.tx(async (tx) => {
    const [n] = await tx.run(`MATCH ${anyNode(b, "n", "{ref_id: $id}")} WHERE ${d.live("n")} RETURN ${d.typeOf("n")} AS type, n.namespace AS ns`, { id: ref_id });
    if (!n) throw new Error(`no live node ${ref_id}`);
    if (typeValue(n["type"]) !== MISHEARING_TYPE) {
      const [owner] = await tx.run(`MATCH ${anyNode(b, "n", "{ref_id: $id}")} WHERE n.is_owner = true RETURN n.ref_id AS id`, { id: ref_id });
      if (owner) throw new Error("refused: the user cannot be forgotten whole; forget their mishearings one by one");
      const own = await tx.run(`MATCH ${d.node("h", MISHEARING_TYPE)} WHERE h.entity_ref_id = $id AND ${d.live("h")} RETURN h.ref_id AS id, h.namespace AS ns`, { id: ref_id });
      for (const h of own) await b.nodes.deleteNode(String(h["id"]), { namespace: String(h["ns"]), reason, tx });
    }
    await b.nodes.deleteNode(ref_id, { namespace: String(n["ns"]), reason, tx });
  }));
}

/** Which of `ids` dictation wrote. */
export async function graphOurs(ctx: StepContext<unknown>, ids: string[]): Promise<Set<string>> {
  const b = await backend(ctx);
  const rows = await raw(b)(`MATCH ${anyNode(b, "n")} WHERE n.ref_id IN $ids AND n.created_by = $by RETURN n.ref_id AS id`, { ids, by: BY });
  return new Set(rows.map((r) => String(r["id"])));
}

/** Whether a word `written` dictation made was undone here already. */
export async function graphTermUndone(ctx: StepContext<unknown>, written: string): Promise<boolean> {
  const b = await backend(ctx);
  const rows = await raw(b)(
    `MATCH ${b.dialect.node("n", LINGO_TYPE)} WHERE ${b.dialect.lower("n.name")} = $n AND n.deleted_reason = $undone RETURN n.ref_id AS id LIMIT 1`,
    { n: written.toLowerCase(), undone: UNDONE },
  );
  return rows.length > 0;
}

/** dictation/enable: sets or clears the node's `dictation_off`. Returns the
 *  node changed (the one a merged-away ref_id was merged into). */
export async function graphEnable(ctx: StepContext<unknown>, ref_id: string, on: boolean): Promise<string> {
  const b = await backend(ctx);
  const live = `MATCH ${anyNode(b, "n", "{ref_id: $id}")} WHERE ${b.dialect.live("n")} RETURN ${b.dialect.typeOf("n")} AS type`;
  return exclusive(b, async () => {
    let id = ref_id;
    let [n] = await raw(b)(live, { id });
    if (!n) {
      const kept = await keptFor(b, ref_id);
      if (kept) [n] = await raw(b)(live, { id: (id = kept) });
    }
    const type = n ? typeValue(n["type"]) : undefined;
    const schema = type ? await b.schemas.schema(type) : null;
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
 *  queue with `until` taken there. */
export async function graphChanges(ctx: StepContext<unknown>, since: number): Promise<{ kind: "dictation"; since: string; until: string; changes: ChangeT[] }> {
  const b = await backend(ctx);
  return exclusive(b, () => changesBetween(b, since, Date.now()));
}

/** What dictation changed over [since, until). The caller holds the writes'
 *  queue (`exclusive`) and took `until` inside it. */
export async function changesBetween(b: GraphBackend, since: number, until: number): Promise<{ kind: "dictation"; since: string; until: string; changes: ChangeT[] }> {
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
  const words = await raw(b)(
    `MATCH ${b.dialect.node("n", LINGO_TYPE)} WHERE n.created_by = $by RETURN ${b.dialect.project("n", ["ref_id", "name", "created_at", "deleted_at", "deleted_reason"])} AS n`,
    { by: BY },
  );
  for (const w of words.map((r) => r["n"] as Row).map((n): Row => ({ ...n, id: n["ref_id"], reason: n["deleted_reason"] }))) {
    if (withPairs.has(String(w["id"]))) continue;
    const created = num(w["created_at"]), deleted = num(w["deleted_at"]);
    const undone = w["reason"] === UNDONE;
    const written = String(w["name"]);
    if (within(created) && (deleted === null || undone)) changes.push({ op: "learn", written, term: true, ...(undone ? { undone: true } : {}), at: iso(created)!, ms: created! });
    if (undone && within(deleted)) changes.push({ op: "undo", written, term: true, at: iso(deleted)!, ms: deleted! });
  }
  changes.sort((x, y) => x.ms - y.ms || (x.op === y.op ? 0 : x.op === "learn" ? -1 : 1));
  return { kind: "dictation", since: new Date(since).toISOString(), until: new Date(until).toISOString(), changes: changes.map(({ ms: _ms, ...c }) => c) };
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
