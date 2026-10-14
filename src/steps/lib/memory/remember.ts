import { z } from "zod";
import { defineStep } from "../../../core.js";
import { EntityRef, type EntityRefT, type Query, canonical, exclusive, memoryDb, newRefId, normalize } from "./_db.js";
import { fitNote, resolve, termName, vocabulary, type Resolved as Term } from "./_ontology.js";

const FactInput = z.object({
  subject: EntityRef,
  predicate: z.string().min(1).describe("A predicate from memory/ontology, e.g. name, lives_in, works_on, prefers. A new one is kept as proposed."),
  text: z.string().describe("The fact as one plain sentence, e.g. \"The user's name is Tom.\""),
  object: EntityRef.optional().describe("The other entity, when the fact links two (Kate works_on Project X)."),
  supersede: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace the subject's current facts with this predicate. Automatic for one-value predicates such as name or lives_in."),
});

type Resolved = { ref_id: string; type: string; name: string; status: "matched" | "created"; similar?: { ref_id: string; name: string }[] };

// Matching, cheapest first: an explicit ref_id, the one entity of the user type, then the
// exact normalised name or alias within the type. Fuzzy and model matching
// come later; until then a new entity reports close names as `similar`.
async function resolveEntity(query: Query, ref: EntityRefT, type: string, createdBy: string, now: number): Promise<Resolved> {
  if (ref.ref_id) {
    const id = await canonical(query, ref.ref_id);
    const [hit] = await query("MATCH (e:Entity) WHERE e.ref_id = $id AND e.deleted_at IS NULL RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name", { id });
    if (hit) return { ...(hit as Resolved), status: "matched" };
  }
  const key = normalize(ref.name);
  const [hit] = (await vocabulary(query)).role(type) === "user"
    ? await query("MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name LIMIT 1", { type })
    : await query(
        `MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL AND (lower(e.name) = $key OR list_contains(e.aliases, $key))
         RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name LIMIT 1`,
        { type, key },
      );
  if (hit) return { ...(hit as Resolved), status: "matched" };

  const firstWord = key.split(" ")[0] ?? key;
  const similar = firstWord.length >= 3
    ? await query(
        `MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL AND lower(e.name) CONTAINS $w
         RETURN e.ref_id AS ref_id, e.name AS name LIMIT 3`,
        { type, w: firstWord },
      )
    : [];
  const ref_id = newRefId();
  await query(
    `CREATE (:Entity {ref_id: $ref_id, type: $type, name: $name, summary: '', attributes: '{}', aliases: [$key],
             created_by: $by, created_at: $now, updated_at: $now})`,
    { ref_id, type, name: ref.name, key, by: createdBy, now },
  );
  return { ref_id, type, name: ref.name, status: "created", ...(similar.length ? { similar: similar as Resolved["similar"] } : {}) };
}

export default defineStep({
  type: "memory/remember",
  description:
    "Store something in long-term memory. Always pass the episode (what was said, as said). " +
    "List the entities it is about in `mentions`, and any facts worth keeping in `facts`. " +
    "Types and predicates are resolved through memory/ontology (aliases such as full_name → name); an unknown one is " +
    "kept as proposed and reported. A one-value predicate (name, lives_in) supersedes the current fact by itself. " +
    "Entities are matched by type and name, so the same person is never stored twice.",
  input: z.object({
    episode: z.string().describe("What was said or observed, in the user's words. Stored as the source of the facts."),
    source: z.string().optional().describe("Where it came from: a message id, chat id, run id or URL."),
    kind: z.enum(["message", "chat", "run", "note", "event"]).optional().default("chat"),
    created_by: z.string().optional().default("agent").describe("Who is writing: 'agent' or 'user'."),
    mentions: z.array(EntityRef).optional().default([]).describe("Entities the episode is about."),
    facts: z.array(FactInput).optional().default([]),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    // Names that would be stored empty are refused before anything is written.
    const refs = [...cfg.mentions, ...cfg.facts.flatMap((f) => (f.object ? [f.subject, f.object] : [f.subject]))];
    const junk = [
      ...refs.filter((r) => !termName("entity_type", r.type)).map((r) => `type ${JSON.stringify(r.type)}`),
      ...cfg.facts.filter((f) => !termName("predicate", f.predicate)).map((f) => `predicate ${JSON.stringify(f.predicate)}`),
    ];
    if (junk.length) return { error: `invalid_input: ${junk.join(", ")} has no letters or digits` };
    return exclusive(async () => {
      const now = Date.now();
      const by = cfg.created_by;
      const ontology = { resolved: [] as string[], proposed: [] as string[], notes: [] as string[] };
      const noteTerm = (r: Term) => {
        const label = `${r.term.kind === "entity_type" ? "type" : "predicate"} ${r.term.name}`;
        if (r.proposed) ontology.proposed.push(label);
        else if (r.given !== r.term.name) ontology.resolved.push(`${r.given} → ${r.term.name}`);
      };
      const typeOf = async (ref: EntityRefT) => {
        const r = await resolve(query, "entity_type", ref.type, by);
        noteTerm(r);
        return r.term.name;
      };

      const episodeId = newRefId();
      await query(
        `CREATE (:Episode {ref_id: $id, kind: $kind, source: $source, content: $content, occurred_at: $now,
                 created_by: $by, created_at: $now, updated_at: $now})`,
        { id: episodeId, kind: cfg.kind, source: cfg.source ?? "", content: cfg.episode, now, by },
      );

      // Keyed by the resolved ref_id, so one entity given once by ref_id and
      // once by name is listed and linked once; `given` saves resolving again.
      const entities = new Map<string, Resolved>();
      const given = new Map<string, Resolved>();
      const entity = async (ref: EntityRefT) => {
        const type = await typeOf(ref);
        const k = ref.ref_id ?? `${type}:${normalize(ref.name)}`;
        let e = given.get(k);
        if (!e) {
          const found = await resolveEntity(query, ref, type, by, now);
          e = entities.get(found.ref_id) ?? found;
          entities.set(e.ref_id, e);
          given.set(k, e);
        }
        return e;
      };

      for (const ref of cfg.mentions) await entity(ref);
      const facts = [];
      for (const f of cfg.facts) {
        const subject = await entity(f.subject);
        const object = f.object ? await entity(f.object) : undefined;
        const p = await resolve(query, "predicate", f.predicate, by, { subject: subject.type, object: object?.type });
        noteTerm(p);
        const note = fitNote(await vocabulary(query), p.term, subject.type, object?.type);
        if (note) ontology.notes.push(note);
        const predicate = p.term.name;

        // The same fact already held: add this episode as another source.
        const [same] = await query(
          `MATCH (x:Fact)-[:SUBJECT]->(s:Entity) WHERE s.ref_id = $s AND x.predicate = $p AND x.text = $t
             AND x.expired_at IS NULL AND x.deleted_at IS NULL RETURN x.ref_id AS ref_id LIMIT 1`,
          { s: subject.ref_id, p: predicate, t: f.text },
        );
        if (same) {
          await query("MATCH (x:Fact), (e:Episode) WHERE x.ref_id = $f AND e.ref_id = $e CREATE (x)-[:FROM_EPISODE]->(e)", { f: same.ref_id, e: episodeId });
          facts.push({ ref_id: same.ref_id, text: f.text, predicate, status: "existing" });
          continue;
        }

        const factId = newRefId();
        await query(
          `CREATE (:Fact {ref_id: $id, predicate: $p, text: $t, confidence: 1.0, valid_at: $now,
                   created_by: $by, created_at: $now, updated_at: $now})`,
          { id: factId, p: predicate, t: f.text, now, by },
        );
        await query("MATCH (x:Fact), (s:Entity) WHERE x.ref_id = $f AND s.ref_id = $s CREATE (x)-[:SUBJECT]->(s)", { f: factId, s: subject.ref_id });
        if (object) await query("MATCH (x:Fact), (o:Entity) WHERE x.ref_id = $f AND o.ref_id = $o CREATE (x)-[:OBJECT]->(o)", { f: factId, o: object.ref_id });
        await query("MATCH (x:Fact), (e:Episode) WHERE x.ref_id = $f AND e.ref_id = $e CREATE (x)-[:FROM_EPISODE]->(e)", { f: factId, e: episodeId });

        let superseded: string[] = [];
        if (f.supersede || p.term.cardinality === "one") {
          const old = await query(
            `MATCH (x:Fact)-[:SUBJECT]->(s:Entity) WHERE s.ref_id = $s AND x.predicate = $p AND x.ref_id <> $f
               AND x.expired_at IS NULL AND x.deleted_at IS NULL
             SET x.expired_at = $now, x.invalid_at = $now, x.updated_at = $now RETURN x.ref_id AS ref_id`,
            { s: subject.ref_id, p: predicate, f: factId, now },
          );
          superseded = old.map((r) => r.ref_id as string);
          for (const o of superseded) {
            await query("MATCH (n:Fact), (o:Fact) WHERE n.ref_id = $n AND o.ref_id = $o CREATE (n)-[:SUPERSEDES]->(o)", { n: factId, o });
          }
        }
        facts.push({ ref_id: factId, text: f.text, predicate, status: "created", ...(superseded.length ? { superseded } : {}) });
      }

      for (const e of entities.values()) {
        await query("MATCH (ep:Episode), (e:Entity) WHERE ep.ref_id = $ep AND e.ref_id = $e CREATE (ep)-[:MENTIONS]->(e)", { ep: episodeId, e: e.ref_id });
      }
      const said = Object.fromEntries(Object.entries(ontology).filter(([, v]) => v.length));
      return { episode: episodeId, entities: [...entities.values()], facts, ...(Object.keys(said).length ? { ontology: said } : {}) };
    });
  },
});
