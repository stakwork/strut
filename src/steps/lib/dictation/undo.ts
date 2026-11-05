import { z } from "zod";
import { defineStep } from "../../../core.js";
import { UNDONE } from "./_shared.js";
import { graphForget, graphOurs } from "./_graph.js";

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
    const ours = await graphOurs(ctx, cfg.undo);
    const other = cfg.undo.filter((id) => !ours.has(id));
    if (other.length) throw new Error(`dictation/undo: not written by dictation: ${other.join(", ")}`);
    for (const ref_id of cfg.undo) {
      await graphForget(ctx, ref_id, UNDONE).catch((err) => { throw new Error(`dictation/undo: ${err instanceof Error ? err.message : err}`); });
    }
    return { undone: cfg.undo };
  },
});
