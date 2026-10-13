import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Query, type Row, canonical, iso, memoryDb, normalize } from "./_db.js";
import { lookup } from "./_ontology.js";

async function entity(query: Query, where: string, params: Record<string, unknown>) {
  const [e] = await query(
    `MATCH (e:Entity) WHERE e.deleted_at IS NULL AND ${where}
     RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.aliases AS aliases,
            e.attributes AS attributes, e.created_by AS created_by, e.created_at AS created_at LIMIT 1`,
    params,
  );
  if (!e) return undefined;
  const facts = await query(
    `MATCH (f:Fact)-[r]->(e:Entity) WHERE e.ref_id = $id AND f.deleted_at IS NULL AND f.expired_at IS NULL
     OPTIONAL MATCH (f)-[:SUBJECT]->(s:Entity)
     OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
     RETURN f.ref_id AS ref_id, f.text AS text, f.predicate AS predicate, f.valid_at AS valid_at,
            label(r) AS role, s.name AS subject, o.name AS object
     ORDER BY f.valid_at DESC`,
    { id: e.ref_id },
  );
  // A fact about the entity and itself (after a merge: Kate knows Kate)
  // comes back once per role; list it once, as its subject.
  const current = new Map<string, Row>();
  for (const f of facts) if (!current.has(f.ref_id) || f.role === "SUBJECT") current.set(f.ref_id, f);
  const [{ n }] = await query("MATCH (ep:Episode)-[:MENTIONS]->(e:Entity {ref_id: $id}) RETURN count(ep) AS n", { id: e.ref_id });
  return {
    ref_id: e.ref_id,
    node_type: e.type,
    name: e.name,
    summary: e.summary,
    aliases: e.aliases,
    attributes: JSON.parse(e.attributes || "{}"),
    created_by: e.created_by,
    created_at: iso(e.created_at),
    facts: [...current.values()].map((f) => ({
      ref_id: f.ref_id,
      text: f.text,
      predicate: f.predicate,
      role: String(f.role).toLowerCase(),
      ...(f.role === "SUBJECT" && f.object ? { object: f.object } : {}),
      ...(f.role === "OBJECT" ? { subject: f.subject } : {}),
      since: iso(f.valid_at),
    })),
    mentioned_in_episodes: Number(n),
  };
}

async function fact(query: Query, id: string) {
  const [f] = await query(
    // Filter in WHERE, not as {ref_id: $id}: in Ladybug 0.21.2 an inline
    // parameter filter plus OPTIONAL MATCH returns the node's fields as null.
    `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.ref_id = $id AND f.deleted_at IS NULL
     OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
     RETURN f.text AS text, f.predicate AS predicate, f.confidence AS confidence, f.valid_at AS valid_at,
            f.invalid_at AS invalid_at, f.expired_at AS expired_at, f.created_by AS created_by,
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
    valid_at: iso(f.valid_at),
    ...(f.expired_at != null ? { invalid_at: iso(f.invalid_at), expired_at: iso(f.expired_at) } : {}),
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
     RETURN e.kind AS kind, e.source AS source, e.content AS content, e.occurred_at AS at, e.created_by AS created_by`,
    { id },
  );
  if (!e) return undefined;
  const mentions = await query("MATCH (:Episode {ref_id: $id})-[:MENTIONS]->(x:Entity) RETURN x.ref_id AS ref_id, x.name AS name, x.type AS type", { id });
  return { ref_id: id, node_type: "Episode", kind: e.kind, source: e.source || undefined, content: e.content, at: iso(e.at), created_by: e.created_by, mentions };
}

export default defineStep({
  type: "memory/get",
  description:
    "Read one node from long-term memory in full. An entity comes with its current facts; a fact with its subject, " +
    "the episodes it came from and what it superseded; an episode with what it mentions. " +
    "Pass a ref_id, or a type and name (type 'Self' alone returns the user).",
  input: z.object({
    ref_id: z.string().optional(),
    type: z.string().optional().describe("An entity type, e.g. Person; Self alone is the user."),
    name: z.string().optional(),
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
    const type = cfg.type ? (await lookup(query, "entity_type", cfg.type))?.name ?? cfg.type : undefined;
    if (type === "Self") return (await entity(query, "e.type = 'Self'", {})) ?? { error: "not_found: nothing is known about the user yet" };
    if (type && cfg.name) {
      const node = await entity(query, "e.type = $type AND (lower(e.name) = $key OR list_contains(e.aliases, $key))", { type, key: normalize(cfg.name) });
      return node ?? { error: `not_found: no ${type} named ${cfg.name}` };
    }
    return { error: "invalid_input: pass a ref_id, type 'Self', or a type and name" };
  },
});
