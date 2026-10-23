import { z } from "zod";
import { defineStep } from "../../../core.js";
import { memoryDb } from "../memory/_db.js";
import forget from "../memory/forget.js";
import { UNDONE } from "./_shared.js";

export default defineStep({
  type: "dictation/undo",
  description:
    "Takes back what dictation/correction or dictation/add learned: pass its `undo` ref_ids. They are forgotten with " +
    "reason \"undone\", so the same pair is never learned again (memory/lexicon lists it in `undone`). Only what " +
    "dictation wrote: any other ref_id is refused and nothing is forgotten.",
  effect: "write",
  input: z.object({ undo: z.array(z.string().min(1)) }),
  output: z.object({ undone: z.array(z.string()) }),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    const ours = new Set<string>();
    for (const table of ["Entity", "Fact"]) {
      const rows = await query(`MATCH (n:${table}) WHERE n.ref_id IN $ids AND n.created_by = $by RETURN n.ref_id AS id`, { ids: cfg.undo, by: "dictation" });
      for (const r of rows) ours.add(r.id as string);
    }
    const other = cfg.undo.filter((id) => !ours.has(id));
    if (other.length) throw new Error(`dictation/undo: not written by dictation: ${other.join(", ")}`);
    for (const ref_id of cfg.undo) {
      const out = await forget.run({ ref_id, reason: UNDONE }, ctx);
      if (out?.error) throw new Error(`dictation/undo: ${out.error}`);
    }
    return { undone: cfg.undo };
  },
});
