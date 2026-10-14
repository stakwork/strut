import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Query, canonical, exclusive, memoryDb } from "./_db.js";
import { vocabulary } from "./_ontology.js";

// Soft delete: the nodes stay, marked with when and why, so a janitor can
// purge them once every copy has seen the forget, and nothing reads them
// meanwhile. An entity takes its facts with it; an episode, the facts that
// came only from it.
async function forgetNodes(query: Query, table: "Entity" | "Fact" | "Episode", ids: string[], reason: string, now: number) {
  if (!ids.length) return;
  await query(
    `MATCH (n:${table}) WHERE n.ref_id IN $ids AND n.deleted_at IS NULL
     SET n.deleted_at = $now, n.deleted_reason = $reason, n.updated_at = $now`,
    { ids, reason, now },
  );
}

export default defineStep({
  type: "memory/forget",
  description:
    "Forget a node of long-term memory, with the reason. An entity takes all its facts with it; an episode, the facts " +
    "that came only from it; a fact, only itself. The user (memory/ontology's user_type) cannot be forgotten whole: forget their facts instead. " +
    "To replace a fact that changed, remember the new one instead; forget is for what is wrong or unwanted.",
  input: z.object({
    ref_id: z.string(),
    reason: z.string().describe("Why, in a few words: 'the user asked', 'wrong person'."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    return exclusive(async () => {
      const now = Date.now();
      // A merged-away entity means the one it was merged into, as in memory/get.
      const id = await canonical(query, cfg.ref_id);
      const [entity] = await query("MATCH (e:Entity) WHERE e.ref_id = $id AND e.deleted_at IS NULL RETURN e.type AS type, e.name AS name", { id });
      if (entity) {
        if ((await vocabulary(query)).role(entity.type) === "user") return { error: "refused: the user cannot be forgotten whole; forget their facts one by one" };
        const facts = (await query(
          "MATCH (f:Fact)-[]->(e:Entity) WHERE e.ref_id = $id AND f.deleted_at IS NULL RETURN DISTINCT f.ref_id AS id", { id },
        )).map((r) => r.id as string);
        await forgetNodes(query, "Entity", [id], cfg.reason, now);
        await forgetNodes(query, "Fact", facts, cfg.reason, now);
        return {
          forgotten: { ref_id: id, node_type: entity.type, name: entity.name }, with_facts: facts.length,
          ...(id !== cfg.ref_id ? { merged_from: cfg.ref_id } : {}),
        };
      }
      const [fact] = await query("MATCH (f:Fact) WHERE f.ref_id = $id AND f.deleted_at IS NULL RETURN f.text AS text", { id });
      if (fact) {
        await forgetNodes(query, "Fact", [id], cfg.reason, now);
        return { forgotten: { ref_id: id, node_type: "Fact", name: fact.text } };
      }
      const [episode] = await query("MATCH (e:Episode) WHERE e.ref_id = $id AND e.deleted_at IS NULL RETURN e.content AS content", { id });
      if (episode) {
        const onlyHere = (await query(
          `MATCH (f:Fact)-[:FROM_EPISODE]->(e:Episode) WHERE e.ref_id = $id AND f.deleted_at IS NULL
           OPTIONAL MATCH (f)-[:FROM_EPISODE]->(o:Episode) WHERE o.ref_id <> $id AND o.deleted_at IS NULL
           WITH f, count(o) AS others WHERE others = 0
           RETURN f.ref_id AS id`,
          { id },
        )).map((r) => r.id as string);
        await forgetNodes(query, "Episode", [id], cfg.reason, now);
        await forgetNodes(query, "Fact", onlyHere, cfg.reason, now);
        return { forgotten: { ref_id: id, node_type: "Episode", name: String(episode.content).slice(0, 80) }, with_facts: onlyHere.length };
      }
      return { error: `not_found: no node with ref_id ${id}` };
    });
  },
});
