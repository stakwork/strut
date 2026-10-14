import { z } from "zod";
import { defineStep } from "../../../core.js";
import { memoryDb } from "./_db.js";
import { vocabulary } from "./_ontology.js";

export default defineStep({
  type: "memory/ontology",
  description:
    "The memory's vocabulary: its entity types and fact predicates, each with a description, aliases, status (active " +
    "or proposed) and how often it is used. A predicate also has its cardinality (one: a new fact replaces the current " +
    "one) and the entity types it connects. An entity type may have a parent (it is matched like its parent and fits " +
    "wherever its parent does), a naming (person, organisation or plain: how names are matched) and a role; user_type is " +
    "the type that is the user. A predicate with role alias gives its subject another name (its fact text is a name). " +
    "Use these names in memory/remember rather than inventing near-copies.",
  input: z.object({
    include_proposed: z.boolean().optional().default(true),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    const vocab = await vocabulary(query);
    const terms = vocab.terms.filter((t) => cfg.include_proposed || t.status === "active");
    const typeUse = new Map((await query("MATCH (e:Entity) WHERE e.deleted_at IS NULL RETURN e.type AS k, count(*) AS n")).map((r) => [r.k, Number(r.n)]));
    const predicateUse = new Map((await query(
      "MATCH (f:Fact) WHERE f.deleted_at IS NULL AND f.expired_at IS NULL RETURN f.predicate AS k, count(*) AS n",
    )).map((r) => [r.k, Number(r.n)]));
    const strip = (t: Record<string, any>) =>
      Object.fromEntries(Object.entries(t).filter(([k, v]) => k !== "kind" && !(Array.isArray(v) && v.length === 0) && v !== ""));
    return {
      user_type: vocab.userType(),
      entity_types: terms.filter((t) => t.kind === "entity_type")
        .map((t) => ({ ...strip(t), cardinality: undefined, used: typeUse.get(t.name) ?? 0 })),
      predicates: terms.filter((t) => t.kind === "predicate").map((t) => ({ ...strip(t), used: predicateUse.get(t.name) ?? 0 })),
    };
  },
});
