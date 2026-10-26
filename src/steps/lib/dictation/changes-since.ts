import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Query, iso, memoryExclusive } from "../memory/_db.js";
import { vocabulary } from "../memory/_ontology.js";
import { Change, UNDONE, type ChangeT } from "./_shared.js";

/** A time as epoch ms: an ISO string, a number of ms, or nothing (the start). */
function ms(at: string | number | undefined): number {
  if (at === undefined || at === "") return 0;
  const n = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(n)) throw new Error(`dictation/changes-since: since is not a time: ${JSON.stringify(at)}`);
  return n;
}

/** What dictation changed over [since, until), read with `query`. The
 *  caller holds the writes' queue (memoryExclusive) and takes `until` inside
 *  it, as the step does: home/sync reads so too, and again inside the
 *  import's lock. */
export async function dictationChanges(query: Query, since: number, until: number): Promise<{ kind: "dictation"; since: string; until: string; changes: ChangeT[] }> {
  const vocab = await vocabulary(query);
  const heardAs = vocab.predicatesWithRole("mishearing");
  const lingo = vocab.typeWithRole("dictation");
  const range = { since, until, heardAs, undone: UNDONE };
  const changes: Array<ChangeT & { ms: number }> = [];
  const pair = (r: Record<string, unknown>) => {
    const form = typeof r["form"] === "string" ? (r["form"] as string) : null;
    return { heard: r["value"] as string, written: form ?? (r["name"] as string), ...(form ? { name: r["name"] as string } : {}) };
  };

  for (const r of await query(
    `MATCH (f:Fact)-[:SUBJECT]->(s:Entity)
     WHERE f.predicate IN $heardAs AND f.created_by = 'dictation' AND f.value IS NOT NULL AND f.expired_at IS NULL
       AND f.created_at >= $since AND f.created_at < $until AND (f.deleted_at IS NULL OR f.deleted_reason = $undone)
     RETURN f.value AS value, f.form AS form, s.name AS name, f.created_at AS at`,
    range,
  )) changes.push({ op: "learn", ...pair(r), at: iso(r["at"])!, ms: Number(r["at"]) });

  for (const r of await query(
    `MATCH (f:Fact)-[:SUBJECT]->(s:Entity)
     WHERE f.predicate IN $heardAs AND f.value IS NOT NULL AND f.deleted_reason = $undone
       AND f.deleted_at >= $since AND f.deleted_at < $until
     RETURN f.value AS value, f.form AS form, s.name AS name, f.deleted_at AS at`,
    range,
  )) changes.push({ op: "undo", ...pair(r), at: iso(r["at"])!, ms: Number(r["at"]) });

  if (lingo) {
    // Terms: words of the dictation type dictation made, with no mishearing ever kept on them.
    const withPairs = new Set(
      (await query(`MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.predicate IN $heardAs RETURN DISTINCT s.ref_id AS id`, { heardAs })).map((r) => r["id"] as string),
    );
    const words = await query(
      `MATCH (e:Entity) WHERE e.type = $lingo AND e.created_by = 'dictation'
       RETURN e.ref_id AS id, e.name AS name, e.created_at AS created_at, e.deleted_at AS deleted_at, e.deleted_reason AS reason`,
      { lingo },
    );
    for (const w of words) {
      if (withPairs.has(w["id"] as string)) continue;
      const created = Number(w["created_at"]);
      const deleted = w["deleted_at"] == null ? null : Number(w["deleted_at"]);
      const undone = w["reason"] === UNDONE;
      if (created >= since && created < until && (deleted === null || undone)) changes.push({ op: "learn", written: w["name"] as string, term: true, at: iso(created)!, ms: created });
      if (undone && deleted! >= since && deleted! < until) changes.push({ op: "undo", written: w["name"] as string, term: true, at: iso(deleted)!, ms: deleted! });
    }
  }

  changes.sort((a, b) => a.ms - b.ms || (a.op === b.op ? 0 : a.op === "learn" ? -1 : 1));
  return { kind: "dictation", since: new Date(since).toISOString(), until: new Date(until).toISOString(), changes: changes.map(({ ms: _ms, ...c }) => c) };
}

// What dictation changed in this strut's memory, read from the graph itself:
// no outbox. A learn is a mishearing fact (or, for a term, an entity of the
// dictation type with none) written with created_by "dictation"; an undo is
// one forgotten with reason "undone". A learn later forgotten for another
// reason (dictation/remove), or expired, is left out: replayed, it would
// come back.
//
// Read in the writes' queue, over [since, until): a write stamps its time
// when it starts and commits later, so a read beside one would miss it for
// good. In the queue every stamp before `until` is committed, and every
// write after it stamps `until` or later, which the next read starts from.
export default defineStep({
  type: "dictation/changes-since",
  description:
    "What dictation learned or undid in this strut's memory from `since` up to now, for another strut to replay with " +
    "dictation/apply-changes (a Mac's strut pushing to its home box). Each change is keyed by its pair (heard, written, and " +
    "the entity's name when written is another form of it), never a ref_id. Pass the reply's `until` as the next `since`: " +
    "nothing falls between two reads.",
  input: z.object({
    since: z.union([z.string(), z.number()]).optional().describe("The last read's `until` (ISO or epoch ms); absent: everything."),
  }),
  output: z.object({ kind: z.literal("dictation"), since: z.string(), until: z.string(), changes: z.array(Change) }),
  async run(cfg, ctx) {
    const since = ms(cfg.since);
    return memoryExclusive(ctx, ({ read }) => dictationChanges(read, since, Date.now()));
  },
});
