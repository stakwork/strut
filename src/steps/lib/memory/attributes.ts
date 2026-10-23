import { z } from "zod";
import { defineStep } from "../../../core.js";
import { canonical, memoryWrite, readAttributes } from "./_db.js";

export default defineStep({
  type: "memory/attributes",
  description:
    "Set or clear an entity's attributes (memory/get shows them): each key in `set` is written, a null clears it, " +
    "the rest are kept. dictation: \"off\" keeps the entity out of dictation's vocabulary (memory/lexicon reports it); " +
    "a lingo_type (e.g. acronym, product_term) says what kind of word it is.",
  input: z.object({
    ref_id: z.string(),
    set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    return memoryWrite(ctx, async (query) => {
      // A merged-away entity means the one it was merged into, as in memory/get.
      const id = await canonical(query, cfg.ref_id);
      const [e] = await query("MATCH (e:Entity) WHERE e.ref_id = $id AND e.deleted_at IS NULL RETURN e.name AS name, e.attributes AS attributes", { id });
      if (!e) return { error: `not_found: no entity with ref_id ${cfg.ref_id}` };
      const attributes = readAttributes(e.attributes);
      for (const [k, v] of Object.entries(cfg.set)) {
        if (v === null) delete attributes[k];
        else attributes[k] = v;
      }
      await query("MATCH (e:Entity) WHERE e.ref_id = $id SET e.attributes = $a, e.updated_at = $now", { id, a: JSON.stringify(attributes), now: Date.now() });
      return { ref_id: id, name: e.name, attributes };
    });
  },
});
