import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Query, type Row, canonical, iso, memoryDb, normalize } from "./_db.js";
import { vocabulary } from "./_ontology.js";

/** At most this many past facts come with an entity. */
const PAST = 20;

async function entity(query: Query, where: string, params: Record<string, unknown>, order = "e.created_at") {
  const [e] = await query(
    `MATCH (e:Entity) WHERE e.deleted_at IS NULL AND ${where}
     RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.aliases AS aliases,
            e.attributes AS attributes, e.created_by AS created_by, e.created_at AS created_at ORDER BY ${order} LIMIT 1`,
    params,
  );
  if (!e) return undefined;
  const facts = (held: boolean, order: string) => query(
    `MATCH (f:Fact)-[r]->(e:Entity) WHERE e.ref_id = $id AND f.deleted_at IS NULL AND f.expired_at IS ${held ? "NULL" : "NOT NULL"}
     OPTIONAL MATCH (f)-[:SUBJECT]->(s:Entity)
     OPTIONAL MATCH (f)-[:OBJECT]->(o:Node)
     RETURN f.ref_id AS ref_id, f.text AS text, f.predicate AS predicate, f.valid_at AS valid_at,
            f.invalid_at AS invalid_at, f.value AS value, f.form AS form, label(r) AS role, s.name AS subject, o.name AS object
     ORDER BY ${order}`,
    { id: e.ref_id },
  );
  // A fact about the entity and itself (after a merge: Kate knows Kate)
  // comes back once per role; list it once, as its subject.
  const once = (rows: Row[]) => {
    const byId = new Map<string, Row>();
    for (const f of rows) if (!byId.has(f.ref_id) || f.role === "SUBJECT") byId.set(f.ref_id, f);
    return [...byId.values()];
  };
  const current = once(await facts(true, "coalesce(f.valid_at, f.created_at) DESC"));
  // Past ones (ended or replaced) are listed apart, newest end first, capped,
  // so "where did I live before" has an answer. The end is the earlier of
  // the world's and the record's: mixing the two clocks on purpose, since a
  // replaced fact may have no end in the world.
  const past = once(await facts(false,
    // A fact held twice (subject and object) is two rows: room for both.
    `CASE WHEN f.invalid_at IS NOT NULL AND f.invalid_at < f.expired_at THEN f.invalid_at ELSE f.expired_at END DESC, f.ref_id DESC LIMIT ${PAST * 2}`))
    .slice(0, PAST);
  const shown = (f: Row) => ({
    ref_id: f.ref_id,
    text: f.text,
    predicate: f.predicate,
    role: String(f.role).toLowerCase(),
    ...(f.role === "SUBJECT" && f.object ? { object: f.object } : {}),
    ...(f.role === "OBJECT" ? { subject: f.subject } : {}),
    ...(f.value ? { value: f.value } : {}),
    ...(f.form ? { form: f.form } : {}),
    since: iso(f.valid_at),
  });
  const [{ n }] = await query("MATCH (ep:Episode)-[:MENTIONS]->(e:Entity {ref_id: $id}) RETURN count(ep) AS n", { id: e.ref_id });
  return {
    ref_id: e.ref_id,
    node_type: e.type,
    // Marks the user, so a reader needs no type name to know them.
    ...((await vocabulary(query)).role(e.type) === "user" ? { user: true } : {}),
    name: e.name,
    summary: e.summary ?? "",
    aliases: e.aliases,
    attributes: JSON.parse(e.attributes || "{}"),
    created_by: e.created_by,
    created_at: iso(e.created_at),
    facts: current.map(shown),
    ...(past.length ? { past: past.map((f) => ({ ...shown(f), until: iso(f.invalid_at) })) } : {}),
    mentioned_in_episodes: Number(n),
  };
}

async function fact(query: Query, id: string) {
  const [f] = await query(
    // Filter in WHERE, not as {ref_id: $id}: in Ladybug 0.21.2 an inline
    // parameter filter plus OPTIONAL MATCH returns the node's fields as null.
    `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.ref_id = $id AND f.deleted_at IS NULL
     OPTIONAL MATCH (f)-[:OBJECT]->(o:Node)
     RETURN f.text AS text, f.predicate AS predicate, f.confidence AS confidence, f.valid_at AS valid_at,
            f.invalid_at AS invalid_at, f.expired_at AS expired_at, f.created_by AS created_by, f.created_at AS created_at,
            s.ref_id AS s_id, s.name AS s_name, o.ref_id AS o_id, o.name AS o_name`,
    { id },
  );
  if (!f) return undefined;
  const episodes = await query(
    `MATCH (:Fact {ref_id: $id})-[:FROM_EPISODE]->(e:Episode)
     RETURN e.ref_id AS ref_id, e.kind AS kind, e.source AS source, e.content AS content, e.occurred_at AS at ORDER BY e.occurred_at`,
    { id },
  );
  const supersedes = await query("MATCH (:Fact {ref_id: $id})-[:SUPERSEDES]->(o:Fact) RETURN o.ref_id AS ref_id, o.text AS text", { id });
  const supersededBy = await query("MATCH (n:Fact)-[:SUPERSEDES]->(:Fact {ref_id: $id}) RETURN n.ref_id AS ref_id, n.text AS text", { id });
  return {
    ref_id: id,
    node_type: "Fact",
    text: f.text,
    predicate: f.predicate,
    confidence: f.confidence,
    subject: { ref_id: f.s_id, name: f.s_name },
    ...(f.o_id ? { object: { ref_id: f.o_id, name: f.o_name } } : {}),
    // World time, each only when known; then record time.
    valid_at: iso(f.valid_at),
    invalid_at: iso(f.invalid_at),
    created_at: iso(f.created_at),
    expired_at: iso(f.expired_at),
    created_by: f.created_by,
    episodes: episodes.map((e) => ({
      ref_id: e.ref_id,
      kind: e.kind,
      source: e.source || undefined,
      excerpt: String(e.content).slice(0, 280),
      at: iso(e.at),
    })),
    supersedes,
    superseded_by: supersededBy,
  };
}

async function episode(query: Query, id: string) {
  const [e] = await query(
    `MATCH (e:Episode {ref_id: $id}) WHERE e.deleted_at IS NULL
     RETURN e.kind AS kind, e.source AS source, e.content AS content, e.speaker AS speaker, e.occurred_at AS at, e.created_by AS created_by`,
    { id },
  );
  if (!e) return undefined;
  // A NULL speaker is the user from before they had an entity: none is shown.
  // merge points a merged-away speaker at the entity kept; a forgotten one
  // shows as forgotten, never as the user.
  const [speaker] = e.speaker
    ? await query("MATCH (x:Entity) WHERE x.ref_id = $s AND x.deleted_at IS NULL RETURN x.ref_id AS ref_id, x.name AS name, x.type AS type", { s: e.speaker })
    : [];
  const mentions = await query(
    "MATCH (ep:Episode)-[:MENTIONS]->(x:Entity) WHERE ep.ref_id = $id AND x.deleted_at IS NULL RETURN x.ref_id AS ref_id, x.name AS name, x.type AS type",
    { id },
  );
  return { ref_id: id, node_type: "Episode", kind: e.kind, source: e.source || undefined, content: e.content, ...(speaker ? { speaker } : e.speaker ? { speaker: { forgotten: true } } : {}), at: iso(e.at), created_by: e.created_by, mentions };
}

export default defineStep({
  type: "memory/get",
  description:
    "Read one node from long-term memory in full. An entity comes with its current facts and, under `past`, the ones that ended or were replaced " +
    "(newest first; `until` only when the end in the world is known); a fact with its subject, " +
    "the episodes it came from and what it superseded; an episode with who said it (none when the user said it " +
    "before memory had an entity for them; { forgotten: true } once they are forgotten) and what it mentions. " +
    "Pass a ref_id, or a type and name; `user: true` (or the user type alone) returns the user. " +
    "`user: true` goes alone, without a type or name; a ref_id takes precedence over the rest.",
  input: z.object({
    ref_id: z.string().optional(),
    type: z.string().optional().describe("An entity type, e.g. Person; the user type alone is the user."),
    name: z.string().optional(),
    user: z.boolean().optional().describe("The user themselves: no type needed."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    if (cfg.ref_id) {
      // A merged-away entity leads to the one it was merged into.
      const id = await canonical(query, cfg.ref_id);
      const node = (await entity(query, "e.ref_id = $id", { id })) ?? (await fact(query, id)) ?? (await episode(query, id));
      if (!node) return { error: `not_found: no node with ref_id ${cfg.ref_id}` };
      return id === cfg.ref_id ? node : { ...node, merged_from: cfg.ref_id };
    }
    if (cfg.user && (cfg.type || cfg.name)) return { error: "invalid_input: pass user: true alone, or a type and name" };
    const vocab = await vocabulary(query);
    const type = cfg.user ? vocab.userType() : cfg.type ? vocab.term("entity_type", cfg.type)?.name ?? cfg.type : undefined;
    if (cfg.user && !type) return { error: "not_found: this memory has no user type" };
    if (type && vocab.role(type) === "user") return (await entity(query, "e.type = $type", { type })) ?? { error: "not_found: nothing is known about the user yet" };
    if (type && cfg.name) {
      // A name before an alias, then the oldest: the same answer every time.
      const node = await entity(
        query, "e.type = $type AND (lower(e.name) = $key OR list_contains(e.aliases, $key))", { type, key: normalize(cfg.name) },
        "CASE WHEN lower(e.name) = $key THEN 0 ELSE 1 END, e.created_at",
      );
      return node ?? { error: `not_found: no ${type} named ${cfg.name}` };
    }
    return { error: "invalid_input: pass a ref_id, user: true, or a type and name" };
  },
});
