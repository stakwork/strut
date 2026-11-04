import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, type GraphBackend } from "./_shared.js";
import { type Query, type Row, memoryDb, normalize } from "../memory/_db.js";
import { vocabulary, type Vocabulary } from "../memory/_ontology.js";

/**
 * The one-off move of the old memory database (`memory/*`, src/steps/lib/memory)
 * onto the workspace graph (plans/graph-memory-plan.md step 7). It reads the
 * old database and writes nothing to it, and it is safe to run again: every
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
 *   - a name fact adds the name to its subject's `alt_names`;
 *   - everything goes to `private`.
 *
 * What has no faithful place is listed for review, never dropped: a fact
 * about one entity alone ("Kate is vegetarian": the thing it is about is
 * not an entity), an entity's free-form attributes, an episode no fact came
 * from, and anything that could not be written. A mishearing stays where
 * dictation reads it (memory/lexicon), and is counted as skipped.
 */

const REVIEW_DEFAULT = 200;

/** The old database's file, as `_db.ts` finds it; undefined when there is none. */
async function oldDatabase(ctx: StepContext<StrutCapabilities> | undefined): Promise<string | undefined> {
  const explicit = await ctx?.services?.secrets?.get("STRUT_MEMORY_DB");
  const path = explicit ? resolvePath(explicit) : ctx?.services?.dataDir ? resolvePath(join(ctx.services.dataDir, "memory", "graph.lbug")) : undefined;
  return path && existsSync(path) ? path : undefined;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const edgeTypeOf = (predicate: string) => {
  const t = predicate.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z]/.test(t) ? t : `HAS_${t}`;
};
/** The name in a name fact's sentence, as memory/duplicates reads it. */
const nameIn = (text: string) => /\b(?:name is|named|called|call me)\s+(.+?)\.?$/i.exec(text)?.[1]?.trim();

type Review = { kind: "fact" | "attributes" | "episode" | "entity"; old_ref_id: string; reason: string } & Record<string, unknown>;

interface Ctx {
  b: GraphBackend;
  query: Query;
  vocab: Vocabulary;
  namespace: string;
  by: { created_by?: string };
  review: Review[];
  skipped: Record<string, number>;
  counts: { nodes_created: number; nodes_found: number; facts_created: number; facts_found: number; names_added: number };
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
  } else if (!("alt_names" in schema.attributes)) {
    // Its other names are what `resolve` matches.
    const { createNodeSchema } = await import("../../../graph/schema-crud.js");
    await createNodeSchema(c.b, c.b.schemas, { type: schema.type, attributes: { alt_names: "?list" } });
  }
  made.set(oldType, type === null ? null : (await c.b.schemas.schema(type))?.type ?? type);
  return made.get(oldType)!;
}

/** The graph's user: the Person marked is_owner, made when there is none. */
async function owner(c: Ctx, name: string, alts: string[]): Promise<string> {
  const { findNodes } = await import("../../../graph/find.js");
  const found = await findNodes(c.b, { node_type: "Person", where: { is_owner: true }, namespace: c.namespace, limit: 1 });
  const hit = found.nodes[0];
  if (hit) {
    await addNames(c, hit.ref_id, alts);
    c.counts.nodes_found++;
    return hit.ref_id;
  }
  const w = await c.b.nodes.write({ type: "Person", data: { name, is_owner: true, ...(alts.length ? { alt_names: alts } : {}) }, ...c.by }, "create", { namespace: c.namespace });
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
    "Move the old memory database (the memory/* steps') onto the workspace graph, once: entities become nodes (the user the Person " +
    "marked is_owner), facts linking two entities become temporal edges with their dates, sources and speaker, names become alt_names, " +
    "all in `private`. Reads the old database and never changes it; safe to run again (what is already there is found, not doubled). " +
    "Returns counts imported, skipped and for review, and the items for review: facts about one entity alone, attributes, and " +
    "episodes no fact came from. A LadybugDB graph only.",
  input: z.object({
    review_limit: z.number().int().optional().default(REVIEW_DEFAULT).describe(`Most items for review to list in full (default ${REVIEW_DEFAULT}); the count is always whole.`),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    try {
      const sctx = ctx as StepContext<StrutCapabilities>;
      if (!(await oldDatabase(sctx))) return { status: "Warning", messages: ["no old memory database here: nothing to import"], imported: 0, skipped: 0, for_review: 0 };
      const b = await graphCtx(sctx);
      if (b.kind !== "ladybug") return "graph/import-memory failed — WRONG_TYPE: it imports into a LadybugDB graph only";
      const { assertEdge } = await import("../../../graph/temporal.js");
      const { resolveNode } = await import("../../../graph/resolve.js");
      const { PRIVATE_NAMESPACE } = await import("../../../graph/ladybug/namespaces.js");
      const { edgeRule } = await import("../../../graph/ladybug/ontology.js");
      const { boundsOf } = await import("../../../graph/scope.js");
      const query = await memoryDb(ctx);
      const vocab = await vocabulary(query);
      const c: Ctx = {
        b, query, vocab,
        namespace: await b.reader.resolveNamespace(PRIVATE_NAMESPACE),
        by: ctx?.actor ? { created_by: ctx.actor } : {},
        review: [], skipped: {},
        counts: { nodes_created: 0, nodes_found: 0, facts_created: 0, facts_found: 0, names_added: 0 },
      };
      const role = (predicate: string) => vocab.term("predicate", predicate)?.role ?? "";

      // ── Entities ──────────────────────────────────────────────────────
      const entities = await query(
        `MATCH (e:Entity) WHERE e.deleted_at IS NULL
         RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.attributes AS attributes, e.aliases AS aliases
         ORDER BY e.created_at, e.ref_id`,
      );
      const facts = await query(
        `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.deleted_at IS NULL AND s.deleted_at IS NULL
         OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
         RETURN f.ref_id AS ref_id, f.predicate AS predicate, f.text AS text, f.value AS value, f.valid_at AS valid_at,
                f.invalid_at AS invalid_at, f.expired_at AS expired_at, s.ref_id AS subject, o.ref_id AS object, o.deleted_at AS object_deleted
         ORDER BY f.created_at, f.ref_id`,
      );
      const names = new Map<string, string[]>();
      for (const f of facts) {
        if (role(f["predicate"]) !== "alias") continue;
        const n = (f["value"] as string | null) ?? nameIn(String(f["text"]));
        if (n) names.set(f["subject"], [...(names.get(f["subject"]) ?? []), n]);
      }
      const userType = vocab.userType();
      const nodeOf = new Map<string, string>();
      const made = new Map<string, string | null>();
      for (const e of entities) {
        const id = String(e["ref_id"]);
        const own = String(e["name"]);
        // One spelling per name, case-blind: a name fact's as written, before the old memory's lowercased aliases.
        const spelled = new Map<string, string>();
        for (const a of [...(names.get(id) ?? []), ...((e["aliases"] as string[] | null) ?? [])]) if (!spelled.has(normalize(a))) spelled.set(normalize(a), a);
        const alts = [...spelled.values()].filter((a) => normalize(a) !== normalize(own));
        const attrs = (() => { try { return JSON.parse(String(e["attributes"] || "{}")) as Record<string, unknown>; } catch { return {}; } })();
        if (attrs && Object.keys(attrs).length) c.review.push({ kind: "attributes", old_ref_id: id, name: own, attributes: attrs, reason: "free-form attributes: set the ones still true as fields, or assert them as facts" });
        if (e["type"] === userType) {
          // The user's name is their current name fact when they gave one ("Me" is no name).
          const current = facts.filter((f) => f["subject"] === id && role(f["predicate"]) === "alias" && f["expired_at"] == null);
          const given = current.length ? ((current.at(-1)!["value"] as string | null) ?? nameIn(String(current.at(-1)!["text"]))) : undefined;
          const name = given ?? own;
          nodeOf.set(id, await owner(c, name, [own, ...alts].filter((a) => normalize(a) !== normalize(name))));
          continue;
        }
        const type = await graphType(c, String(e["type"]), made);
        if (!type) {
          c.review.push({ kind: "entity", old_ref_id: id, name: own, type: e["type"], reason: `the graph's ${e["type"]} type is not an entity type` });
          continue;
        }
        const r = await resolveNode(b, { type, name: own, ...(alts.length ? { aliases: alts } : {}), namespaces: [c.namespace] });
        if (r.ambiguous) {
          c.review.push({ kind: "entity", old_ref_id: id, name: own, type, candidates: r.candidates.map((x) => ({ ref_id: x.ref_id, title: x.title })), reason: "several nodes already go by this name: pick one, or make a new one" });
          continue;
        }
        if (r.match) {
          nodeOf.set(id, r.match.ref_id);
          c.counts.nodes_found++;
          c.counts.names_added += await addNames(c, r.match.ref_id, alts);
          continue;
        }
        const schema = await b.schemas.schema(type);
        const summary = typeof e["summary"] === "string" && e["summary"].trim() && schema && "description" in schema.attributes ? { description: e["summary"] } : {};
        const w = await b.nodes.write({ type, data: { name: own, ...summary, ...(alts.length ? { alt_names: alts } : {}) }, ...c.by }, "create", { namespace: c.namespace });
        nodeOf.set(id, w.ref_id);
        if (w.outcome === "existing") c.counts.nodes_found++;
        else c.counts.nodes_created++;
      }

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
      const iso = (ms: unknown) => (num(ms) === null ? undefined : new Date(num(ms)!).toISOString());

      for (const f of facts) {
        const id = String(f["ref_id"]);
        const predicate = String(f["predicate"]);
        const kind = role(predicate);
        if (kind === "alias") continue; // its subject's alt_names, above
        if (kind === "mishearing") { skip(c, "a mishearing: dictation keeps reading it from the old memory"); continue; }
        const subject = nodeOf.get(f["subject"]);
        const ended = f["expired_at"] != null;
        const said = (episodes.get(id) ?? []).map((ep) => ({
          source: String(ep["source"] || `memory/episode:${ep["ref_id"]}`),
          said_by: ep["speaker"] && !userIds.has(ep["speaker"]) ? nodeOf.get(ep["speaker"]) : undefined,
        }));
        const about = { old_ref_id: id, predicate, text: f["text"], valid_at: iso(f["valid_at"]), invalid_at: iso(f["invalid_at"]), ...(ended ? { ended: true } : {}), sources: said.map((s) => s.source) };
        if (!subject) { c.review.push({ kind: "fact", ...about, reason: "its subject was not imported (listed above)" }); continue; }
        if (!f["object"] || f["object_deleted"] != null) {
          c.review.push({ kind: "fact", ...about, subject: { ref_id: subject, name: (await b.reader.getNode(subject))?.title }, reason: "about one entity alone: assert it to the node it is about, or set it as a field" });
          continue;
        }
        const object = nodeOf.get(f["object"]);
        if (!object) { c.review.push({ kind: "fact", ...about, reason: "its object was not imported (listed above)" }); continue; }
        // A past fact the old memory also holds now would end the current one: the current one stands.
        if (ended && held.has(`${f["subject"]}|${predicate}|${f["object"]}`)) { skip(c, "an earlier spell of a fact held now"); continue; }
        const ready_ = await edgeReady(predicate, await typeOf(subject), await typeOf(object), vocab.term("predicate", predicate)?.cardinality ?? "many", vocab.term("predicate", predicate)?.aliases ?? []);
        if (typeof ready_ === "string") { c.review.push({ kind: "fact", ...about, reason: ready_ }); continue; }
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
            ...c.by,
          }, { ...(b.embedder ? { embedder: b.embedder } : {}) });
          if (r.action !== "unchanged" && r.action !== "reconfirmed") wrote = true;
        }
        if (wrote) c.counts.facts_created++;
        else c.counts.facts_found++;
      }
      // Name facts: their names went to alt_names with the nodes.
      for (const [old, ns] of names) {
        const node = nodeOf.get(old);
        if (node) c.counts.names_added += await addNames(c, node, ns);
      }

      // ── Episodes no fact came from ─────────────────────────────────────
      const lone = await query(
        `MATCH (ep:Episode) WHERE ep.deleted_at IS NULL
         OPTIONAL MATCH (f:Fact)-[:FROM_EPISODE]->(ep) WHERE f.deleted_at IS NULL
         WITH ep, count(f) AS n WHERE n = 0
         RETURN ep.ref_id AS ref_id, ep.content AS content, ep.source AS source, ep.speaker AS speaker, ep.occurred_at AS at ORDER BY ep.occurred_at`,
      );
      for (const ep of lone) {
        c.review.push({ kind: "episode", old_ref_id: String(ep["ref_id"]), text: ep["content"], at: iso(ep["at"]), ...(ep["source"] ? { source: ep["source"] } : {}), reason: "what was said, with no fact saved from it: save what is worth keeping" });
      }
      const withFacts = Number((await query("MATCH (ep:Episode) WHERE ep.deleted_at IS NULL RETURN count(ep) AS n"))[0]?.["n"] ?? 0) - lone.length;
      if (withFacts > 0) c.skipped["an episode its facts were imported from: their sources name it"] = withFacts;

      const imported = c.counts.nodes_created + c.counts.facts_created + c.counts.names_added;
      const skipped = Object.values(c.skipped).reduce((a, n) => a + n, 0);
      return {
        status: "Success",
        imported,
        already: c.counts.nodes_found + c.counts.facts_found,
        skipped,
        for_review: c.review.length,
        counts: c.counts,
        skipped_by_reason: c.skipped,
        review: c.review.slice(0, Math.max(0, cfg.review_limit)),
        ...(c.review.length > cfg.review_limit ? { review_truncated: true } : {}),
      };
    } catch (e) {
      return errText("graph/import-memory", e);
    }
  },
});
