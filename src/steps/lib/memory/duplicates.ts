import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Query, memoryDb } from "./_db.js";
import { type Candidate, type Named, named, pairsOf, words } from "../../../graph/name-pairs.js";
import { vocabulary } from "./_ontology.js";

export type { Candidate };

/** The name in a name fact's sentence: what follows "name is", "named",
 *  "called" or "call me" ("The user's name is Tom Smith." → tom smith). */
function nameIn(text: string): string[] {
  const m = /\b(?:name is|named|called|call me)\s+(.+)$/i.exec(text);
  return m ? words(m[1]!) : [];
}

/** Every pair that may be one entity saved twice, strongest first. Score 100
 *  is a Person with the user's full name, and the only pair with the user in
 *  it. memory/merge reads this to hold the janitor to what is offered here. */
export async function candidatePairs(query: Query): Promise<Candidate[]> {
  const rows = await query(
    `MATCH (e:Entity) WHERE e.deleted_at IS NULL
     RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.aliases AS aliases ORDER BY e.created_at, e.ref_id`,
  );
  const entities = rows.map((r) => named({ ref_id: r.ref_id as string, name: r.name as string, node_type: r.type as string }, (r.aliases ?? []) as string[]));

  // Behaviour comes from the ontology rows, never a type's name: the user
  // is the type with role "user", and people are the other types whose
  // names are matched the way the user's are.
  const vocab = await vocabulary(query);
  const userType = vocab.userType();
  const isUser = (e: Named) => vocab.role(e.side.node_type) === "user";
  const isPerson = (e: Named) => !!userType && !isUser(e) && vocab.naming(e.side.node_type) === vocab.naming(userType);

  // The user, by the names they gave: their current name facts (a
  // predicate with role "alias"), the name kept on the fact, else read from
  // its sentence.
  const user = entities.find(isUser);
  let names: string[] = [];
  if (user) {
    const facts = await query(
      `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE s.ref_id = $id AND f.predicate IN $predicates
         AND f.expired_at IS NULL AND f.deleted_at IS NULL
       RETURN f.value AS value, f.text AS text`,
      { id: user.side.ref_id, predicates: vocab.predicatesWithRole("alias") },
    );
    names = facts.map((f) => (f.value ? words(f.value) : nameIn(f.text)).join(" "));
  }
  return pairsOf(entities, isUser, names, isPerson);
}

// Deterministic candidates for the duplicates janitor: it proposes, a model
// (or a person) decides. Personal scale, so every pair is compared in memory.
export default defineStep({
  type: "memory/duplicates",
  description:
    "List entities that may be saved twice, strongest first, each pair with the reason it matched: the same name or " +
    "alias on two entities (also of different types), a Person with the user's full name, or one name the " +
    "first-name form of the other ('Kate' and 'Katie Moss'). Candidates only: call memory/get on both before merging.",
  input: z.object({
    limit: z.number().optional().default(20),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return (await candidatePairs(await memoryDb(ctx)))
      .slice(0, Math.max(1, cfg.limit))
      .map(({ a, b, reason }) => ({ a, b, reason }));
  },
});
