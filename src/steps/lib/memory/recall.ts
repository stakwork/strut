import { z } from "zod";
import { defineStep } from "../../../core.js";
import { iso, memoryDb, normalize } from "./_db.js";

const STOP = new Set(["the", "and", "what", "who", "whom", "whose", "where", "when", "which", "does", "did", "about", "with", "for", "you", "your", "know", "tell", "are", "was", "has", "have", "this", "that"]);

// Plain word matching over names and fact text, ranked by how many words hit.
// Fine at personal scale; Ladybug's full-text and vector indexes replace it later.
export default defineStep({
  type: "memory/recall",
  description:
    "Search long-term memory. Returns small results: ref_id, name, node_type, a short description, and an edges count. " +
    "Facts come back as their sentence. Call memory/get on a ref_id for the full node. " +
    "For anything about the user themselves, memory/get with type 'Self' returns everything known about them.",
  input: z.object({
    q: z.string().describe("Plain words, e.g. 'Kate cooking' or 'my name'."),
    type: z.string().optional().describe("Comma-separated filter: entity types (Person, Topic, …) and/or 'Fact'."),
    limit: z.number().optional().default(10),
    include_expired: z.boolean().optional().default(false).describe("Also return facts that were superseded."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    const words = normalize(cfg.q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
    const terms = words.length ? words : [normalize(cfg.q)];
    const types = cfg.type ? new Set(cfg.type.split(",").map((t) => t.trim())) : undefined;
    const score = (text: string) => terms.reduce((n, w) => n + (normalize(text).includes(w) ? 1 : 0), 0);

    const hits: { score: number; hit: Record<string, unknown> }[] = [];

    if (!types || [...types].some((t) => t !== "Fact")) {
      const rows = await query(
        `MATCH (e:Entity) WHERE e.deleted_at IS NULL
         OPTIONAL MATCH (f:Fact)-[]->(e) WHERE f.expired_at IS NULL AND f.deleted_at IS NULL
         RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.aliases AS aliases, count(f) AS facts`,
      );
      for (const r of rows) {
        if (types && !types.has(r.type)) continue;
        const s = score(`${r.name} ${(r.aliases ?? []).join(" ")} ${r.summary ?? ""}`);
        if (s > 0) hits.push({ score: s + 0.5, hit: { ref_id: r.ref_id, name: r.name, node_type: r.type, description: r.summary ?? "", edges: { FACTS: Number(r.facts) } } });
      }
    }

    if (!types || types.has("Fact")) {
      const rows = await query(
        `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.deleted_at IS NULL
         OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
         RETURN f.ref_id AS ref_id, f.text AS text, f.predicate AS predicate, f.valid_at AS valid_at,
                f.expired_at AS expired_at, s.name AS subject, o.name AS object`,
      );
      for (const r of rows) {
        if (r.expired_at != null && !cfg.include_expired) continue;
        const s = score(`${r.text} ${r.predicate} ${r.subject} ${r.object ?? ""}`);
        if (s === 0) continue;
        const since = iso(r.valid_at)?.slice(0, 10);
        const description = `${r.subject} · ${r.predicate}${r.object ? ` → ${r.object}` : ""}${since ? ` · since ${since}` : ""}${r.expired_at != null ? " · superseded" : ""}`;
        hits.push({ score: s, hit: { ref_id: r.ref_id, name: r.text, node_type: "Fact", description, edges: {} } });
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, cfg.limit)).map((h) => h.hit);
  },
});
