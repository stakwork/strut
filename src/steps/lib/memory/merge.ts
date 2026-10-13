import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Query, exclusive, memoryDb, normalize } from "./_db.js";
import { lookup } from "./_ontology.js";

/** Moves every `edge` between `table` nodes and the duplicate onto the kept entity. */
async function repoint(query: Query, edge: string, table: "Fact" | "Episode", dup: string, keep: string): Promise<number> {
  const from = (await query(
    `MATCH (x:${table})-[:${edge}]->(d:Entity) WHERE d.ref_id = $dup RETURN x.ref_id AS id`, { dup },
  )).map((r) => r.id as string);
  const already = new Set((await query(
    `MATCH (x:${table})-[:${edge}]->(k:Entity) WHERE k.ref_id = $keep AND x.ref_id IN $ids RETURN x.ref_id AS id`, { keep, ids: from },
  )).map((r) => r.id as string));
  const moving = from.filter((id) => !already.has(id));
  if (moving.length) {
    await query(`MATCH (x:${table}), (k:Entity) WHERE x.ref_id IN $ids AND k.ref_id = $keep CREATE (x)-[:${edge}]->(k)`, { ids: moving, keep });
  }
  await query(`MATCH (x:${table})-[r:${edge}]->(d:Entity) WHERE d.ref_id = $dup DELETE r`, { dup });
  return moving.length;
}

export default defineStep({
  type: "memory/merge",
  description:
    "Merge two entities that are the same thing: the duplicate's facts and mentions move to the one kept, its names " +
    "become the kept one's aliases, and it becomes an alias pointing there, so its ref_id still leads to the kept " +
    "entity. Facts that now repeat, or a one-value predicate (name, lives_in) now held twice, keep the newest and " +
    "supersede the rest. Nothing is deleted.",
  input: z.object({
    keep: z.string().describe("The ref_id of the entity to keep."),
    duplicate: z.string().describe("The ref_id of the entity that is the same thing."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    return exclusive(async () => {
      const now = Date.now();
      const { keep, duplicate: dup } = cfg;
      if (keep === dup) return { error: "invalid_input: keep and duplicate are the same entity" };
      const read = (id: string) => query(
        "MATCH (e:Entity) WHERE e.ref_id = $id AND e.deleted_at IS NULL RETURN e.type AS type, e.name AS name, e.aliases AS aliases", { id },
      ).then((r) => r[0]);
      const [kept, gone] = [await read(keep), await read(dup)];
      if (!kept || !gone) return { error: `not_found: ${!kept ? keep : dup} is not an entity in memory` };
      if (gone.type === "Self") return { error: "refused: Self cannot be merged into another entity; merge the other one into Self" };
      const notes = kept.type === gone.type ? [] : [`Merged a ${gone.type} into a ${kept.type}.`];

      const moved = {
        subject_of: await repoint(query, "SUBJECT", "Fact", dup, keep),
        object_of: await repoint(query, "OBJECT", "Fact", dup, keep),
        mentions: await repoint(query, "MENTIONS", "Episode", dup, keep),
      };
      // Aliases that pointed at the duplicate now point at the kept entity.
      const pointing = (await query("MATCH (a:Entity)-[:ALIAS_OF]->(d:Entity) WHERE d.ref_id = $dup RETURN a.ref_id AS id", { dup })).map((r) => r.id);
      if (pointing.length) {
        await query("MATCH (a:Entity), (k:Entity) WHERE a.ref_id IN $ids AND k.ref_id = $keep CREATE (a)-[:ALIAS_OF]->(k)", { ids: pointing, keep });
        await query("MATCH (a:Entity)-[r:ALIAS_OF]->(d:Entity) WHERE d.ref_id = $dup DELETE r", { dup });
      }
      const aliases = [...new Set([...(kept.aliases ?? []), ...(gone.aliases ?? []), normalize(gone.name)])];
      await query("MATCH (k:Entity) WHERE k.ref_id = $keep SET k.aliases = $aliases, k.updated_at = $now", { keep, aliases, now });
      await query("MATCH (d:Entity), (k:Entity) WHERE d.ref_id = $dup AND k.ref_id = $keep CREATE (d)-[:ALIAS_OF]->(k)", { dup, keep });
      await query(
        "MATCH (d:Entity) WHERE d.ref_id = $dup SET d.deleted_at = $now, d.deleted_reason = $why, d.updated_at = $now",
        { dup, now, why: `merged into ${keep}` },
      );

      // Tidy the kept entity's current facts: a repeat, or a second value of a
      // one-value predicate, is superseded by the newest.
      const facts = await query(
        `MATCH (f:Fact)-[:SUBJECT]->(k:Entity) WHERE k.ref_id = $keep AND f.expired_at IS NULL AND f.deleted_at IS NULL
         RETURN f.ref_id AS id, f.predicate AS predicate, f.text AS text, f.valid_at AS at ORDER BY f.valid_at DESC`,
        { keep },
      );
      const one = new Set<string>();
      for (const p of new Set(facts.map((f) => f.predicate as string))) {
        if ((await lookup(query, "predicate", p))?.cardinality === "one") one.add(p);
      }
      const newest = new Map<string, string>();
      const superseded: string[] = [];
      for (const f of facts) {
        const group = one.has(f.predicate) ? `${f.predicate}` : `${f.predicate}\u0000${f.text}`;
        const winner = newest.get(group);
        if (!winner) { newest.set(group, f.id); continue; }
        await query(
          `MATCH (o:Fact), (n:Fact) WHERE o.ref_id = $old AND n.ref_id = $new
           SET o.expired_at = $now, o.invalid_at = $now, o.updated_at = $now CREATE (n)-[:SUPERSEDES]->(o)`,
          { old: f.id, new: winner, now },
        );
        superseded.push(f.id);
      }
      return {
        kept: { ref_id: keep, node_type: kept.type, name: kept.name },
        merged: { ref_id: dup, node_type: gone.type, name: gone.name },
        moved, aliases, ...(superseded.length ? { superseded } : {}), ...(notes.length ? { notes } : {}),
      };
    });
  },
});
