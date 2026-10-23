import { z } from "zod";
import { defineStep } from "../../../core.js";
import { iso, memoryDb, readAttributes } from "./_db.js";
import { vocabulary } from "./_ontology.js";

/** The forget reason dictation's Undo gives: a mishearing forgotten so is never learned again. */
export const UNDONE = "undone";

// Dictation's vocabulary, read in one call: every entity's written forms and
// mishearings. Personal scale (a few hundred entities), so the rows are
// grouped here rather than in Cypher.
export default defineStep({
  type: "memory/lexicon",
  description:
    "Dictation's vocabulary in one read: every entity with its type, name, `written` forms (its name, then the names " +
    "its name facts give, as cased), `heard` (how dictation mishears it: { ref_id, value, form, created_at }, form null " +
    "meaning the name), `dictation_off` (attributes.dictation is \"off\", set with memory/attributes), and for ranking " +
    "`facts` (current facts it is in), `updated_at` and `known_by_user` (a current fact of the user's points at it). " +
    "`undone` lists the mishearings forgotten with reason \"undone\", so they are not learned again. " +
    "A mishearing is written with memory/remember: { episode, kind: \"note\", created_by: \"dictation\", facts: [{ " +
    "subject: { ref_id?, type, name }, predicate: <the predicate with role mishearing>, text, value: <the wrong text>, " +
    "form?: <the written form> }] }, where a form left out is the subject name given (so naming the subject by an alias, " +
    "BTC, gives that form); Undo is memory/forget { ref_id, reason: \"undone\" }.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    const query = await memoryDb(ctx);
    const vocab = await vocabulary(query);
    const names = vocab.predicatesWithRole("alias");
    const heardAs = vocab.predicatesWithRole("mishearing");
    const userType = vocab.userType();

    const entities = await query(
      `MATCH (e:Entity) WHERE e.deleted_at IS NULL
       RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.attributes AS attributes, e.updated_at AS updated_at
       ORDER BY e.name, e.ref_id`,
    );
    const facts = await query(
      `MATCH (f:Fact)-[r]->(e:Entity) WHERE e.deleted_at IS NULL AND f.deleted_at IS NULL
       RETURN e.ref_id AS entity, label(r) AS role, f.ref_id AS ref_id, f.predicate AS predicate, f.value AS value,
              f.form AS form, f.expired_at AS expired_at, f.created_at AS created_at
       ORDER BY f.created_at, f.ref_id`,
    );
    const user = userType ? entities.find((e) => e.type === userType) : undefined;
    const known = new Set(user
      ? (await query(
          `MATCH (f:Fact)-[:SUBJECT]->(u:Entity), (f)-[:OBJECT]->(e:Entity)
           WHERE u.ref_id = $u AND f.deleted_at IS NULL AND f.expired_at IS NULL RETURN DISTINCT e.ref_id AS id`,
          { u: user.ref_id },
        )).map((r) => r.id as string)
      : []);
    const undone = await query(
      `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.predicate IN $heardAs AND f.deleted_reason = $why AND f.value IS NOT NULL
       RETURN f.ref_id AS ref_id, f.value AS value, f.form AS form, s.ref_id AS entity, s.name AS name, f.deleted_at AS undone_at
       ORDER BY f.deleted_at, f.ref_id`,
      { heardAs, why: UNDONE },
    );

    const byEntity = new Map<string, typeof facts>();
    for (const f of facts) byEntity.set(f.entity, [...(byEntity.get(f.entity) ?? []), f]);
    return {
      entities: entities.map((e) => {
        const own = byEntity.get(e.ref_id) ?? [];
        const subjectOf = own.filter((f) => f.role === "SUBJECT");
        const current = new Set(own.filter((f) => f.expired_at == null).map((f) => f.ref_id));
        // A replaced name is still a right way to write it, as it still finds the entity.
        const written = [...new Set([e.name, ...subjectOf.filter((f) => names.includes(f.predicate) && f.value).map((f) => f.value as string)])];
        const heard = subjectOf.filter((f) => heardAs.includes(f.predicate) && f.value && f.expired_at == null)
          .map((f) => ({ ref_id: f.ref_id, value: f.value, form: f.form ?? null, created_at: iso(f.created_at) }));
        const last = Math.max(Number(e.updated_at ?? 0), ...own.map((f) => Number(f.created_at ?? 0)));
        const attributes = readAttributes(e.attributes);
        return {
          ref_id: e.ref_id, type: e.type, name: e.name, ...(e.ref_id === user?.ref_id ? { user: true } : {}),
          written, heard, dictation_off: attributes.dictation === "off",
          facts: current.size, updated_at: iso(last), known_by_user: known.has(e.ref_id),
        };
      }),
      undone: undone.map((f) => ({
        ref_id: f.ref_id, value: f.value, form: f.form ?? null, entity: { ref_id: f.entity, name: f.name }, undone_at: iso(f.undone_at),
      })),
    };
  },
});
