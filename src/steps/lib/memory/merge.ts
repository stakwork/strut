import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Query, type Row, editAliases, memoryWrite, normalize, supersede } from "./_db.js";
import { lookup, vocabulary } from "./_ontology.js";
import { candidatePairs } from "./duplicates.js";
import { SYSTEM_WRITER as JANITOR } from "../../../system-workflows.js";

/** The janitor (a system workflow, src/system-workflows.ts) merges with no
 *  person watching and no undo, reading memory that holds what other people
 *  said. So, in code: only a pair memory/duplicates offers, into the user only
 *  on the full-name match, and at most JANITOR_CAP merges in a rolling day. */
export const JANITOR_CAP = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

async function janitorRefusal(query: Query, keep: string, dup: string, keepIsUser: boolean, now: number): Promise<string | undefined> {
  const [{ n } = { n: 0 }] = await query(
    `MATCH (e:Entity) WHERE e.deleted_at > $since AND e.deleted_reason STARTS WITH "merged into " AND e.deleted_reason ENDS WITH $by
     RETURN count(e) AS n`,
    { since: now - DAY_MS, by: ` by ${JANITOR}` },
  );
  if (Number(n) >= JANITOR_CAP) return `refused: the janitor has already merged ${JANITOR_CAP} pairs in the last 24 hours; stop merging`;
  const pair = (await candidatePairs(query)).find((p) => (p.a.ref_id === keep && p.b.ref_id === dup) || (p.a.ref_id === dup && p.b.ref_id === keep));
  if (!pair) return "refused: the janitor may only merge a pair memory_duplicates offers; this pair is not one";
  if (keepIsUser && pair.score < 100) return "refused: the janitor may merge into the user only a Person with the user's full name";
  return undefined;
}

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
    created_by: z.string().optional().default("agent").describe("Who is merging: 'agent' or 'user'."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return memoryWrite(ctx, async (query) => {
      const now = Date.now();
      const { keep, duplicate: dup } = cfg;
      if (keep === dup) return { error: "invalid_input: keep and duplicate are the same entity" };
      const read = (id: string) => query(
        "MATCH (e:Entity) WHERE e.ref_id = $id AND e.deleted_at IS NULL RETURN e.type AS type, e.name AS name, e.aliases AS aliases", { id },
      ).then((r) => r[0]);
      const [kept, gone] = [await read(keep), await read(dup)];
      if (!kept || !gone) return { error: `not_found: ${!kept ? keep : dup} is not an entity in memory` };
      const vocab = await vocabulary(query);
      if (vocab.role(gone.type) === "user") {
        return { error: "refused: the user cannot be merged into another entity; merge the other one into the user" };
      }
      if (cfg.created_by === JANITOR) {
        const refusal = await janitorRefusal(query, keep, dup, vocab.role(kept.type) === "user", now);
        if (refusal) return { error: refusal };
      }
      const notes = kept.type === gone.type ? [] : [`Merged a ${gone.type} into a ${kept.type}.`];

      // A mishearing with no form meant the duplicate's name: it keeps meaning that.
      if (normalize(gone.name) !== normalize(kept.name)) {
        await query(
          `MATCH (f:Fact)-[:SUBJECT]->(d:Entity) WHERE d.ref_id = $dup AND f.predicate IN $heard AND f.value IS NOT NULL AND f.form IS NULL
           SET f.form = $name`,
          { dup, heard: vocab.predicatesWithRole("mishearing"), name: gone.name },
        );
      }
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
      await query("MATCH (ep:Episode) WHERE ep.speaker = $dup SET ep.speaker = $keep", { dup, keep });
      const aliases = await editAliases(query, keep, [...(gone.aliases ?? []), gone.name], now);
      await query("MATCH (d:Entity), (k:Entity) WHERE d.ref_id = $dup AND k.ref_id = $keep CREATE (d)-[:ALIAS_OF]->(k)", { dup, keep });
      await query(
        "MATCH (d:Entity) WHERE d.ref_id = $dup SET d.deleted_at = $now, d.deleted_reason = $why, d.updated_at = $now",
        { dup, now, why: `merged into ${keep} by ${cfg.created_by}` },
      );

      // Tidy the kept entity's current facts: a repeat, or a second value of a
      // one-value predicate, is superseded by the newest: the one that began
      // later when both say when, else the one memory learned last. A fact
      // whose end has passed is not current, so never the one kept.
      const newer = (a: Row, b: Row) =>
        a.valid_at != null && b.valid_at != null && Number(a.valid_at) !== Number(b.valid_at)
          ? Number(b.valid_at) - Number(a.valid_at)
          : Number(b.created_at) - Number(a.created_at) || String(b.id).localeCompare(String(a.id));
      const facts = (await query(
        `MATCH (f:Fact)-[:SUBJECT]->(k:Entity) WHERE k.ref_id = $keep AND f.expired_at IS NULL AND f.deleted_at IS NULL
           AND (f.invalid_at IS NULL OR f.invalid_at > $now)
         RETURN f.ref_id AS id, f.predicate AS predicate, f.text AS text, f.value AS value, f.form AS form,
                f.valid_at AS valid_at, f.created_at AS created_at`,
        { keep, now },
      )).sort(newer);
      const one = new Set<string>();
      // A mishearing repeats when its text and form do, as in remember, whatever its sentence.
      const heard = new Set(vocab.predicatesWithRole("mishearing"));
      for (const p of new Set(facts.map((f) => f.predicate as string))) {
        if ((await lookup(query, "predicate", p))?.cardinality === "one") one.add(p);
      }
      const newest = new Map<string, { id: string; valid_at: unknown }>();
      const superseded: string[] = [];
      for (const f of facts) {
        const group = one.has(f.predicate) ? `${f.predicate}`
          : heard.has(f.predicate) && f.value != null ? `${f.predicate}\u0000${normalize(f.value)}\u0000${normalize(f.form ?? kept.name)}`
          : `${f.predicate}\u0000${f.text}`;
        const winner = newest.get(group);
        if (!winner) { newest.set(group, { id: f.id, valid_at: f.valid_at }); continue; }
        // As in remember: a replaced value ended when the kept one began, if known; a repeat just stops being held.
        await supersede(query, winner.id, one.has(f.predicate) && winner.valid_at != null ? Number(winner.valid_at) : null, [f.id], now);
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
