import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, type GraphBackend } from "./_shared.js";
import { type Query, type Row, normalize, oldMemory, oldMemoryPath } from "../memory/_db.js";
import { vocabulary, type Vocabulary } from "../memory/_ontology.js";
import { NodeWriter } from "../../../graph/node-writer.js";
import { words } from "../../../graph/text-match.js";
import { importMishearings } from "../dictation/_graph.js";

/**
 * The one-off move of the old memory database (the retired `memory/*` steps'
 * own file, read through src/steps/lib/memory/_db.ts) onto the workspace
 * graph (plans/graph-memory-plan.md step 7). It reads a copy of the old
 * database and writes nothing to it, and it is safe to run again: every
 * node is found by `resolve` before one is made, and every fact goes through
 * `assert`, which re-confirms what the graph already holds.
 *
 *   - An entity becomes a node of the type of the same name (made, as an
 *     entity type with no key, when the graph has none); the user's type
 *     and the types named as people are named are `Person`, the user the one
 *     marked `is_owner`. Its other names become `alt_names`, its summary
 *     the description;
 *   - a fact linking two entities becomes a temporal edge (the predicate,
 *     uppercased, or IS_<it> when a plain edge type already has the name:
 *     `about` is IS_ABOUT, as ABOUT is the claims'; a one-value predicate a
 *     `cardinality: one` type), with its
 *     sentence and world times, ended when it was no longer held, each
 *     episode it came from as a source and its speaker, when not the user,
 *     as `said_by`;
 *   - a name fact adds the name to its subject's `alt_names`, spelled as its
 *     sentence writes it; a name fact that gives no name (the old memory
 *     kept none) is a sentence about its subject, its description;
 *   - the user's old name in the old memory ("Me") is no name of theirs: the
 *     user is named by their name facts, else `owner_name`;
 *   - each node and fact keeps when the old memory learned it
 *     (`created_at`) and who wrote it (`created_by`);
 *   - everything goes to `private`.
 *
 * Run again, it repairs what an earlier import wrote and this one would not:
 * names taken from the old memory that it no longer gives, a description it
 * now gives, a fact it now drops, and dates that are later than the old
 * memory's.
 *
 * What has no place on the graph as it is, is dropped and counted by reason
 * (`skipped_by_reason`): a fact about one entity alone ("Kate is
 * vegetarian": the thing it is about is not an entity), an entity's
 * free-form attributes, an episode no fact came from, a fact whose sentence
 * says nothing its two ends' names do not ("Tom's uncle is Tom's uncle."),
 * and anything that could not be written. A mishearing becomes a
 * Mishearing record of its node, where dictation reads it on the graph
 * (dictation/_graph.ts).
 */


const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const edgeTypeOf = (predicate: string) => {
  const t = predicate.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z]/.test(t) ? t : `HAS_${t}`;
};
/** `name` as `text` writes it, matched word by word, case and accents aside
 *  ("katherine moss" in "Her name is Katherine Moss." is "Katherine Moss");
 *  undefined when the text does not hold it. */
export function spelledIn(text: string, name: string): string | undefined {
  const want = words(name);
  if (!want.length) return undefined;
  const toks = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  for (let i = 0; i + want.length <= toks.length; i++) {
    if (want.every((w, j) => words(toks[i + j]![0])[0] === w)) {
      const last = toks[i + want.length - 1]!;
      return text.slice(toks[i]!.index!, last.index! + last[0].length);
    }
  }
  return undefined;
}

/** A sentence that says nothing its two ends' names do not: every word of three letters or more is one of theirs. */
export function restates(text: string, names: string[]): boolean {
  const held = new Set(names.flatMap((n) => words(n)));
  const own = words(text).filter((w) => w.length >= 3);
  return own.length > 0 && own.every((w) => held.has(w));
}


interface Ctx {
  b: GraphBackend;
  /** The file's own query, whatever the reader's list: the import's repairs name rows by ref_id. */
  raw: (cypher: string, params?: Record<string, unknown>) => Promise<Row[]>;
  query: Query;
  vocab: Vocabulary;
  namespace: string;
  by: { created_by?: string };
  /** Writes nodes on the old memory's clock: `at` while an item is written. */
  nodes: NodeWriter;
  clock: { at?: number };
  skipped: Record<string, number>;
  counts: { nodes_created: number; nodes_found: number; facts_created: number; facts_found: number; names_added: number; repaired: number };
}

/** Who an old item was written by, else this run's actor. */
const byOf = (c: Ctx, row: Row) => (row["created_by"] ? { created_by: String(row["created_by"]) } : c.by);

/** Moves a found node's or edge's `created_at` back to when the old memory learned it, and fills a missing `created_by`. */
async function backdate(c: Ctx, table: string, ref_id: string, at: number | null, by: { created_by?: string }) {
  if (at !== null) {
    const r = await c.raw(`MATCH ${table} WHERE x.ref_id = $id AND x.created_at > $at SET x.created_at = $at RETURN x.ref_id AS id`, { id: ref_id, at });
    if (r.length) c.counts.repaired++;
  }
  if (by.created_by) await c.raw(`MATCH ${table} WHERE x.ref_id = $id AND x.created_by IS NULL SET x.created_by = $by RETURN x.ref_id AS id`, { id: ref_id, by: by.created_by });
}
const NODE = "(x:Node)";
const EDGE = (type: string) => `()-[x:${type}]->()`;

/** Takes off a found node's `alt_names` what an earlier import took from the
 *  old memory and this one does not give: `stale` (names the old memory
 *  held for it) or part of one of its name sentences. Returns how many. */
async function dropStale(c: Ctx, ref_id: string, keep: string[], stale: string[], sentences: string[]): Promise<number> {
  const node = await c.b.reader.getNode(ref_id);
  const held = Array.isArray(node?.properties["alt_names"]) ? (node!.properties["alt_names"] as unknown[]).map(String) : [];
  const kept = new Set(keep.map(normalize));
  const old = new Set(stale.map(normalize));
  const said = sentences.map(normalize);
  const next = held.filter((a) => kept.has(normalize(a)) || !(old.has(normalize(a)) || said.some((t) => t.includes(normalize(a)))));
  if (next.length === held.length) return 0;
  await c.b.nodes.update(ref_id, { set: { alt_names: next } });
  return held.length - next.length;
}

/** Sets a found node's description when it has none. */
async function describe(c: Ctx, ref_id: string, description: string | undefined) {
  if (!description) return;
  const node = await c.b.reader.getNode(ref_id);
  const had = node?.properties["description"];
  if (typeof had === "string" && had.trim()) return;
  await c.b.nodes.update(ref_id, { set: { description } });
  c.counts.repaired++;
}

const skip = (c: Ctx, reason: string) => (c.skipped[reason] = (c.skipped[reason] ?? 0) + 1);

/** The graph type an old entity type becomes: Person for the user and for
 *  the types named as people are, else the type of the same name, made as
 *  an entity type when missing. Null when that name is a type of another
 *  role (it cannot hold entities). */
async function graphType(c: Ctx, oldType: string, made: Map<string, string | null>): Promise<string | null> {
  const had = made.get(oldType);
  if (had !== undefined) return had;
  const user = c.vocab.userType();
  const person = c.vocab.role(oldType) === "user" || (!!user && c.vocab.naming(oldType) === c.vocab.naming(user) && c.vocab.naming(oldType) === "person");
  let type: string | null = person ? "Person" : oldType;
  const schema = await c.b.schemas.schema(type);
  if (schema && schema.role !== undefined && schema.role !== "entity") type = null;
  else if (!schema) {
    const { createNodeSchema } = await import("../../../graph/schema-crud.js");
    const term = c.vocab.term("entity_type", oldType);
    await createNodeSchema(c.b, c.b.schemas, {
      type: oldType,
      attributes: { description: "?string", alt_names: "?list" },
      index: ["name", "description", "alt_names"],
      role: "entity",
      // No key: names are not keys (plans/graph-memory-prd.md "Identity"), and a
      // name-keyed type refuses a name with no Latin letters. resolve finds it.
      key: "ref_id",
      ...(term?.description ? { type_description: term.description } : {}),
    });
  } else if (!("alt_names" in schema.attributes) || !("description" in schema.attributes)) {
    // Its other names are what `resolve` matches; its description is what the old memory said of it.
    const { createNodeSchema } = await import("../../../graph/schema-crud.js");
    const missing = { ...(!("alt_names" in schema.attributes) ? { alt_names: "?list" } : {}), ...(!("description" in schema.attributes) ? { description: "?string" } : {}) };
    await createNodeSchema(c.b, c.b.schemas, { type: schema.type, attributes: missing });
  }
  made.set(oldType, type === null ? null : (await c.b.schemas.schema(type))?.type ?? type);
  return made.get(oldType)!;
}

/** The graph's user: the Person marked is_owner, made when there is none. */
async function owner(c: Ctx, name: string, alts: string[], stale: string[], row: Row): Promise<string> {
  const { findNodes } = await import("../../../graph/find.js");
  const found = await findNodes(c.b, { node_type: "Person", where: { is_owner: true }, namespace: c.namespace, limit: 1 });
  const hit = found.nodes[0];
  if (hit) {
    c.counts.names_added += await addNames(c, hit.ref_id, alts);
    // The node's own title stays whatever it is; any other old name goes.
    c.counts.repaired += await dropStale(c, hit.ref_id, [(await c.b.reader.getNode(hit.ref_id))?.title ?? "", ...alts], stale, []);
    await backdate(c, NODE, hit.ref_id, num(row["created_at"]), byOf(c, row));
    c.counts.nodes_found++;
    return hit.ref_id;
  }
  c.clock.at = num(row["created_at"]) ?? undefined;
  const w = await c.nodes.write({ type: "Person", data: { name, is_owner: true, ...(alts.length ? { alt_names: alts } : {}) }, ...byOf(c, row) }, "create", { namespace: c.namespace });
  c.counts.nodes_created++;
  return w.ref_id;
}

/** Adds the names a node lacks (case-blind) to its `alt_names`. */
async function addNames(c: Ctx, ref_id: string, names: string[]): Promise<number> {
  const node = await c.b.reader.getNode(ref_id);
  if (!node) return 0;
  const held = Array.isArray(node.properties["alt_names"]) ? (node.properties["alt_names"] as unknown[]).map(String) : [];
  const known = new Set([node.title ?? "", ...held].map(normalize));
  const fresh: string[] = [];
  for (const n of names) if (n.trim() && !known.has(normalize(n))) known.add(normalize(n)), fresh.push(n);
  if (!fresh.length) return 0;
  await c.b.nodes.update(ref_id, { set: { alt_names: [...held, ...fresh] } });
  return fresh.length;
}

export default defineStep({
  type: "graph/import-memory",
  description:
    "Move the old memory database (the retired memory/* steps') onto the workspace graph, once: entities become nodes (the user the Person " +
    "marked is_owner), facts linking two entities become temporal edges with their dates, sources and speaker, names become alt_names, " +
    "all in `private`. Reads the old database and never changes it; safe to run again (what is already there is found, not doubled). " +
    "Returns counts imported and skipped, by reason: what has no place on the graph (facts about one entity alone, attributes, " +
    "episodes no fact came from) is dropped. A LadybugDB graph only.",
  input: z.object({
    owner_name: z.string().optional().describe("The user's name, when the host knows it: used when no name fact in the old memory gives one."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const sctx = ctx as StepContext<StrutCapabilities>;
      const path = await oldMemoryPath(sctx);
      if (!path) return { status: "Warning", messages: ["no old memory database here: nothing to import"], imported: 0, skipped: 0 };
      const b = await graphCtx(sctx);
      if (b.kind !== "ladybug") return "graph/import-memory failed — WRONG_TYPE: it imports into a LadybugDB graph only";
      const { assertEdge } = await import("../../../graph/temporal.js");
      const { resolveNode } = await import("../../../graph/resolve.js");
      const { PRIVATE_NAMESPACE } = await import("../../../graph/ladybug/namespaces.js");
      const { edgeRule } = await import("../../../graph/ladybug/ontology.js");
      const { boundsOf } = await import("../../../graph/scope.js");
      const query = await oldMemory(path);
      const vocab = await vocabulary(query);
      const c: Ctx = {
        b, query, vocab,
        raw: (q, p) => (boundsOf(b)?.query ?? b.query.bind(b))(q, p) as Promise<Row[]>,
        namespace: await b.reader.resolveNamespace(PRIVATE_NAMESPACE),
        by: ctx?.actor ? { created_by: ctx.actor } : {},
        nodes: undefined as unknown as NodeWriter,
        clock: {},
        skipped: {},
        counts: { nodes_created: 0, nodes_found: 0, facts_created: 0, facts_found: 0, names_added: 0, repaired: 0 },
      };
      c.nodes = new NodeWriter(b, { ...(b.embedder ? { embedder: b.embedder } : {}), resolver: b.schemas, now: () => c.clock.at ?? Date.now() });
      const role = (predicate: string) => vocab.term("predicate", predicate)?.role ?? "";

      // ── Entities ──────────────────────────────────────────────────────
      const entities = await query(
        `MATCH (e:Entity) WHERE e.deleted_at IS NULL
         RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.attributes AS attributes, e.aliases AS aliases,
                e.created_at AS created_at, e.created_by AS created_by
         ORDER BY e.created_at, e.ref_id`,
      );
      const facts = await query(
        `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.deleted_at IS NULL AND s.deleted_at IS NULL
         OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
         RETURN f.ref_id AS ref_id, f.predicate AS predicate, f.text AS text, f.value AS value, f.valid_at AS valid_at,
                f.invalid_at AS invalid_at, f.expired_at AS expired_at, s.ref_id AS subject, o.ref_id AS object, o.deleted_at AS object_deleted,
                f.created_at AS created_at, f.created_by AS created_by
         ORDER BY f.created_at, f.ref_id`,
      );
      // An old name fact keeps no name: the old memory folded it into its
      // subject's aliases, lowercased. A name is an alias its sentence writes,
      // as the sentence spells it; a name fact that writes none is a sentence
      // about its subject.
      const nameOf = new Map(entities.map((e) => [String(e["ref_id"]), String(e["name"])]));
      const aliasesOf = new Map(entities.map((e) => [String(e["ref_id"]), ((e["aliases"] as string[] | null) ?? []).map(String)]));
      const nameFacts = new Map<string, Row[]>();
      for (const f of facts) if (role(f["predicate"]) === "alias") nameFacts.set(f["subject"], [...(nameFacts.get(f["subject"]) ?? []), f]);
      const namesIn = (id: string, f: Row): string[] => {
        if (typeof f["value"] === "string" && f["value"].trim()) return [f["value"].trim()];
        // Its own name is no name it gives ("Sam, also called …" names Sam already).
        const own = normalize(nameOf.get(id) ?? "");
        return (aliasesOf.get(id) ?? []).filter((a) => normalize(a) !== own).map((a) => spelledIn(String(f["text"]), a)).filter((n): n is string => !!n);
      };
      const names = new Map<string, string[]>();
      const sentences = new Map<string, string[]>();
      for (const [id, fs] of nameFacts) {
        for (const f of fs) {
          const given = namesIn(id, f);
          if (given.length) names.set(id, [...(names.get(id) ?? []), ...given]);
          else if (f["expired_at"] == null) sentences.set(id, [...(sentences.get(id) ?? []), String(f["text"])]);
        }
      }
      const userType = vocab.userType();
      const nodeOf = new Map<string, string>();
      const made = new Map<string, string | null>();
      for (const e of entities) {
        const id = String(e["ref_id"]);
        const own = String(e["name"]);
        const at = num(e["created_at"]);
        // One spelling per name, case-blind: as a sentence writes it, before the old memory's lowercased aliases.
        const spelled = new Map<string, string>();
        for (const a of [...(names.get(id) ?? []), ...(aliasesOf.get(id) ?? [])]) if (!spelled.has(normalize(a))) spelled.set(normalize(a), a);
        const attrs = (() => { try { return JSON.parse(String(e["attributes"] || "{}")) as Record<string, unknown>; } catch { return {}; } })();
        if (attrs && Object.keys(attrs).length) skip(c, "free-form attributes");
        if (e["type"] === userType) {
          // The user's names are the ones their name facts give: the old
          // memory's own name for them ("Me") and its aliases are none.
          const current = (nameFacts.get(id) ?? []).filter((f) => f["expired_at"] == null).flatMap((f) => namesIn(id, f));
          const given = (names.get(id) ?? []);
          const name = current.at(-1) ?? cfg.owner_name?.trim() ?? given.at(-1) ?? own;
          const alts = [...new Map(given.map((n) => [normalize(n), n])).values()].filter((a) => normalize(a) !== normalize(name));
          const stale = [own, ...(aliasesOf.get(id) ?? [])].filter((a) => !alts.some((n) => normalize(n) === normalize(a)));
          nodeOf.set(id, await owner(c, name, alts, stale, e));
          continue;
        }
        const alts = [...spelled.values()].filter((a) => normalize(a) !== normalize(own));
        const type = await graphType(c, String(e["type"]), made);
        if (!type) {
          skip(c, "an entity of a type that is not an entity type on the graph");
          continue;
        }
        const schema = await b.schemas.schema(type);
        const described = schema && "description" in schema.attributes;
        const said = sentences.get(id) ?? [];
        const description = typeof e["summary"] === "string" && e["summary"].trim() ? e["summary"] : said.length ? said.join(" ") : undefined;
        const r = await resolveNode(b, { type, name: own, ...(alts.length ? { aliases: alts } : {}), namespaces: [c.namespace] });
        if (r.ambiguous) {
          skip(c, "an entity several nodes already go by the name of");
          continue;
        }
        if (r.match) {
          nodeOf.set(id, r.match.ref_id);
          c.counts.nodes_found++;
          c.counts.names_added += await addNames(c, r.match.ref_id, alts);
          c.counts.repaired += await dropStale(c, r.match.ref_id, [own, ...alts], [], said);
          if (described) await describe(c, r.match.ref_id, description);
          await backdate(c, NODE, r.match.ref_id, at, byOf(c, e));
          continue;
        }
        c.clock.at = at ?? undefined;
        const w = await c.nodes.write({ type, data: { name: own, ...(described && description ? { description } : {}), ...(alts.length ? { alt_names: alts } : {}) }, ...byOf(c, e) }, "create", { namespace: c.namespace });
        nodeOf.set(id, w.ref_id);
        if (w.outcome === "existing") c.counts.nodes_found++;
        else c.counts.nodes_created++;
      }
      c.clock.at = undefined;

      // ── Facts ─────────────────────────────────────────────────────────
      const episodes = new Map<string, Row[]>();
      for (const r of await query(
        `MATCH (f:Fact)-[:FROM_EPISODE]->(ep:Episode) WHERE f.deleted_at IS NULL AND ep.deleted_at IS NULL
         RETURN f.ref_id AS fact, ep.ref_id AS ref_id, ep.source AS source, ep.speaker AS speaker ORDER BY ep.created_at, ep.ref_id`,
      )) episodes.set(r["fact"], [...(episodes.get(r["fact"]) ?? []), r]);
      const userIds = new Set(entities.filter((e) => e["type"] === userType).map((e) => String(e["ref_id"])));
      const held = new Set(facts.filter((f) => f["expired_at"] == null && f["object"]).map((f) => `${f["subject"]}|${f["predicate"]}|${f["object"]}`));
      // Schema rows are the file's, whatever the reader's list.
      const schemaQuery = boundsOf(b)?.query ?? b.query.bind(b);
      const ready = new Map<string, { edge: string } | string>();
      // The temporal edge type a predicate becomes between two types: its
      // name uppercased, or IS_<name> when a plain edge type holds that name
      // (ABOUT is the claims'). A string when neither can be.
      const plain = async (edge: string) => {
        const rule = await edgeRule((q, p) => schemaQuery(q, p), edge);
        return rule ? rule["temporal"] !== true : undefined;
      };
      // A predicate's aliases go onto its edge type: what a search reads as naming it.
      const edgeReady = async (predicate: string, s: string, t: string, cardinality: string, aliases: string[]): Promise<{ edge: string } | string> => {
        const key = `${s}|${predicate}|${t}`;
        if (ready.has(key)) return ready.get(key)!;
        const base = edgeTypeOf(predicate);
        const edge = (await plain(base)) ? `IS_${base}` : base;
        let out: { edge: string } | string = { edge };
        const existing = await b.schemas.edgeSchema(edge, s, t);
        if (existing && !existing.rule.temporal) out = `${edge} is a plain edge type on the graph; a fact needs a temporal one`;
        else if (!existing) {
          const held = await plain(edge);
          if (held) out = `${base} and ${edge} are plain edge types on the graph; a fact needs a temporal one`;
          else await b.schemas.createEdgeSchema(s, edge, t, held === false ? undefined : { temporal: true, cardinality: cardinality === "one" ? "one" : "many" }, { aliases });
        }
        ready.set(key, out);
        return out;
      };
      const typeOfNode = new Map<string, string>();
      const typeOf = async (ref: string) => {
        if (!typeOfNode.has(ref)) typeOfNode.set(ref, (await b.reader.getNode(ref))?.node_type ?? "");
        return typeOfNode.get(ref)!;
      };

      for (const f of facts) {
        const id = String(f["ref_id"]);
        const predicate = String(f["predicate"]);
        const kind = role(predicate);
        if (kind === "alias") continue; // its subject's alt_names, above
        if (kind === "mishearing") continue; // dictation's records, below
        const subject = nodeOf.get(f["subject"]);
        const ended = f["expired_at"] != null;
        const said = (episodes.get(id) ?? []).map((ep) => ({
          source: String(ep["source"] || `memory/episode:${ep["ref_id"]}`),
          said_by: ep["speaker"] && !userIds.has(ep["speaker"]) ? nodeOf.get(ep["speaker"]) : undefined,
        }));
        if (!subject) { skip(c, "a fact whose subject was not imported"); continue; }
        if (!f["object"] || f["object_deleted"] != null) {
          skip(c, "a fact about one entity alone");
          continue;
        }
        const object = nodeOf.get(f["object"]);
        if (!object) { skip(c, "a fact whose object was not imported"); continue; }
        // A past fact the old memory also holds now would end the current one: the current one stands.
        if (ended && held.has(`${f["subject"]}|${predicate}|${f["object"]}`)) { skip(c, "an earlier spell of a fact held now"); continue; }
        const endNames = async (old: string, node: string) => [nameOf.get(old) ?? "", ...(aliasesOf.get(old) ?? []), String((await b.reader.getNode(node))?.title ?? "")];
        if (restates(String(f["text"]), [...(await endNames(f["subject"], subject)), ...(await endNames(f["object"], object))])) {
          skip(c, "a fact whose sentence only names its two ends");
          // What an earlier import wrote of it, from the old memory alone, goes.
          // Either name the edge type may have: a type the graph has not made is no table, and no edge.
          const earlier = (await Promise.all([edgeTypeOf(predicate), `IS_${edgeTypeOf(predicate)}`].map((type) =>
            c.raw(`MATCH (s:Node)-[x:${type}]->(t:Node) WHERE s.ref_id = $s AND t.ref_id = $t AND x.text = $text AND x.deleted_at IS NULL RETURN x.ref_id AS id, x.sources AS sources`, { s: subject, t: object, text: String(f["text"]) }).then((rows) => rows.map((r): Row & { type: string } => ({ ...r, type })), () => [] as Array<Row & { type: string }>)))).flat();
          for (const r of earlier) {
            const src = ((r["sources"] as string[] | null) ?? []).map(String);
            if (src.every((x) => x.startsWith("memory/episode:"))) { await b.edges.delete({ ref_id: String(r["id"]), edge: String(r["type"]) }); c.counts.repaired++; }
          }
          continue;
        }
        const ready_ = await edgeReady(predicate, await typeOf(subject), await typeOf(object), vocab.term("predicate", predicate)?.cardinality ?? "many", vocab.term("predicate", predicate)?.aliases ?? []);
        if (typeof ready_ === "string") { skip(c, "a fact whose edge type is a plain one on the graph"); continue; }
        const edge = ready_.edge;
        let wrote = false;
        for (const s of said.length ? said : [{ source: undefined, said_by: undefined }]) {
          const r = await assertEdge(b, b.schemas, {
            edge,
            source_ref_id: subject,
            target_ref_id: object,
            text: String(f["text"]),
            ...(num(f["valid_at"]) !== null ? { valid_at: num(f["valid_at"])! } : {}),
            ...(num(f["invalid_at"]) !== null ? { invalid_at: num(f["invalid_at"])! } : {}),
            ...(ended ? { ended: true } : {}),
            ...(s.source ? { source: s.source } : {}),
            ...(s.said_by ? { said_by: s.said_by } : {}),
            ...byOf(c, f),
          }, { ...(b.embedder ? { embedder: b.embedder } : {}), ...(num(f["created_at"]) !== null ? { now: () => num(f["created_at"])! } : {}) });
          if (r.action !== "unchanged" && r.action !== "reconfirmed") wrote = true;
          else await backdate(c, EDGE(edge), r.ref_id, num(f["created_at"]), byOf(c, f));
        }
        if (wrote) c.counts.facts_created++;
        else c.counts.facts_found++;
      }
      // Name facts: their names went to alt_names with the nodes.
      for (const [old, ns] of names) {
        const node = nodeOf.get(old);
        if (node) c.counts.names_added += await addNames(c, node, ns);
      }
      // Mishearings: dictation's records of the nodes, undone ones too.
      const heard = await importMishearings(b, query, nodeOf);
      c.counts.facts_created += heard.imported;
      c.counts.facts_found += heard.already;
      if (heard.skipped) c.skipped["a mishearing of an entity not imported"] = heard.skipped;

      // ── Episodes no fact came from ─────────────────────────────────────
      const lone = await query(
        `MATCH (ep:Episode) WHERE ep.deleted_at IS NULL
         OPTIONAL MATCH (f:Fact)-[:FROM_EPISODE]->(ep) WHERE f.deleted_at IS NULL
         WITH ep, count(f) AS n WHERE n = 0
         RETURN ep.ref_id AS ref_id, ep.content AS content, ep.source AS source, ep.speaker AS speaker, ep.occurred_at AS at ORDER BY ep.occurred_at`,
      );
      if (lone.length) c.skipped["an episode no fact came from"] = lone.length;
      const withFacts = Number((await query("MATCH (ep:Episode) WHERE ep.deleted_at IS NULL RETURN count(ep) AS n"))[0]?.["n"] ?? 0) - lone.length;
      if (withFacts > 0) c.skipped["an episode its facts were imported from: their sources name it"] = withFacts;

      const imported = c.counts.nodes_created + c.counts.facts_created + c.counts.names_added;
      const skipped = Object.values(c.skipped).reduce((a, n) => a + n, 0);
      return {
        status: "Success",
        imported,
        already: c.counts.nodes_found + c.counts.facts_found,
        skipped,
        counts: c.counts,
        skipped_by_reason: c.skipped,
      };
    } catch (e) {
      return errText("graph/import-memory", e);
    }
  },
});
